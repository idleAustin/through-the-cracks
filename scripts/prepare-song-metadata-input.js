#!/usr/bin/env node
// Builds .cache/song-metadata/catalog-input.json with Album-first groupings for metadata discovery.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mechanicalClean, nameKey } from './archive-normalizer.js';
import { resolveCanonicalArtist } from './artist-aliases.js';
import { buildSongKey } from '../server/playlistBuilder.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

export const DEFAULT_SONGS_PATH = path.join(REPO_ROOT, 'public', 'data', 'songs.json');
export const DEFAULT_ARTISTS_PATH = path.join(REPO_ROOT, 'public', 'data', 'artists.json');
export const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, '.cache', 'song-metadata', 'catalog-input.json');

const EXACT_SINGLE_LABELS = new Set([
  '',
  'single',
  '(single)',
  '[single]',
  'non-album',
  'non album',
  'non-album track',
  'non album track',
  'unknown',
  'unknown album',
  'n/a',
  'na',
  'none',
  'various',
]);

export function normalizeGroupingToken(value) {
  return nameKey(value);
}

export function isSingleOrBlankAlbum(album) {
  const clean = normalizeGroupingToken(album);
  if (EXACT_SINGLE_LABELS.has(clean)) return true;
  if (/^single\s*[-:/]/.test(clean)) return true;
  if (/\s+(?:\(|\[|-\s*)single[\])]?$/.test(clean)) return true;
  return false;
}

function choosePrimaryAlbum(song) {
  const rawPrimary = mechanicalClean(song?.album || '');
  if (rawPrimary && !isSingleOrBlankAlbum(rawPrimary)) return rawPrimary;
  const list = Array.isArray(song?.albums) ? song.albums : [];
  for (const candidate of list) {
    const cleaned = mechanicalClean(candidate || '');
    if (cleaned && !isSingleOrBlankAlbum(cleaned)) return cleaned;
  }
  return rawPrimary;
}

function buildArtistPlayMap(artists) {
  const map = new Map();
  for (const row of Array.isArray(artists) ? artists : []) {
    const canonical = resolveCanonicalArtist(row?.name || '');
    const key = nameKey(canonical);
    if (!key) continue;
    const plays = Number(row?.totalPlays || 0);
    const prev = map.get(key);
    if (!prev || plays > prev.totalPlays) {
      map.set(key, { artist: canonical, artistKey: key, totalPlays: plays });
    }
  }
  return map;
}

function mergeDate(current, candidate, pickLatest) {
  if (!candidate) return current || '';
  if (!current) return candidate;
  return pickLatest ? (candidate > current ? candidate : current) : (candidate < current ? candidate : current);
}

function addOrMergeSong(songMap, rawSong, artistPlayMap) {
  const canonicalArtist = resolveCanonicalArtist(rawSong?.artist || '') || mechanicalClean(rawSong?.artist || '');
  const songTitle = mechanicalClean(rawSong?.songTitle || '');
  if (!canonicalArtist || !songTitle) return;

  const artistKey = nameKey(canonicalArtist);
  const songKey = buildSongKey(canonicalArtist, songTitle);
  const primaryAlbum = choosePrimaryAlbum(rawSong);
  const isSingle = isSingleOrBlankAlbum(primaryAlbum);
  const albumNorm = isSingle ? '' : normalizeGroupingToken(primaryAlbum);
  const albumKey = isSingle ? null : `${artistKey}|||${albumNorm}`;

  const rawAlbums = Array.isArray(rawSong?.albums) ? rawSong.albums : [];
  const albumSet = new Set(
    [rawSong?.album, ...rawAlbums].map((v) => mechanicalClean(v || '')).filter(Boolean),
  );
  const totalPlays = Number(rawSong?.totalPlays || 0);
  const artistMeta = artistPlayMap.get(artistKey);
  const artistTotalPlays = artistMeta ? artistMeta.totalPlays : totalPlays;
  const firstApp = String(rawSong?.firstAppearance || '');
  const lastApp = String(rawSong?.lastAppearance || '');

  const existing = songMap.get(songKey);
  if (!existing) {
    songMap.set(songKey, {
      song_key: songKey,
      artist: canonicalArtist,
      artist_key: artistKey,
      song_title: songTitle,
      album: primaryAlbum,
      albums: [...albumSet],
      album_key: albumKey,
      album_norm: albumNorm,
      is_single: isSingle,
      totalPlays,
      artistTotalPlays,
      firstAppearance: firstApp,
      lastAppearance: lastApp,
      pass_tier: totalPlays >= 2 ? 'multi' : 'single',
    });
    return;
  }

  for (const name of albumSet) {
    if (!existing.albums.includes(name)) existing.albums.push(name);
  }
  if (existing.is_single && !isSingle) {
    existing.album = primaryAlbum;
    existing.album_norm = albumNorm;
    existing.album_key = albumKey;
    existing.is_single = false;
  }
  existing.totalPlays += totalPlays;
  existing.artistTotalPlays = Math.max(existing.artistTotalPlays, artistTotalPlays);
  existing.firstAppearance = mergeDate(existing.firstAppearance, firstApp, false);
  existing.lastAppearance = mergeDate(existing.lastAppearance, lastApp, true);
  existing.pass_tier = existing.totalPlays >= 2 ? 'multi' : 'single';
}

function buildAlbumGroups(songs) {
  const albumMap = new Map();
  for (const song of songs) {
    if (song.is_single || !song.album_key) continue;
    let group = albumMap.get(song.album_key);
    if (!group) {
      group = {
        albumKey: song.album_key,
        artist: song.artist,
        artistKey: song.artist_key,
        album: song.album,
        albumNorm: song.album_norm,
        totalPlays: 0,
        maxSongPlays: 0,
        songCount: 0,
        multiSpinCount: 0,
        firstAppearance: song.firstAppearance,
        lastAppearance: song.lastAppearance,
        songKeys: [],
      };
      albumMap.set(song.album_key, group);
    }
    group.totalPlays += song.totalPlays;
    if (song.totalPlays > group.maxSongPlays) group.maxSongPlays = song.totalPlays;
    group.songCount += 1;
    if (song.totalPlays >= 2) group.multiSpinCount += 1;
    group.firstAppearance = mergeDate(group.firstAppearance, song.firstAppearance, false);
    group.lastAppearance = mergeDate(group.lastAppearance, song.lastAppearance, true);
    group.songKeys.push(song.song_key);
  }

  return [...albumMap.values()].sort(
    (a, b) =>
      b.totalPlays - a.totalPlays ||
      b.maxSongPlays - a.maxSongPlays ||
      b.songCount - a.songCount ||
      a.albumKey.localeCompare(b.albumKey),
  );
}

export function prepareMetadataCatalog({ songs = [], artists = [] } = {}) {
  const artistPlayMap = buildArtistPlayMap(artists);
  const songMap = new Map();
  for (const rawSong of Array.isArray(songs) ? songs : []) {
    addOrMergeSong(songMap, rawSong, artistPlayMap);
  }

  const normalizedSongs = [...songMap.values()].sort(
    (a, b) =>
      b.totalPlays - a.totalPlays ||
      b.artistTotalPlays - a.artistTotalPlays ||
      b.lastAppearance.localeCompare(a.lastAppearance) ||
      a.song_key.localeCompare(b.song_key),
  );

  const albums = buildAlbumGroups(normalizedSongs);
  const artistList = [...artistPlayMap.values()].sort(
    (a, b) => b.totalPlays - a.totalPlays || a.artistKey.localeCompare(b.artistKey),
  );

  let multiSpinSongs = 0;
  let highSpinSongs = 0;
  let singleSongs = 0;
  for (const s of normalizedSongs) {
    if (s.totalPlays >= 2) multiSpinSongs += 1;
    if (s.totalPlays >= 5) highSpinSongs += 1;
    if (s.is_single) singleSongs += 1;
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    stats: {
      totalSongs: normalizedSongs.length,
      multiSpinSongs,
      singleSpinSongs: normalizedSongs.length - multiSpinSongs,
      highSpinSongs,
      totalArtists: artistList.length,
      albumGroupCount: albums.length,
      albumCoveredSongs: normalizedSongs.length - singleSongs,
      singleSongs,
    },
    artists: artistList,
    albums,
    songs: normalizedSongs,
  };
}

export function writeMetadataInputFile({
  songsPath = DEFAULT_SONGS_PATH,
  artistsPath = DEFAULT_ARTISTS_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
  const songs = JSON.parse(readFileSync(songsPath, 'utf8'));
  const artists = JSON.parse(readFileSync(artistsPath, 'utf8'));
  const payload = prepareMetadataCatalog({ songs, artists });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, outputPath);
  return payload;
}

export function parsePrepareArgs(argv = []) {
  const opts = {
    songsPath: DEFAULT_SONGS_PATH,
    artistsPath: DEFAULT_ARTISTS_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--songs=')) opts.songsPath = path.resolve(arg.slice('--songs='.length));
    else if (arg.startsWith('--artists=')) opts.artistsPath = path.resolve(arg.slice('--artists='.length));
    else if (arg.startsWith('--out=')) opts.outputPath = path.resolve(arg.slice('--out='.length));
  }
  return opts;
}

function main() {
  const opts = parsePrepareArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/prepare-song-metadata-input.js [--songs=path] [--artists=path] [--out=path]');
    return;
  }
  const result = writeMetadataInputFile(opts);
  const { stats } = result;
  console.log(
    `Prepared ${stats.totalSongs} songs (${stats.albumGroupCount} albums, ${stats.albumCoveredSongs} album-covered, ${stats.singleSongs} singles, ${stats.multiSpinSongs} multi-spin) -> ${opts.outputPath}`,
  );
}

const isEntrypoint =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isEntrypoint) {
  main();
}

