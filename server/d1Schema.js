// Cloudflare D1 schema DDL, idempotent episode/spin upserts, and Blogger-to-D1 ingestion pipeline.
import { computeIncrementalStartDate, fetchBloggerPosts, parsePost } from '../scripts/blogger-parser.js';

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
];

export const D1_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_episodes_air_date ON episodes(air_date DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_episode_pos ON song_plays(episode_id, position ASC)',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_air_date ON song_plays(air_date)',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_artist ON song_plays(artist)',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_artist_lower ON song_plays(LOWER(TRIM(artist)))',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_featured_lower ON song_plays(LOWER(featured_artist))',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_song_lower ON song_plays(LOWER(TRIM(song_title)))',
  'CREATE INDEX IF NOT EXISTS idx_song_plays_album_lower ON song_plays(LOWER(TRIM(album)))',
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
  await db.batch(D1_INDEX_STATEMENTS.map((sql) => db.prepare(sql)));
}

export async function upsertEpisodesIntoD1(
  db,
  episodesData,
  { now = new Date().toISOString(), batchSize = 250 } = {},
) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  const statements = [];
  let episodesUpserted = 0;
  let songPlaysUpserted = 0;
  let latestAirDate = null;

  for (const item of episodesData || []) {
    const ep = item?.episode ?? item;
    if (!ep || !/^\d{4}-\d{2}-\d{2}$/.test(ep.airDate || '')) continue;

    const epId = String(ep.id);
    const songs = item?.songs ?? ep.songs ?? [];
    episodesUpserted++;
    if (!latestAirDate || ep.airDate > latestAirDate) latestAirDate = ep.airDate;

    statements.push(db.prepare(DELETE_SONGS_SQL).bind(epId));
    statements.push(
      db.prepare(UPSERT_EPISODE_SQL).bind(
        epId,
        ep.title || '',
        ep.airDate,
        ep.dayOfWeek ?? null,
        ep.episodeNumber ?? null,
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

  return { episodesUpserted, songPlaysUpserted, latestAirDate };
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

  const { episodesUpserted, songPlaysUpserted, latestAirDate } = await upsertEpisodesIntoD1(db, parsed);
  return {
    mode: incremental ? 'incremental' : 'full',
    startDateIso,
    fetchedPosts: (rawPosts || []).length,
    episodesUpserted,
    songPlaysUpserted,
    latestAirDate,
  };
}
