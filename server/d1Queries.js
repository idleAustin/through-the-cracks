// Cloudflare D1 read-only SQL query layer with per-binding TTL cache and static-snapshot parity.
import { computeCappedPagination, parseCapParam, parsePageParams, parseSortParam } from './routes/queryUtils.js';

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

const escapeLike = (s) => `%${String(s).slice(0, 120).replace(/[\\%_]/g, '\\$&')}%`;

const mapEpisodeRow = (row) => ({
  id: String(row.id),
  air_date: row.air_date,
  airDate: row.air_date,
  song_count: Number(row.song_count ?? 0),
  songCount: Number(row.song_count ?? 0),
  url: row.url || null,
});

export async function getD1Overview(db) {
  return withCache(db, 'overview', async () => {
    const statsSql = `SELECT
      (SELECT COUNT(1) FROM episodes) AS total_episodes,
      (SELECT COUNT(1) FROM song_plays) AS total_song_plays,
      (SELECT COUNT(DISTINCT LOWER(TRIM(artist))) FROM song_plays) AS unique_artists,
      (SELECT COUNT(DISTINCT CASE WHEN LENGTH(TRIM(COALESCE(album, ''))) > 0 THEN (LOWER(TRIM(artist)) || '|||' || LOWER(TRIM(album))) END) FROM song_plays) AS unique_albums,
      (SELECT COUNT(DISTINCT (LOWER(TRIM(song_title)) || CHAR(9) || LOWER(TRIM(artist)))) FROM song_plays) AS unique_songs,
      (SELECT MIN(air_date) FROM episodes) AS earliest_date,
      (SELECT MAX(air_date) FROM episodes) AS latest_date,
      (SELECT id FROM episodes ORDER BY air_date DESC, id DESC LIMIT 1) AS latest_episode_id,
      (SELECT COUNT(1) FROM (SELECT 1 FROM song_plays GROUP BY LOWER(TRIM(artist)) HAVING COUNT(1) = 1)) AS one_spin_artists,
      (SELECT COUNT(1) FROM (SELECT 1 FROM song_plays GROUP BY LOWER(TRIM(artist)), LOWER(TRIM(song_title)) HAVING COUNT(1) = 1)) AS one_spin_songs`;

    const topArtistsSql = `SELECT MIN(TRIM(artist)) AS name, COUNT(1) AS plays
      FROM song_plays GROUP BY LOWER(TRIM(artist)) ORDER BY plays DESC, LOWER(name) ASC LIMIT 10`;

    const topSongsSql = `WITH song_totals AS (
        SELECT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk,
          MIN(TRIM(artist)) AS artist, MIN(TRIM(song_title)) AS song, COUNT(1) AS plays
        FROM song_plays GROUP BY ak, sk ORDER BY plays DESC, LOWER(song) ASC, LOWER(artist) ASC LIMIT 10
      ), album_counts AS (
        SELECT LOWER(TRIM(sp.artist)) AS ak, LOWER(TRIM(sp.song_title)) AS sk, TRIM(sp.album) AS album, COUNT(1) AS cnt
        FROM song_plays sp JOIN song_totals st ON LOWER(TRIM(sp.artist)) = st.ak AND LOWER(TRIM(sp.song_title)) = st.sk
        WHERE LENGTH(TRIM(COALESCE(sp.album, ''))) > 0 GROUP BY ak, sk, TRIM(sp.album)
      ), ranked_albums AS (
        SELECT ak, sk, album, ROW_NUMBER() OVER (PARTITION BY ak, sk ORDER BY cnt DESC, LOWER(album) ASC) AS rn FROM album_counts
      )
      SELECT st.artist, st.song, COALESCE(ra.album, '') AS album, st.plays
      FROM song_totals st LEFT JOIN ranked_albums ra ON st.ak = ra.ak AND st.sk = ra.sk AND ra.rn = 1
      ORDER BY st.plays DESC, LOWER(st.song) ASC, LOWER(st.artist) ASC`;

    const [stats, topArtists, topSongs] = await Promise.all([qFirst(db, statsSql), qAll(db, topArtistsSql), qAll(db, topSongsSql)]);
    return {
      totalEpisodes: Number(stats?.total_episodes ?? 0),
      totalSongPlays: Number(stats?.total_song_plays ?? 0),
      uniqueArtists: Number(stats?.unique_artists ?? 0),
      uniqueAlbums: Number(stats?.unique_albums ?? 0),
      uniqueSongs: Number(stats?.unique_songs ?? 0),
      latestEpisodeId: stats?.latest_episode_id ? String(stats.latest_episode_id) : null,
      oneSpinArtists: Number(stats?.one_spin_artists ?? 0),
      oneSpinSongs: Number(stats?.one_spin_songs ?? 0),
      dateRange: { earliest: stats?.earliest_date ?? null, latest: stats?.latest_date ?? null },
      topArtists: topArtists.map((r) => ({ name: r.name, plays: Number(r.plays) })),
      topSongs: topSongs.map((r) => ({ artist: r.artist, song: r.song, album: r.album || '', plays: Number(r.plays) })),
    };
  });
}

export async function getD1YearSpins(db, queryParams = {}) {
  const artist = typeof queryParams.artist === 'string' ? queryParams.artist.trim() : '';
  const song = typeof queryParams.song === 'string' ? queryParams.song.trim() : '';
  return withCache(db, `years:${artist.toLowerCase()}:${song.toLowerCase()}`, async () => {
    const conds = [];
    const params = [];
    if (artist) { conds.push('LOWER(TRIM(artist)) = LOWER(?)'); params.push(artist); }
    if (song) { conds.push('LOWER(TRIM(song_title)) = LOWER(?)'); params.push(song); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [rows, maxRow] = await Promise.all([
      qAll(db, `SELECT CAST(SUBSTR(air_date, 1, 4) AS INTEGER) AS year, COUNT(1) AS spins FROM song_plays ${where} GROUP BY year ORDER BY year ASC`, params),
      qFirst(db, 'SELECT MAX(CAST(SUBSTR(air_date, 1, 4) AS INTEGER)) AS max_year FROM episodes'),
    ]);
    const maxYear = Math.max(2026, Number(maxRow?.max_year ?? 2026));
    const years = Array.from({ length: maxYear - 2013 + 1 }, (_, i) => 2013 + i);
    const counts = new Map(rows.map((r) => [Number(r.year), Number(r.spins)]));
    return { years, spins: years.map((y) => counts.get(y) ?? 0), scope: song ? 'song' : artist ? 'artist' : 'archive', artist: artist || null, song: song || null };
  });
}

export async function getD1Episodes(db, queryParams = {}) {
  const { page, limit, offset } = parsePageParams(queryParams);
  const year = typeof queryParams.year === 'string' && /^\d{4}$/.test(queryParams.year.trim()) ? queryParams.year.trim() : '';
  const song = typeof queryParams.song === 'string' ? queryParams.song.trim().toLowerCase() : '';
  const artist = typeof queryParams.artist === 'string' ? queryParams.artist.trim().toLowerCase() : '';

  return withCache(db, `episodes:${year}:${song}:${artist}:${page}:${limit}`, async () => {
    const conds = [];
    const spConds = [];
    const params = [];
    if (year) { conds.push('SUBSTR(e.air_date, 1, 4) = ?'); params.push(year); }
    if (song) { spConds.push('LOWER(TRIM(sp.song_title)) = ?'); params.push(song); }
    if (artist) { spConds.push('LOWER(TRIM(sp.artist)) = ?'); params.push(artist); }
    if (spConds.length) conds.push(`e.id IN (SELECT DISTINCT sp.episode_id FROM song_plays sp WHERE ${spConds.join(' AND ')})`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [rows, countRow] = await Promise.all([
      qAll(db, `SELECT e.id, e.air_date, e.url, e.song_count FROM episodes e ${where} ORDER BY e.air_date DESC, e.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      qFirst(db, `SELECT COUNT(1) AS total FROM episodes e ${where}`, params),
    ]);
    const items = rows.map(mapEpisodeRow);
    const total = Number(countRow?.total ?? 0);
    return { items, episodes: items, total, page, limit, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  });
}

export async function getD1EpisodeById(db, id) {
  const epId = String(id ?? '');
  return withCache(db, `episode:${epId}`, async () => {
    const [epRow, songRows] = await Promise.all([
      qFirst(db, 'SELECT id, air_date, url, song_count FROM episodes WHERE id = ?', [epId]),
      qAll(db, 'SELECT position, artist, featured_artist, song_title, album, release_kind FROM song_plays WHERE episode_id = ? ORDER BY position ASC', [epId]),
    ]);
    if (!epRow) return null;
    const playlist = songRows.map((s) => ({
      position: Number(s.position),
      song: s.song_title,
      songTitle: s.song_title,
      artist: s.artist,
      ...(s.featured_artist ? { featuredArtist: s.featured_artist } : {}),
      album: s.album || '',
      ...(s.release_kind && s.release_kind !== 'album' ? { releaseKind: s.release_kind } : {}),
    }));
    return { ...mapEpisodeRow(epRow), playlist, songs: playlist };
  });
}

export async function getD1Artists(db, queryParams = {}) {
  const search = typeof queryParams.search === 'string' ? queryParams.search.trim().toLowerCase() : '';
  const sort = parseSortParam(queryParams.sort);
  const cap = parseCapParam(queryParams.cap);
  const { page, limit } = parsePageParams(queryParams);

  return withCache(db, `artists:${search}:${sort}:${cap ?? ''}:${page}:${limit}`, async () => {
    const where = search ? "WHERE LOWER(TRIM(artist)) LIKE ? ESCAPE '\\'" : '';
    const params = search ? [escapeLike(search)] : [];
    const orderBy = sort === 'obscure' ? 'ORDER BY total_plays ASC, first_appearance ASC, LOWER(name) ASC' : 'ORDER BY total_plays DESC, LOWER(name) ASC';

    const countRow = await qFirst(db, `SELECT COUNT(DISTINCT LOWER(TRIM(artist))) AS total FROM song_plays ${where}`, params);
    const rawTotal = Number(countRow?.total ?? 0);
    const { total, effectiveLimit, offset, totalPages } = computeCappedPagination({ rawTotal, cap, page, limit });

    const listSql = `SELECT MIN(TRIM(artist)) AS name, COUNT(1) AS total_plays,
      COUNT(DISTINCT LOWER(TRIM(song_title))) AS unique_songs,
      COUNT(DISTINCT CASE WHEN LENGTH(TRIM(COALESCE(album, ''))) > 0 THEN LOWER(TRIM(album)) END) AS unique_albums,
      MIN(air_date) AS first_appearance, MAX(air_date) AS last_appearance
      FROM song_plays ${where} GROUP BY LOWER(TRIM(artist)) ${orderBy} LIMIT ? OFFSET ?`;
    const rows = effectiveLimit > 0 ? await qAll(db, listSql, [...params, effectiveLimit, offset]) : [];
    const items = rows.map((r) => ({
      name: r.name,
      totalPlays: Number(r.total_plays),
      uniqueSongs: Number(r.unique_songs),
      uniqueAlbums: Number(r.unique_albums),
      firstAppearance: r.first_appearance || '',
      lastAppearance: r.last_appearance || '',
    }));
    return { items, artists: items, total, unboundedTotal: rawTotal, page, limit, pagination: { page, limit, total, totalPages } };
  });
}

export async function getD1Songs(db, queryParams = {}) {
  const search = typeof queryParams.search === 'string' ? queryParams.search.trim().toLowerCase() : '';
  const sort = parseSortParam(queryParams.sort);
  const cap = parseCapParam(queryParams.cap);
  const { page, limit } = parsePageParams(queryParams);

  return withCache(db, `songs:${search}:${sort}:${cap ?? ''}:${page}:${limit}`, async () => {
    const having = search
      ? "HAVING MAX(CASE WHEN LOWER(TRIM(artist)) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(featured_artist, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(song_title)) LIKE ? ESCAPE '\\' OR LOWER(TRIM(album)) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) = 1"
      : '';
    const params = search ? [escapeLike(search), escapeLike(search), escapeLike(search), escapeLike(search)] : [];
    const orderBy = sort === 'obscure' ? 'ORDER BY total_plays ASC, first_played ASC, LOWER(song_title) ASC, LOWER(artist) ASC' : 'ORDER BY total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC';

    const countRow = await qFirst(db, `SELECT COUNT(1) AS total FROM (SELECT 1 FROM song_plays GROUP BY LOWER(TRIM(artist)), LOWER(TRIM(song_title)) ${having})`, params);
    const rawTotal = Number(countRow?.total ?? 0);
    const { total, effectiveLimit, offset, totalPages } = computeCappedPagination({ rawTotal, cap, page, limit });

    const listSql = `WITH grouped AS (
        SELECT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk,
          MIN(TRIM(artist)) AS artist, MIN(TRIM(song_title)) AS song_title,
          COUNT(1) AS total_plays, MIN(air_date) AS first_played, MAX(air_date) AS last_played
        FROM song_plays GROUP BY ak, sk ${having} ${orderBy} LIMIT ? OFFSET ?
      ), album_counts AS (
        SELECT LOWER(TRIM(sp.artist)) AS ak, LOWER(TRIM(sp.song_title)) AS sk, TRIM(sp.album) AS album, COUNT(1) AS cnt
        FROM song_plays sp JOIN grouped g ON LOWER(TRIM(sp.artist)) = g.ak AND LOWER(TRIM(sp.song_title)) = g.sk
        WHERE LENGTH(TRIM(COALESCE(sp.album, ''))) > 0 GROUP BY ak, sk, TRIM(sp.album)
      ), ranked_albums AS (
        SELECT ak, sk, album, ROW_NUMBER() OVER (PARTITION BY ak, sk ORDER BY cnt DESC, LOWER(album) ASC) AS rn FROM album_counts
      )
      SELECT g.artist, g.song_title, COALESCE(ra.album, '') AS album, g.total_plays, g.first_played, g.last_played
      FROM grouped g LEFT JOIN ranked_albums ra ON g.ak = ra.ak AND g.sk = ra.sk AND ra.rn = 1 ${orderBy}`;

    const rows = effectiveLimit > 0 ? await qAll(db, listSql, [...params, effectiveLimit, offset]) : [];
    const items = rows.map((r) => ({
      artist: r.artist,
      songTitle: r.song_title,
      album: r.album || '',
      totalPlays: Number(r.total_plays),
      firstPlayed: r.first_played || '',
      lastPlayed: r.last_played || '',
    }));
    return { items, songs: items, total, unboundedTotal: rawTotal, page, limit, pagination: { page, limit, total, totalPages } };
  });
}

export async function getD1ArtistSongs(db, artistName) {
  const trimmed = String(artistName ?? '').trim();
  return withCache(db, `artistSongs:${trimmed.toLowerCase()}`, async () => {
    const [summary, pairRows] = await Promise.all([
      qFirst(db, `SELECT COUNT(1) AS total_plays, COUNT(DISTINCT LOWER(TRIM(song_title))) AS unique_songs,
        COUNT(DISTINCT CASE WHEN LENGTH(TRIM(COALESCE(album, ''))) > 0 THEN LOWER(TRIM(album)) END) AS unique_albums, MIN(air_date) AS first_appearance, MAX(air_date) AS last_appearance
        FROM song_plays WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?))`, [trimmed]),
      qAll(db, `SELECT LOWER(TRIM(song_title)) AS sk, MIN(TRIM(song_title)) AS song_title, TRIM(COALESCE(album, '')) AS album,
        COUNT(1) AS cnt, MIN(air_date) AS first_played, MAX(air_date) AS last_played
        FROM song_plays WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) GROUP BY sk, TRIM(COALESCE(album, ''))`, [trimmed]),
    ]);

    const songMap = new Map();
    const artistAlbumCounts = new Map();
    for (const r of pairRows) {
      const cnt = Number(r.cnt);
      let entry = songMap.get(r.sk);
      if (!entry) {
        entry = { songTitle: r.song_title, totalPlays: 0, firstPlayed: r.first_played || '', lastPlayed: r.last_played || '', albumCounts: new Map() };
        songMap.set(r.sk, entry);
      }
      entry.totalPlays += cnt;
      if (r.song_title < entry.songTitle) entry.songTitle = r.song_title;
      if (r.first_played && (!entry.firstPlayed || r.first_played < entry.firstPlayed)) entry.firstPlayed = r.first_played;
      if (r.last_played && (!entry.lastPlayed || r.last_played > entry.lastPlayed)) entry.lastPlayed = r.last_played;
      if (r.album) {
        entry.albumCounts.set(r.album, (entry.albumCounts.get(r.album) || 0) + cnt);
        artistAlbumCounts.set(r.album, (artistAlbumCounts.get(r.album) || 0) + cnt);
      }
    }

    const byCnt = (a, b) => (b[1] - a[1]) || a[0].toLowerCase().localeCompare(b[0].toLowerCase());
    const songs = Array.from(songMap.values())
      .map((s) => {
        const songAlbums = Array.from(s.albumCounts.entries()).sort(byCnt).map(([name]) => name);
        return { songTitle: s.songTitle, album: songAlbums[0] || '', albums: songAlbums, totalPlays: s.totalPlays, firstPlayed: s.firstPlayed, lastPlayed: s.lastPlayed };
      })
      .sort((a, b) => (b.totalPlays - a.totalPlays) || a.songTitle.toLowerCase().localeCompare(b.songTitle.toLowerCase()));
    const albums = Array.from(artistAlbumCounts.entries()).sort(byCnt).map(([name]) => name);

    return {
      artist: artistName,
      summary: {
        totalPlays: Number(summary?.total_plays ?? 0),
        uniqueSongs: Number(summary?.unique_songs ?? 0),
        uniqueAlbums: Number(summary?.unique_albums ?? 0),
        firstAppearance: summary?.first_appearance || '',
        lastAppearance: summary?.last_appearance || '',
      },
      albums,
      songs,
    };
  });
}

export async function getD1Search(db, queryParams = {}) {
  const q = typeof queryParams.q === 'string' ? queryParams.q.trim().slice(0, 120).toLowerCase() : '';
  if (!q || q.length < 2) return { artists: [], songs: [], albums: [] };

  return withCache(db, `search:${q}`, async () => {
    const like = escapeLike(q);
    const searchSongsSql = `WITH matched_keys AS (
        SELECT DISTINCT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk
        FROM song_plays
        WHERE LOWER(TRIM(song_title)) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(featured_artist, ''))) LIKE ? ESCAPE '\\'
      ), grouped AS (
        SELECT LOWER(TRIM(sp.artist)) AS ak, LOWER(TRIM(sp.song_title)) AS sk,
          MIN(TRIM(sp.artist)) AS artist, MIN(TRIM(sp.song_title)) AS song_title, COUNT(1) AS plays
        FROM song_plays sp
        JOIN matched_keys m ON LOWER(TRIM(sp.artist)) = m.ak AND LOWER(TRIM(sp.song_title)) = m.sk
        GROUP BY ak, sk ORDER BY plays DESC, LOWER(song_title) ASC LIMIT 10
      ), album_counts AS (
        SELECT LOWER(TRIM(sp.artist)) AS ak, LOWER(TRIM(sp.song_title)) AS sk, TRIM(sp.album) AS album, COUNT(1) AS cnt
        FROM song_plays sp JOIN grouped g ON LOWER(TRIM(sp.artist)) = g.ak AND LOWER(TRIM(sp.song_title)) = g.sk
        WHERE LENGTH(TRIM(COALESCE(sp.album, ''))) > 0 GROUP BY ak, sk, TRIM(sp.album)
      ), ranked_albums AS (
        SELECT ak, sk, album, ROW_NUMBER() OVER (PARTITION BY ak, sk ORDER BY cnt DESC, LOWER(album) ASC) AS rn FROM album_counts
      )
      SELECT g.artist, g.song_title, COALESCE(ra.album, '') AS album, g.plays
      FROM grouped g LEFT JOIN ranked_albums ra ON g.ak = ra.ak AND g.sk = ra.sk AND ra.rn = 1
      ORDER BY g.plays DESC, LOWER(g.song_title) ASC`;
    const [artists, songs, albums] = await Promise.all([
      qAll(db, "SELECT MIN(TRIM(artist)) AS name, COUNT(1) AS plays, COUNT(DISTINCT LOWER(TRIM(song_title))) AS unique_songs FROM song_plays WHERE LOWER(TRIM(artist)) LIKE ? ESCAPE '\\' GROUP BY LOWER(TRIM(artist)) ORDER BY plays DESC, LOWER(name) ASC LIMIT 10", [like]),
      qAll(db, searchSongsSql, [like, like]),
      qAll(db, "SELECT MIN(TRIM(artist)) AS artist, MIN(TRIM(album)) AS album, COUNT(1) AS plays FROM song_plays WHERE LOWER(TRIM(album)) LIKE ? ESCAPE '\\' AND LENGTH(TRIM(COALESCE(album, ''))) > 0 GROUP BY LOWER(TRIM(artist)), LOWER(TRIM(album)) ORDER BY plays DESC LIMIT 10", [like]),
    ]);
    return {
      artists: artists.map((r) => ({ name: r.name, plays: Number(r.plays), uniqueSongs: Number(r.unique_songs ?? 0) })),
      songs: songs.map((r) => ({ artist: r.artist, songTitle: r.song_title, album: r.album || '', plays: Number(r.plays) })),
      albums: albums.map((r) => ({ artist: r.artist, album: r.album, plays: Number(r.plays) })),
    };
  });
}
