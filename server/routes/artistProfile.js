// Read-only Artist Profile HTTP route handler backed by BigQuery and the shared profile builder.
import express from 'express';
import {
  buildArtistProfile, computeArtistRank, normalizeArtistKey, pickArtistDisplayName,
} from '../artistProfileBuilder.js';
import { unwrapBqValue } from './queryUtils.js';

function buildQueries(project, dataset) {
  const sp = `\`${project}.${dataset}.song_plays\``;
  const ep = `\`${project}.${dataset}.episodes\``;
  return {
    spinRowsSql: `WITH target_spins AS (
      SELECT sp.episode_id, sp.air_date, sp.position, sp.artist, sp.song_title, sp.album
      FROM ${sp} sp WHERE LOWER(TRIM(sp.artist)) = @artistKey
    ), ep_counts AS (
      SELECT sp.episode_id, COUNT(1) AS cnt
      FROM ${sp} sp WHERE sp.episode_id IN (SELECT DISTINCT episode_id FROM target_spins)
      GROUP BY sp.episode_id
    )
    SELECT sp.episode_id, sp.air_date, e.episode_number, e.title AS episode_title,
      CASE WHEN e.song_count > 0 THEN e.song_count ELSE COALESCE(ec.cnt, 0) END AS episode_song_count,
      sp.position, sp.artist, sp.song_title, sp.album, e.url AS blogger_url
    FROM target_spins sp
    LEFT JOIN ${ep} e ON e.id = sp.episode_id
    LEFT JOIN ep_counts ec ON ec.episode_id = sp.episode_id
    ORDER BY sp.air_date DESC, sp.episode_id DESC, sp.position ASC`,
    archiveTotalsSql: `SELECT (SELECT COUNT(1) FROM ${sp}) AS total_spins,
      (SELECT COUNT(1) FROM ${ep}) AS total_episodes,
      (SELECT MIN(air_date) FROM ${ep}) AS earliest_date,
      (SELECT MAX(air_date) FROM ${ep}) AS latest_date`,
    yearSpinsSql: `SELECT EXTRACT(YEAR FROM air_date) AS year, COUNT(1) AS spins
      FROM ${sp} GROUP BY year ORDER BY year ASC`,
    artistCountsSql: `SELECT LOWER(TRIM(artist)) AS ak, COUNT(1) AS spins
      FROM ${sp} WHERE LENGTH(TRIM(artist)) > 0 GROUP BY ak`,
    coOccurrenceSql: `WITH artist_eps AS (
      SELECT DISTINCT sp.episode_id FROM ${sp} sp WHERE LOWER(TRIM(sp.artist)) = @artistKey
    ), co_counts AS (
      SELECT LOWER(TRIM(sp.artist)) AS ak, COUNT(DISTINCT sp.episode_id) AS shared_episodes
      FROM artist_eps ae JOIN ${sp} sp ON sp.episode_id = ae.episode_id
      WHERE LOWER(TRIM(sp.artist)) != @artistKey AND LENGTH(TRIM(sp.artist)) > 0
      GROUP BY ak
    ), neighbor_variants AS (
      SELECT LOWER(TRIM(sp.artist)) AS ak, TRIM(sp.artist) AS name, COUNT(1) AS spins, MIN(sp.air_date) AS air_date
      FROM ${sp} sp WHERE LOWER(TRIM(sp.artist)) IN (SELECT ak FROM co_counts)
      GROUP BY ak, name
    )
    SELECT nv.ak, nv.name, nv.spins, nv.air_date, cc.shared_episodes
    FROM neighbor_variants nv JOIN co_counts cc ON cc.ak = nv.ak`,
  };
}

function buildArchiveYears(yearRows, earliestDate, latestDate) {
  let minYear = 2013;
  let maxYear = 2026;
  const counts = new Map();
  for (const r of yearRows) {
    const yr = Number(r.year);
    if (yr >= 2000 && yr < minYear) minYear = yr;
    if (yr > maxYear) maxYear = yr;
    counts.set(yr, Number(r.spins));
  }
  const ey = Number(String(earliestDate || '').slice(0, 4));
  const ly = Number(String(latestDate || '').slice(0, 4));
  if (ey >= 2000 && ey < minYear) minYear = ey;
  if (ly > maxYear) maxYear = ly;
  return Array.from({ length: maxYear - minYear + 1 }, (_, i) => ({ year: minYear + i, spins: counts.get(minYear + i) ?? 0 }));
}

function mapSpinRows(spinRows) {
  return spinRows.map((r) => ({
    episodeId: String(r.episode_id),
    airDate: unwrapBqValue(r.air_date),
    episodeNumber: r.episode_number == null ? null : Number(r.episode_number),
    episodeTitle: r.episode_title || '',
    episodeSongCount: Number(r.episode_song_count ?? 0),
    position: Number(r.position),
    artist: r.artist || '',
    song: r.song_title || '',
    songTitle: r.song_title || '',
    album: r.album || '',
    bloggerUrl: r.blogger_url || null,
  }));
}

function buildCoOccurrences(coRows, countByKey, totalArtists) {
  const sortedDesc = Array.from(countByKey.values()).sort((a, b) => b - a);
  const rankBySpins = new Map();
  for (let i = 0; i < sortedDesc.length; i += 1) {
    if (!rankBySpins.has(sortedDesc[i])) rankBySpins.set(sortedDesc[i], i + 1);
  }
  const neighborMap = new Map();
  for (const r of coRows) {
    let entry = neighborMap.get(r.ak);
    if (!entry) neighborMap.set(r.ak, (entry = { sharedEpisodes: Number(r.shared_episodes), variants: [] }));
    entry.variants.push({ name: r.name, spins: Number(r.spins), airDate: unwrapBqValue(r.air_date) });
  }
  return Array.from(neighborMap.entries()).map(([ak, entry]) => ({
    name: pickArtistDisplayName(entry.variants),
    sharedEpisodes: entry.sharedEpisodes,
    rank: rankBySpins.get(countByKey.get(ak)) ?? totalArtists,
  }));
}

export function createArtistProfileRouter({ query, project, dataset }) {
  const router = express.Router();
  const sql = buildQueries(project, dataset);

  router.get('/artists/:name/profile', async (req, res) => {
    try {
      const key = normalizeArtistKey(req.params.name);
      if (!key) return res.status(400).json({ error: 'Artist name is required' });

      const spinRows = await query(sql.spinRowsSql, { artistKey: key });
      if (spinRows.length === 0) return res.status(404).json({ error: 'Artist not found' });

      const [archiveRows, yearRows, artistCountRows, coRows] = await Promise.all([
        query(sql.archiveTotalsSql),
        query(sql.yearSpinsSql),
        query(sql.artistCountsSql),
        query(sql.coOccurrenceSql, { artistKey: key }),
      ]);

      const rows = mapSpinRows(spinRows);
      const countByKey = new Map(artistCountRows.map((r) => [r.ak, Number(r.spins)]));
      const { rank, totalArtists } = computeArtistRank(rows.length, countByKey.values());
      const coOccurrences = buildCoOccurrences(coRows, countByKey, totalArtists);
      const archiveRow = archiveRows[0] || {};
      const earliest = unwrapBqValue(archiveRow.earliest_date) ?? null;
      const latest = unwrapBqValue(archiveRow.latest_date) ?? null;
      const archive = {
        totalSpins: Number(archiveRow.total_spins ?? 0),
        totalEpisodes: Number(archiveRow.total_episodes ?? 0),
        dateRange: { earliest, latest },
        years: buildArchiveYears(yearRows, earliest, latest),
      };

      const profile = buildArtistProfile({ rows, coOccurrences, rank, totalArtists, archive });
      return profile ? res.json(profile) : res.status(404).json({ error: 'Artist not found' });
    } catch (err) {
      console.error('Error fetching artist profile:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
