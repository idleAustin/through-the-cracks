#!/usr/bin/env node
// Syncs .cache/song-metadata/checkpoint.jsonl.gz and public/data/metadata-atlas.json with Cloudflare R2.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const DEFAULT_ACCOUNT_ID = '4d9a172a2e7dd978083f9d0fc83cc8c7';
export const DEFAULT_BUCKET = 'through-the-cracks-snapshots';
export const R2_CHECKPOINT_KEY = 'state/song-metadata/checkpoint.jsonl.gz';
export const R2_ATLAS_KEY = 'v1/metadata-atlas.json';
export const R2_MANIFEST_KEY = 'v1/manifest.json';
export const DEFAULT_CHECKPOINT_PATH = path.join(ROOT, '.cache', 'song-metadata', 'checkpoint.jsonl');
export const DEFAULT_ATLAS_PATH = path.join(ROOT, 'public', 'data', 'metadata-atlas.json');

const MERGE_FIELDS = ['mb', 'discogs', 'shs', 'artist_profile', 'shs_artist_uri'];
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasTruthyValue = (v) =>
  v !== null && v !== undefined && v !== '' && v !== false && v !== 0 &&
  (typeof v !== 'object' || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0));
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function redactTokenError(message) {
  return String(message ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:key|token|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
}

export function r2ObjectUrl({ accountId = DEFAULT_ACCOUNT_ID, bucket = DEFAULT_BUCKET, key }) {
  const encodedKey = String(key || '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}`;
}

export function mergeCheckpointLines(rawText) {
  const records = new Map();
  for (const line of String(rawText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const key = rec && typeof rec === 'object' ? rec.song_key : null;
    if (!key) continue;
    const prev = records.get(key);
    if (!prev) {
      records.set(key, { ...rec });
      continue;
    }
    for (const field of MERGE_FIELDS) {
      if (hasTruthyValue(rec[field])) prev[field] = rec[field];
    }
    const mergedSources = new Set([
      ...(Array.isArray(prev.sources_checked) ? prev.sources_checked : []),
      ...(Array.isArray(rec.sources_checked) ? rec.sources_checked : []),
    ]);
    prev.sources_checked = [...mergedSources].sort();
    prev.checked_at = rec.checked_at || prev.checked_at;
  }
  const lines = [...records.values()].map((rec) => JSON.stringify(rec));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function validateAtlasJson(rawText) {
  const parsed = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
  if (!isPlainObject(parsed) || !isPlainObject(parsed.summary) || !Array.isArray(parsed.decades) || !isPlainObject(parsed.states)) {
    throw new Error('Invalid metadata-atlas JSON: expected { summary, decades[], states }');
  }
  return parsed;
}

async function r2Request({
  accountId,
  bucket,
  key,
  token,
  method = 'GET',
  body,
  contentType,
  fetchImpl = globalThis.fetch,
  sleepFn = defaultSleep,
  maxAttempts = 3,
}) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required to sync metadata with R2');
  const url = r2ObjectUrl({ accountId, bucket, key });
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers['Content-Type'] = contentType;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}) });
      if (res.ok || (method === 'GET' && res.status === 404)) return res;
      const errText = redactTokenError((await res.text().catch(() => '')).slice(0, 200));
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`R2 ${method} ${key} failed (${res.status}): ${errText}`);
      }
    } catch (err) {
      if (attempt === maxAttempts || /R2 (?:GET|PUT)/.test(String(err?.message || ''))) {
        throw new Error(redactTokenError(err?.message || err));
      }
    }
    await sleepFn(300 * attempt);
  }
  throw new Error(`R2 ${method} ${key} failed after ${maxAttempts} attempts`);
}

export async function pullCheckpoint({
  outPath = DEFAULT_CHECKPOINT_PATH,
  require = false,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID,
  bucket = process.env.R2_SNAPSHOT_BUCKET || DEFAULT_BUCKET,
  token = process.env.CLOUDFLARE_API_TOKEN || '',
  fetchImpl = globalThis.fetch,
  sleepFn = defaultSleep,
} = {}) {
  const res = await r2Request({ accountId, bucket, key: R2_CHECKPOINT_KEY, token, method: 'GET', fetchImpl, sleepFn });
  if (res.status === 404) {
    if (require) throw new Error(`Missing required R2 metadata checkpoint: ${R2_CHECKPOINT_KEY}`);
    return { skipped: true, reason: 'not_found', outPath };
  }
  const compressed = Buffer.from(await res.arrayBuffer());
  const raw = gunzipSync(compressed).toString('utf8');
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, raw, 'utf8');
  renameSync(tmpPath, outPath);
  const lineCount = raw ? raw.trimEnd().split('\n').length : 0;
  return { skipped: false, outPath, bytes: compressed.length, lineCount };
}

export async function pushCheckpoint({
  inPath = DEFAULT_CHECKPOINT_PATH,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID,
  bucket = process.env.R2_SNAPSHOT_BUCKET || DEFAULT_BUCKET,
  token = process.env.CLOUDFLARE_API_TOKEN || '',
  fetchImpl = globalThis.fetch,
  sleepFn = defaultSleep,
} = {}) {
  if (!existsSync(inPath)) throw new Error(`Missing metadata checkpoint file: ${inPath}`);
  const compacted = mergeCheckpointLines(readFileSync(inPath, 'utf8'));
  const lineCount = compacted ? compacted.trimEnd().split('\n').length : 0;
  const compressed = gzipSync(Buffer.from(compacted, 'utf8'), { level: 6 });
  await r2Request({
    accountId, bucket, key: R2_CHECKPOINT_KEY, token, method: 'PUT',
    body: compressed, contentType: 'application/gzip', fetchImpl, sleepFn,
  });
  return { key: R2_CHECKPOINT_KEY, lineCount, compressedBytes: compressed.length };
}

export async function pushAtlas({
  inPath = DEFAULT_ATLAS_PATH,
  bumpManifest = false,
  now = new Date().toISOString(),
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID,
  bucket = process.env.R2_SNAPSHOT_BUCKET || DEFAULT_BUCKET,
  token = process.env.CLOUDFLARE_API_TOKEN || '',
  fetchImpl = globalThis.fetch,
  sleepFn = defaultSleep,
} = {}) {
  if (!existsSync(inPath)) throw new Error(`Missing metadata atlas file: ${inPath}`);
  const raw = readFileSync(inPath, 'utf8');
  const parsed = validateAtlasJson(raw);
  const normalizedBody = JSON.stringify(parsed);

  await r2Request({
    accountId, bucket, key: R2_ATLAS_KEY, token, method: 'PUT',
    body: normalizedBody, contentType: 'application/json; charset=utf-8', fetchImpl, sleepFn,
  });

  let manifestBumped = false;
  if (bumpManifest) {
    const manifestRes = await r2Request({
      accountId, bucket, key: R2_MANIFEST_KEY, token, method: 'GET', fetchImpl, sleepFn,
    });
    if (manifestRes.status !== 404) {
      const existing = await manifestRes.json().catch(() => null);
      if (isPlainObject(existing)) {
        await r2Request({
          accountId, bucket, key: R2_MANIFEST_KEY, token, method: 'PUT',
          body: JSON.stringify({ ...existing, updatedAt: now }),
          contentType: 'application/json; charset=utf-8',
          fetchImpl, sleepFn,
        });
        manifestBumped = true;
      }
    }
  }
  return { key: R2_ATLAS_KEY, bytes: normalizedBody.length, totalSongs: parsed.summary.totalSongs ?? 0, manifestBumped };
}

export function parseCliArgs(argv = []) {
  const [command = '', ...rest] = argv;
  const opts = { command, require: false, bumpManifest: false, outPath: undefined, inPath: undefined };
  for (const arg of rest) {
    if (arg === '--require') opts.require = true;
    else if (arg === '--bump-manifest') opts.bumpManifest = true;
    else if (arg.startsWith('--out=')) opts.outPath = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--in=')) opts.inPath = path.resolve(arg.slice('--in='.length));
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.command === 'pull') {
    const res = await pullCheckpoint({ outPath: opts.outPath, require: opts.require });
    console.log(res.skipped
      ? `ℹ️  No remote checkpoint at R2 ${R2_CHECKPOINT_KEY}; continuing without error.`
      : `✓ Pulled ${res.lineCount} checkpoint records (${res.bytes} gz bytes) -> ${res.outPath}`);
    return;
  }
  if (opts.command === 'push-checkpoint') {
    const res = await pushCheckpoint({ inPath: opts.inPath });
    console.log(`✓ Pushed ${res.lineCount} compacted records (${res.compressedBytes} gz bytes) -> R2 ${res.key}`);
    return;
  }
  if (opts.command === 'push-atlas') {
    const res = await pushAtlas({ inPath: opts.inPath, bumpManifest: opts.bumpManifest });
    console.log(`✓ Pushed ${res.key} (${res.bytes} bytes, ${res.totalSongs} songs, manifestBumped=${res.manifestBumped})`);
    return;
  }
  console.error('Usage: node scripts/sync-metadata-r2.js <pull|push-checkpoint|push-atlas> [--out=path] [--in=path] [--require] [--bump-manifest]');
  process.exit(1);
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
    console.error(`❌ Metadata R2 sync failed: ${redactTokenError(err?.message || err)}`);
    process.exit(1);
  });
}
