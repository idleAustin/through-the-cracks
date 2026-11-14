// Read-only overview telemetry, leaderboard, and annual spin volume HTTP route handlers.
import express from 'express';
import { unwrapBqValue } from './queryUtils.js';

const ARCHIVE_YEARS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

export function createOverviewRouter({ query, project, dataset }) {
  const router = express.Router();

  router.get('/overview', async (_req, res) => {
    try {
      const statsQuery = `
        SELECT
          (SELECT COUNT(1) FROM \`${project}.${dataset}.episodes\`) AS total_episodes,
          (SELECT COUNT(1) FROM \`${project}.${dataset}.song_plays\`) AS total_song_plays,
          (SELECT COUNT(DISTINCT LOWER(artist)) FROM \`${project}.${dataset}.song_plays\`) AS unique_artists,
          (SELECT COUNT(DISTINCT IF(LENGTH(TRIM(COALESCE(album, ''))) > 0, CONCAT(LOWER(TRIM(artist)), '|||', LOWER(TRIM(album))), NULL)) FROM \`${project}.${dataset}.song_plays\`) AS unique_albums,
          (SELECT COUNT(DISTINCT CONCAT(LOWER(artist), '|||', LOWER(song_title))) FROM \`${project}.${dataset}.song_plays\`) AS unique_songs,
          (SELECT MIN(air_date) FROM \`${project}.${dataset}.episodes\`) AS earliest_date,
          (SELECT MAX(air_date) FROM \`${project}.${dataset}.episodes\`) AS latest_date,
          (SELECT id FROM \`${project}.${dataset}.episodes\` ORDER BY air_date DESC, id DESC LIMIT 1) AS latest_episode_id,
          (SELECT COUNT(1) FROM (SELECT 1 FROM \`${project}.${dataset}.song_plays\` GROUP BY LOWER(artist) HAVING COUNT(1) = 1)) AS one_spin_artists,
          (SELECT COUNT(1) FROM (SELECT 1 FROM \`${project}.${dataset}.song_plays\` GROUP BY LOWER(artist), LOWER(song_title) HAVING COUNT(1) = 1)) AS one_spin_songs
      `;

      const topArtistsQuery = `
        SELECT artist, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        GROUP BY artist
        ORDER BY plays DESC
        LIMIT 10
      `;

      const topSongsQuery = `
        SELECT artist, song_title, COUNT(1) AS plays, COALESCE(MAX(NULLIF(TRIM(album), '')), '') AS album
        FROM \`${project}.${dataset}.song_plays\`
        GROUP BY artist, song_title
        ORDER BY plays DESC
        LIMIT 10
      `;

      const [statsRows, topArtists, topSongs] = await Promise.all([
        query(statsQuery),
        query(topArtistsQuery),
        query(topSongsQuery),
      ]);
      const stats = statsRows[0] || {};

      res.json({
        totalEpisodes: Number(stats.total_episodes ?? 0),
        totalSongPlays: Number(stats.total_song_plays ?? 0),
        uniqueArtists: Number(stats.unique_artists ?? 0),
        uniqueAlbums: Number(stats.unique_albums ?? 0),
        uniqueSongs: Number(stats.unique_songs ?? 0),
        latestEpisodeId: stats.latest_episode_id ? String(stats.latest_episode_id) : null,
        oneSpinArtists: Number(stats.one_spin_artists ?? 0),
        oneSpinSongs: Number(stats.one_spin_songs ?? 0),
        dateRange: {
          earliest: unwrapBqValue(stats.earliest_date),
          latest: unwrapBqValue(stats.latest_date),
        },
        topArtists: topArtists.map(r => ({ name: r.artist, plays: Number(r.plays) })),
        topSongs: topSongs.map(r => ({
          artist: r.artist,
          song: r.song_title,
          album: r.album || '',
          plays: Number(r.plays),
        })),
      });
    } catch (err) {
      console.error('Error fetching overview:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/years', async (req, res) => {
    try {
      const artist = typeof req.query.artist === 'string' ? req.query.artist.trim() : '';
      const song = typeof req.query.song === 'string' ? req.query.song.trim() : '';

      const conditions = [];
      const params = {};
      if (artist) {
        conditions.push('LOWER(artist) = LOWER(@artist)');
        params.artist = artist;
      }
      if (song) {
        conditions.push('LOWER(song_title) = LOWER(@song)');
        params.song = song;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const yearsQuery = `
        SELECT EXTRACT(YEAR FROM air_date) AS year, COUNT(1) AS spins
        FROM \`${project}.${dataset}.song_plays\`
        ${whereClause}
        GROUP BY year
        ORDER BY year ASC
      `;

      const rows = await query(yearsQuery, params);
      const countsByYear = new Map(rows.map(r => [Number(r.year), Number(r.spins)]));

      res.json({
        years: ARCHIVE_YEARS,
        spins: ARCHIVE_YEARS.map(year => countsByYear.get(year) ?? 0),
        scope: song ? 'song' : artist ? 'artist' : 'archive',
        artist: artist || null,
        song: song || null,
      });
    } catch (err) {
      console.error('Error fetching annual spins:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
