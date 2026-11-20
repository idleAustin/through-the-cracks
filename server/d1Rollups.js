// Materialized D1 rollup rebuilds, chunked cache_blobs I/O, per-binding TTL cache, and rollup-backed readers.
import { buildArchiveYearAxis } from './artistProfileBuilder.js';
import { computeCappedPagination } from './routes/queryUtils.js';

export const MAX_BLOB_CHUNK_CHARS = 400_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const dbCache = new WeakMap();

export function clearD1Cache(db) {
  if (db) dbCache.delete(db);
}

export async function withCache(db, key, loader) {
  let store = dbCache.get(db);
  if (!store) {
    store = new Map();
    dbCache.set(db, store);
  }
  const hit = store.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  const value = await loader();
  if (store.size >= MAX_CACHE_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export const qAll = async (db, sql, params = []) => {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return (await stmt.all())?.results ?? [];
};

export const qFirst = async (db, sql, params = []) => {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return (await stmt.first()) ?? null;
};

export const stripControlChars = (s) => String(s ?? '').replace(/\p{Cc}/gu, '');
export const escapeLike = (s) => `%${String(s).slice(0, 120).replace(/[\\%_]/g, '\\$&')}%`;

export const mapEpisodeRow = (row) => ({
  id: String(row.id),
  air_date: row.air_date,
  airDate: row.air_date,
  song_count: Number(row.song_count ?? 0),
  songCount: Number(row.song_count ?? 0),
  url: row.url || null,
});

const REBUILD_ARTIST_ROLLUPS_SQL = `WITH base AS (
  SELECT LOWER(TRIM(artist)) AS artist_key, MIN(TRIM(artist)) AS name, COUNT(1) AS total_plays,
    COUNT(DISTINCT LOWER(TRIM(song_title))) AS unique_songs,
    COUNT(DISTINCT CASE WHEN LENGTH(TRIM(COALESCE(album, ''))) > 0 THEN LOWER(TRIM(album)) END) AS unique_albums,
    MIN(air_date) AS first_appearance, MAX(air_date) AS last_appearance
  FROM song_plays GROUP BY artist_key
), variant_counts AS (
  SELECT LOWER(TRIM(artist)) AS artist_key, TRIM(artist) AS variant_name,
    COUNT(1) AS cnt, MIN(NULLIF(air_date, '')) AS first_date
  FROM song_plays WHERE LENGTH(TRIM(artist)) > 0 GROUP BY artist_key, TRIM(artist)
), ranked_names AS (
  SELECT artist_key, variant_name,
    ROW_NUMBER() OVER (PARTITION BY artist_key ORDER BY cnt DESC, CASE WHEN COALESCE(first_date, '') = '' THEN 1 ELSE 0 END ASC, first_date ASC, variant_name ASC) AS rn
  FROM variant_counts
)
INSERT INTO artist_rollups (artist_key, name, profile_name, total_plays, rank, unique_songs, unique_albums, first_appearance, last_appearance)
SELECT b.artist_key, b.name, COALESCE(rn.variant_name, b.name, ''), b.total_plays,
  COALESCE(CASE WHEN LENGTH(b.artist_key) > 0 THEN RANK() OVER (PARTITION BY CASE WHEN LENGTH(b.artist_key) > 0 THEN 1 ELSE 0 END ORDER BY b.total_plays DESC) ELSE NULL END, 1) AS rank,
  b.unique_songs, b.unique_albums, COALESCE(b.first_appearance, ''), COALESCE(b.last_appearance, '')
FROM base b LEFT JOIN ranked_names rn ON rn.artist_key = b.artist_key AND rn.rn = 1`;

const REBUILD_SONG_ROLLUPS_SQL = `WITH song_base AS (
  SELECT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk,
    MIN(TRIM(artist)) AS artist, MIN(TRIM(song_title)) AS song_title,
    COUNT(1) AS total_plays, MIN(air_date) AS first_played, MAX(air_date) AS last_played
  FROM song_plays GROUP BY ak, sk
), album_counts AS (
  SELECT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, TRIM(album) AS album, COUNT(1) AS cnt
  FROM song_plays WHERE LENGTH(TRIM(COALESCE(album, ''))) > 0 GROUP BY ak, sk, TRIM(album)
), ranked_albums AS (
  SELECT ak, sk, album, ROW_NUMBER() OVER (PARTITION BY ak, sk ORDER BY cnt DESC, LOWER(album) ASC) AS rn
  FROM album_counts
), all_tok AS (
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(artist)) AS tok FROM song_plays WHERE LENGTH(TRIM(artist)) > 0
  UNION ALL
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(song_title)) AS tok FROM song_plays WHERE LENGTH(TRIM(song_title)) > 0
  UNION ALL
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(featured_artist)) AS tok FROM song_plays WHERE LENGTH(TRIM(COALESCE(featured_artist, ''))) > 0
  UNION ALL
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(album)) AS tok FROM song_plays WHERE LENGTH(TRIM(COALESCE(album, ''))) > 0
), search_agg AS (
  SELECT ak, sk, GROUP_CONCAT(tok, CHAR(31)) AS search_text FROM all_tok GROUP BY ak, sk
), song_tok AS (
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(song_title)) AS tok FROM song_plays WHERE LENGTH(TRIM(song_title)) > 0
  UNION ALL
  SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk, LOWER(TRIM(featured_artist)) AS tok FROM song_plays WHERE LENGTH(TRIM(COALESCE(featured_artist, ''))) > 0
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

const REBUILD_ALBUM_ROLLUPS_SQL = `INSERT INTO album_rollups (artist_key, album_key, artist, album, total_plays)
SELECT LOWER(TRIM(artist)) AS artist_key, LOWER(TRIM(album)) AS album_key,
  MIN(TRIM(artist)) AS artist, MIN(TRIM(album)) AS album, COUNT(1) AS total_plays
FROM song_plays WHERE LENGTH(TRIM(COALESCE(album, ''))) > 0 GROUP BY artist_key, album_key`;

export const ROLLUP_REBUILD_SQL = [
  'DELETE FROM artist_rollups',
  REBUILD_ARTIST_ROLLUPS_SQL,
  'DELETE FROM song_rollups',
  REBUILD_SONG_ROLLUPS_SQL,
  'DELETE FROM album_rollups',
  REBUILD_ALBUM_ROLLUPS_SQL,
];

export async function writeCacheBlob(db, key, value, { updatedAt = new Date().toISOString() } = {}) {
  const json = JSON.stringify(value);
  const chunks = [];
  for (let i = 0; i < json.length; i += MAX_BLOB_CHUNK_CHARS) {
    chunks.push(json.slice(i, i + MAX_BLOB_CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('');
  const stmts = [
    db.prepare('DELETE FROM cache_blobs WHERE blob_key = ?').bind(key),
    ...chunks.map((chunk, idx) =>
      db.prepare('INSERT INTO cache_blobs (blob_key, chunk_index, payload, updated_at) VALUES (?, ?, ?, ?)').bind(key, idx, chunk, updatedAt),
    ),
  ];
  await db.batch(stmts);
}

export async function readCacheBlob(db, key) {
  try {
    const rows = await qAll(db, 'SELECT payload FROM cache_blobs WHERE blob_key = ? ORDER BY chunk_index ASC', [key]);
    if (!rows || rows.length === 0) return null;
    const raw = rows.map((r) => String(r.payload ?? '')).join('');
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (/no such table/i.test(String(err?.message ?? err))) return null;
    throw err;
  }
}

export async function refreshRollupCacheBlobs(db, { now = new Date().toISOString() } = {}) {
  const [epStats, latestRow, rollupStats, topArtists, topSongs, yearRows] = await Promise.all([
    qFirst(db, 'SELECT COUNT(1) AS total_episodes, MIN(air_date) AS earliest_date, MAX(air_date) AS latest_date FROM episodes'),
    qFirst(db, 'SELECT id FROM episodes ORDER BY air_date DESC, id DESC LIMIT 1'),
    qFirst(db, `SELECT
      COALESCE((SELECT SUM(total_plays) FROM artist_rollups), 0) AS total_song_plays,
      (SELECT COUNT(1) FROM artist_rollups) AS unique_artists,
      (SELECT COUNT(1) FROM artist_rollups WHERE LENGTH(artist_key) > 0) AS ranked_artists,
      (SELECT COUNT(1) FROM album_rollups) AS unique_albums,
      (SELECT COUNT(1) FROM song_rollups) AS unique_songs,
      (SELECT COUNT(1) FROM artist_rollups WHERE total_plays = 1) AS one_spin_artists,
      (SELECT COUNT(1) FROM song_rollups WHERE total_plays = 1) AS one_spin_songs`),
    qAll(db, 'SELECT name, total_plays AS plays FROM artist_rollups ORDER BY total_plays DESC, LOWER(name) ASC LIMIT 10'),
    qAll(db, 'SELECT artist, song_title AS song, album, total_plays AS plays FROM song_rollups ORDER BY total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC LIMIT 10'),
    qAll(db, 'SELECT CAST(SUBSTR(air_date, 1, 4) AS INTEGER) AS year, COUNT(1) AS spins FROM song_plays GROUP BY year ORDER BY year ASC'),
  ]);

  const earliest = epStats?.earliest_date ?? null;
  const latest = epStats?.latest_date ?? null;
  const overview = {
    totalEpisodes: Number(epStats?.total_episodes ?? 0),
    totalSongPlays: Number(rollupStats?.total_song_plays ?? 0),
    uniqueArtists: Number(rollupStats?.unique_artists ?? 0),
    uniqueAlbums: Number(rollupStats?.unique_albums ?? 0),
    uniqueSongs: Number(rollupStats?.unique_songs ?? 0),
    latestEpisodeId: latestRow?.id ? String(latestRow.id) : null,
    oneSpinArtists: Number(rollupStats?.one_spin_artists ?? 0),
    oneSpinSongs: Number(rollupStats?.one_spin_songs ?? 0),
    dateRange: { earliest, latest },
    topArtists: topArtists.map((r) => ({ name: r.name, plays: Number(r.plays) })),
    topSongs: topSongs.map((r) => ({ artist: r.artist, song: r.song, album: r.album || '', plays: Number(r.plays) })),
  };

  const parsedMax = latest ? Number(String(latest).slice(0, 4)) : 2026;
  const maxYear = Math.max(2026, Number.isFinite(parsedMax) ? parsedMax : 2026);
  const years = Array.from({ length: maxYear - 2013 + 1 }, (_, i) => 2013 + i);
  const yearCounts = new Map(yearRows.map((r) => [Number(r.year), Number(r.spins)]));
  const yearSpinsArchive = {
    years,
    spins: years.map((y) => yearCounts.get(y) ?? 0),
    profileYears: buildArchiveYearAxis(yearRows, 'year', { earliest, latest }),
    rankedArtists: Number(rollupStats?.ranked_artists ?? 0),
  };

  await writeCacheBlob(db, 'overview', overview, { updatedAt: now });
  await writeCacheBlob(db, 'year_spins_archive', yearSpinsArchive, { updatedAt: now });
  clearD1Cache(db);
  return { overview, yearSpinsArchive };
}

export async function rebuildD1Rollups(db, { now = new Date().toISOString() } = {}) {
  await db.batch(ROLLUP_REBUILD_SQL.map((sql) => db.prepare(sql)));
  return await refreshRollupCacheBlobs(db, { now });
}

export async function getRollupOverview(db) {
  return readCacheBlob(db, 'overview');
}

export async function getRollupYearSpins(db, { artist = '', song = '' } = {}) {
  const archive = await readCacheBlob(db, 'year_spins_archive');
  if (!archive) return null;
  if (!artist && !song) {
    return { years: archive.years, spins: archive.spins, scope: 'archive', artist: null, song: null };
  }
  const conds = [];
  const params = [];
  if (artist) { conds.push('LOWER(TRIM(artist)) = ?'); params.push(artist.toLowerCase()); }
  if (song) { conds.push('LOWER(TRIM(song_title)) = ?'); params.push(song.toLowerCase()); }
  const rows = await qAll(
    db,
    `SELECT CAST(SUBSTR(air_date, 1, 4) AS INTEGER) AS year, COUNT(1) AS spins FROM song_plays WHERE ${conds.join(' AND ')} GROUP BY year ORDER BY year ASC`,
    params,
  );
  const counts = new Map(rows.map((r) => [Number(r.year), Number(r.spins)]));
  return {
    years: archive.years,
    spins: archive.years.map((y) => counts.get(y) ?? 0),
    scope: song ? 'song' : artist ? 'artist' : 'archive',
    artist: artist || null,
    song: song || null,
  };
}

export async function getRollupEpisodes(db, { year = '', song = '', artist = '', page = 1, limit = 20, offset = 0 } = {}) {
  const ov = await getRollupOverview(db);
  if (!ov) return null;
  const conds = [];
  const spConds = [];
  const params = [];
  if (year) { conds.push('SUBSTR(e.air_date, 1, 4) = ?'); params.push(year); }
  if (song) { spConds.push('LOWER(TRIM(sp.song_title)) = ?'); params.push(song); }
  if (artist) { spConds.push('LOWER(TRIM(sp.artist)) = ?'); params.push(artist); }
  if (spConds.length) conds.push(`e.id IN (SELECT DISTINCT sp.episode_id FROM song_plays sp WHERE ${spConds.join(' AND ')})`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = await qAll(
    db,
    `SELECT e.id, e.air_date, e.url, e.song_count FROM episodes e ${where} ORDER BY e.air_date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  let total = Number(ov.totalEpisodes ?? 0);
  if (where) {
    const countRow = await qFirst(db, `SELECT COUNT(1) AS total FROM episodes e ${where}`, params);
    total = Number(countRow?.total ?? 0);
  }
  const items = rows.map(mapEpisodeRow);
  return { items, episodes: items, total, page, limit, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function runRollupCatalog({ db, table, searchCol, search, orderBy, cols, unfilteredTotal, mapRow, resultKey, cap, page, limit }) {
  const cleanSearch = stripControlChars(search).trim().toLowerCase();
  const where = cleanSearch ? `WHERE ${searchCol} LIKE ? ESCAPE '\\'` : '';
  const params = cleanSearch ? [escapeLike(cleanSearch)] : [];
  let rawTotal = unfilteredTotal;
  if (cleanSearch) {
    const countRow = await qFirst(db, `SELECT COUNT(1) AS total FROM ${table} ${where}`, params);
    rawTotal = Number(countRow?.total ?? 0);
  }
  const { total, effectiveLimit, offset, totalPages } = computeCappedPagination({ rawTotal, cap, page, limit });
  const rows = effectiveLimit > 0
    ? await qAll(db, `SELECT ${cols} FROM ${table} ${where} ${orderBy} LIMIT ? OFFSET ?`, [...params, effectiveLimit, offset])
    : [];
  const items = rows.map(mapRow);
  return { items, [resultKey]: items, total, unboundedTotal: rawTotal, page, limit, pagination: { page, limit, total, totalPages } };
}

export async function getRollupArtists(db, { search = '', sort = 'top', cap = null, page = 1, limit = 25 } = {}) {
  const ov = await getRollupOverview(db);
  if (!ov) return null;
  return runRollupCatalog({
    db, table: 'artist_rollups', searchCol: 'artist_key', search, cap, page, limit, resultKey: 'artists',
    unfilteredTotal: Number(ov.uniqueArtists ?? 0),
    orderBy: sort === 'obscure' ? 'ORDER BY total_plays ASC, first_appearance ASC, LOWER(name) ASC' : 'ORDER BY total_plays DESC, LOWER(name) ASC',
    cols: 'name, total_plays, unique_songs, unique_albums, first_appearance, last_appearance',
    mapRow: (r) => ({
      name: r.name, totalPlays: Number(r.total_plays), uniqueSongs: Number(r.unique_songs),
      uniqueAlbums: Number(r.unique_albums), firstAppearance: r.first_appearance || '', lastAppearance: r.last_appearance || '',
    }),
  });
}

export async function getRollupSongs(db, { search = '', sort = 'top', cap = null, page = 1, limit = 25 } = {}) {
  const ov = await getRollupOverview(db);
  if (!ov) return null;
  return runRollupCatalog({
    db, table: 'song_rollups', searchCol: 'search_text', search, cap, page, limit, resultKey: 'songs',
    unfilteredTotal: Number(ov.uniqueSongs ?? 0),
    orderBy: sort === 'obscure' ? 'ORDER BY total_plays ASC, first_played ASC, LOWER(song_title) ASC, LOWER(artist) ASC' : 'ORDER BY total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC',
    cols: 'artist, song_title, album, total_plays, first_played, last_played',
    mapRow: (r) => ({
      artist: r.artist, songTitle: r.song_title, album: r.album || '',
      totalPlays: Number(r.total_plays), firstPlayed: r.first_played || '', lastPlayed: r.last_played || '',
    }),
  });
}

export async function getRollupSearch(db, { q = '' } = {}) {
  const ov = await getRollupOverview(db);
  if (!ov) return null;
  const cleanQ = stripControlChars(q).trim().slice(0, 120).toLowerCase();
  if (!cleanQ || cleanQ.length < 2) return { artists: [], songs: [], albums: [] };
  const like = escapeLike(cleanQ);
  const [artists, songs, albums] = await Promise.all([
    qAll(db, "SELECT name, total_plays AS plays, unique_songs FROM artist_rollups WHERE artist_key LIKE ? ESCAPE '\\' ORDER BY total_plays DESC, LOWER(name) ASC LIMIT 10", [like]),
    qAll(db, "SELECT artist, song_title, album, total_plays AS plays FROM song_rollups WHERE song_search_text LIKE ? ESCAPE '\\' ORDER BY total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC LIMIT 10", [like]),
    qAll(db, "SELECT artist, album, total_plays AS plays FROM album_rollups WHERE album_key LIKE ? ESCAPE '\\' ORDER BY total_plays DESC, LOWER(artist) ASC, LOWER(album) ASC LIMIT 10", [like]),
  ]);
  return {
    artists: artists.map((r) => ({ name: r.name, plays: Number(r.plays), uniqueSongs: Number(r.unique_songs ?? 0) })),
    songs: songs.map((r) => ({ artist: r.artist, songTitle: r.song_title, album: r.album || '', plays: Number(r.plays) })),
    albums: albums.map((r) => ({ artist: r.artist, album: r.album, plays: Number(r.plays) })),
  };
}

export async function getRollupArtistProfileMeta(db, key) {
  const [ov, yearArchive] = await Promise.all([
    readCacheBlob(db, 'overview'),
    readCacheBlob(db, 'year_spins_archive'),
  ]);
  if (!ov || !yearArchive) return null;

  const [rankRow, coRows] = await Promise.all([
    qFirst(db, 'SELECT rank FROM artist_rollups WHERE artist_key = ?', [key]),
    qAll(
      db,
      `WITH artist_eps AS (
        SELECT DISTINCT episode_id FROM song_plays WHERE LOWER(TRIM(artist)) = ?
      ), co_counts AS (
        SELECT LOWER(TRIM(sp.artist)) AS ak, COUNT(DISTINCT sp.episode_id) AS shared_episodes
        FROM artist_eps ae JOIN song_plays sp ON sp.episode_id = ae.episode_id
        WHERE LOWER(TRIM(sp.artist)) != ? AND LENGTH(TRIM(sp.artist)) > 0
        GROUP BY ak
      )
      SELECT ar.profile_name AS name, cc.shared_episodes, ar.rank
      FROM co_counts cc JOIN artist_rollups ar ON cc.ak = ar.artist_key`,
      [key, key],
    ),
  ]);
  if (!rankRow) return null;

  return {
    rank: Number(rankRow.rank),
    totalArtists: Number(yearArchive.rankedArtists ?? 0),
    archive: {
      totalSpins: Number(ov.totalSongPlays ?? 0),
      totalEpisodes: Number(ov.totalEpisodes ?? 0),
      dateRange: { earliest: ov.dateRange?.earliest ?? null, latest: ov.dateRange?.latest ?? null },
      years: yearArchive.profileYears || [],
    },
    coOccurrences: coRows.map((r) => ({ name: r.name, sharedEpisodes: Number(r.shared_episodes), rank: Number(r.rank) })),
  };
}
