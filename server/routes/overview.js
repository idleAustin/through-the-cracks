// Read-only overview summary and leaderboard HTTP route handler.
import express from 'express';
import { unwrapBqValue } from './queryUtils.js';

export function createOverviewRouter({ query, project, dataset }) {
  const router = express.Router();

  router.get('/overview', async (_req, res) => {
    try {
      const statsQuery = `
        SELECT
          (SELECT COUNT(1) FROM \`${project}.${dataset}.episodes\`) AS total_episodes,
          (SELECT COUNT(1) FROM \`${project}.${dataset}.song_plays\`) AS total_song_plays,
          (SELECT COUNT(DISTINCT LOWER(artist)) FROM \`${project}.${dataset}.song_plays\`) AS unique_artists,
          (SELECT COUNT(DISTINCT CONCAT(LOWER(artist), '|||', LOWER(album))) FROM \`${project}.${dataset}.song_plays\`) AS unique_albums,
          (SELECT COUNT(DISTINCT CONCAT(LOWER(artist), '|||', LOWER(song_title))) FROM \`${project}.${dataset}.song_plays\`) AS unique_songs,
          (SELECT MIN(air_date) FROM \`${project}.${dataset}.episodes\`) AS earliest_date,
          (SELECT MAX(air_date) FROM \`${project}.${dataset}.episodes\`) AS latest_date
      `;

      const topArtistsQuery = `
        SELECT artist, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        GROUP BY artist
        ORDER BY plays DESC
        LIMIT 10
      `;

      const topSongsQuery = `
        SELECT artist, song_title, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        GROUP BY artist, song_title
        ORDER BY plays DESC
        LIMIT 10
      `;

      const [stats] = await query(statsQuery);
      const topArtists = await query(topArtistsQuery);
      const topSongs = await query(topSongsQuery);

      res.json({
        totalEpisodes: Number(stats.total_episodes),
        totalSongPlays: Number(stats.total_song_plays),
        uniqueArtists: Number(stats.unique_artists),
        uniqueAlbums: Number(stats.unique_albums),
        uniqueSongs: Number(stats.unique_songs),
        dateRange: {
          earliest: unwrapBqValue(stats.earliest_date),
          latest: unwrapBqValue(stats.latest_date),
        },
        topArtists: topArtists.map(r => ({ name: r.artist, plays: Number(r.plays) })),
        topSongs: topSongs.map(r => ({ artist: r.artist, song: r.song_title, plays: Number(r.plays) }))
      });
    } catch (err) {
      console.error('Error fetching overview:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

