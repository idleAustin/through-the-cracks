// Read-only random Playlist generator Express route backed by public/data/song-links.json.
import express from 'express';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawRandomPlaylist, parsePlaylistQuery } from '../playlistBuilder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_SONG_LINKS_PATH = path.resolve(__dirname, '..', '..', 'public', 'data', 'song-links.json');

const snapshotCache = new Map();

export function resetPlaylistSnapshotCache(snapshotPath) {
  if (snapshotPath) {
    snapshotCache.delete(path.resolve(snapshotPath));
  } else {
    snapshotCache.clear();
  }
}

export function extractPlaylistSongs(parsed) {
  const songs = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.songs)
      ? parsed.songs
      : null;
  return songs && songs.length > 0 ? songs : null;
}

export function getRequestSearchParams(req) {
  const rawUrl = req?.originalUrl || req?.url || '/';
  try {
    return new URL(rawUrl, 'http://localhost').searchParams;
  } catch {
    const qIdx = rawUrl.indexOf('?');
    return new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '');
  }
}

export async function loadSongLinksSnapshot(snapshotPath = DEFAULT_SONG_LINKS_PATH) {
  const resolvedPath = path.resolve(snapshotPath);
  let fileStats;
  try {
    fileStats = await stat(resolvedPath);
  } catch {
    snapshotCache.delete(resolvedPath);
    return null;
  }
  if (!fileStats.isFile()) {
    snapshotCache.delete(resolvedPath);
    return null;
  }

  const cached = snapshotCache.get(resolvedPath);
  if (cached && cached.mtimeMs === fileStats.mtimeMs && cached.size === fileStats.size) {
    return cached.songs;
  }

  try {
    const raw = await readFile(resolvedPath, 'utf8');
    const songs = extractPlaylistSongs(JSON.parse(raw));
    if (!songs) {
      snapshotCache.delete(resolvedPath);
      return null;
    }
    snapshotCache.set(resolvedPath, {
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
      songs,
    });
    return songs;
  } catch {
    snapshotCache.delete(resolvedPath);
    return null;
  }
}

export function createPlaylistRouter({
  snapshotPath = DEFAULT_SONG_LINKS_PATH,
  loadPool = loadSongLinksSnapshot,
} = {}) {
  const router = express.Router();

  router.get('/random', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const searchParams = getRequestSearchParams(req);
      const parsed = parsePlaylistQuery(searchParams);
      if (parsed.error) {
        return res.status(parsed.status || 400).json({ error: parsed.error });
      }

      const pool = await loadPool(snapshotPath);
      if (!pool || pool.length === 0) {
        return res.status(503).json({ error: 'Song links snapshot unavailable' });
      }

      const payload = drawRandomPlaylist(pool, searchParams, { assumedPlayable: true });
      return res.status(200).json(payload);
    } catch (err) {
      console.error('Error generating random playlist:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export const playlistRouter = createPlaylistRouter();
export default playlistRouter;
