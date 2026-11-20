// Pure Web-API-only D1 song_links upserts and rollup-backed random Playlist pool loader.
import { resolveCanonicalArtist } from '../scripts/artist-aliases.js';
import { clearD1Cache, qAll, qFirst, withCache } from './d1Rollups.js';
import { buildSongKey, buildSqliteSongKey, drawRandomPlaylist, parsePlaylistQuery } from './playlistBuilder.js';

const PLAYABLE_LINKS_SQL = `SELECT
  song_key,
  artist,
  song_title,
  video_id,
  COALESCE(yt_title, '') AS yt_title,
  COALESCE(yt_artist, '') AS yt_artist,
  duration_seconds,
  confidence_score,
  match_tier,
  is_embeddable,
  us_playable
FROM song_links
WHERE is_embeddable = 1
  AND us_playable = 1
  AND video_id IS NOT NULL
  AND LENGTH(TRIM(video_id)) > 0`;

const ROLLUP_STATS_SQL = `SELECT
  artist_key,
  song_key,
  artist,
  song_title,
  COALESCE(album, '') AS album,
  total_plays
FROM song_rollups`;

const RAW_PLAYS_STATS_SQL = `SELECT
  LOWER(TRIM(artist)) AS artist_key,
  LOWER(TRIM(song_title)) AS song_key,
  MIN(TRIM(artist)) AS artist,
  MIN(TRIM(song_title)) AS song_title,
  MAX(TRIM(COALESCE(album, ''))) AS album,
  COUNT(*) AS total_plays
FROM song_plays
GROUP BY LOWER(TRIM(artist)), LOWER(TRIM(song_title))`;

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

function setHigherPlayStat(map, key, row) {
  if (!key) return;
  const prev = map.get(key);
  if (!prev || Number(row.total_plays ?? 0) > Number(prev.total_plays ?? 0)) {
    map.set(key, row);
  }
}

function buildStatLookup(statRows) {
  const bySqliteKey = new Map();
  const byCanonicalKey = new Map();
  for (const row of statRows) {
    const ak = String(row.artist_key ?? '').trim();
    const sk = String(row.song_key ?? '').trim();
    if (ak || sk) setHigherPlayStat(bySqliteKey, `${ak}|||${sk}`, row);
    const artist = String(row.artist ?? '');
    const title = String(row.song_title ?? '');
    if (artist.trim() && title.trim()) {
      setHigherPlayStat(byCanonicalKey, buildSongKey(artist, title), row);
    }
  }
  return { bySqliteKey, byCanonicalKey };
}

function resolveStatForLink(link, { bySqliteKey, byCanonicalKey }) {
  const rawKey = String(link.song_key || '');
  const direct = bySqliteKey.get(rawKey);
  if (direct) return direct;

  let best = byCanonicalKey.get(rawKey) ?? null;
  const consider = (hit) => {
    if (hit && (!best || Number(hit.total_plays ?? 0) > Number(best.total_plays ?? 0))) {
      best = hit;
    }
  };
  for (const key of candidateSqliteKeysForRow(link)) {
    consider(bySqliteKey.get(key));
  }
  const artist = String(link.artist || '');
  const songTitle = String(link.song_title || '');
  if (artist.trim() && songTitle.trim()) {
    consider(byCanonicalKey.get(buildSongKey(artist, songTitle)));
  }
  return best;
}

export async function loadD1PlaylistPool(db) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  return withCache(db, 'playlist_pool', async () => {
    const useRollups = await hasPopulatedSongRollups(db);
    // Fetch playable links and rollup/play stats separately so SQLite never executes an O(N*M) concatenated-key join.
    const [linkRows, statRows] = await Promise.all([
      qAll(db, PLAYABLE_LINKS_SQL),
      qAll(db, useRollups ? ROLLUP_STATS_SQL : RAW_PLAYS_STATS_SQL),
    ]);
    const lookup = buildStatLookup(statRows);
    const merged = linkRows.map((r) => {
      const stat = resolveStatForLink(r, lookup);
      const statArtist = String(stat?.artist ?? '').trim();
      const statTitle = String(stat?.song_title ?? '').trim();
      return {
        songKey: String(r.song_key),
        artist: statArtist || String(r.artist || ''),
        songTitle: statTitle || String(r.song_title || ''),
        album: String(stat?.album ?? ''),
        totalPlays: Number(stat?.total_plays ?? 0),
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
      };
    });
    merged.sort(
      (a, b) =>
        b.totalPlays - a.totalPlays ||
        (a.songKey < b.songKey ? -1 : a.songKey > b.songKey ? 1 : 0),
    );
    return merged;
  });
}

export async function getD1RandomPlaylist(db, searchParams = {}) {
  if (!db) throw new Error('D1 database binding (DB) is not configured');
  const parsed = parsePlaylistQuery(searchParams);
  if (parsed.error) return parsed;
  const pool = await loadD1PlaylistPool(db);
  return drawRandomPlaylist(pool, searchParams);
}
