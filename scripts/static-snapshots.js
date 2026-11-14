// Generates pre-computed static JSON snapshots and year shards in public/data/ from episodes data.
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildArtistProfile,
  encodeArtistProfileKey,
  normalizeArtistKey,
  pickArtistDisplayName,
} from '../server/artistProfileBuilder.js';

function cmpAsc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildYearAxis(episodes) {
  let minY = 2013;
  let maxY = 2026;
  for (const ep of episodes) {
    const yr = Number((ep.airDate || '').slice(0, 4));
    if (yr >= 2000 && yr < minY) minY = yr;
    if (yr > maxY) maxY = yr;
  }
  return Array.from({ length: maxY - minY + 1 }, (_, idx) => minY + idx);
}

function updateBounds(entry, airDate) {
  if (!airDate) return;
  if (!entry.firstAppearance || airDate < entry.firstAppearance) entry.firstAppearance = airDate;
  if (!entry.lastAppearance || airDate > entry.lastAppearance) entry.lastAppearance = airDate;
}

function aggregateSnapshots(episodesData) {
  const sorted = [...episodesData].sort(
    (a, b) => cmpAsc(b.airDate || '', a.airDate || '') || cmpAsc(String(b.id), String(a.id)),
  );
  const years = buildYearAxis(sorted);
  const yearIdxMap = new Map(years.map((y, idx) => [y, idx]));
  const archive = new Array(years.length).fill(0);

  const normalizedEpisodes = [];
  const episodesIndexList = [];
  const songEpisodes = {};
  const playlistsByYear = new Map();
  const artistMap = new Map();
  const albumMap = new Map();
  const songMap = new Map();
  const yearStats = new Map();
  let totalSongPlays = 0;

  for (const ep of sorted) {
    const epId = String(ep.id);
    const airDate = ep.airDate || '';
    const yearStr = airDate.slice(0, 4);
    const yearIdx = yearIdxMap.get(Number(yearStr));
    const ordered = [...(ep.songs || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    normalizedEpisodes.push({
      id: epId,
      title: ep.title || '',
      airDate,
      dayOfWeek: ep.dayOfWeek ?? null,
      episodeNumber: ep.episodeNumber ?? null,
      publishedAt: ep.publishedAt || null,
      url: ep.url || null,
      songCount: ordered.length,
      songs: ordered.map((s) => ({
        position: Number(s.position),
        rawLine: s.rawLine || '',
        artist: s.artist || '',
        songTitle: s.songTitle || s.song || '',
        album: s.album || '',
      })),
    });

    episodesIndexList.push({ id: epId, air_date: airDate, song_count: ordered.length, url: ep.url || null });

    if (yearStr) {
      if (!playlistsByYear.has(yearStr)) playlistsByYear.set(yearStr, {});
      playlistsByYear.get(yearStr)[epId] = ordered.map((s) => {
        const title = s.songTitle || s.song || '';
        return { position: Number(s.position), song: title, songTitle: title, artist: s.artist || '', album: s.album || '' };
      });
    }

    const statYr = yearStr || 'unknown';
    if (!yearStats.has(statYr)) {
      yearStats.set(statYr, { year: statYr, episodeCount: 0, songCount: 0, uniqueArtists: new Set() });
    }
    const yStat = yearStats.get(statYr);
    yStat.episodeCount++;
    yStat.songCount += ordered.length;

    for (const s of ordered) {
      totalSongPlays++;
      if (yearIdx !== undefined) archive[yearIdx]++;

      const rawArtist = s.artist || '';
      const rawTitle = s.songTitle || s.song || '';
      const albumTrim = (s.album || '').trim();
      const artistLower = rawArtist.trim().toLowerCase();
      const titleLower = rawTitle.trim().toLowerCase();
      const albumLower = albumTrim.toLowerCase();

      yStat.uniqueArtists.add(artistLower);

      const albumKey = `${artistLower}|||${albumLower}`;
      if (!albumMap.has(albumKey)) {
        albumMap.set(albumKey, {
          artist: rawArtist,
          album: albumTrim,
          totalPlays: 0,
          uniqueSongs: new Set(),
          firstAppearance: airDate,
        });
      }
      const alEntry = albumMap.get(albumKey);
      alEntry.totalPlays++;
      alEntry.uniqueSongs.add(titleLower);
      updateBounds(alEntry, airDate);

      const songIdxKey = `${titleLower}\t${artistLower}`;
      if (!songEpisodes[songIdxKey]) songEpisodes[songIdxKey] = [epId];
      else if (!songEpisodes[songIdxKey].includes(epId)) songEpisodes[songIdxKey].push(epId);

      if (!artistMap.has(artistLower)) {
        artistMap.set(artistLower, {
          name: rawArtist,
          totalPlays: 0,
          uniqueSongs: new Set(),
          uniqueAlbums: new Set(),
          episodeIds: new Set(),
          firstAppearance: airDate,
          lastAppearance: airDate,
          yearSpins: new Array(years.length).fill(0),
        });
      }
      const aEntry = artistMap.get(artistLower);
      aEntry.totalPlays++;
      aEntry.uniqueSongs.add(titleLower);
      aEntry.uniqueAlbums.add(albumLower);
      aEntry.episodeIds.add(epId);
      updateBounds(aEntry, airDate);
      if (yearIdx !== undefined) aEntry.yearSpins[yearIdx]++;

      if (!songMap.has(songIdxKey)) {
        songMap.set(songIdxKey, {
          artist: rawArtist,
          songTitle: rawTitle,
          albumCounts: new Map(),
          totalPlays: 0,
          firstAppearance: airDate,
          lastAppearance: airDate,
          yearSpins: new Array(years.length).fill(0),
        });
      }
      const sEntry = songMap.get(songIdxKey);
      sEntry.totalPlays++;
      if (albumTrim) sEntry.albumCounts.set(albumTrim, (sEntry.albumCounts.get(albumTrim) || 0) + 1);
      updateBounds(sEntry, airDate);
      if (yearIdx !== undefined) sEntry.yearSpins[yearIdx]++;
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
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpAsc(a.name.toLowerCase(), b.name.toLowerCase()));

  const albums = Array.from(albumMap.values())
    .map((a) => ({
      artist: a.artist,
      album: a.album,
      totalPlays: a.totalPlays,
      uniqueSongs: a.uniqueSongs.size,
      firstAppearance: a.firstAppearance,
    }))
    .sort(
      (a, b) =>
        (b.totalPlays - a.totalPlays) ||
        cmpAsc(a.artist.toLowerCase(), b.artist.toLowerCase()) ||
        cmpAsc(a.album.toLowerCase(), b.album.toLowerCase()),
    );

  const songValues = Array.from(songMap.values());
  const songs = songValues
    .map((s) => {
      const songAlbums = Array.from(s.albumCounts.entries())
        .sort((a, b) => (b[1] - a[1]) || cmpAsc(a[0].toLowerCase(), b[0].toLowerCase()))
        .map(([name]) => name);
      return {
        artist: s.artist,
        songTitle: s.songTitle,
        album: songAlbums[0] || '',
        albums: songAlbums,
        totalPlays: s.totalPlays,
        firstAppearance: s.firstAppearance,
        lastAppearance: s.lastAppearance,
      };
    })
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpAsc(a.songTitle.toLowerCase(), b.songTitle.toLowerCase()) || cmpAsc(a.artist.toLowerCase(), b.artist.toLowerCase()));

  const yearSummary = Array.from(yearStats.values())
    .map((y) => ({ year: y.year, episodeCount: y.episodeCount, songCount: y.songCount, uniqueArtists: y.uniqueArtists.size }))
    .sort((a, b) => cmpAsc(a.year, b.year));

  const artistYearSpins = {};
  for (const a of artistValues) artistYearSpins[a.name] = a.yearSpins;
  const songYearSpins = {};
  for (const s of songValues) songYearSpins[`${s.songTitle}\t${s.artist}`] = s.yearSpins;

  const overview = {
    lastUpdated: new Date().toISOString(),
    latestEpisodeId: normalizedEpisodes[0]?.id || null,
    totalEpisodes: normalizedEpisodes.length,
    totalSongPlays,
    uniqueArtists: artists.length,
    uniqueAlbums: albums.length,
    uniqueSongs: songs.length,
    oneSpinArtists: artists.filter((a) => a.totalPlays === 1).length,
    oneSpinSongs: songs.filter((s) => s.totalPlays === 1).length,
    dateRange: { earliest: normalizedEpisodes[normalizedEpisodes.length - 1]?.airDate || null, latest: normalizedEpisodes[0]?.airDate || null },
    topArtists: artists.slice(0, 10).map((a) => ({ name: a.name, plays: a.totalPlays })),
    topSongs: songs.slice(0, 10).map((s) => ({ artist: s.artist, song: s.songTitle, album: s.album, plays: s.totalPlays })),
    yearSummary,
  };

  return { normalizedEpisodes, episodesIndex: { episodes: episodesIndexList, songEpisodes }, playlistsByYear, yearSpins: { years, archive, artists: artistYearSpins, songs: songYearSpins }, artists, albums, songs, overview };
}

export function writeArtistProfileSnapshots(episodesData, dataDir) {
  const profilesDir = path.join(dataDir, 'artist-profiles');
  mkdirSync(profilesDir, { recursive: true });

  const episodes = episodesData || [];
  const years = buildYearAxis(episodes);
  const yearCountMap = new Map(years.map((y) => [y, 0]));
  const rowsByArtist = new Map();
  const variantsByArtist = new Map();
  const coMap = new Map();
  let totalSpins = 0;
  let earliest = null;
  let latest = null;

  for (const ep of episodes) {
    const epId = String(ep.id);
    const airDate = ep.airDate || '';
    const epNum = ep.episodeNumber == null ? null : Number(ep.episodeNumber);
    const ordered = [...(ep.songs || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const epSongCount = ordered.length || Number(ep.songCount ?? 0);
    if (airDate) {
      if (!earliest || airDate < earliest) earliest = airDate;
      if (!latest || airDate > latest) latest = airDate;
    }
    const yr = Number(airDate.slice(0, 4));
    const epArtistKeys = new Set();

    for (const s of ordered) {
      totalSpins += 1;
      if (yearCountMap.has(yr)) yearCountMap.set(yr, yearCountMap.get(yr) + 1);
      const rawArtist = String(s.artist || '').trim();
      const ak = normalizeArtistKey(rawArtist);
      if (!ak) continue;
      epArtistKeys.add(ak);

      if (!rowsByArtist.has(ak)) rowsByArtist.set(ak, []);
      rowsByArtist.get(ak).push({
        episodeId: epId,
        airDate,
        episodeNumber: epNum,
        episodeSongCount: epSongCount,
        position: Number(s.position),
        artist: rawArtist,
        songTitle: s.songTitle || s.song || '',
        album: s.album || '',
      });

      let vMap = variantsByArtist.get(ak);
      if (!vMap) { vMap = new Map(); variantsByArtist.set(ak, vMap); }
      const prev = vMap.get(rawArtist);
      if (!prev) vMap.set(rawArtist, { name: rawArtist, spins: 1, airDate });
      else {
        prev.spins += 1;
        if (airDate && (!prev.airDate || airDate < prev.airDate)) prev.airDate = airDate;
      }
    }

    const keysInEp = Array.from(epArtistKeys);
    for (const ak of keysInEp) {
      let neighbors = coMap.get(ak);
      if (!neighbors) { neighbors = new Map(); coMap.set(ak, neighbors); }
      for (const otherAk of keysInEp) {
        if (otherAk !== ak) neighbors.set(otherAk, (neighbors.get(otherAk) ?? 0) + 1);
      }
    }
  }

  const displayByKey = new Map();
  const countByKey = new Map();
  for (const [ak, rows] of rowsByArtist.entries()) {
    displayByKey.set(ak, pickArtistDisplayName(variantsByArtist.get(ak).values()));
    countByKey.set(ak, rows.length);
  }
  const sortedDesc = Array.from(countByKey.values()).sort((a, b) => b - a);
  const rankBySpins = new Map();
  for (let i = 0; i < sortedDesc.length; i += 1) {
    if (!rankBySpins.has(sortedDesc[i])) rankBySpins.set(sortedDesc[i], i + 1);
  }
  const totalArtists = countByKey.size;
  const archive = {
    totalSpins,
    totalEpisodes: episodes.length,
    dateRange: { earliest, latest },
    years: years.map((year) => ({ year, spins: yearCountMap.get(year) ?? 0 })),
  };

  const writtenFiles = new Set();
  for (const [ak, rows] of rowsByArtist.entries()) {
    const coOccurrences = Array.from(coMap.get(ak)?.entries() || []).map(([otherAk, sharedEpisodes]) => ({
      name: displayByKey.get(otherAk),
      sharedEpisodes,
      rank: rankBySpins.get(countByKey.get(otherAk)) ?? totalArtists,
    }));
    const profile = buildArtistProfile({
      rows,
      coOccurrences,
      rank: rankBySpins.get(rows.length) ?? totalArtists,
      totalArtists,
      archive,
    });
    const fileName = `${encodeArtistProfileKey(ak)}.json`;
    writtenFiles.add(fileName);
    writeFileSync(path.join(profilesDir, fileName), JSON.stringify(profile));
  }

  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json') && !writtenFiles.has(entry.name)) {
      rmSync(path.join(profilesDir, entry.name), { force: true });
    }
  }
}

export function writeStaticSnapshots(episodesData, dataDir, { writeEpisodesFile = false } = {}) {
  const playlistsDir = path.join(dataDir, 'playlists');
  mkdirSync(playlistsDir, { recursive: true });
  const { normalizedEpisodes, episodesIndex, playlistsByYear, yearSpins, artists, albums, songs, overview } = aggregateSnapshots(episodesData);

  if (writeEpisodesFile) {
    writeFileSync(path.join(dataDir, 'episodes.json'), JSON.stringify(normalizedEpisodes, null, 2));
  }
  writeFileSync(path.join(dataDir, 'episodes-index.json'), JSON.stringify(episodesIndex));
  for (const [year, playlistMap] of playlistsByYear.entries()) {
    writeFileSync(path.join(playlistsDir, `${year}.json`), JSON.stringify(playlistMap));
  }
  writeFileSync(path.join(dataDir, 'year-spins.json'), JSON.stringify(yearSpins));
  writeFileSync(path.join(dataDir, 'artists.json'), JSON.stringify(artists, null, 2));
  writeFileSync(path.join(dataDir, 'albums.json'), JSON.stringify(albums, null, 2));
  writeFileSync(path.join(dataDir, 'songs.json'), JSON.stringify(songs, null, 2));
  writeFileSync(path.join(dataDir, 'years.json'), JSON.stringify(overview.yearSummary, null, 2));
  writeFileSync(path.join(dataDir, 'overview.json'), JSON.stringify(overview, null, 2));
  writeArtistProfileSnapshots(episodesData, dataDir);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(selfPath);
  } catch {
    return path.resolve(process.argv[1]) === selfPath;
  }
}

if (isDirectExecution()) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.join(rootDir, 'public', 'data');
  const episodesData = JSON.parse(readFileSync(path.join(dataDir, 'episodes.json'), 'utf8'));
  writeStaticSnapshots(episodesData, dataDir);
  console.log(`✓ Wrote static snapshots to ${dataDir}`);
}
