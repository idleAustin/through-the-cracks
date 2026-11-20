// Cloudflare D1 schema DDL, idempotent episode/spin upserts, and Blogger-to-D1 ingestion pipeline.
import { computeIncrementalStartDate, fetchBloggerPosts, parsePost } from '../scripts/blogger-parser.js';
import { readCacheBlob, rebuildD1Rollups } from './d1Rollups.js';
import {
  collectEpisodeArtistKeys,
  dedupeEpisodeItems,
  filterChangedEpisodes,
  normalizeEpisodeNumber,
  refreshD1RollupsIncremental,
} from './d1RollupIncremental.js';

export const D1_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    air_date TEXT NOT NULL,
    day_of_week TEXT,
    episode_number INTEGER,
    published_at TEXT,
    url TEXT,
    song_count INTEGER NOT NULL DEFAULT 0,
    ingested_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS song_plays (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    air_date TEXT NOT NULL,
    position INTEGER NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    featured_artist TEXT NOT NULL DEFAULT '',
    song_title TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    release_kind TEXT NOT NULL DEFAULT 'album',
    raw_line TEXT NOT NULL DEFAULT '',
    ingested_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cache_blobs (
    blob_key TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (blob_key, chunk_index)
  )`,
  `CREATE TABLE IF NOT EXISTS artist_rollups (
    artist_key TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    profile_name TEXT NOT NULL DEFAULT '',
    total_plays INTEGER NOT NULL DEFAULT 0,
    rank INTEGER NOT NULL DEFAULT 1,
    unique_songs INTEGER NOT NULL DEFAULT 0,
    unique_albums INTEGER NOT NULL DEFAULT 0,
    first_appearance TEXT NOT NULL DEFAULT '',
    last_appearance TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS song_rollups (
    artist_key TEXT NOT NULL,
    song_key TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    song_title TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    total_plays INTEGER NOT NULL DEFAULT 0,
    first_played TEXT NOT NULL DEFAULT '',
    last_played TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL DEFAULT '',
    song_search_text TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (artist_key, song_key)
  )`,
  `CREATE TABLE IF NOT EXISTS album_rollups (
    artist_key TEXT NOT NULL,
    album_key TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    total_plays INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (artist_key, album_key)
  )`,
  `CREATE TABLE IF NOT EXISTS song_links (
    song_key TEXT PRIMARY KEY,
    artist TEXT NOT NULL,
    song_title TEXT NOT NULL,
    video_id TEXT,
    yt_title TEXT,
    yt_artist TEXT,
    yt_album TEXT,
    result_type TEXT,
    duration_seconds INTEGER,
    confidence_score INTEGER NOT NULL DEFAULT 0,
    match_tier TEXT NOT NULL DEFAULT 'unmatched',
    is_embeddable INTEGER NOT NULL DEFAULT 0,
    us_playable INTEGER NOT NULL DEFAULT 0,
    status_reason TEXT NOT NULL DEFAULT 'unchecked',
    checked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export const D1_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_episodes_air_date ON episodes(air_date DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_episode_pos ON song_plays(episode_id, position ASC)',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_air_date ON song_plays(air_date)',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_artist_lower ON song_plays(LOWER(TRIM(artist)))',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_song_lower ON song_plays(LOWER(TRIM(song_title)))',
  'CREATE INDEX IF NOT EXISTS idx_artist_rollups_top ON artist_rollups(total_plays DESC, LOWER(name) ASC)',
  'CREATE INDEX IF NOT EXISTS idx_artist_rollups_obscure ON artist_rollups(total_plays ASC, first_appearance ASC, LOWER(name) ASC)',
  'CREATE INDEX IF NOT EXISTS idx_song_rollups_top ON song_rollups(total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC)',
  'CREATE INDEX IF NOT EXISTS idx_song_rollups_obscure ON song_rollups(total_plays ASC, first_played ASC, LOWER(song_title) ASC, LOWER(artist) ASC)',
  'CREATE INDEX IF NOT EXISTS idx_album_rollups_plays ON album_rollups(total_plays DESC, LOWER(artist) ASC, LOWER(album) ASC)',
  'CREATE INDEX IF NOT EXISTS idx_song_links_random_pool ON song_links(is_embeddable, us_playable, confidence_score DESC)',
  'CREATE INDEX IF NOT EXISTS idx_song_links_tier ON song_links(match_tier)',
];

export const LEGACY_DROP_INDEX_STATEMENTS = [
  'DROP INDEX IF EXISTS idx_song_plays_artist',
  'DROP INDEX IF EXISTS idx_song_plays_featured_lower',
  'DROP INDEX IF EXISTS idx_song_plays_album_lower',
];

export const D1_SCHEMA_STATEMENTS = [...D1_TABLE_STATEMENTS, ...D1_INDEX_STATEMENTS];
export const DDL_STATEMENTS = D1_SCHEMA_STATEMENTS;

const DELETE_SONGS_SQL = 'DELETE FROM song_plays WHERE episode_id = ?';
const UPSERT_EPISODE_SQL =
  'INSERT OR REPLACE INTO episodes (id, title, air_date, day_of_week, episode_number, published_at, url, song_count, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const UPSERT_SONG_SQL =
  'INSERT OR REPLACE INTO song_plays (id, episode_id, air_date, position, artist, featured_artist, song_title, album, release_kind, raw_line, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

export async function ensureD1Schema(db) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  await db.batch(D1_TABLE_STATEMENTS.map((sql) => db.prepare(sql)));
  const info = await db.prepare('PRAGMA table_info(song_plays)').all();
  const cols = new Set((info?.results || []).map((row) => row.name));
  if (cols.size > 0) {
    const alters = [];
    if (!cols.has('featured_artist')) {
      alters.push(db.prepare("ALTER TABLE song_plays ADD COLUMN featured_artist TEXT NOT NULL DEFAULT ''"));
    }
    if (!cols.has('release_kind')) {
      alters.push(db.prepare("ALTER TABLE song_plays ADD COLUMN release_kind TEXT NOT NULL DEFAULT 'album'"));
    }
    if (alters.length > 0) await db.batch(alters);
  }
  await db.batch(LEGACY_DROP_INDEX_STATEMENTS.map((sql) => db.prepare(sql)));
  await db.batch(D1_INDEX_STATEMENTS.map((sql) => db.prepare(sql)));
}

export async function upsertEpisodesIntoD1(
  db,
  episodesData,
  { now = new Date().toISOString(), batchSize = 250, skipUnchanged = true } = {},
) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  const validItems = [];
  for (const item of episodesData || []) {
    const ep = item?.episode ?? item;
    if (!ep || !/^\d{4}-\d{2}-\d{2}$/.test(ep.airDate || '')) continue;
    validItems.push(item);
  }

  const { changedItems, episodesUnchanged, oldArtistKeys } =
    skipUnchanged !== false
      ? await filterChangedEpisodes(db, validItems)
      : { changedItems: dedupeEpisodeItems(validItems), episodesUnchanged: 0, oldArtistKeys: new Set() };

  const statements = [];
  const changedEpisodeIds = [];
  let episodesUpserted = 0;
  let songPlaysUpserted = 0;
  let latestAirDate = null;

  for (const item of changedItems) {
    const ep = item?.episode ?? item;
    const epId = String(ep.id);
    const songs = item?.songs ?? ep.songs ?? [];
    episodesUpserted++;
    changedEpisodeIds.push(epId);
    if (!latestAirDate || ep.airDate > latestAirDate) latestAirDate = ep.airDate;

    statements.push(db.prepare(DELETE_SONGS_SQL).bind(epId));
    statements.push(
      db.prepare(UPSERT_EPISODE_SQL).bind(
        epId,
        ep.title || '',
        ep.airDate,
        ep.dayOfWeek ?? null,
        normalizeEpisodeNumber(ep.episodeNumber),
        ep.publishedAt || null,
        ep.url || null,
        songs.length,
        now,
      ),
    );

    for (const song of songs) {
      const pos = Number(song.position);
      songPlaysUpserted++;
      statements.push(
        db.prepare(UPSERT_SONG_SQL).bind(
          `${epId}_${pos}`,
          epId,
          ep.airDate,
          pos,
          song.artist || '',
          song.featuredArtist || '',
          song.songTitle || song.song || '',
          song.album || '',
          song.releaseKind || 'album',
          song.rawLine || '',
          now,
        ),
      );
    }
  }

  for (let i = 0; i < statements.length; i += batchSize) {
    await db.batch(statements.slice(i, i + batchSize));
  }

  if (episodesUpserted > 0) {
    const hasRollups = (await readCacheBlob(db, 'overview')) !== null;
    if (!hasRollups) {
      await rebuildD1Rollups(db, { now });
    } else {
      const newArtistKeys = await collectEpisodeArtistKeys(db, changedEpisodeIds);
      const affectedKeys = [...new Set([...oldArtistKeys, ...newArtistKeys])];
      if (affectedKeys.length > 200) {
        await rebuildD1Rollups(db, { now });
      } else {
        await refreshD1RollupsIncremental(db, affectedKeys, { now });
      }
    }
  }

  return { episodesUpserted, episodesUnchanged, songPlaysUpserted, latestAirDate };
}

export async function ingestBloggerToD1({
  db,
  blogId = '3469042462299367694',
  apiKey = '',
  incremental = true,
  lookbackDays = 14,
  fetcher = fetchBloggerPosts,
} = {}) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  await ensureD1Schema(db);

  let startDateIso = null;
  if (incremental) {
    const row = await db.prepare('SELECT MAX(air_date) AS latest_date FROM episodes').first();
    startDateIso = row?.latest_date
      ? computeIncrementalStartDate([{ airDate: row.latest_date }], lookbackDays)
      : null;
  }

  const rawPosts = await fetcher({ blogId, apiKey, startDateIso });
  const parsed = [];
  for (const post of rawPosts || []) {
    if (!post?.title?.toLowerCase().includes('through the cracks')) continue;
    const result = parsePost(post);
    if (result.songs.length > 0) parsed.push(result);
  }

  const { episodesUpserted, episodesUnchanged, songPlaysUpserted, latestAirDate } = await upsertEpisodesIntoD1(db, parsed);
  if (episodesUpserted === 0 && (await readCacheBlob(db, 'overview')) === null) {
    const row = await db.prepare('SELECT COUNT(1) AS cnt FROM episodes').first();
    if (Number(row?.cnt ?? 0) > 0) {
      await rebuildD1Rollups(db);
    }
  }
  return {
    mode: incremental ? 'incremental' : 'full',
    startDateIso,
    fetchedPosts: (rawPosts || []).length,
    episodesUpserted,
    episodesUnchanged,
    songPlaysUpserted,
    latestAirDate,
  };
}
