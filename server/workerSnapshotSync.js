// Pure Web-API D1-to-R2 snapshot builder and uploader for Worker ingest and Cron refreshes.
import { buildArchiveYearAxis } from './artistProfileBuilder.js';
import { loadD1PlaylistPool } from './d1Playlist.js';
import { clearD1Cache, qAll, qFirst, readCacheBlob } from './d1Rollups.js';
import { toPlaylistSongItem } from './playlistBuilder.js';

const JSON_CT = 'application/json; charset=utf-8';
const R2_MANIFEST_KEY = 'v1/manifest.json';
const R2_SONG_LINKS_KEY = 'v1/song-links.json';

const cmpAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpText = (a, b) => cmpAsc(String(a || '').toLowerCase(), String(b || '').toLowerCase());
const isMissingTableError = (err) => /no such table/i.test(String(err?.message ?? err));
const putR2Json = (bucket, key, payload) =>
  bucket.put(key, JSON.stringify(payload), { httpMetadata: { contentType: JSON_CT } });

async function loadCompactSongLinks(db) {
  clearD1Cache(db);
  try {
    const pool = await loadD1PlaylistPool(db);
    return pool.map(toPlaylistSongItem).filter((item) => Boolean(item.videoId));
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

async function readExistingManifest(bucket) {
  if (typeof bucket.get !== 'function') return null;
  try {
    const obj = await bucket.get(R2_MANIFEST_KEY);
    if (!obj) return null;
    const data = typeof obj.json === 'function' ? await obj.json() : JSON.parse(await obj.text());
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function computeManifestCountsFromD1(db) {
  try {
    const [epRow, latestRow, playRow] = await Promise.all([
      qFirst(db, 'SELECT COUNT(1) AS total_episodes FROM episodes'),
      qFirst(db, 'SELECT id FROM episodes ORDER BY air_date DESC, id DESC LIMIT 1'),
      qFirst(db, 'SELECT COUNT(1) AS total_song_plays FROM song_plays'),
    ]);
    return {
      totalEpisodes: Number(epRow?.total_episodes ?? 0),
      totalSongPlays: Number(playRow?.total_song_plays ?? 0),
      latestEpisodeId: latestRow?.id ? String(latestRow.id) : null,
    };
  } catch (err) {
    if (isMissingTableError(err)) {
      return { totalEpisodes: 0, totalSongPlays: 0, latestEpisodeId: null };
    }
    throw err;
  }
}

async function getD1ManifestCounts(db) {
  try {
    const overview = await readCacheBlob(db, 'overview');
    if (overview && typeof overview === 'object') {
      return {
        totalEpisodes: Number(overview.totalEpisodes ?? 0),
        totalSongPlays: Number(overview.totalSongPlays ?? 0),
        latestEpisodeId: overview.latestEpisodeId ? String(overview.latestEpisodeId) : null,
      };
    }
  } catch { /* fall back to direct table counts */ }
  return computeManifestCountsFromD1(db);
}

/**
 * Returns true when an existing R2 v1/manifest.json has drifted from D1 episode/spin totals.
 */
export async function isR2ArchiveOutOfSync(db, bucket) {
  if (!db || !bucket) return false;
  const existing = await readExistingManifest(bucket);
  if (!existing) return false;
  const d1 = await getD1ManifestCounts(db);
  return (
    Number(existing.totalEpisodes ?? 0) !== d1.totalEpisodes ||
    Number(existing.totalSongPlays ?? 0) !== d1.totalSongPlays ||
    String(existing.latestEpisodeId || '') !== String(d1.latestEpisodeId || '')
  );
}

/**
 * Chooses full R2 snapshot sync (on episode changes, forceSync, or R2/D1 drift) or song-links-only sync.
 */
export async function syncR2AfterIngest({
  db,
  bucket,
  episodesUpserted = 0,
  linkChangesMade = false,
  forceSync = false,
} = {}) {
  if (!bucket) return { mode: 'skipped', archiveDrift: false };
  const archiveDrift = !forceSync && !(episodesUpserted > 0)
    ? await isR2ArchiveOutOfSync(db, bucket)
    : false;
  if (forceSync || episodesUpserted > 0 || archiveDrift) {
    await syncR2SnapshotsFromD1(db, bucket);
    return { mode: 'full', archiveDrift };
  }
  if (linkChangesMade) {
    await syncR2SongLinksFromD1(db, bucket);
    return { mode: 'song-links', archiveDrift: false };
  }
  return { mode: 'skipped', archiveDrift: false };
}

/**
 * Syncs only v1/song-links.json and v1/manifest.json from D1 into R2 using native bindings.
 */
export async function syncR2SongLinksFromD1(db, bucket, { updatedAt = new Date().toISOString() } = {}) {
  if (!db || !bucket) return null;
  const rows = await loadCompactSongLinks(db);
  const existing = await readExistingManifest(bucket);
  const hasCounts =
    existing &&
    existing.totalEpisodes !== undefined &&
    existing.totalSongPlays !== undefined;
  const counts = hasCounts
    ? {
        totalEpisodes: Number(existing.totalEpisodes ?? 0),
        totalSongPlays: Number(existing.totalSongPlays ?? 0),
        latestEpisodeId: existing.latestEpisodeId ? String(existing.latestEpisodeId) : null,
      }
    : await computeManifestCountsFromD1(db);

  const manifest = {
    version: Number.isFinite(Number(existing?.version)) ? Number(existing.version) : 1,
    updatedAt,
    totalEpisodes: counts.totalEpisodes,
    totalSongPlays: counts.totalSongPlays,
    latestEpisodeId: counts.latestEpisodeId,
  };

  await putR2Json(bucket, R2_SONG_LINKS_KEY, rows);
  await putR2Json(bucket, R2_MANIFEST_KEY, manifest);
  return {
    updatedObjects: [R2_SONG_LINKS_KEY, R2_MANIFEST_KEY],
    songLinksCount: rows.length,
  };
}

function getOrInit(map, key, create) {
  let val = map.get(key);
  if (!val) {
    val = create();
    map.set(key, val);
  }
  return val;
}

function updateBounds(entry, airDate) {
  if (!airDate) return;
  if (!entry.firstAppearance || airDate < entry.firstAppearance) entry.firstAppearance = airDate;
  if (!entry.lastAppearance || airDate > entry.lastAppearance) entry.lastAppearance = airDate;
}

export async function syncR2SnapshotsFromD1(db, bucket, { updatedAt = new Date().toISOString() } = {}) {
  if (!db || !bucket) return null;
  const [episodeRows, playRows, songLinks] = await Promise.all([
    qAll(db, 'SELECT id, air_date, url, song_count FROM episodes ORDER BY air_date DESC, id DESC'),
    qAll(
      db,
      'SELECT episode_id, air_date, position, artist, featured_artist, song_title, album, release_kind FROM song_plays ORDER BY air_date DESC, episode_id DESC, position ASC',
    ),
    loadCompactSongLinks(db),
  ]);

  const playsByEp = new Map();
  for (const row of playRows) getOrInit(playsByEp, String(row.episode_id), () => []).push(row);

  const years = buildArchiveYearAxis(episodeRows, 'air_date').map((y) => y.year);
  const yearIdxMap = new Map(years.map((y, i) => [y, i]));
  const archive = new Array(years.length).fill(0);
  const episodesIndexList = [];
  const songEpisodes = {};
  const playlistsByYear = new Map();
  const artistMap = new Map();
  const albumMap = new Map();
  const songMap = new Map();
  const yearStats = new Map();
  let totalSongPlays = 0;

  for (const ep of episodeRows) {
    const epId = String(ep.id);
    const airDate = String(ep.air_date || '');
    const yearStr = airDate.slice(0, 4);
    const yearIdx = yearIdxMap.get(Number(yearStr));
    const ordered = playsByEp.get(epId) || [];

    episodesIndexList.push({
      id: epId,
      air_date: airDate,
      song_count: ordered.length || Number(ep.song_count ?? 0),
      url: ep.url || null,
    });

    if (yearStr) {
      getOrInit(playlistsByYear, yearStr, () => ({}))[epId] = ordered.map((s) => ({
        position: Number(s.position),
        song: s.song_title || '',
        songTitle: s.song_title || '',
        artist: s.artist || '',
        ...(s.featured_artist ? { featuredArtist: s.featured_artist } : {}),
        album: s.album || '',
        ...(s.release_kind && s.release_kind !== 'album' ? { releaseKind: s.release_kind } : {}),
      }));
    }

    const statYr = yearStr || 'unknown';
    const yStat = getOrInit(yearStats, statYr, () => ({
      year: statYr,
      episodeCount: 0,
      songCount: 0,
      uniqueArtists: new Set(),
    }));
    yStat.episodeCount += 1;
    yStat.songCount += ordered.length;

    for (const s of ordered) {
      totalSongPlays += 1;
      if (yearIdx !== undefined) archive[yearIdx] += 1;
      const rawArtist = s.artist || '';
      const rawTitle = s.song_title || '';
      const albumTrim = (s.album || '').trim();
      const artistLower = rawArtist.trim().toLowerCase();
      const titleLower = rawTitle.trim().toLowerCase();
      const albumLower = albumTrim.toLowerCase();
      yStat.uniqueArtists.add(artistLower);

      if (albumLower) {
        const al = getOrInit(albumMap, `${artistLower}|||${albumLower}`, () => ({
          artist: rawArtist,
          album: albumTrim,
          totalPlays: 0,
          uniqueSongs: new Set(),
          firstAppearance: airDate,
        }));
        al.totalPlays += 1;
        al.uniqueSongs.add(titleLower);
        updateBounds(al, airDate);
      }

      const sk = `${titleLower}\t${artistLower}`;
      if (!songEpisodes[sk]) songEpisodes[sk] = [epId];
      else if (!songEpisodes[sk].includes(epId)) songEpisodes[sk].push(epId);

      const aEntry = getOrInit(artistMap, artistLower, () => ({
        name: rawArtist,
        totalPlays: 0,
        uniqueSongs: new Set(),
        uniqueAlbums: new Set(),
        episodeIds: new Set(),
        firstAppearance: airDate,
        lastAppearance: airDate,
        yearSpins: new Array(years.length).fill(0),
      }));
      aEntry.totalPlays += 1;
      aEntry.uniqueSongs.add(titleLower);
      if (albumLower) aEntry.uniqueAlbums.add(albumLower);
      aEntry.episodeIds.add(epId);
      updateBounds(aEntry, airDate);
      if (yearIdx !== undefined) aEntry.yearSpins[yearIdx] += 1;

      const sEntry = getOrInit(songMap, sk, () => ({
        artist: rawArtist,
        songTitle: rawTitle,
        albumCounts: new Map(),
        featuredArtists: new Set(),
        totalPlays: 0,
        firstAppearance: airDate,
        lastAppearance: airDate,
        yearSpins: new Array(years.length).fill(0),
      }));
      sEntry.totalPlays += 1;
      const feat = (s.featured_artist || '').trim();
      if (feat) sEntry.featuredArtists.add(feat);
      if (albumTrim) sEntry.albumCounts.set(albumTrim, (sEntry.albumCounts.get(albumTrim) || 0) + 1);
      updateBounds(sEntry, airDate);
      if (yearIdx !== undefined) sEntry.yearSpins[yearIdx] += 1;
    }
  }

  const artistValues = Array.from(artistMap.values());
  const artists = artistValues
    .map((a) => ({
      name: a.name,
      totalPlays: a.totalPlays,
      uniqueSongs: a.uniqueSongs.size,
      uniqueAlbums: a.uniqueAlbums.size,
      episodeCount: a.episodeIds.size,
      firstAppearance: a.firstAppearance,
      lastAppearance: a.lastAppearance,
    }))
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpText(a.name, b.name));

  const albums = Array.from(albumMap.values())
    .map((a) => ({
      artist: a.artist,
      album: a.album,
      totalPlays: a.totalPlays,
      uniqueSongs: a.uniqueSongs.size,
      firstAppearance: a.firstAppearance,
    }))
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpText(a.artist, b.artist) || cmpText(a.album, b.album));

  const songValues = Array.from(songMap.values());
  const songs = songValues
    .map((s) => {
      const songAlbums = Array.from(s.albumCounts.entries())
        .sort((a, b) => (b[1] - a[1]) || cmpText(a[0], b[0]))
        .map(([n]) => n);
      return {
        artist: s.artist,
        songTitle: s.songTitle,
        album: songAlbums[0] || '',
        albums: songAlbums,
        ...(s.featuredArtists.size ? { featuredArtists: [...s.featuredArtists].sort() } : {}),
        totalPlays: s.totalPlays,
        firstAppearance: s.firstAppearance,
        lastAppearance: s.lastAppearance,
      };
    })
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpText(a.songTitle, b.songTitle) || cmpText(a.artist, b.artist));

  const yearSummary = Array.from(yearStats.values())
    .map((y) => ({ year: y.year, episodeCount: y.episodeCount, songCount: y.songCount, uniqueArtists: y.uniqueArtists.size }))
    .sort((a, b) => cmpAsc(a.year, b.year));

  const overview = {
    lastUpdated: updatedAt,
    latestEpisodeId: episodesIndexList[0]?.id || null,
    totalEpisodes: episodesIndexList.length,
    totalSongPlays,
    uniqueArtists: artists.length,
    uniqueAlbums: albums.length,
    uniqueSongs: songs.length,
    oneSpinArtists: artists.filter((a) => a.totalPlays === 1).length,
    oneSpinSongs: songs.filter((s) => s.totalPlays === 1).length,
    dateRange: {
      earliest: episodesIndexList[episodesIndexList.length - 1]?.air_date || null,
      latest: episodesIndexList[0]?.air_date || null,
    },
    topArtists: artists.slice(0, 10).map((a) => ({ name: a.name, plays: a.totalPlays })),
    topSongs: songs.slice(0, 10).map((s) => ({ artist: s.artist, song: s.songTitle, album: s.album, plays: s.totalPlays })),
    yearSummary,
  };
  const manifest = {
    version: 1,
    updatedAt,
    totalEpisodes: overview.totalEpisodes,
    totalSongPlays: overview.totalSongPlays,
    latestEpisodeId: overview.latestEpisodeId,
  };

  const putJson = (key, payload) => putR2Json(bucket, key, payload);

  await Promise.all([
    putJson('v1/overview.json', overview),
    putJson('v1/years.json', yearSummary),
    putJson('v1/year-spins.json', {
      years,
      archive,
      artists: Object.fromEntries(artistValues.map((a) => [a.name, a.yearSpins])),
      songs: Object.fromEntries(songValues.map((s) => [`${s.songTitle}\t${s.artist}`, s.yearSpins])),
    }),
    putJson('v1/episodes-index.json', { episodes: episodesIndexList, songEpisodes }),
    putJson('v1/artists.json', artists),
    putJson('v1/songs.json', songs),
    putJson('v1/albums.json', albums),
    putJson(R2_SONG_LINKS_KEY, songLinks),
    ...Array.from(playlistsByYear.entries()).map(([yr, map]) => putJson(`v1/playlists/${yr}.json`, map)),
  ]);
  await putJson(R2_MANIFEST_KEY, manifest);
  return manifest;
}
