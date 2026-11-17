// Uploads public/data/ static JSON snapshots under v1/ to Cloudflare R2 via the REST API.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');

const DEFAULT_ACCOUNT_ID = '4d9a172a2e7dd978083f9d0fc83cc8c7';
const DEFAULT_BUCKET = 'through-the-cracks-snapshots';
const CONCURRENCY = 16;
const TOP_LEVEL_FILES = [
  'overview.json',
  'year-spins.json',
  'episodes-index.json',
  'artists.json',
  'songs.json',
  'albums.json',
  'years.json',
];
const OPTIONAL_TOP_LEVEL_FILES = ['song-links.json', 'metadata-atlas.json'];

function collectSubdirJson(dataDir, dirName) {
  const fullDir = path.join(dataDir, dirName);
  if (!existsSync(fullDir)) return [];
  return readdirSync(fullDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => `${dirName}/${entry.name}`)
    .sort();
}

export function collectSnapshotPlan(dataDir = DATA_DIR) {
  const entries = [];
  for (const name of TOP_LEVEL_FILES) {
    const filePath = path.join(dataDir, name);
    if (!existsSync(filePath)) throw new Error(`Missing required snapshot file: ${filePath}`);
    entries.push({ relPath: name, filePath });
  }
  for (const name of OPTIONAL_TOP_LEVEL_FILES) {
    const filePath = path.join(dataDir, name);
    if (existsSync(filePath)) entries.push({ relPath: name, filePath });
  }
  for (const relPath of [...collectSubdirJson(dataDir, 'playlists'), ...collectSubdirJson(dataDir, 'artist-profiles')]) {
    entries.push({ relPath, filePath: path.join(dataDir, relPath) });
  }

  const overview = JSON.parse(readFileSync(path.join(dataDir, 'overview.json'), 'utf8'));
  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totalEpisodes: Number(overview?.totalEpisodes ?? 0),
    totalSongPlays: Number(overview?.totalSongPlays ?? 0),
    latestEpisodeId: overview?.latestEpisodeId ? String(overview.latestEpisodeId) : null,
  };
  return { entries, manifest };
}

async function putR2Object({ accountId, bucket, token, relPath, body }) {
  const encodedPath = relPath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/v1/${encodedPath}`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body,
      });
      if (res.ok) return;
      const errText = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === 3) {
        throw new Error(`R2 PUT v1/${relPath} failed (${res.status}): ${errText.slice(0, 200)}`);
      }
    } catch (err) {
      if (attempt === 3) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
}

async function uploadWithConcurrency(items, workerFn, concurrency = CONCURRENCY) {
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      await workerFn(items[idx]);
      completed += 1;
      if (completed % 250 === 0 || completed === items.length) {
        console.log(`  Uploaded ${completed}/${items.length} snapshot objects...`);
      }
    }
  });
  await Promise.all(workers);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const bucket = process.env.R2_SNAPSHOT_BUCKET || DEFAULT_BUCKET;
  const { entries, manifest } = collectSnapshotPlan();

  if (dryRun) {
    const sampleKeys = [
      ...entries.filter((e) => !e.relPath.includes('/')).map((e) => `v1/${e.relPath}`),
      ...entries.filter((e) => e.relPath.startsWith('playlists/')).slice(0, 2).map((e) => `v1/${e.relPath}`),
      ...entries.filter((e) => e.relPath.startsWith('artist-profiles/')).slice(0, 3).map((e) => `v1/${e.relPath}`),
      'v1/manifest.json',
    ];
    console.log(`[dry-run] R2 target: account=${accountId} bucket=${bucket} concurrency=${CONCURRENCY}`);
    console.log(`[dry-run] Total objects: ${entries.length + 1} (${entries.length} snapshots + v1/manifest.json last)`);
    console.log(`[dry-run] Sample keys:\n  ${sampleKeys.join('\n  ')}`);
    console.log(`[dry-run] Manifest preview: ${JSON.stringify(manifest)}`);
    return;
  }

  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!token) {
    throw new Error('CLOUDFLARE_API_TOKEN is required to upload R2 snapshots (or pass --dry-run)');
  }

  console.log(`Uploading ${entries.length} snapshot objects to R2 bucket '${bucket}' (concurrency=${CONCURRENCY})...`);
  await uploadWithConcurrency(entries, ({ relPath, filePath }) =>
    putR2Object({ accountId, bucket, token, relPath, body: readFileSync(filePath) }),
  );

  await putR2Object({
    accountId,
    bucket,
    token,
    relPath: 'manifest.json',
    body: JSON.stringify(manifest),
  });
  console.log(`✓ Uploaded ${entries.length + 1} objects (including v1/manifest.json last) to R2 bucket '${bucket}'`);
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
  main().catch((err) => {
    console.error('❌ R2 seed failed:', err.message || err);
    process.exit(1);
  });
}
