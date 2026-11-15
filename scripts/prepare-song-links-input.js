// Stage 1 backfill: pre-key and sort songs.json into gitignored staging input for Python discovery.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCanonicalArtist } from './artist-aliases.js';
import { buildSongKey } from '../server/playlistBuilder.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const DEFAULT_INPUT_PATH = path.join(ROOT, 'public', 'data', 'songs.json');
export const DEFAULT_OUTPUT_PATH = path.join(ROOT, '.cache', 'song-links', 'catalog-input.json');

function uniqueNonEmptyStrings(values) {
  const seen = new Set();
  const out = [];
  for (const val of values || []) {
    const trimmed = String(val ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function uniqueArrayItems(values) {
  const seen = new Set();
  const out = [];
  for (const val of values || []) {
    if (val === undefined || val === null) continue;
    const key = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(val);
  }
  return out;
}

function toNonNegativeInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

export function normalizeCatalogEntry(song) {
  if (!song || typeof song !== 'object') return null;
  const rawArtist = String(song.artist ?? '').trim();
  const rawTitle = String(song.song_title ?? song.songTitle ?? song.song ?? '').trim();
  if (!rawArtist && !rawTitle) return null;

  const artist = resolveCanonicalArtist(rawArtist) || rawArtist;
  const songTitle = rawTitle;
  const songKey = String(song.song_key ?? song.songKey ?? '').trim() || buildSongKey(artist, songTitle);
  const album = String(song.album ?? '').trim();
  const albums = uniqueNonEmptyStrings(Array.isArray(song.albums) ? song.albums : album ? [album] : []);
  const totalPlays = toNonNegativeInt(song.totalPlays ?? song.total_plays);
  const episodes = Array.isArray(song.episodes) ? uniqueArrayItems(song.episodes) : [];

  return {
    song_key: songKey,
    artist,
    song_title: songTitle,
    album: album || albums[0] || '',
    ...(albums.length > 0 ? { albums } : {}),
    totalPlays,
    episodes,
  };
}

export function prepareCatalogInput(songs) {
  const byKey = new Map();

  for (const rawSong of songs || []) {
    const entry = normalizeCatalogEntry(rawSong);
    if (!entry) continue;

    const existing = byKey.get(entry.song_key);
    if (!existing) {
      byKey.set(entry.song_key, { ...entry, _bestPlays: entry.totalPlays });
      continue;
    }

    const preferIncoming = entry.totalPlays > existing._bestPlays;
    if (preferIncoming) {
      existing.artist = entry.artist;
      existing.song_title = entry.song_title;
      existing._bestPlays = entry.totalPlays;
      if (entry.album) existing.album = entry.album;
    } else if (!existing.album && entry.album) {
      existing.album = entry.album;
    }

    existing.totalPlays += entry.totalPlays;
    const mergedAlbums = uniqueNonEmptyStrings([...(existing.albums || []), ...(entry.albums || [])]);
    if (mergedAlbums.length > 0) existing.albums = mergedAlbums;
    existing.episodes = uniqueArrayItems([...existing.episodes, ...entry.episodes]);
  }

  const entries = Array.from(byKey.values()).map(({ _bestPlays, ...clean }) => clean);
  entries.sort(
    (a, b) =>
      b.totalPlays - a.totalPlays ||
      (a.song_key < b.song_key ? -1 : a.song_key > b.song_key ? 1 : 0),
  );
  return entries;
}

export function summarizeCatalogInput(entries) {
  let multi = 0;
  let single = 0;
  for (const entry of entries || []) {
    const plays = Number(entry?.totalPlays ?? 0);
    if (plays >= 2) multi += 1;
    else if (plays === 1) single += 1;
  }
  return { total: (entries || []).length, multi, single };
}

export function parsePrepareArgs(argv = []) {
  const args = { inputPath: DEFAULT_INPUT_PATH, outputPath: DEFAULT_OUTPUT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--input=')) args.inputPath = path.resolve(arg.slice('--input='.length));
    else if (arg === '--input' && argv[i + 1]) args.inputPath = path.resolve(argv[++i]);
    else if (arg.startsWith('--output=')) args.outputPath = path.resolve(arg.slice('--output='.length));
    else if (arg === '--output' && argv[i + 1]) args.outputPath = path.resolve(argv[++i]);
  }
  return args;
}

export function writeCatalogInputFile({ inputPath = DEFAULT_INPUT_PATH, outputPath = DEFAULT_OUTPUT_PATH } = {}) {
  const rawSongs = JSON.parse(readFileSync(inputPath, 'utf8'));
  const entries = prepareCatalogInput(rawSongs);
  const summary = summarizeCatalogInput(entries);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  return { entries, summary, inputPath, outputPath };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectExecution()) {
  const opts = parsePrepareArgs(process.argv.slice(2));
  const { summary, outputPath } = writeCatalogInputFile(opts);
  console.log(
    `✓ Wrote ${summary.total} prepared songs (${summary.multi} multi-spin, ${summary.single} single-spin) to ${outputPath}`,
  );
}
