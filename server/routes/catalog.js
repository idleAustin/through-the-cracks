// Read-only artists, songs, artist-songs, and unified search HTTP route handlers.
import express from 'express';
import { escapeSqlString, parsePageParams, unwrapBqValue } from './queryUtils.js';

export function createCatalogRouter({ query, project, dataset }) {
  const router = express.Router();

  router.get('/artists', async (req, res) => {
    try {
      const search = (req.query.search || '').trim().toLowerCase();
      const { page, limit, offset } = parsePageParams(req.query);

      let whereClause = '';
      if (search) {
        whereClause = `WHERE LOWER(artist) LIKE '%${escapeSqlString(search)}%'`;
      }

      const listQuery = `
        SELECT
          artist AS name,
          COUNT(1) AS total_plays,
          COUNT(DISTINCT LOWER(song_title)) AS unique_songs,
          COUNT(DISTINCT LOWER(album)) AS unique_albums,
          MIN(air_date) AS first_appearance,
          MAX(air_date) AS last_appearance
        FROM \`${project}.${dataset}.song_plays\`
        ${whereClause}
        GROUP BY artist
        ORDER BY total_plays DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const countQuery = `
        SELECT COUNT(DISTINCT artist) AS total
        FROM \`${project}.${dataset}.song_plays\`
        ${whereClause}
      `;

      const rows = await query(listQuery);
      const [countRow] = await query(countQuery);

      res.json({
        artists: rows.map(r => ({
          name: r.name,
          totalPlays: Number(r.total_plays),
          uniqueSongs: Number(r.unique_songs),
          uniqueAlbums: Number(r.unique_albums),
          firstAppearance: unwrapBqValue(r.first_appearance),
          lastAppearance: unwrapBqValue(r.last_appearance),
        })),
        pagination: {
          page,
          limit,
          total: Number(countRow.total),
          totalPages: Math.ceil(Number(countRow.total) / limit)
        }
      });
    } catch (err) {
      console.error('Error fetching artists:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/search', async (req, res) => {
    try {
      const q = (req.query.q || '').trim().toLowerCase();
      if (!q || q.length < 2) {
        return res.json({ artists: [], songs: [], albums: [] });
      }

      const escapedQ = escapeSqlString(q);

      const artistQuery = `
        SELECT artist AS name, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        WHERE LOWER(artist) LIKE '%${escapedQ}%'
        GROUP BY artist
        ORDER BY plays DESC
        LIMIT 10
      `;

      const songQuery = `
        SELECT artist, song_title, album, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        WHERE LOWER(song_title) LIKE '%${escapedQ}%'
        GROUP BY artist, song_title, album
        ORDER BY plays DESC
        LIMIT 10
      `;

      const albumQuery = `
        SELECT artist, album, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        WHERE LOWER(album) LIKE '%${escapedQ}%'
        GROUP BY artist, album
        ORDER BY plays DESC
        LIMIT 10
      `;

      const [artists, songs, albums] = await Promise.all([
        query(artistQuery),
        query(songQuery),
        query(albumQuery)
      ]);

      res.json({
        artists: artists.map(r => ({ name: r.name, plays: Number(r.plays) })),
        songs: songs.map(r => ({ artist: r.artist, songTitle: r.song_title, album: r.album, plays: Number(r.plays) })),
        albums: albums.map(r => ({ artist: r.artist, album: r.album, plays: Number(r.plays) }))
      });
    } catch (err) {
      console.error('Error executing search:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/songs', async (req, res) => {
    try {
      const search = (req.query.search || '').trim().toLowerCase();
      const { page, limit, offset } = parsePageParams(req.query);

      let whereClause = '';
      if (search) {
        const escaped = escapeSqlString(search);
        whereClause = `WHERE LOWER(artist) LIKE '%${escaped}%' OR LOWER(song_title) LIKE '%${escaped}%'`;
      }

      const listQuery = `
        SELECT
          artist,
          song_title,
          ARRAY_AGG(album ORDER BY cnt DESC LIMIT 1)[OFFSET(0)] AS album,
          SUM(cnt) AS total_plays,
          MIN(first_played) AS first_played,
          MAX(last_played) AS last_played
        FROM (
          SELECT
            artist,
            song_title,
            album,
            COUNT(1) AS cnt,
            MIN(air_date) AS first_played,
            MAX(air_date) AS last_played
          FROM \`${project}.${dataset}.song_plays\`
          ${whereClause}
          GROUP BY artist, song_title, album
        )
        GROUP BY artist, song_title
        ORDER BY total_plays DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const countQuery = `
        SELECT COUNT(1) AS total FROM (
          SELECT 1
          FROM \`${project}.${dataset}.song_plays\`
          ${whereClause}
          GROUP BY artist, song_title
        )
      `;

      const rows = await query(listQuery);
      const [countRow] = await query(countQuery);

      res.json({
        songs: rows.map(r => ({
          artist: r.artist,
          songTitle: r.song_title,
          album: r.album || '',
          totalPlays: Number(r.total_plays),
          firstPlayed: unwrapBqValue(r.first_played),
          lastPlayed: unwrapBqValue(r.last_played),
        })),
        pagination: {
          page,
          limit,
          total: Number(countRow.total),
          totalPages: Math.ceil(Number(countRow.total) / limit)
        }
      });
    } catch (err) {
      console.error('Error fetching songs:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/artists/:name/songs', async (req, res) => {
    try {
      const artistName = req.params.name;

      const listQuery = `
        SELECT
          song_title,
          ARRAY_AGG(album ORDER BY cnt DESC LIMIT 1)[OFFSET(0)] AS album,
          SUM(cnt) AS total_plays,
          MIN(first_played) AS first_played,
          MAX(last_played) AS last_played
        FROM (
          SELECT
            song_title,
            album,
            COUNT(1) AS cnt,
            MIN(air_date) AS first_played,
            MAX(air_date) AS last_played
          FROM \`${project}.${dataset}.song_plays\`
          WHERE artist = @artistName
          GROUP BY song_title, album
        )
        GROUP BY song_title
        ORDER BY total_plays DESC
      `;

      const summaryQuery = `
        SELECT
          COUNT(1) AS total_plays,
          COUNT(DISTINCT LOWER(song_title)) AS unique_songs,
          COUNT(DISTINCT LOWER(album)) AS unique_albums,
          MIN(air_date) AS first_appearance,
          MAX(air_date) AS last_appearance
        FROM \`${project}.${dataset}.song_plays\`
        WHERE artist = @artistName
      `;

      const [rows, summaryRows] = await Promise.all([
        query(listQuery, { artistName }),
        query(summaryQuery, { artistName })
      ]);

      const summary = summaryRows[0] || {};

      res.json({
        artist: artistName,
        summary: {
          totalPlays: Number(summary.total_plays || 0),
          uniqueSongs: Number(summary.unique_songs || 0),
          uniqueAlbums: Number(summary.unique_albums || 0),
          firstAppearance: unwrapBqValue(summary.first_appearance) || '',
          lastAppearance: unwrapBqValue(summary.last_appearance) || '',
        },
        songs: rows.map(r => ({
          songTitle: r.song_title,
          album: r.album || '',
          totalPlays: Number(r.total_plays),
          firstPlayed: unwrapBqValue(r.first_played),
          lastPlayed: unwrapBqValue(r.last_played),
        }))
      });
    } catch (err) {
      console.error('Error fetching artist songs:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

