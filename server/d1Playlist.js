// Pure Web-API-only D1 song_links upserts and rollup-backed random Playlist pool loader.
import { resolveCanonicalArtist } from '../scripts/artist-aliases.js';
import { clearD1Cache, qAll, qFirst, withCache } from './d1Rollups.js';
import { buildSongKey, buildSqliteSongKey, drawRandomPlaylist, parsePlaylistQuery } from './playlistBuilder.js';

const ROLLUP_LOOKUP_BATCH_SIZE = 50;

const ROLLUP_HYDRATE_SQL_PREFIX =
  "SELECT (artist_key || '|||' || song_key) AS rollup_key, album, total_plays FROM song_rollups WHERE (artist_key || '|||' || song_key) IN (";

const RAW_PLAYS_HYDRATE_SQL_PREFIX = `SELECT
  (LOWER(TRIM(artist)) || '|||' || LOWER(TRIM(song_title))) AS rollup_key,
  MAX(TRIM(COALESCE(album, ''))) AS album,
  COUNT(*) AS total_plays
FROM song_plays
WHERE (LOWER(TRIM(artist)) || '|||' || LOWER(TRIM(song_title))) IN (`;

export const UPSERT_SONG_LINK_SQL = `INSERT INTO song_links (
  song_key, artist, song_title, video_id, yt_title, yt_artist, yt_album,
  result_type, duration_seconds, confidence_score, match_tier,
  is_embeddable, us_playable, status_reason, checked_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(song_key) DO UPDATE SET
  artist = excluded.artist,
  song_title = excluded.song_title,
  video_id = excluded.video_id,
  yt_title = excluded.yt_title,
  yt_artist = excluded.yt_artist,
  yt_album = excluded.yt_album,
  result_type = excluded.result_type,
  duration_seconds = excluded.duration_seconds,
  confidence_score = excluded.confidence_score,
  match_tier = excluded.match_tier,
  is_embeddable = excluded.is_embeddable,
  us_playable = excluded.us_playable,
  status_reason = excluded.status_reason,
  checked_at = excluded.checked_at,
  updated_at = excluded.updated_at
WHERE song_links.match_tier != 'manual'`;

const ROLLUP_POOL_SQL = `SELECT
  sl.song_key,
  COALESCE(NULLIF(sr.artist, ''), sl.artist) AS artist,
  COALESCE(NULLIF(sr.song_title, ''), sl.song_title) AS song_title,
  COALESCE(sr.album, '') AS album,
  COALESCE(sr.total_plays, 0) AS total_plays,
  sl.video_id,
  COALESCE(sl.yt_title, '') AS yt_title,
  COALESCE(sl.yt_artist, '') AS yt_artist,
  sl.duration_seconds,
  sl.confidence_score,
  sl.match_tier,
  sl.is_embeddable,
  sl.us_playable
FROM song_links sl
LEFT JOIN song_rollups sr ON (sr.artist_key || '|||' || sr.song_key) = sl.song_key
WHERE sl.is_embeddable = 1
  AND sl.us_playable = 1
  AND sl.video_id IS NOT NULL
  AND LENGTH(TRIM(sl.video_id)) > 0
ORDER BY total_plays DESC, sl.song_key ASC`;

const RAW_PLAYS_POOL_SQL = `WITH play_stats AS (
  SELECT
    (LOWER(TRIM(artist)) || '|||' || LOWER(TRIM(song_title))) AS song_key,
    MIN(TRIM(artist)) AS artist,
    MIN(TRIM(song_title)) AS song_title,
    COUNT(*) AS total_plays,
    MAX(TRIM(COALESCE(album, ''))) AS album
  FROM song_plays
  GROUP BY LOWER(TRIM(artist)), LOWER(TRIM(song_title))
)
SELECT
  sl.song_key,
  COALESCE(NULLIF(ps.artist, ''), sl.artist) AS artist,
  COALESCE(NULLIF(ps.song_title, ''), sl.song_title) AS song_title,
  COALESCE(ps.album, '') AS album,
  COALESCE(ps.total_plays, 0) AS total_plays,
  sl.video_id,
  COALESCE(sl.yt_title, '') AS yt_title,
  COALESCE(sl.yt_artist, '') AS yt_artist,
  sl.duration_seconds,
  sl.confidence_score,
  sl.match_tier,
  sl.is_embeddable,
  sl.us_playable
FROM song_links sl
LEFT JOIN play_stats ps ON ps.song_key = sl.song_key
WHERE sl.is_embeddable = 1
  AND sl.us_playable = 1
  AND sl.video_id IS NOT NULL
  AND LENGTH(TRIM(sl.video_id)) > 0
ORDER BY total_plays DESC, sl.song_key ASC`;

function toBinaryFlag(val) {
  return val === true || val === 1 || val === '1' ? 1 : 0;
}

export async function upsertSongLink(db, link = {}) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  const artist = String(link.artist ?? '');
  const songTitle = String(link.songTitle ?? link.song_title ?? '');
  const rawKey = String(link.songKey ?? link.song_key ?? '').trim();
  const songKey = rawKey || buildSongKey(artist, songTitle);
  const videoId = link.videoId ?? link.video_id ?? null;
  const ytTitle = link.ytTitle ?? link.yt_title ?? null;
  const rawYtArtists = Array.isArray(link.ytArtists) ? link.ytArtists.join(', ') : null;
  const ytArtist = link.ytArtist ?? link.yt_artist ?? rawYtArtists;
  const ytAlbum = link.ytAlbum ?? link.yt_album ?? null;
  const resultType = link.resultType ?? link.result_type ?? null;
  const rawDuration = link.durationSeconds ?? link.duration_seconds;
  const parsedDuration =
    rawDuration === null || rawDuration === undefined || rawDuration === '' ? null : Number(rawDuration);
  const durationSeconds = Number.isFinite(parsedDuration) ? Math.trunc(parsedDuration) : null;
  const rawScore = Number(link.confidenceScore ?? link.confidence_score ?? 0);
  const confidenceScore = Number.isFinite(rawScore) ? Math.trunc(rawScore) : 0;
  const matchTier = String(link.matchTier ?? link.match_tier ?? 'unmatched');
  const isEmbeddable = toBinaryFlag(link.isEmbeddable ?? link.is_embeddable);
  const usPlayable = toBinaryFlag(link.usPlayable ?? link.us_playable);
  const statusReason = String(link.statusReason ?? link.status_reason ?? 'unchecked');
  const now = new Date().toISOString();
  const checkedAt = String(link.checkedAt ?? link.checked_at ?? now);
  const updatedAt = String(link.updatedAt ?? link.updated_at ?? now);

  const result = await db
    .prepare(UPSERT_SONG_LINK_SQL)
    .bind(
      songKey,
      artist,
      songTitle,
      videoId,
      ytTitle,
      ytArtist,
      ytAlbum,
      resultType,
      durationSeconds,
      confidenceScore,
      matchTier,
      isEmbeddable,
      usPlayable,
      statusReason,
      checkedAt,
      updatedAt,
    )
    .run();
  clearD1Cache(db);
  return result;
}

async function hasPopulatedSongRollups(db) {
  try {
    const row = await qFirst(db, 'SELECT 1 AS ok FROM song_rollups LIMIT 1');
    return Boolean(row);
  } catch (err) {
    if (/no such table/i.test(String(err?.message ?? err))) return false;
    throw err;
  }
}

function candidateSqliteKeysForRow(row) {
  const artist = String(row.artist || '');
  const songTitle = String(row.song_title || '');
  if (!artist.trim() || !songTitle.trim()) return [];
  const rowKey = String(row.song_key || '');
  const canonicalArtist = resolveCanonicalArtist(artist);
  const candidates = [
    buildSqliteSongKey(artist, songTitle),
    buildSqliteSongKey(canonicalArtist, songTitle),
  ];
  const unique = [];
  for (const key of candidates) {
    if (key && key !== rowKey && !unique.includes(key)) unique.push(key);
  }
  return unique;
}

async function hydrateMissedPlayCounts(db, rows, useRollups) {
  const zeroRows = [];
  const lookupKeys = new Set();

  for (const row of rows) {
    if (Number(row.total_plays ?? 0) !== 0) continue;
    const candidates = candidateSqliteKeysForRow(row);
    if (candidates.length === 0) continue;
    zeroRows.push({ row, candidates });
    for (const key of candidates) lookupKeys.add(key);
  }

  if (lookupKeys.size === 0) return false;

  const keys = [...lookupKeys];
  const rollupByKey = new Map();
  for (let i = 0; i < keys.length; i += ROLLUP_LOOKUP_BATCH_SIZE) {
    const chunk = keys.slice(i, i + ROLLUP_LOOKUP_BATCH_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const sql = useRollups
      ? `${ROLLUP_HYDRATE_SQL_PREFIX}${placeholders})`
      : `${RAW_PLAYS_HYDRATE_SQL_PREFIX}${placeholders})\nGROUP BY LOWER(TRIM(artist)), LOWER(TRIM(song_title))`;
    const matches = await qAll(db, sql, chunk);
    for (const match of matches) {
      if (match?.rollup_key) rollupByKey.set(String(match.rollup_key), match);
    }
  }

  let hydrated = false;
  for (const { row, candidates } of zeroRows) {
    let bestMatch = null;
    for (const key of candidates) {
      const hit = rollupByKey.get(key);
      if (hit && (!bestMatch || Number(hit.total_plays ?? 0) > Number(bestMatch.total_plays ?? 0))) {
        bestMatch = hit;
      }
    }
    if (!bestMatch) continue;
    row.total_plays = Number(bestMatch.total_plays ?? 0);
    row.album = String(bestMatch.album ?? row.album ?? '');
    hydrated = true;
  }
  return hydrated;
}

export async function loadD1PlaylistPool(db) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  return withCache(db, 'playlist_pool', async () => {
    const useRollups = await hasPopulatedSongRollups(db);
    const rows = await qAll(db, useRollups ? ROLLUP_POOL_SQL : RAW_PLAYS_POOL_SQL);
    const hydrated = await hydrateMissedPlayCounts(db, rows, useRollups);
    if (hydrated) {
      rows.sort(
        (a, b) =>
          Number(b.total_plays ?? 0) - Number(a.total_plays ?? 0) ||
          (String(a.song_key) < String(b.song_key) ? -1 : String(a.song_key) > String(b.song_key) ? 1 : 0),
      );
    }
    return rows.map((r) => ({
      songKey: String(r.song_key),
      artist: String(r.artist || ''),
      songTitle: String(r.song_title || ''),
      album: String(r.album || ''),
      totalPlays: Number(r.total_plays ?? 0),
      videoId: String(r.video_id || ''),
      ytTitle: String(r.yt_title || ''),
      ytArtist: String(r.yt_artist || ''),
      durationSeconds:
        r.duration_seconds === null || r.duration_seconds === undefined
          ? null
          : Number(r.duration_seconds),
      confidenceScore: Number(r.confidence_score ?? 0),
      matchTier: String(r.match_tier || 'unmatched'),
      isEmbeddable: Number(r.is_embeddable) === 1,
      usPlayable: Number(r.us_playable) === 1,
    }));
  });
}

export async function getD1RandomPlaylist(db, searchParams = {}) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  const parsed = parsePlaylistQuery(searchParams);
  if (parsed.error) return parsed;
  const pool = await loadD1PlaylistPool(db);
  return drawRandomPlaylist(pool, searchParams);
}
