#!/usr/bin/env node

/**
 * Through the Cracks — Full Ingestion Script
 * 
 * Fetches ALL posts from Ed Dirmeyer's blog via the Blogger API v3,
 * parses every playlist into structured data, and writes to:
 *   1. BigQuery tables (episodes + song_plays)
 *   2. Pre-computed JSON files in public/data/ (for local dev / fallback)
 * 
 * Usage:
 *   node scripts/ingest.js              # Full ingestion (all posts)
 *   node scripts/ingest.js --incremental # Only fetch new posts since last run
 *   node scripts/ingest.js --skip-bq    # Skip BigQuery, only write JSON
 * 
 * Requires: .env file with BLOGGER_API_KEY, BLOGGER_BLOG_ID,
 *           and optionally GCP_PROJECT_ID, BQ_DATASET
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeStaticSnapshots } from './static-snapshots.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const INCREMENTAL = args.includes('--incremental');
const SKIP_BQ = args.includes('--skip-bq');

// ── Load .env ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    console.error('❌ No .env file found. Run: bash scripts/setup-api-key.sh');
    process.exit(1);
  }
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

loadEnv();

const API_KEY = process.env.BLOGGER_API_KEY;
const BLOG_ID = process.env.BLOGGER_BLOG_ID;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const BQ_DATASET = process.env.BQ_DATASET || 'through_the_cracks';

if (!API_KEY || !BLOG_ID) {
  console.error('❌ Missing BLOGGER_API_KEY or BLOGGER_BLOG_ID in .env');
  process.exit(1);
}

const DATA_DIR = join(ROOT, 'public', 'data');
const CACHE_DIR = join(ROOT, '.cache');

// ── BigQuery Client ─────────────────────────────────────────────────────────

let bigquery = null;

async function initBigQuery() {
  if (SKIP_BQ) return false;
  if (!GCP_PROJECT) {
    console.log('⚠️  No GCP_PROJECT_ID in .env — skipping BigQuery writes');
    console.log('   Run: bash scripts/setup-bigquery.sh to configure BigQuery');
    return false;
  }

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    bigquery = new BigQuery({ projectId: GCP_PROJECT });

    // Test connection
    const [datasets] = await bigquery.getDatasets();
    const hasDataset = datasets.some(d => d.id === BQ_DATASET);
    if (!hasDataset) {
      console.log(`⚠️  BigQuery dataset '${BQ_DATASET}' not found in project '${GCP_PROJECT}'`);
      console.log('   Run: bash scripts/setup-bigquery.sh to create it');
      return false;
    }

    return true;
  } catch (err) {
    console.log(`⚠️  BigQuery connection failed: ${err.message}`);
    console.log('   Run: bash scripts/setup-bigquery.sh to configure authentication');
    return false;
  }
}


// ── API Fetching ────────────────────────────────────────────────────────────

const BASE_URL = `https://www.googleapis.com/blogger/v3/blogs/${BLOG_ID}/posts`;

async function _getLatestIngestedDate() {
  if (!bigquery || !INCREMENTAL) return null;

  try {
    const query = `SELECT MAX(air_date) as latest FROM \`${GCP_PROJECT}.${BQ_DATASET}.episodes\``;
    const [rows] = await bigquery.query({ query });
    if (rows.length > 0 && rows[0].latest) {
      return rows[0].latest.value; // BigQuery DATE comes as {value: 'YYYY-MM-DD'}
    }
  } catch (err) {
    console.log(`   Could not read latest date from BigQuery: ${err.message}`);
  }
  return null;
}

async function fetchAllPosts() {
  // For full (non-incremental) runs, check cache
  if (!INCREMENTAL) {
    const cachePath = join(CACHE_DIR, 'raw-posts.json');
    if (existsSync(cachePath)) {
      console.log('📦 Loading from cache (.cache/raw-posts.json)...');
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
      console.log(`   ${cached.length} posts loaded from cache`);
      return cached;
    }
  }

  console.log('🌐 Fetching posts from Blogger API...');
  console.log(`   Blog ID: ${BLOG_ID}`);
  if (INCREMENTAL) console.log('   Mode: incremental (new posts only)');
  console.log('');

  const allPosts = [];
  let pageToken = null;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const params = new URLSearchParams({
      key: API_KEY,
      maxResults: '20',
      fields: 'items(id,title,content,published,updated,url),nextPageToken',
      orderBy: 'published',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `${BASE_URL}?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      console.error(`❌ API error (HTTP ${response.status}): ${text}`);
      process.exit(1);
    }

    const data = await response.json();
    const items = data.items || [];
    allPosts.push(...items);

    process.stdout.write(`\r   Page ${pageNum}: ${allPosts.length} posts fetched...`);

    if (!data.nextPageToken) {
      console.log('');
      break;
    }
    pageToken = data.nextPageToken;

    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`✅ Fetched ${allPosts.length} total posts`);

  // Cache raw posts (only for full runs)
  if (!INCREMENTAL) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, 'raw-posts.json'), JSON.stringify(allPosts, null, 2));
    console.log('💾 Cached raw posts to .cache/raw-posts.json');
  }

  return allPosts;
}


// ── HTML Parsing ────────────────────────────────────────────────────────────

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#176;/g, '\u00B0')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8239;/g, ' ')
    .replace(/&#\d+;/g, (match) => {
      const code = parseInt(match.replace(/&#|;/g, ''));
      return String.fromCharCode(code);
    });
}

function htmlToLines(html) {
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n');

  text = text.replace(/<[^>]*>/g, '');
  text = decodeHtmlEntities(text);

  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}


// ── Episode Metadata ────────────────────────────────────────────────────────

function parseEpisodeMetadata(post) {
  const titleMatch = post.title.match(
    /Playlist for WEVL's Through The Cracks,\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2}\/\d{1,2}\/\d{4})/i
  );

  let dayOfWeek = null;
  let airDate = null;

  if (titleMatch) {
    dayOfWeek = titleMatch[1];
    const dateParts = titleMatch[2].split('/');
    airDate = `${dateParts[2]}-${dateParts[0].padStart(2, '0')}-${dateParts[1].padStart(2, '0')}`;
  } else {
    if (post.published) {
      airDate = post.published.substring(0, 10);
    }
  }

  // Match #NN inside a <div> tag to avoid false matches on HTML entities
  const episodeMatch = post.content.match(/<div>#(\d+)<\/div>/);
  const fallbackMatch = !episodeMatch ? post.content.match(/(?:^|\n|<br\s*\/?>)\s*#(\d+)\s*(?:<|$)/i) : null;
  const episodeNumber = episodeMatch
    ? parseInt(episodeMatch[1])
    : (fallbackMatch ? parseInt(fallbackMatch[1]) : null);

  return {
    id: post.id,
    title: post.title,
    airDate,
    dayOfWeek,
    episodeNumber,
    publishedAt: post.published,
    url: post.url,
  };
}


// ── Song Line Parsing ───────────────────────────────────────────────────────

function parseSongLine(rawLine, position) {
  let cleaned = rawLine.replace(/^[-•*]\s*/, '').trim();

  // Handle instrumental interludes
  let isInstrumental = false;
  if (/^(?:instrumental\s+|intrumental\s+)?interlude:\s*/i.test(cleaned)) {
    isInstrumental = true;
    cleaned = cleaned.replace(/^(?:instrumental\s+|intrumental\s+)?interlude:\s*/i, '').trim();
  }

  // Normalize dash separators: split by whitespace-flanked or single-side flanked dashes
  // replacing with a clean token " |~| " without breaking internal hyphenated words
  const normalized = cleaned.replace(/\s+-\s+|\s+-|-\s+/g, ' |~| ');
  const parts = normalized.split(' |~| ').map(p => p.trim()).filter(p => p.length > 0);

  if (parts.length < 2) {
    return null; // Not a song line (header, episode number, show intro, etc.)
  }

  let artist, songTitle, album;

  if (parts.length >= 3) {
    artist = parts[0];
    album = parts[parts.length - 1];
    songTitle = parts.slice(1, -1).join(' - ');
  } else if (parts.length === 2) {
    artist = parts[0];
    songTitle = parts[1];
    album = isInstrumental ? 'Instrumental Interlude' : '[Single / Track]';
  }

  if (isInstrumental && parts.length >= 3 && !album.toLowerCase().includes('interlude')) {
    album = `${album} (Instrumental Interlude)`;
  }

  // Filter non-song headers or notices
  if (
    artist.toLowerCase().includes('playlist for') ||
    artist.startsWith('#') ||
    artist.toLowerCase().includes('thanksgiving saturday') ||
    artist.toLowerCase().includes('anniversary special')
  ) {
    return null;
  }

  return {
    position,
    rawLine,
    artist,
    songTitle,
    album,
  };
}


// ── Full Post Parser ────────────────────────────────────────────────────────

function parsePost(post) {
  const episode = parseEpisodeMetadata(post);
  const lines = htmlToLines(post.content);

  const songLines = lines.filter(line => {
    if (/^#\d+/.test(line)) return false;
    if (/^\d+$/.test(line)) return false;
    if (/^playlist for/i.test(line)) return false;
    return true;
  });

  const songs = [];
  let pos = 1;

  for (const line of songLines) {
    const parsed = parseSongLine(line, pos);
    if (parsed) {
      songs.push({ ...parsed, position: pos });
      pos++;
    }
  }

  return { episode, songs };
}


// ── BigQuery Load Jobs ──────────────────────────────────────────────────────
// BigQuery sandbox (no billing) blocks streaming inserts and DML.
// Load jobs are free and work without billing. We write NDJSON temp files
// and use table.load() with WRITE_TRUNCATE to replace existing data.

async function writeToBigQuery(episodes) {
  if (!bigquery) return;

  const now = new Date().toISOString();

  console.log('☁️  Writing to BigQuery via load jobs...');

  // Prepare episode rows
  const episodeRows = episodes.map(ep => ({
    id: ep.episode.id,
    title: ep.episode.title,
    air_date: ep.episode.airDate,
    day_of_week: ep.episode.dayOfWeek,
    episode_number: ep.episode.episodeNumber,
    published_at: ep.episode.publishedAt,
    url: ep.episode.url,
    song_count: ep.songs.length,
    ingested_at: now,
  }));

  // Prepare song_plays rows
  const songRows = [];
  for (const ep of episodes) {
    for (const song of ep.songs) {
      songRows.push({
        id: `${ep.episode.id}_${song.position}`,
        episode_id: ep.episode.id,
        air_date: ep.episode.airDate,
        position: song.position,
        artist: song.artist,
        song_title: song.songTitle,
        album: song.album,
        raw_line: song.rawLine,
        ingested_at: now,
      });
    }
  }

  // Write NDJSON temp files
  mkdirSync(CACHE_DIR, { recursive: true });
  const episodesNdjson = join(CACHE_DIR, 'bq-episodes.ndjson');
  const songsNdjson = join(CACHE_DIR, 'bq-song-plays.ndjson');

  writeFileSync(episodesNdjson, episodeRows.map(r => JSON.stringify(r)).join('\n'));
  writeFileSync(songsNdjson, songRows.map(r => JSON.stringify(r)).join('\n'));

  console.log(`   Wrote temp files: ${episodeRows.length} episodes, ${songRows.length} song plays`);

  // Load episodes table (WRITE_TRUNCATE replaces all existing data — no DML needed)
  console.log('   Loading episodes...');
  const episodesTable = bigquery.dataset(BQ_DATASET).table('episodes');
  const [episodesJob] = await episodesTable.load(episodesNdjson, {
    sourceFormat: 'NEWLINE_DELIMITED_JSON',
    writeDisposition: INCREMENTAL ? 'WRITE_APPEND' : 'WRITE_TRUNCATE',
    autodetect: false,
    schema: {
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
    },
  });

  const episodesErrors = episodesJob.status?.errors;
  if (episodesErrors && episodesErrors.length > 0) {
    console.log(`   ⚠️  Episodes load had errors:`, episodesErrors);
  } else {
    console.log(`   ✅ Episodes: ${episodeRows.length} rows loaded`);
  }

  // Load song_plays table
  console.log('   Loading song plays...');
  const songsTable = bigquery.dataset(BQ_DATASET).table('song_plays');
  const [songsJob] = await songsTable.load(songsNdjson, {
    sourceFormat: 'NEWLINE_DELIMITED_JSON',
    writeDisposition: INCREMENTAL ? 'WRITE_APPEND' : 'WRITE_TRUNCATE',
    autodetect: false,
    schema: {
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
    },
  });

  const songsErrors = songsJob.status?.errors;
  if (songsErrors && songsErrors.length > 0) {
    console.log(`   ⚠️  Song plays load had errors:`, songsErrors);
  } else {
    console.log(`   ✅ Song plays: ${songRows.length} rows loaded`);
  }

  console.log(`   ✅ BigQuery load complete`);
}


// ── Data Aggregation ────────────────────────────────────────────────────────

function buildAggregations(episodes) {
  const artistMap = new Map();
  const albumMap = new Map();
  const songMap = new Map();

  for (const ep of episodes) {
    for (const song of ep.songs) {
      // Artist aggregation
      const artistKey = song.artist.toLowerCase();
      if (!artistMap.has(artistKey)) {
        artistMap.set(artistKey, {
          name: song.artist,
          totalPlays: 0,
          uniqueSongs: new Set(),
          uniqueAlbums: new Set(),
          firstAppearance: ep.episode.airDate,
          lastAppearance: ep.episode.airDate,
          episodeIds: new Set(),
        });
      }
      const artist = artistMap.get(artistKey);
      artist.totalPlays++;
      artist.uniqueSongs.add(song.songTitle.toLowerCase());
      artist.uniqueAlbums.add(song.album.toLowerCase());
      artist.episodeIds.add(ep.episode.id);
      if (ep.episode.airDate && (!artist.firstAppearance || ep.episode.airDate < artist.firstAppearance)) {
        artist.firstAppearance = ep.episode.airDate;
      }
      if (ep.episode.airDate && (!artist.lastAppearance || ep.episode.airDate > artist.lastAppearance)) {
        artist.lastAppearance = ep.episode.airDate;
      }

      // Album aggregation
      const albumKey = `${song.artist.toLowerCase()}|||${song.album.toLowerCase()}`;
      if (!albumMap.has(albumKey)) {
        albumMap.set(albumKey, {
          artist: song.artist,
          album: song.album,
          totalPlays: 0,
          uniqueSongs: new Set(),
          firstAppearance: ep.episode.airDate,
        });
      }
      const albumEntry = albumMap.get(albumKey);
      albumEntry.totalPlays++;
      albumEntry.uniqueSongs.add(song.songTitle.toLowerCase());

      // Song aggregation
      const songKey = `${song.artist.toLowerCase()}|||${song.songTitle.toLowerCase()}`;
      if (!songMap.has(songKey)) {
        songMap.set(songKey, {
          artist: song.artist,
          songTitle: song.songTitle,
          albums: new Set(),
          totalPlays: 0,
          firstAppearance: ep.episode.airDate,
        });
      }
      const songEntry = songMap.get(songKey);
      songEntry.totalPlays++;
      songEntry.albums.add(song.album);
    }
  }

  const artists = Array.from(artistMap.values())
    .map(a => ({
      name: a.name,
      totalPlays: a.totalPlays,
      uniqueSongs: a.uniqueSongs.size,
      uniqueAlbums: a.uniqueAlbums.size,
      episodeCount: a.episodeIds.size,
      firstAppearance: a.firstAppearance,
      lastAppearance: a.lastAppearance,
    }))
    .sort((a, b) => b.totalPlays - a.totalPlays);

  const albums = Array.from(albumMap.values())
    .map(a => ({
      artist: a.artist,
      album: a.album,
      totalPlays: a.totalPlays,
      uniqueSongs: a.uniqueSongs.size,
      firstAppearance: a.firstAppearance,
    }))
    .sort((a, b) => b.totalPlays - a.totalPlays);

  const songs = Array.from(songMap.values())
    .map(s => ({
      artist: s.artist,
      songTitle: s.songTitle,
      albums: Array.from(s.albums),
      totalPlays: s.totalPlays,
      firstAppearance: s.firstAppearance,
    }))
    .sort((a, b) => b.totalPlays - a.totalPlays);

  // Year stats
  const yearStats = {};
  for (const ep of episodes) {
    const year = ep.episode.airDate ? ep.episode.airDate.substring(0, 4) : 'unknown';
    if (!yearStats[year]) {
      yearStats[year] = { year, episodeCount: 0, songCount: 0, uniqueArtists: new Set() };
    }
    yearStats[year].episodeCount++;
    yearStats[year].songCount += ep.songs.length;
    for (const song of ep.songs) {
      yearStats[year].uniqueArtists.add(song.artist.toLowerCase());
    }
  }
  const yearSummary = Object.values(yearStats)
    .map(y => ({ ...y, uniqueArtists: y.uniqueArtists.size }))
    .sort((a, b) => a.year.localeCompare(b.year));

  return { artists, albums, songs, yearSummary };
}


// ── Write JSON files ────────────────────────────────────────────────────────

function writeJsonFiles(episodes, agg) {
  console.log('💾 Writing JSON data files...');
  mkdirSync(DATA_DIR, { recursive: true });

  const episodesData = episodes.map(p => ({
    ...p.episode,
    songCount: p.songs.length,
    songs: p.songs,
  }));
  writeFileSync(join(DATA_DIR, 'episodes.json'), JSON.stringify(episodesData, null, 2));
  console.log(`   ✓ episodes.json (${episodesData.length} episodes)`);

  writeFileSync(join(DATA_DIR, 'artists.json'), JSON.stringify(agg.artists, null, 2));
  console.log(`   ✓ artists.json (${agg.artists.length} artists)`);

  writeFileSync(join(DATA_DIR, 'albums.json'), JSON.stringify(agg.albums, null, 2));
  console.log(`   ✓ albums.json (${agg.albums.length} albums)`);

  writeFileSync(join(DATA_DIR, 'songs.json'), JSON.stringify(agg.songs, null, 2));
  console.log(`   ✓ songs.json (${agg.songs.length} songs)`);

  writeFileSync(join(DATA_DIR, 'years.json'), JSON.stringify(agg.yearSummary, null, 2));
  console.log(`   ✓ years.json (${agg.yearSummary.length} years)`);

  const overview = {
    lastUpdated: new Date().toISOString(),
    totalEpisodes: episodes.length,
    totalSongPlays: episodes.reduce((sum, ep) => sum + ep.songs.length, 0),
    uniqueArtists: agg.artists.length,
    uniqueAlbums: agg.albums.length,
    uniqueSongs: agg.songs.length,
    dateRange: {
      earliest: episodes[episodes.length - 1]?.episode.airDate,
      latest: episodes[0]?.episode.airDate,
    },
    topArtists: agg.artists.slice(0, 10).map(a => ({ name: a.name, plays: a.totalPlays })),
    topSongs: agg.songs.slice(0, 10).map(s => ({ artist: s.artist, song: s.songTitle, plays: s.totalPlays })),
    yearSummary: agg.yearSummary,
  };
  writeFileSync(join(DATA_DIR, 'overview.json'), JSON.stringify(overview, null, 2));
  console.log(`   ✓ overview.json`);
  writeStaticSnapshots(episodesData, DATA_DIR);
}


// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Through the Cracks — Data Ingestion');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // 1. Initialize BigQuery (if configured)
  const bqReady = await initBigQuery();
  if (bqReady) {
    console.log(`✅ BigQuery connected: ${GCP_PROJECT}.${BQ_DATASET}`);
  } else {
    console.log('📋 BigQuery: skipped (writing JSON files only)');
  }
  console.log('');

  // 2. Fetch all posts
  const rawPosts = await fetchAllPosts();
  console.log('');

  // 3. Parse all posts
  console.log('🔍 Parsing posts...');
  const parsed = [];
  let totalSongs = 0;
  let skippedPosts = 0;

  for (const post of rawPosts) {
    if (!post.title || !post.title.includes('Through The Cracks')) {
      skippedPosts++;
      continue;
    }

    const result = parsePost(post);
    if (result.songs.length === 0) {
      skippedPosts++;
      continue;
    }

    parsed.push(result);
    totalSongs += result.songs.length;
  }

  parsed.sort((a, b) => {
    if (!a.episode.airDate || !b.episode.airDate) return 0;
    return b.episode.airDate.localeCompare(a.episode.airDate);
  });

  console.log(`✅ Parsed ${parsed.length} episodes, ${totalSongs} song plays`);
  if (skippedPosts > 0) {
    console.log(`   (skipped ${skippedPosts} non-playlist posts)`);
  }
  console.log('');

  // 4. Build aggregations
  console.log('📊 Building aggregations...');
  const agg = buildAggregations(parsed);
  console.log(`   ${agg.artists.length} unique artists`);
  console.log(`   ${agg.albums.length} unique albums`);
  console.log(`   ${agg.songs.length} unique songs`);
  console.log('');

  // 5. Write to BigQuery
  if (bqReady) {
    await writeToBigQuery(parsed);
    console.log('');
  }

  // 6. Write JSON files (always, for local dev fallback)
  writeJsonFiles(parsed, agg);
  console.log('');

  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ Ingestion complete!');
  console.log('');
  console.log(`  📊 ${parsed.length} episodes | ${totalSongs} song plays`);
  console.log(`  🎤 ${agg.artists.length} artists | ${agg.albums.length} albums | ${agg.songs.length} songs`);
  const earliest = parsed[parsed.length - 1]?.episode.airDate;
  const latest = parsed[0]?.episode.airDate;
  console.log(`  📅 ${earliest} → ${latest}`);
  if (bqReady) {
    console.log(`  ☁️  BigQuery: ${GCP_PROJECT}.${BQ_DATASET}`);
  }
  console.log('');
  console.log('  Top 10 most played artists:');
  for (let i = 0; i < Math.min(10, agg.artists.length); i++) {
    const a = agg.artists[i];
    console.log(`  ${String(i + 1).padStart(3)}. ${a.name} (${a.totalPlays} plays)`);
  }
  console.log('');
  console.log('  Data written to: public/data/ + BigQuery');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
