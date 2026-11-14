// Read-only episodes listing and episode playlist detail HTTP route handlers.
import express from 'express';
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

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function createEpisodesRouter({ query, project, dataset }) {
  const router = express.Router();

  router.get('/episodes', async (req, res) => {
    try {
      const { page, limit, offset } = parsePageParams(req.query);
      const { whereClause, params } = buildEpisodesFilter(req.query, project, dataset);

      const listQuery = `
        SELECT e.id, e.air_date, e.url, e.song_count
        FROM \`${project}.${dataset}.episodes\` e
        ${whereClause}
        ORDER BY e.air_date DESC, e.id DESC
        LIMIT ${limit} OFFSET ${offset}
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
      const totalPages = Math.ceil(total / limit);

      res.json({
        items,
        episodes: items,
        total,
        page,
        limit,
        pagination: { page, limit, total, totalPages },
      });
    } catch (err) {
      console.error('Error fetching episodes:', err);
      res.status(500).json({ error: err.message });
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

      res.json({
        ...mapEpisodeRow(epRows[0]),
        playlist,
        songs: playlist,
      });
    } catch (err) {
      console.error('Error fetching episode details:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
