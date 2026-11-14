// Cloudflare D1 Artist Profile query module returning full profile data via the shared Web-API builder.
import {
  buildArchiveYearAxis,
  buildArtistProfile,
  buildCoOccurrences,
  buildRankMap,
  computeArtistRank,
  mapProfileSpinRow,
  normalizeArtistKey,
} from './artistProfileBuilder.js';
import { qAll, qFirst, withCache } from './d1Queries.js';

const SPIN_ROWS_SQL = `SELECT
  sp.episode_id AS episode_id,
  sp.air_date AS air_date,
  e.episode_number AS episode_number,
  CASE
    WHEN e.song_count > 0 THEN e.song_count
    ELSE (SELECT COUNT(1) FROM song_plays sp2 WHERE sp2.episode_id = sp.episode_id)
  END AS episode_song_count,
  sp.position AS position,
  sp.artist AS artist,
  sp.featured_artist AS featured_artist,
  sp.song_title AS song_title,
  sp.album AS album,
  sp.release_kind AS release_kind
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
SELECT nv.ak AS neighbor_key, nv.name, nv.spins, nv.air_date, cc.shared_episodes
FROM neighbor_variants nv
JOIN co_counts cc ON cc.ak = nv.ak`;

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

    const rows = spinRows.map(mapProfileSpinRow);
    const countByKey = new Map(artistCountRows.map((r) => [r.ak, Number(r.spins)]));
    const rankByKey = buildRankMap(countByKey);
    const totalArtists = countByKey.size;
    const rank = rankByKey.get(key) ?? computeArtistRank(rows.length, countByKey.values()).rank;
    const coOccurrences = buildCoOccurrences(coRows, null, rankByKey);

    const earliest = archiveRow?.earliest_date ?? null;
    const latest = archiveRow?.latest_date ?? null;
    const archive = {
      totalSpins: Number(archiveRow?.total_spins ?? 0),
      totalEpisodes: Number(archiveRow?.total_episodes ?? 0),
      dateRange: { earliest, latest },
      years: buildArchiveYearAxis(yearRows, 'year', { earliest, latest }),
    };

    return buildArtistProfile({ rows, coOccurrences, rank, totalArtists, archive });
  });
}
