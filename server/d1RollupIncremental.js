// Incremental D1 episode diffing and per-artist rollup maintenance for low-write Blogger refreshes.
import { qAll, qFirst, refreshRollupCacheBlobs } from './d1Rollups.js';

export const CHUNK_SIZE = 40;
const MAX_BATCH_STATEMENTS = 96;

export function normalizeEpisodeNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

export function dedupeEpisodeItems(items) {
  const deduped = new Map();
  for (const item of items || []) {
    const ep = item?.episode ?? item;
    if (!ep) continue;
    const epId = String(ep.id);
    deduped.delete(epId);
    deduped.set(epId, item);
  }
  return Array.from(deduped.values());
}

function isEpisodeUnchanged(existing, existingSpins, ep, songs) {
  if (!existing) return false;
  const epMatches =
    (existing.title || '') === (ep.title || '') &&
    existing.air_date === ep.airDate &&
    (existing.day_of_week ?? null) === (ep.dayOfWeek ?? null) &&
    (existing.episode_number ?? null) === normalizeEpisodeNumber(ep.episodeNumber) &&
    (existing.published_at ?? null) === (ep.publishedAt || null) &&
    (existing.url ?? null) === (ep.url || null) &&
    Number(existing.song_count ?? 0) === songs.length;
  if (!epMatches || songs.length !== existingSpins.length) return false;

  const positions = new Set();
  for (const s of songs) {
    const pos = Number(s?.position);
    if (!Number.isFinite(pos) || positions.has(pos)) return false;
    positions.add(pos);
  }

  const sortedSongs = [...songs].sort((a, b) => Number(a.position) - Number(b.position));
  for (let idx = 0; idx < sortedSongs.length; idx += 1) {
    const spin = existingSpins[idx];
    const s = sortedSongs[idx];
    if (
      Number(spin.position) !== Number(s.position) ||
      spin.air_date !== ep.airDate ||
      (spin.artist || '') !== (s.artist || '') ||
      (spin.featured_artist || '') !== (s.featuredArtist || '') ||
      (spin.song_title || '') !== (s.songTitle || s.song || '') ||
      (spin.album || '') !== (s.album || '') ||
      (spin.release_kind || 'album') !== (s.releaseKind || 'album') ||
      (spin.raw_line || '') !== (s.rawLine || '')
    ) {
      return false;
    }
  }
  return true;
}

export async function filterChangedEpisodes(db, validItems) {
  const dedupedItems = dedupeEpisodeItems(validItems);
  if (dedupedItems.length === 0) {
    return { changedItems: [], episodesUnchanged: 0, oldArtistKeys: new Set() };
  }
  if (!(await qFirst(db, 'SELECT 1 AS ok FROM episodes LIMIT 1'))) {
    return { changedItems: dedupedItems, episodesUnchanged: 0, oldArtistKeys: new Set() };
  }

  const changedItems = [];
  const oldArtistKeys = new Set();
  let episodesUnchanged = 0;

  for (let i = 0; i < dedupedItems.length; i += CHUNK_SIZE) {
    const chunk = dedupedItems.slice(i, i + CHUNK_SIZE);
    const ids = chunk.map((item) => String((item?.episode ?? item).id));
    const ph = ids.map(() => '?').join(', ');
    const epRows = await qAll(
      db,
      `SELECT id, title, air_date, day_of_week, episode_number, published_at, url, song_count FROM episodes WHERE id IN (${ph})`,
      ids,
    );
    const existingById = new Map(epRows.map((row) => [String(row.id), row]));
    const existingIds = ids.filter((id) => existingById.has(id));
    const spinsByEpId = new Map();

    if (existingIds.length > 0) {
      const existingPh = existingIds.map(() => '?').join(', ');
      const spinRows = await qAll(
        db,
        `SELECT episode_id, air_date, position, artist, featured_artist, song_title, album, release_kind, raw_line, LOWER(TRIM(artist)) AS ak FROM song_plays WHERE episode_id IN (${existingPh}) ORDER BY episode_id ASC, position ASC`,
        existingIds,
      );
      for (const spin of spinRows) {
        const key = String(spin.episode_id);
        const list = spinsByEpId.get(key) || [];
        list.push(spin);
        spinsByEpId.set(key, list);
      }
    }

    for (const item of chunk) {
      const ep = item?.episode ?? item;
      const epId = String(ep.id);
      const songs = item?.songs ?? ep.songs ?? [];
      const existing = existingById.get(epId);
      const existingSpins = spinsByEpId.get(epId) || [];
      if (isEpisodeUnchanged(existing, existingSpins, ep, songs)) {
        episodesUnchanged += 1;
      } else {
        changedItems.push(item);
        for (const spin of existingSpins) oldArtistKeys.add(String(spin.ak ?? ''));
      }
    }
  }
  return { changedItems, episodesUnchanged, oldArtistKeys };
}

export async function collectEpisodeArtistKeys(db, episodeIds) {
  const keys = new Set();
  const ids = [...new Set((episodeIds || []).map((id) => String(id)))];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const ph = chunk.map(() => '?').join(', ');
    const rows = await qAll(db, `SELECT DISTINCT LOWER(TRIM(artist)) AS ak FROM song_plays WHERE episode_id IN (${ph})`, chunk);
    for (const row of rows) keys.add(String(row.ak ?? ''));
  }
  return keys;
}

function buildScopedArtistRollupInsertSql(ph) {
  return `WITH scoped_plays AS (
  SELECT artist, song_title, album, air_date FROM song_plays WHERE LOWER(TRIM(artist)) IN (${ph})
), base AS (
  SELECT LOWER(TRIM(artist)) AS artist_key, MIN(TRIM(artist)) AS name, COUNT(1) AS total_plays,
    COUNT(DISTINCT LOWER(TRIM(song_title))) AS unique_songs,
    COUNT(DISTINCT CASE WHEN LENGTH(TRIM(COALESCE(album, ''))) > 0 THEN LOWER(TRIM(album)) END) AS unique_albums,
    MIN(air_date) AS first_appearance, MAX(air_date) AS last_appearance
  FROM scoped_plays GROUP BY artist_key
), variant_counts AS (
  SELECT LOWER(TRIM(artist)) AS artist_key, TRIM(artist) AS variant_name,
    COUNT(1) AS cnt, MIN(NULLIF(air_date, '')) AS first_date
  FROM scoped_plays WHERE LENGTH(TRIM(artist)) > 0 GROUP BY artist_key, TRIM(artist)
), ranked_names AS (
  SELECT artist_key, variant_name,
    ROW_NUMBER() OVER (PARTITION BY artist_key ORDER BY cnt DESC, CASE WHEN COALESCE(first_date, '') = '' THEN 1 ELSE 0 END ASC, first_date ASC, variant_name ASC) AS rn
  FROM variant_counts
)
INSERT INTO artist_rollups (artist_key, name, profile_name, total_plays, rank, unique_songs, unique_albums, first_appearance, last_appearance)
SELECT b.artist_key, b.name, COALESCE(rn.variant_name, b.name, ''), b.total_plays, 1,
  b.unique_songs, b.unique_albums, COALESCE(b.first_appearance, ''), COALESCE(b.last_appearance, '')
FROM base b LEFT JOIN ranked_names rn ON rn.artist_key = b.artist_key AND rn.rn = 1`;
}

function buildScopedSongRollupInsertSql(ph) {
  return `WITH scoped_plays AS (
  SELECT artist, featured_artist, song_title, album, air_date FROM song_plays WHERE LOWER(TRIM(artist)) IN (${ph})
), song_base AS (
  SELECT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk,
    MIN(TRIM(artist)) AS artist, MIN(TRIM(song_title)) AS song_title,
    COUNT(1) AS total_plays, MIN(air_date) AS first_played, MAX(air_date) AS last_played
  FROM scoped_plays GROUP BY ak, sk
), album_counts AS (
  SELECT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, TRIM(album) AS album, COUNT(1) AS cnt
  FROM scoped_plays WHERE LENGTH(TRIM(COALESCE(album, ''))) > 0 GROUP BY ak, sk, TRIM(album)
), ranked_albums AS (
  SELECT ak, sk, album, ROW_NUMBER() OVER (PARTITION BY ak, sk ORDER BY cnt DESC, LOWER(album) ASC) AS rn FROM album_counts
), all_tok AS (
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(artist)) AS tok FROM scoped_plays WHERE LENGTH(TRIM(artist)) > 0
  UNION ALL SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(song_title)) AS tok FROM scoped_plays WHERE LENGTH(TRIM(song_title)) > 0
  UNION ALL SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(featured_artist)) AS tok FROM scoped_plays WHERE LENGTH(TRIM(COALESCE(featured_artist, ''))) > 0
  UNION ALL SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(album)) AS tok FROM scoped_plays WHERE LENGTH(TRIM(COALESCE(album, ''))) > 0
), search_agg AS (
  SELECT ak, sk, GROUP_CONCAT(tok, CHAR(31)) AS search_text FROM all_tok GROUP BY ak, sk
), song_tok AS (
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(song_title)) AS tok FROM scoped_plays WHERE LENGTH(TRIM(song_title)) > 0
  UNION ALL SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(featured_artist)) AS tok FROM scoped_plays WHERE LENGTH(TRIM(COALESCE(featured_artist, ''))) > 0
), song_search_agg AS (
  SELECT ak, sk, GROUP_CONCAT(tok, CHAR(31)) AS song_search_text FROM song_tok GROUP BY ak, sk
)
INSERT INTO song_rollups (artist_key, song_key, artist, song_title, album, total_plays, first_played, last_played, search_text, song_search_text)
SELECT sb.ak, sb.sk, sb.artist, sb.song_title, COALESCE(ra.album, ''),
  sb.total_plays, COALESCE(sb.first_played, ''), COALESCE(sb.last_played, ''),
  COALESCE(sa.search_text, ''), COALESCE(ssa.song_search_text, '')
FROM song_base sb
LEFT JOIN ranked_albums ra ON sb.ak = ra.ak AND sb.sk = ra.sk AND ra.rn = 1
LEFT JOIN search_agg sa ON sb.ak = sa.ak AND sb.sk = sa.sk
LEFT JOIN song_search_agg ssa ON sb.ak = ssa.ak AND sb.sk = ssa.sk`;
}

function buildScopedAlbumRollupInsertSql(ph) {
  return `INSERT INTO album_rollups (artist_key, album_key, artist, album, total_plays)
SELECT LOWER(TRIM(artist)) AS artist_key, LOWER(TRIM(album)) AS album_key,
  MIN(TRIM(artist)) AS artist, MIN(TRIM(album)) AS album, COUNT(1) AS total_plays
FROM song_plays
WHERE LOWER(TRIM(artist)) IN (${ph}) AND LENGTH(TRIM(COALESCE(album, ''))) > 0
GROUP BY artist_key, album_key`;
}

const SYNC_ARTIST_RANKS_SQL = `WITH computed_ranks AS (
  SELECT artist_key,
    COALESCE(CASE WHEN LENGTH(artist_key) > 0 THEN RANK() OVER (PARTITION BY CASE WHEN LENGTH(artist_key) > 0 THEN 1 ELSE 0 END ORDER BY total_plays DESC) ELSE NULL END, 1) AS new_rank
  FROM artist_rollups
)
UPDATE artist_rollups
SET rank = cr.new_rank
FROM computed_ranks cr
WHERE artist_rollups.artist_key = cr.artist_key
  AND artist_rollups.rank != cr.new_rank`;

export async function refreshD1RollupsIncremental(db, artistKeys, { now = new Date().toISOString() } = {}) {
  const uniqueKeys = [...new Set((artistKeys || []).filter((k) => k !== null && k !== undefined).map((k) => String(k)))];
  if (uniqueKeys.length === 0) return await refreshRollupCacheBlobs(db, { now });

  const stmts = [];
  for (let i = 0; i < uniqueKeys.length; i += CHUNK_SIZE) {
    const chunk = uniqueKeys.slice(i, i + CHUNK_SIZE);
    const ph = chunk.map(() => '?').join(', ');
    stmts.push(
      db.prepare(`DELETE FROM artist_rollups WHERE artist_key IN (${ph})`).bind(...chunk),
      db.prepare(buildScopedArtistRollupInsertSql(ph)).bind(...chunk),
      db.prepare(`DELETE FROM song_rollups WHERE artist_key IN (${ph})`).bind(...chunk),
      db.prepare(buildScopedSongRollupInsertSql(ph)).bind(...chunk),
      db.prepare(`DELETE FROM album_rollups WHERE artist_key IN (${ph})`).bind(...chunk),
      db.prepare(buildScopedAlbumRollupInsertSql(ph)).bind(...chunk),
    );
  }
  stmts.push(db.prepare(SYNC_ARTIST_RANKS_SQL));

  for (let i = 0; i < stmts.length; i += MAX_BATCH_STATEMENTS) {
    await db.batch(stmts.slice(i, i + MAX_BATCH_STATEMENTS));
  }
  return await refreshRollupCacheBlobs(db, { now });
}
