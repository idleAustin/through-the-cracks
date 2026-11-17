// Read-only metadata atlas Express route backed by public/data/metadata-atlas.json.
import express from 'express';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_ATLAS_SNAPSHOT_PATH = path.resolve(__dirname, '..', '..', 'public', 'data', 'metadata-atlas.json');

const snapshotCache = new Map();
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isValidAtlasPayload(parsed) {
  return isPlainObject(parsed) && isPlainObject(parsed.summary) && Array.isArray(parsed.decades) && isPlainObject(parsed.states);
}

export function resetAtlasSnapshotCache(snapshotPath) {
  if (snapshotPath) {
    snapshotCache.delete(path.resolve(snapshotPath));
  } else {
    snapshotCache.clear();
  }
}

export async function loadAtlasSnapshot(snapshotPath = DEFAULT_ATLAS_SNAPSHOT_PATH) {
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
    return cached.atlas;
  }

  try {
    const raw = await readFile(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isValidAtlasPayload(parsed)) {
      snapshotCache.delete(resolvedPath);
      return null;
    }
    snapshotCache.set(resolvedPath, {
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
      atlas: parsed,
    });
    return parsed;
  } catch {
    snapshotCache.delete(resolvedPath);
    return null;
  }
}

export function createAtlasRouter({
  snapshotPath = DEFAULT_ATLAS_SNAPSHOT_PATH,
  loadSnapshot = loadAtlasSnapshot,
} = {}) {
  const router = express.Router();

  router.get('/atlas', async (_req, res) => {
    try {
      const atlas = await loadSnapshot(snapshotPath);
      if (!atlas) {
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'Metadata atlas snapshot unavailable' });
      }
      res.set('Cache-Control', 'public, max-age=300');
      return res.status(200).json(atlas);
    } catch (err) {
      console.error('Error fetching metadata atlas:', err);
      res.set('Cache-Control', 'no-store');
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export const atlasRouter = createAtlasRouter();
export default atlasRouter;
