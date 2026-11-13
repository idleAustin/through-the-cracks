// Generates pre-computed static JSON snapshots and year shards in public/data/ from episodes data.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const episodesIndexList = [];
  const songEpisodes = {};
  const playlistsByYear = new Map();
  const artistMap = new Map();
  const albumKeys = new Set();
  const songMap = new Map();
  const yearStats = new Map();
  let totalSongPlays = 0;

  for (const ep of sorted) {
    const epId = String(ep.id);
    const airDate = ep.airDate || '';
    const yearStr = airDate.slice(0, 4);
    const yearIdx = yearIdxMap.get(Number(yearStr));
    const ordered = [...(ep.songs || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    episodesIndexList.push({ id: epId, air_date: airDate, song_count: ordered.length, url: ep.url || null });

    if (yearStr) {
      if (!playlistsByYear.has(yearStr)) playlistsByYear.set(yearStr, {});
      playlistsByYear.get(yearStr)[epId] = ordered.map(s => {
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
      albumKeys.add(`${artistLower}|||${albumLower}`);

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
    .map(a => ({
      name: a.name,
      totalPlays: a.totalPlays,
      uniqueSongs: a.uniqueSongs.size,
      uniqueAlbums: a.uniqueAlbums.size,
      episodeCount: a.episodeIds.size,
      firstAppearance: a.firstAppearance,
      lastAppearance: a.lastAppearance,
    }))
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpAsc(a.name.toLowerCase(), b.name.toLowerCase()));

  const songValues = Array.from(songMap.values());
  const songs = songValues
    .map(s => {
      const albums = Array.from(s.albumCounts.entries())
        .sort((a, b) => (b[1] - a[1]) || cmpAsc(a[0].toLowerCase(), b[0].toLowerCase()))
        .map(([name]) => name);
      return {
        artist: s.artist,
        songTitle: s.songTitle,
        album: albums[0] || '',
        albums,
        totalPlays: s.totalPlays,
        firstAppearance: s.firstAppearance,
        lastAppearance: s.lastAppearance,
      };
    })
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpAsc(a.songTitle.toLowerCase(), b.songTitle.toLowerCase()) || cmpAsc(a.artist.toLowerCase(), b.artist.toLowerCase()));

  const yearSummary = Array.from(yearStats.values())
    .map(y => ({ year: y.year, episodeCount: y.episodeCount, songCount: y.songCount, uniqueArtists: y.uniqueArtists.size }))
    .sort((a, b) => cmpAsc(a.year, b.year));

  const artistYearSpins = {};
  for (const a of artistValues) artistYearSpins[a.name] = a.yearSpins;
  const songYearSpins = {};
  for (const s of songValues) songYearSpins[`${s.songTitle}\t${s.artist}`] = s.yearSpins;

  const overview = {
    lastUpdated: new Date().toISOString(),
    latestEpisodeId: sorted[0] ? String(sorted[0].id) : null,
    totalEpisodes: sorted.length,
    totalSongPlays,
    uniqueArtists: artists.length,
    uniqueAlbums: albumKeys.size,
    uniqueSongs: songs.length,
    oneSpinArtists: artists.filter(a => a.totalPlays === 1).length,
    oneSpinSongs: songs.filter(s => s.totalPlays === 1).length,
    dateRange: { earliest: sorted[sorted.length - 1]?.airDate || null, latest: sorted[0]?.airDate || null },
    topArtists: artists.slice(0, 10).map(a => ({ name: a.name, plays: a.totalPlays })),
    topSongs: songs.slice(0, 10).map(s => ({ artist: s.artist, song: s.songTitle, album: s.album, plays: s.totalPlays })),
    yearSummary,
  };

  return { episodesIndex: { episodes: episodesIndexList, songEpisodes }, playlistsByYear, yearSpins: { years, archive, artists: artistYearSpins, songs: songYearSpins }, artists, songs, overview };
}

export function writeStaticSnapshots(episodesData, dataDir) {
  const playlistsDir = path.join(dataDir, 'playlists');
  mkdirSync(playlistsDir, { recursive: true });
  const { episodesIndex, playlistsByYear, yearSpins, artists, songs, overview } = aggregateSnapshots(episodesData);

  writeFileSync(path.join(dataDir, 'episodes-index.json'), JSON.stringify(episodesIndex));
  for (const [year, playlistMap] of playlistsByYear.entries()) {
    writeFileSync(path.join(playlistsDir, `${year}.json`), JSON.stringify(playlistMap));
  }
  writeFileSync(path.join(dataDir, 'year-spins.json'), JSON.stringify(yearSpins));
  writeFileSync(path.join(dataDir, 'artists.json'), JSON.stringify(artists, null, 2));
  writeFileSync(path.join(dataDir, 'songs.json'), JSON.stringify(songs, null, 2));
  writeFileSync(path.join(dataDir, 'overview.json'), JSON.stringify(overview, null, 2));
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
