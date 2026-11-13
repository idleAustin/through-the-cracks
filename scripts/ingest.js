#!/usr/bin/env node
// Through the Cracks ingestion CLI: fetches Blogger posts, updates BigQuery (WRITE_TRUNCATE), and writes static JSON snapshots.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeIncrementalStartDate,
  fetchBloggerPosts,
  mergeIncrementalEpisodes,
  parsePost,
} from './blogger-parser.js';
import { writeStaticSnapshots } from './static-snapshots.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, '.cache');

function loadEnvIfPresent() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (!process.env[key]) process.env[key] = match[2].trim();
    }
  }
}

loadEnvIfPresent();

const args = process.argv.slice(2);
const INCREMENTAL = args.includes('--incremental');
const SKIP_BQ = args.includes('--skip-bq');
const USE_CACHE = args.includes('--use-cache');

const API_KEY = process.env.BLOGGER_API_KEY || '';
const BLOG_ID = process.env.BLOGGER_BLOG_ID || '3469042462299367694';
const GCP_PROJECT = process.env.GCP_PROJECT_ID || '';
const BQ_DATASET = process.env.BQ_DATASET || 'through_the_cracks';

let bigquery = null;

async function initBigQuery() {
  if (SKIP_BQ) return false;
  if (!GCP_PROJECT) {
    console.log('⚠️  No GCP_PROJECT_ID set — skipping BigQuery writes');
    return false;
  }

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
      try {
        const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
        bigquery = new BigQuery({ projectId: GCP_PROJECT, credentials });
      } catch (err) {
        console.warn(`⚠️  Failed to parse GCP_SERVICE_ACCOUNT_KEY (${err.message}); falling back to ADC`);
        bigquery = new BigQuery({ projectId: GCP_PROJECT });
      }
    } else {
      bigquery = new BigQuery({ projectId: GCP_PROJECT });
    }

    const [exists] = await bigquery.dataset(BQ_DATASET).exists();
    if (!exists) {
      console.warn(`⚠️  BigQuery dataset '${BQ_DATASET}' not found in project '${GCP_PROJECT}'`);
      bigquery = null;
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`⚠️  BigQuery initialization failed (${err.message}) — skipping BigQuery writes`);
    bigquery = null;
    return false;
  }
}

const EPISODES_SCHEMA = {
  fields: [
    { name: 'id', type: 'STRING' },
    { name: 'title', type: 'STRING' },
    { name: 'air_date', type: 'DATE' },
    { name: 'day_of_week', type: 'STRING' },
    { name: 'episode_number', type: 'INT64' },
    { name: 'published_at', type: 'TIMESTAMP' },
    { name: 'url', type: 'STRING' },
    { name: 'song_count', type: 'INT64' },
    { name: 'ingested_at', type: 'TIMESTAMP' },
  ],
};

const SONG_PLAYS_SCHEMA = {
  fields: [
    { name: 'id', type: 'STRING' },
    { name: 'episode_id', type: 'STRING' },
    { name: 'air_date', type: 'DATE' },
    { name: 'position', type: 'INT64' },
    { name: 'artist', type: 'STRING' },
    { name: 'song_title', type: 'STRING' },
    { name: 'album', type: 'STRING' },
    { name: 'raw_line', type: 'STRING' },
    { name: 'ingested_at', type: 'TIMESTAMP' },
  ],
};

async function writeToBigQuery(episodesData) {
  if (!bigquery) return;
  try {
    const now = new Date().toISOString();
    const validEpisodes = episodesData.filter((ep) => /^\d{4}-\d{2}-\d{2}$/.test(ep.airDate || ''));
    const dropped = episodesData.length - validEpisodes.length;
    if (dropped > 0) {
      console.warn(`⚠️  Dropped ${dropped} episodes with missing/invalid airDate before BigQuery load`);
    }

    const episodeRows = validEpisodes.map((ep) => ({
      id: String(ep.id),
      title: ep.title || '',
      air_date: ep.airDate,
      day_of_week: ep.dayOfWeek ?? null,
      episode_number: ep.episodeNumber ?? null,
      published_at: ep.publishedAt || null,
      url: ep.url || null,
      song_count: (ep.songs || []).length,
      ingested_at: now,
    }));

    const songRows = [];
    for (const ep of validEpisodes) {
      for (const song of ep.songs || []) {
        songRows.push({
          id: `${ep.id}_${song.position}`,
          episode_id: String(ep.id),
          air_date: ep.airDate,
          position: song.position,
          artist: song.artist || '',
          song_title: song.songTitle || '',
          album: song.album || '',
          raw_line: song.rawLine || '',
          ingested_at: now,
        });
      }
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const episodesNdjson = path.join(CACHE_DIR, 'bq-episodes.ndjson');
    const songsNdjson = path.join(CACHE_DIR, 'bq-song-plays.ndjson');
    writeFileSync(episodesNdjson, episodeRows.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(songsNdjson, songRows.map((r) => JSON.stringify(r)).join('\n'));
    console.log(`☁️  Loading BigQuery (${episodeRows.length} episodes, ${songRows.length} song plays)...`);

    const [episodesJob] = await bigquery.dataset(BQ_DATASET).table('episodes').load(episodesNdjson, {
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      writeDisposition: 'WRITE_TRUNCATE',
      autodetect: false,
      schema: EPISODES_SCHEMA,
    });
    if (episodesJob.status?.errors?.length) {
      console.warn('⚠️  Episodes load errors:', episodesJob.status.errors);
    } else {
      console.log(`   ✅ Episodes loaded: ${episodeRows.length} rows`);
    }

    const [songsJob] = await bigquery.dataset(BQ_DATASET).table('song_plays').load(songsNdjson, {
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      writeDisposition: 'WRITE_TRUNCATE',
      autodetect: false,
      schema: SONG_PLAYS_SCHEMA,
    });
    if (songsJob.status?.errors?.length) {
      console.warn('⚠️  Song plays load errors:', songsJob.status.errors);
    } else {
      console.log(`   ✅ Song plays loaded: ${songRows.length} rows`);
    }
  } catch (err) {
    console.warn(`⚠️  BigQuery write failed (${err.message}); continuing with static JSON snapshots`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Through the Cracks — Data Ingestion');
  console.log('═══════════════════════════════════════════════════════════');

  const bqReady = await initBigQuery();
  const episodesJsonPath = path.join(DATA_DIR, 'episodes.json');
  const existingEpisodes =
    INCREMENTAL && existsSync(episodesJsonPath) ? JSON.parse(readFileSync(episodesJsonPath, 'utf-8')) : [];
  const startDateIso = INCREMENTAL ? computeIncrementalStartDate(existingEpisodes, 14) : null;

  let rawPosts;
  const cachePath = path.join(CACHE_DIR, 'raw-posts.json');
  if (!INCREMENTAL && USE_CACHE && existsSync(cachePath)) {
    console.log('📦 Loading cached posts from .cache/raw-posts.json...');
    rawPosts = JSON.parse(readFileSync(cachePath, 'utf-8'));
  } else {
    console.log(`🌐 Fetching Blogger posts (${INCREMENTAL ? `incremental since ${startDateIso || 'beginning'}` : 'full'})...`);
    rawPosts = await fetchBloggerPosts({ blogId: BLOG_ID, apiKey: API_KEY, startDateIso });
    if (!INCREMENTAL) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(rawPosts, null, 2));
    }
  }

  const parsed = [];
  for (const post of rawPosts) {
    if (!post.title?.toLowerCase().includes('through the cracks')) continue;
    const result = parsePost(post);
    if (result.songs.length === 0) continue;
    parsed.push(result);
  }

  const mergedEpisodes = mergeIncrementalEpisodes(INCREMENTAL ? existingEpisodes : [], parsed);
  console.log(`✅ Parsed ${parsed.length} playlist posts -> ${mergedEpisodes.length} total episodes`);

  if (bqReady) await writeToBigQuery(mergedEpisodes);
  writeStaticSnapshots(mergedEpisodes, DATA_DIR, { writeEpisodesFile: true });
  console.log(`✅ Wrote static JSON snapshots to ${DATA_DIR}`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
}
