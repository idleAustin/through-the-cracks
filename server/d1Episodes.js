// Cloudflare D1 Episode listing (year/song/artist/day/q filters) and Episode DNA provenance queries.
import { escapeLike, mapEpisodeRow, qAll, qFirst, readCacheBlob, stripControlChars, withCache } from './d1Rollups.js';
import { buildEnrichedEpisodeDetail, buildEpisodeLookupKeys, parseBroadcastDayParam } from './episodeDetailBuilder.js';
import { buildSqliteSongKey, sqliteAsciiLower } from './playlistBuilder.js';
import { parsePageParams } from './routes/queryUtils.js';

const D1_IN_CHUNK_SIZE = 45;
const placeholders = (count) => Array.from({ length: count }, () => '?').join(', ');

function chunkValues(items, size = D1_IN_CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function buildEpisodesFilter(queryParams) {
  const year = typeof queryParams.year === 'string' && /^\d{4}$/.test(queryParams.year.trim()) ? queryParams.year.trim() : '';
  const song = typeof queryParams.song === 'string' ? queryParams.song.trim().toLowerCase() : '';
  const artist = typeof queryParams.artist === 'string' ? queryParams.artist.trim().toLowerCase() : '';
  const q = stripControlChars(typeof queryParams.q === 'string' ? queryParams.q : '').trim().slice(0, 120).toLowerCase();
  const day = parseBroadcastDayParam(queryParams.day);

  const conds = [];
  const spConds = [];
  const params = [];
  if (year) { conds.push('SUBSTR(e.air_date, 1, 4) = ?'); params.push(year); }
  if (song) { spConds.push('LOWER(TRIM(sp.song_title)) = ?'); params.push(song); }
  if (artist) { spConds.push('LOWER(TRIM(sp.artist)) = ?'); params.push(artist); }
  if (spConds.length) conds.push(`e.id IN (SELECT DISTINCT sp.episode_id FROM song_plays sp WHERE ${spConds.join(' AND ')})`);
  if (day) { conds.push("STRFTIME('%w', e.air_date) = ?"); params.push(day.sqliteDow); }
  if (q) {
    const like = escapeLike(q);
    conds.push(
      `(LOWER(e.air_date) LIKE ? ESCAPE '\\' OR e.id IN (SELECT DISTINCT spq.episode_id FROM song_plays spq WHERE LOWER(spq.song_title) LIKE ? ESCAPE '\\' OR LOWER(spq.artist) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(spq.featured_artist, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(spq.album, '')) LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like, like, like, like);
  }

  return {
    filterKey: [year, song, artist, q, day?.name || ''],
    where: conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    params,
  };
}

export async function getD1Episodes(db, queryParams = {}) {
  const parsed = parsePageParams(queryParams);
  const safePage = Math.min(Math.max(1, Math.trunc(Number(parsed.page) || 1)), 1_000_000);
  const safeLimit = Math.min(Math.max(1, Math.trunc(Number(parsed.limit) || 40)), 100);
  const safeOffset = (safePage - 1) * safeLimit;
  const { filterKey, where, params } = buildEpisodesFilter(queryParams);
  const cacheKey = JSON.stringify(['episodes', ...filterKey, safePage, safeLimit]);

  return withCache(db, cacheKey, async () => {
    let rows;
    let total;
    if (!where) {
      const [epRows, ov] = await Promise.all([
        qAll(db, 'SELECT e.id, e.air_date, e.url, e.song_count FROM episodes e ORDER BY e.air_date DESC, e.id DESC LIMIT ? OFFSET ?', [safeLimit, safeOffset]),
        readCacheBlob(db, 'overview'),
      ]);
      rows = epRows;
      if (ov) {
        total = Number(ov.totalEpisodes ?? 0);
      } else {
        const countRow = await qFirst(db, 'SELECT COUNT(1) AS total FROM episodes e');
        total = Number(countRow?.total ?? 0);
      }
    } else {
      const [epRows, countRow] = await Promise.all([
        qAll(db, `SELECT e.id, e.air_date, e.url, e.song_count FROM episodes e ${where} ORDER BY e.air_date DESC, e.id DESC LIMIT ? OFFSET ?`, [...params, safeLimit, safeOffset]),
        qFirst(db, `SELECT COUNT(1) AS total FROM episodes e ${where}`, params),
      ]);
      rows = epRows;
      total = Number(countRow?.total ?? 0);
    }

    const items = rows.map(mapEpisodeRow);
    return {
      items,
      episodes: items,
      total,
      page: safePage,
      limit: safeLimit,
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
    };
  });
}

function recordArtistFirst(map, rawKey, firstAppearance) {
  const ak = String(rawKey ?? '');
  if (!ak) return;
  const first = String(firstAppearance ?? '');
  for (const k of ak === ak.toLowerCase() ? [ak] : [ak, ak.toLowerCase()]) {
    const prev = map.get(k);
    if (prev === undefined || first < prev) map.set(k, first);
  }
}

function recordSongStatRow(songStatsByKey, sqliteSongPairSet, row) {
  const key = buildSqliteSongKey(row.artist_key, row.song_key);
  if (!sqliteSongPairSet.has(key)) return;
  songStatsByKey.set(key, {
    totalPlays: Number(row.total_plays ?? 1),
    firstPlayed: row.first_played || '',
    lastPlayed: row.last_played || '',
  });
}

async function loadSongAndArtistStats(db, queryArtistKeys, sqliteSongPairSet) {
  const songStatsByKey = new Map();
  const artistFirstByKey = new Map();
  if (queryArtistKeys.length === 0) return { songStatsByKey, artistFirstByKey };

  const hasRollups = Boolean(await readCacheBlob(db, 'overview'));
  let loadedFromRollups = false;

  if (hasRollups) {
    try {
      for (const chunk of chunkValues(queryArtistKeys)) {
        const ph = placeholders(chunk.length);
        const [songRows, artistRows] = await Promise.all([
          qAll(db, `SELECT artist_key, song_key, total_plays, first_played, last_played FROM song_rollups WHERE artist_key IN (${ph})`, chunk),
          qAll(db, `SELECT artist_key, first_appearance FROM artist_rollups WHERE artist_key IN (${ph})`, chunk),
        ]);
        for (const r of songRows) recordSongStatRow(songStatsByKey, sqliteSongPairSet, r);
        for (const r of artistRows) recordArtistFirst(artistFirstByKey, r.artist_key, r.first_appearance || '');
      }
      loadedFromRollups = true;
    } catch (err) {
      if (!/no such table/i.test(String(err?.message ?? err))) throw err;
      songStatsByKey.clear();
      artistFirstByKey.clear();
    }
  }

  if (!loadedFromRollups) {
    for (const chunk of chunkValues(queryArtistKeys)) {
      const ph = placeholders(chunk.length);
      const rows = await qAll(
        db,
        `SELECT LOWER(TRIM(artist)) AS artist_key, LOWER(TRIM(song_title)) AS song_key,
          COUNT(1) AS total_plays, COALESCE(MIN(air_date), '') AS first_played, COALESCE(MAX(air_date), '') AS last_played
         FROM song_plays WHERE LOWER(TRIM(artist)) IN (${ph})
         GROUP BY LOWER(TRIM(artist)), LOWER(TRIM(song_title))`,
        chunk,
      );
      for (const r of rows) {
        recordSongStatRow(songStatsByKey, sqliteSongPairSet, r);
        recordArtistFirst(artistFirstByKey, r.artist_key, r.first_played || '');
      }
    }
  }

  return { songStatsByKey, artistFirstByKey };
}

async function loadPlayableLinks(db, songLinkKeys) {
  const playableLinksByKey = new Map();
  if (songLinkKeys.length === 0) return playableLinksByKey;
  try {
    for (const chunk of chunkValues(songLinkKeys)) {
      const ph = placeholders(chunk.length);
      const rows = await qAll(
        db,
        `SELECT song_key, video_id, duration_seconds FROM song_links WHERE song_key IN (${ph}) AND is_embeddable = 1 AND us_playable = 1`,
        chunk,
      );
      for (const r of rows) {
        if (r?.song_key) {
          playableLinksByKey.set(String(r.song_key), {
            videoId: r.video_id ?? null,
            durationSeconds: r.duration_seconds ?? null,
          });
        }
      }
    }
  } catch (err) {
    if (!/no such table/i.test(String(err?.message ?? err))) throw err;
    playableLinksByKey.clear();
  }
  return playableLinksByKey;
}

export async function getD1EpisodeById(db, id, queryParams = {}) {
  const epId = String(id ?? '');
  const withProvenance = queryParams?.provenance === '1' || queryParams?.provenance === true;
  const cacheKey = JSON.stringify(['episode', withProvenance ? 'prov' : 'bare', epId]);

  return withCache(db, cacheKey, async () => {
    const [epRow, songRows] = await Promise.all([
      qFirst(db, 'SELECT id, air_date, url, song_count FROM episodes WHERE id = ?', [epId]),
      qAll(db, 'SELECT position, artist, featured_artist, song_title, album, release_kind FROM song_plays WHERE episode_id = ? ORDER BY position ASC', [epId]),
    ]);
    if (!epRow) return null;

    const tracks = songRows.map((s) => ({
      position: Number(s.position),
      song: s.song_title,
      songTitle: s.song_title,
      artist: s.artist,
      ...(s.featured_artist ? { featuredArtist: s.featured_artist } : {}),
      album: s.album || '',
      ...(s.release_kind && s.release_kind !== 'album' ? { releaseKind: s.release_kind } : {}),
    }));

    if (!withProvenance) return { ...mapEpisodeRow(epRow), playlist: tracks, songs: tracks };

    const { artistKeys, songPairs, songLinkKeys } = buildEpisodeLookupKeys(tracks);
    const sqliteSongPairSet = new Set(songPairs);
    const queryArtistSet = new Set(artistKeys);
    for (const t of tracks) {
      const sk = sqliteAsciiLower(t.artist);
      if (sk) queryArtistSet.add(sk);
    }

    const [prevRow, nextRow, { songStatsByKey, artistFirstByKey }, playableLinksByKey] = await Promise.all([
      qFirst(db, 'SELECT id FROM episodes WHERE (air_date > ? OR (air_date = ? AND id > ?)) ORDER BY air_date ASC, id ASC LIMIT 1', [epRow.air_date, epRow.air_date, epId]),
      qFirst(db, 'SELECT id FROM episodes WHERE (air_date < ? OR (air_date = ? AND id < ?)) ORDER BY air_date DESC, id DESC LIMIT 1', [epRow.air_date, epRow.air_date, epId]),
      loadSongAndArtistStats(db, [...queryArtistSet], sqliteSongPairSet),
      loadPlayableLinks(db, songLinkKeys),
    ]);

    return buildEnrichedEpisodeDetail({
      episode: mapEpisodeRow(epRow),
      tracks,
      songStatsByKey,
      artistFirstByKey,
      playableLinksByKey,
      prevEpisodeId: prevRow?.id ?? null,
      nextEpisodeId: nextRow?.id ?? null,
    });
  });
}
