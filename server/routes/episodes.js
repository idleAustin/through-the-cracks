// Read-only episodes listing and episode playlist detail HTTP route handlers.
import express from 'express';
import { parsePageParams, unwrapBqValue } from './queryUtils.js';

export function createEpisodesRouter({ query, project, dataset }) {
  const router = express.Router();

  router.get('/episodes', async (req, res) => {
    try {
      const { page, limit, offset } = parsePageParams(req.query);

      const listQuery = `
        SELECT id, title, air_date, day_of_week, episode_number, published_at, url, song_count
        FROM \`${project}.${dataset}.episodes\`
        ORDER BY air_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const countQuery = `SELECT COUNT(1) as total FROM \`${project}.${dataset}.episodes\``;

      const rows = await query(listQuery);
      const [countRow] = await query(countQuery);

      res.json({
        episodes: rows.map(r => ({
          id: r.id,
          title: r.title,
          airDate: unwrapBqValue(r.air_date),
          dayOfWeek: r.day_of_week,
          episodeNumber: Number(r.episode_number),
          publishedAt: unwrapBqValue(r.published_at),
          url: r.url,
          songCount: Number(r.song_count)
        })),
        pagination: {
          page,
          limit,
          total: Number(countRow.total),
          totalPages: Math.ceil(Number(countRow.total) / limit)
        }
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
        SELECT id, title, air_date, day_of_week, episode_number, published_at, url, song_count
        FROM \`${project}.${dataset}.episodes\`
        WHERE id = @id
      `;
      const songsQuery = `
        SELECT position, artist, song_title, album, raw_line
        FROM \`${project}.${dataset}.song_plays\`
        WHERE episode_id = @id
        ORDER BY position ASC
      `;

      const epRows = await query(epQuery, { id });
      if (epRows.length === 0) {
        return res.status(404).json({ error: 'Episode not found' });
      }

      const songsRows = await query(songsQuery, { id });
      const ep = epRows[0];

      res.json({
        id: ep.id,
        title: ep.title,
        airDate: unwrapBqValue(ep.air_date),
        dayOfWeek: ep.day_of_week,
        episodeNumber: Number(ep.episode_number),
        publishedAt: unwrapBqValue(ep.published_at),
        url: ep.url,
        songCount: Number(ep.song_count),
        songs: songsRows.map(s => ({
          position: Number(s.position),
          artist: s.artist,
          songTitle: s.song_title,
          album: s.album,
          rawLine: s.raw_line
        }))
      });
    } catch (err) {
      console.error('Error fetching episode details:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

