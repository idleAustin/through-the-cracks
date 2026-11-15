// Read-only episodes listing (year/song/artist/day/q filters) and Episode DNA provenance HTTP route handlers.
import express from 'express';
import { stripControlChars } from '../d1Rollups.js';
import { buildEnrichedEpisodeDetail, buildEpisodeLookupKeys, parseBroadcastDayParam } from '../episodeDetailBuilder.js';
import { buildSongKey, buildSqliteSongKey } from '../playlistBuilder.js';
import { buildPlayableLinksByKey } from '../r2Episodes.js';
import { loadSongLinksSnapshot } from './playlist.js';
import { parsePageParams, unwrapBqValue } from './queryUtils.js';

function mapEpisodeRow(row) {
  const airDate = unwrapBqValue(row.air_date);
  const songCount = Number(row.song_count);
  return {
    id: row.id,
    air_date: airDate,
    airDate,
    song_count: songCount,
    songCount,
    url: row.url || null,
  };
}

function buildEpisodesFilter(queryParams, project, dataset) {
  const conditions = [];
  const spConditions = [];
  const params = {};

  const rawYear = typeof queryParams.year === 'string' ? queryParams.year.trim() : '';
  if (/^\d{4}$/.test(rawYear)) {
    conditions.push('EXTRACT(YEAR FROM e.air_date) = @year');
    params.year = Number(rawYear);
  }

  const song = typeof queryParams.song === 'string' ? queryParams.song.trim().toLowerCase() : '';
  if (song) {
    spConditions.push('LOWER(TRIM(sp.song_title)) = @song');
    params.song = song;
  }

  const artist = typeof queryParams.artist === 'string' ? queryParams.artist.trim().toLowerCase() : '';
  if (artist) {
    spConditions.push('LOWER(TRIM(sp.artist)) = @artist');
    params.artist = artist;
  }

  if (spConditions.length > 0) {
    conditions.push(
      `e.id IN (SELECT DISTINCT sp.episode_id FROM \`${project}.${dataset}.song_plays\` sp WHERE ${spConditions.join(' AND ')})`
    );
  }

  const day = parseBroadcastDayParam(queryParams.day);
  if (day) {
    conditions.push('EXTRACT(DAYOFWEEK FROM e.air_date) = @dow');
    params.dow = day.bqDow;
  }

  const q = stripControlChars(typeof queryParams.q === 'string' ? queryParams.q : '').trim().slice(0, 120).toLowerCase();
  if (q) {
    params.qLike = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(
      `(CAST(e.air_date AS STRING) LIKE @qLike OR e.id IN (SELECT DISTINCT spq.episode_id FROM \`${project}.${dataset}.song_plays\` spq WHERE LOWER(TRIM(spq.song_title)) LIKE @qLike OR LOWER(TRIM(spq.artist)) LIKE @qLike OR LOWER(TRIM(COALESCE(spq.featured_artist, ''))) LIKE @qLike OR LOWER(TRIM(COALESCE(spq.album, ''))) LIKE @qLike))`
    );
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

async function buildEpisodeProvenanceDetail({ query, project, dataset, playlistSnapshotPath, episode, playlist }) {
  const id = String(episode.id ?? '');
  const airDate = String(episode.airDate ?? '');
  const { artistKeys } = buildEpisodeLookupKeys(playlist);

  const prevQuery = `
    SELECT id
    FROM \`${project}.${dataset}.episodes\`
    WHERE (air_date > DATE(@airDate) OR (air_date = DATE(@airDate) AND id > @id))
    ORDER BY air_date ASC, id ASC
    LIMIT 1
  `;
  const nextQuery = `
    SELECT id
    FROM \`${project}.${dataset}.episodes\`
    WHERE (air_date < DATE(@airDate) OR (air_date = DATE(@airDate) AND id < @id))
    ORDER BY air_date DESC, id DESC
    LIMIT 1
  `;
  const songStatsQuery = `
    SELECT LOWER(TRIM(artist)) AS ak, LOWER(TRIM(song_title)) AS sk,
      COUNT(1) AS total_plays, MIN(air_date) AS first_played, MAX(air_date) AS last_played
    FROM \`${project}.${dataset}.song_plays\`
    WHERE LOWER(TRIM(artist)) IN UNNEST(@artistKeys)
    GROUP BY ak, sk
  `;
  const artistFirstQuery = `
    SELECT LOWER(TRIM(artist)) AS ak, MIN(air_date) AS first_appearance
    FROM \`${project}.${dataset}.song_plays\`
    WHERE LOWER(TRIM(artist)) IN UNNEST(@artistKeys)
    GROUP BY ak
  `;

  const [prevRows, nextRows, songStatsRows, artistFirstRows, songLinks] = await Promise.all([
    airDate ? query(prevQuery, { id, airDate }) : Promise.resolve([]),
    airDate ? query(nextQuery, { id, airDate }) : Promise.resolve([]),
    artistKeys.length > 0 ? query(songStatsQuery, { artistKeys }) : Promise.resolve([]),
    artistKeys.length > 0 ? query(artistFirstQuery, { artistKeys }) : Promise.resolve([]),
    playlistSnapshotPath === null ? Promise.resolve(null) : loadSongLinksSnapshot(playlistSnapshotPath).catch(() => null),
  ]);

  const songStatsByKey = new Map();
  for (const r of songStatsRows) {
    const stat = {
      totalPlays: Number(r.total_plays ?? 1),
      firstPlayed: String(unwrapBqValue(r.first_played) ?? ''),
      lastPlayed: String(unwrapBqValue(r.last_played) ?? ''),
    };
    const sqliteKey = buildSqliteSongKey(r.ak, r.sk);
    const canonKey = buildSongKey(r.ak, r.sk);
    if (sqliteKey) songStatsByKey.set(sqliteKey, stat);
    if (canonKey && !songStatsByKey.has(canonKey)) songStatsByKey.set(canonKey, stat);
  }

  const artistFirstByKey = new Map();
  for (const r of artistFirstRows) {
    const ak = String(r.ak ?? '').trim().toLowerCase();
    const first = String(unwrapBqValue(r.first_appearance) ?? '');
    if (ak && first) artistFirstByKey.set(ak, first);
  }

  return buildEnrichedEpisodeDetail({
    episode,
    tracks: playlist,
    songStatsByKey,
    artistFirstByKey,
    playableLinksByKey: buildPlayableLinksByKey(songLinks),
    prevEpisodeId: prevRows[0]?.id ?? null,
    nextEpisodeId: nextRows[0]?.id ?? null,
  });
}

export function createEpisodesRouter({ query, project, dataset, playlistSnapshotPath }) {
  const router = express.Router();

  router.get('/episodes', async (req, res) => {
    try {
      const { page, limit } = parsePageParams(req.query);
      const clampedLimit = Math.min(Math.max(1, Math.trunc(Number.isFinite(Number(limit)) ? Number(limit) : 40)), 100);
      const clampedPage = Math.min(Math.max(1, Math.trunc(Number.isFinite(Number(page)) ? Number(page) : 1)), 1_000_000);
      const safeLimit = Number.isSafeInteger(clampedLimit) ? clampedLimit : 40;
      const safePage = Number.isSafeInteger(clampedPage) ? clampedPage : 1;
      const rawOffset = (safePage - 1) * safeLimit;
      const safeOffset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
      const { whereClause, params } = buildEpisodesFilter(req.query, project, dataset);

      const listQuery = `
        SELECT e.id, e.air_date, e.url, e.song_count
        FROM \`${project}.${dataset}.episodes\` e
        ${whereClause}
        ORDER BY e.air_date DESC, e.id DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `;

      const countQuery = `
        SELECT COUNT(1) AS total
        FROM \`${project}.${dataset}.episodes\` e
        ${whereClause}
      `;

      const [rows, countRows] = await Promise.all([
        query(listQuery, params),
        query(countQuery, params),
      ]);

      const items = rows.map(mapEpisodeRow);
      const total = Number(countRows[0]?.total ?? 0);
      const totalPages = Math.ceil(total / safeLimit);

      res.json({
        items,
        episodes: items,
        total,
        page: safePage,
        limit: safeLimit,
        pagination: { page: safePage, limit: safeLimit, total, totalPages },
      });
    } catch (err) {
      console.error('Error fetching episodes:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/episodes/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const epQuery = `
        SELECT id, air_date, url, song_count
        FROM \`${project}.${dataset}.episodes\`
        WHERE id = @id
      `;
      const songsQuery = `
        SELECT position, artist, featured_artist, song_title, album, release_kind
        FROM \`${project}.${dataset}.song_plays\`
        WHERE episode_id = @id
        ORDER BY position ASC
      `;

      const epRows = await query(epQuery, { id });
      if (epRows.length === 0) {
        return res.status(404).json({ error: 'Episode not found' });
      }

      const songsRows = await query(songsQuery, { id });
      const playlist = songsRows.map(s => ({
        position: Number(s.position),
        song: s.song_title,
        songTitle: s.song_title,
        artist: s.artist,
        ...(s.featured_artist ? { featuredArtist: s.featured_artist } : {}),
        album: s.album || '',
        ...(s.release_kind && s.release_kind !== 'album' ? { releaseKind: s.release_kind } : {}),
      }));

      const episode = mapEpisodeRow(epRows[0]);
      if (req.query?.provenance !== '1') {
        return res.json({ ...episode, playlist, songs: playlist });
      }

      const enriched = await buildEpisodeProvenanceDetail({
        query,
        project,
        dataset,
        playlistSnapshotPath,
        episode,
        playlist,
      });
      return res.json(enriched);
    } catch (err) {
      console.error('Error fetching episode details:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
