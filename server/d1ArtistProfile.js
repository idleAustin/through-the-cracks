// Cloudflare D1 Artist Profile query module returning full profile data via the shared Web-API builder.
import { buildArtistProfile, computeArtistRank, normalizeArtistKey, pickArtistDisplayName } from './artistProfileBuilder.js';
import { qAll, qFirst, withCache } from './d1Queries.js';

const SPIN_ROWS_SQL = `SELECT
  sp.episode_id AS episode_id,
  sp.air_date AS air_date,
  e.episode_number AS episode_number,
  e.title AS episode_title,
  CASE
    WHEN e.song_count > 0 THEN e.song_count
    ELSE (SELECT COUNT(1) FROM song_plays sp2 WHERE sp2.episode_id = sp.episode_id)
  END AS episode_song_count,
  sp.position AS position,
  sp.artist AS artist,
  sp.song_title AS song_title,
  sp.album AS album,
  e.url AS blogger_url
FROM song_plays sp
LEFT JOIN episodes e ON e.id = sp.episode_id
WHERE LOWER(TRIM(sp.artist)) = ?
ORDER BY sp.air_date DESC, sp.episode_id DESC, sp.position ASC`;

const ARCHIVE_TOTALS_SQL = `SELECT
  (SELECT COUNT(1) FROM song_plays) AS total_spins,
  (SELECT COUNT(1) FROM episodes) AS total_episodes,
  (SELECT MIN(air_date) FROM episodes) AS earliest_date,
  (SELECT MAX(air_date) FROM episodes) AS latest_date`;

const YEAR_SPINS_SQL = `SELECT CAST(SUBSTR(air_date, 1, 4) AS INTEGER) AS year, COUNT(1) AS spins
FROM song_plays
GROUP BY year
ORDER BY year ASC`;

const ARTIST_COUNTS_SQL = `SELECT LOWER(TRIM(artist)) AS ak, COUNT(1) AS spins
FROM song_plays
WHERE LENGTH(TRIM(artist)) > 0
GROUP BY ak`;

const CO_OCCURRENCE_SQL = `WITH artist_eps AS (
  SELECT DISTINCT episode_id FROM song_plays WHERE LOWER(TRIM(artist)) = ?
),
co_counts AS (
  SELECT LOWER(TRIM(sp.artist)) AS ak, COUNT(DISTINCT sp.episode_id) AS shared_episodes
  FROM artist_eps ae
  JOIN song_plays sp ON sp.episode_id = ae.episode_id
  WHERE LOWER(TRIM(sp.artist)) != ? AND LENGTH(TRIM(sp.artist)) > 0
  GROUP BY ak
),
neighbor_variants AS (
  SELECT LOWER(TRIM(sp.artist)) AS ak, TRIM(sp.artist) AS name, COUNT(1) AS spins, MIN(sp.air_date) AS air_date
  FROM song_plays sp
  WHERE LOWER(TRIM(sp.artist)) IN (SELECT ak FROM co_counts)
  GROUP BY ak, TRIM(sp.artist)
)
SELECT nv.ak, nv.name, nv.spins, nv.air_date, cc.shared_episodes
FROM neighbor_variants nv
JOIN co_counts cc ON cc.ak = nv.ak`;

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
  return Array.from({ length: maxYear - minYear + 1 }, (_, i) => ({
    year: minYear + i,
    spins: counts.get(minYear + i) ?? 0,
  }));
}

export async function getD1ArtistProfile(db, artistName) {
  const key = normalizeArtistKey(artistName);
  if (!key) return null;

  return withCache(db, `artistProfile:${key}`, async () => {
    const spinRows = await qAll(db, SPIN_ROWS_SQL, [key]);
    if (spinRows.length === 0) return null;

    const [archiveRow, yearRows, artistCountRows, coRows] = await Promise.all([
      qFirst(db, ARCHIVE_TOTALS_SQL),
      qAll(db, YEAR_SPINS_SQL),
      qAll(db, ARTIST_COUNTS_SQL),
      qAll(db, CO_OCCURRENCE_SQL, [key, key]),
    ]);

    const rows = spinRows.map((r) => ({
      episodeId: String(r.episode_id),
      airDate: r.air_date,
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

    const allCounts = artistCountRows.map((r) => Number(r.spins));
    const countByKey = new Map(artistCountRows.map((r) => [r.ak, Number(r.spins)]));
    const { rank, totalArtists } = computeArtistRank(rows.length, allCounts);

    const sortedDesc = [...allCounts].sort((a, b) => b - a);
    const rankBySpins = new Map();
    for (let i = 0; i < sortedDesc.length; i += 1) {
      if (!rankBySpins.has(sortedDesc[i])) rankBySpins.set(sortedDesc[i], i + 1);
    }

    const neighborMap = new Map();
    for (const r of coRows) {
      let entry = neighborMap.get(r.ak);
      if (!entry) { entry = { sharedEpisodes: Number(r.shared_episodes), variants: [] }; neighborMap.set(r.ak, entry); }
      entry.variants.push({ name: r.name, spins: Number(r.spins), airDate: r.air_date });
    }

    const coOccurrences = Array.from(neighborMap.entries()).map(([ak, entry]) => ({
      name: pickArtistDisplayName(entry.variants),
      sharedEpisodes: entry.sharedEpisodes,
      rank: rankBySpins.get(countByKey.get(ak)) ?? totalArtists,
    }));

    const earliest = archiveRow?.earliest_date ?? null;
    const latest = archiveRow?.latest_date ?? null;
    const archive = {
      totalSpins: Number(archiveRow?.total_spins ?? 0),
      totalEpisodes: Number(archiveRow?.total_episodes ?? 0),
      dateRange: { earliest, latest },
      years: buildArchiveYears(yearRows, earliest, latest),
    };

    return buildArtistProfile({ rows, coOccurrences, rank, totalArtists, archive });
  });
}
