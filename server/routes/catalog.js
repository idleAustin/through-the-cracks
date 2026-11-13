// Read-only artists, songs, artist-songs, and unified search HTTP route handlers.
import express from 'express';
import {
  computeCappedPagination,
  parseCapParam,
  parsePageParams,
  parseSortParam,
  unwrapBqValue,
} from './queryUtils.js';

function parseCatalogParams(queryParams) {
  const search = typeof queryParams.search === 'string' ? queryParams.search.trim().toLowerCase() : '';
  const sort = parseSortParam(queryParams.sort);
  const cap = parseCapParam(queryParams.cap);
  const { page, limit } = parsePageParams(queryParams);
  const params = search ? { searchLike: `%${search}%` } : {};
  return { search, sort, cap, page, limit, params };
}

async function runCappedCatalogQuery({ query, countQuery, buildListQuery, params, cap, page, limit }) {
  const [countRow] = await query(countQuery, params);
  const rawTotal = Number(countRow?.total ?? 0);
  const { total, effectiveLimit, offset, totalPages } = computeCappedPagination({
    rawTotal,
    cap,
    page,
    limit,
  });
  const rows = effectiveLimit > 0 ? await query(buildListQuery(effectiveLimit, offset), params) : [];
  return { rows, total, rawTotal, pagination: { page, limit, total, totalPages } };
}

export function createCatalogRouter({ query, project, dataset }) {
  const router = express.Router();

  router.get('/artists', async (req, res) => {
    try {
      const { search, sort, cap, page, limit, params } = parseCatalogParams(req.query);
      const whereClause = search ? 'WHERE LOWER(artist) LIKE @searchLike' : '';
      const orderBy = sort === 'obscure'
        ? 'ORDER BY total_plays ASC, first_appearance ASC, LOWER(artist) ASC'
        : 'ORDER BY total_plays DESC, LOWER(artist) ASC';

      const countQuery = `
        SELECT COUNT(DISTINCT artist) AS total
        FROM \`${project}.${dataset}.song_plays\`
        ${whereClause}
      `;

      const buildListQuery = (effectiveLimit, offset) => `
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
        ${orderBy}
        LIMIT ${effectiveLimit} OFFSET ${offset}
      `;

      const { rows, total, rawTotal, pagination } = await runCappedCatalogQuery({
        query,
        countQuery,
        buildListQuery,
        params,
        cap,
        page,
        limit,
      });

      const items = rows.map(r => ({
        name: r.name,
        totalPlays: Number(r.total_plays),
        uniqueSongs: Number(r.unique_songs),
        uniqueAlbums: Number(r.unique_albums),
        firstAppearance: unwrapBqValue(r.first_appearance),
        lastAppearance: unwrapBqValue(r.last_appearance),
      }));

      res.json({
        items,
        artists: items,
        total,
        unboundedTotal: rawTotal,
        page,
        limit,
        pagination,
      });
    } catch (err) {
      console.error('Error fetching artists:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/search', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      if (!q || q.length < 2) {
        return res.json({ artists: [], songs: [], albums: [] });
      }

      const params = { searchLike: `%${q}%` };

      const artistQuery = `
        SELECT
          artist AS name,
          COUNT(1) AS plays,
          COUNT(DISTINCT LOWER(song_title)) AS unique_songs
        FROM \`${project}.${dataset}.song_plays\`
        WHERE LOWER(artist) LIKE @searchLike
        GROUP BY artist
        ORDER BY plays DESC
        LIMIT 10
      `;

      const songQuery = `
        SELECT artist, song_title, album, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        WHERE LOWER(song_title) LIKE @searchLike
        GROUP BY artist, song_title, album
        ORDER BY plays DESC
        LIMIT 10
      `;

      const albumQuery = `
        SELECT artist, album, COUNT(1) AS plays
        FROM \`${project}.${dataset}.song_plays\`
        WHERE LOWER(album) LIKE @searchLike
        GROUP BY artist, album
        ORDER BY plays DESC
        LIMIT 10
      `;

      const [artists, songs, albums] = await Promise.all([
        query(artistQuery, params),
        query(songQuery, params),
        query(albumQuery, params),
      ]);

      res.json({
        artists: artists.map(r => ({
          name: r.name,
          plays: Number(r.plays),
          uniqueSongs: Number(r.unique_songs ?? 0),
        })),
        songs: songs.map(r => ({ artist: r.artist, songTitle: r.song_title, album: r.album, plays: Number(r.plays) })),
        albums: albums.map(r => ({ artist: r.artist, album: r.album, plays: Number(r.plays) })),
      });
    } catch (err) {
      console.error('Error executing search:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/songs', async (req, res) => {
    try {
      const { search, sort, cap, page, limit, params } = parseCatalogParams(req.query);
      const whereClause = search
        ? 'WHERE LOWER(artist) LIKE @searchLike OR LOWER(song_title) LIKE @searchLike OR LOWER(album) LIKE @searchLike'
        : '';
      const orderBy = sort === 'obscure'
        ? 'ORDER BY total_plays ASC, first_played ASC, LOWER(song_title) ASC, LOWER(artist) ASC'
        : 'ORDER BY total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC';

      const countQuery = `
        SELECT COUNT(1) AS total FROM (
          SELECT 1
          FROM \`${project}.${dataset}.song_plays\`
          ${whereClause}
          GROUP BY artist, song_title
        )
      `;

      const buildListQuery = (effectiveLimit, offset) => `
        SELECT
          artist,
          song_title,
          ARRAY_AGG(album ORDER BY IF(album != '', 1, 0) DESC, cnt DESC LIMIT 1)[OFFSET(0)] AS album,
          SUM(cnt) AS total_plays,
          MIN(first_played) AS first_played,
          MAX(last_played) AS last_played
        FROM (
          SELECT
            artist,
            song_title,
            COALESCE(TRIM(album), '') AS album,
            COUNT(1) AS cnt,
            MIN(air_date) AS first_played,
            MAX(air_date) AS last_played
          FROM \`${project}.${dataset}.song_plays\`
          ${whereClause}
          GROUP BY artist, song_title, album
        )
        GROUP BY artist, song_title
        ${orderBy}
        LIMIT ${effectiveLimit} OFFSET ${offset}
      `;

      const { rows, total, rawTotal, pagination } = await runCappedCatalogQuery({
        query,
        countQuery,
        buildListQuery,
        params,
        cap,
        page,
        limit,
      });

      const items = rows.map(r => ({
        artist: r.artist,
        songTitle: r.song_title,
        album: r.album || '',
        totalPlays: Number(r.total_plays),
        firstPlayed: unwrapBqValue(r.first_played),
        lastPlayed: unwrapBqValue(r.last_played),
      }));

      res.json({
        items,
        songs: items,
        total,
        unboundedTotal: rawTotal,
        page,
        limit,
        pagination,
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
          ARRAY_AGG(album ORDER BY IF(album != '', 1, 0) DESC, cnt DESC LIMIT 1)[OFFSET(0)] AS album,
          ARRAY_AGG(IF(album != '', album, NULL) IGNORE NULLS ORDER BY cnt DESC, LOWER(album) ASC) AS albums,
          SUM(cnt) AS total_plays,
          MIN(first_played) AS first_played,
          MAX(last_played) AS last_played
        FROM (
          SELECT
            song_title,
            COALESCE(TRIM(album), '') AS album,
            COUNT(1) AS cnt,
            MIN(air_date) AS first_played,
            MAX(air_date) AS last_played
          FROM \`${project}.${dataset}.song_plays\`
          WHERE artist = @artistName
          GROUP BY song_title, album
        )
        GROUP BY song_title
        ORDER BY total_plays DESC, LOWER(song_title) ASC
      `;

      const albumsQuery = `
        SELECT
          TRIM(album) AS album,
          COUNT(1) AS total_plays
        FROM \`${project}.${dataset}.song_plays\`
        WHERE artist = @artistName AND album IS NOT NULL AND LENGTH(TRIM(album)) > 0
        GROUP BY album
        ORDER BY total_plays DESC, LOWER(album) ASC
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

      const [rows, albumRows, summaryRows] = await Promise.all([
        query(listQuery, { artistName }),
        query(albumsQuery, { artistName }),
        query(summaryQuery, { artistName }),
      ]);

      const summary = summaryRows[0] || {};
      const songs = rows.map(r => {
        const songAlbums = Array.isArray(r.albums)
          ? [...new Set(r.albums.map(a => (a || '').trim()).filter(Boolean))]
          : (r.album ? [r.album] : []);
        return {
          songTitle: r.song_title,
          album: r.album || songAlbums[0] || '',
          albums: songAlbums,
          totalPlays: Number(r.total_plays),
          firstPlayed: unwrapBqValue(r.first_played),
          lastPlayed: unwrapBqValue(r.last_played),
        };
      });

      const albums = albumRows.length > 0
        ? [...new Set(albumRows.map(r => (r.album || '').trim()).filter(Boolean))]
        : [...new Set(songs.flatMap(s => s.albums))];

      res.json({
        artist: artistName,
        summary: {
          totalPlays: Number(summary.total_plays || 0),
          uniqueSongs: Number(summary.unique_songs || 0),
          uniqueAlbums: Number(summary.unique_albums || 0),
          firstAppearance: unwrapBqValue(summary.first_appearance) || '',
          lastAppearance: unwrapBqValue(summary.last_appearance) || '',
        },
        albums,
        songs,
      });
    } catch (err) {
      console.error('Error fetching artist songs:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
