// Stage 3 & 4 backfill: batch-verify YouTube compatibility and emit chunked D1 SQL + static snapshot.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStaticSongLinksSnapshot,
  buildUpsertSqlChunks,
  DEFAULT_CHUNK_SIZE,
  evaluateVideoCompatibility,
} from './song-links-export-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const MAX_VIDEOS_BATCH = 50;
export const DEFAULT_CHECKPOINT_PATH = path.join(ROOT, '.cache', 'song-links', 'checkpoint.jsonl');
export const DEFAULT_VERIFIED_PATH = path.join(ROOT, '.cache', 'song-links', 'verified.jsonl');
export const DEFAULT_SQL_DIR = path.join(ROOT, '.cache', 'song-links', 'sql');
export const DEFAULT_SONGS_PATH = path.join(ROOT, 'public', 'data', 'songs.json');
export const DEFAULT_SNAPSHOT_OUT = path.join(ROOT, 'public', 'data', 'song-links.json');

export function readCheckpointJsonl(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const byKey = new Map();
  const orderedKeys = [];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (err) {
      console.warn(`Warning: ignoring malformed JSONL line ${i + 1} in ${filePath}: ${err.message}`);
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const key = String(rec.song_key ?? rec.songKey ?? '').trim() || `${rec.artist || ''}|||${rec.song_title || rec.songTitle || ''}`;
    if (!byKey.has(key)) orderedKeys.push(key);
    byKey.set(key, rec);
  }

  return orderedKeys.map((key) => byKey.get(key));
}

export async function fetchVideosMetadataBatch(videoIds, apiKey, fetchFn = globalThis.fetch) {
  const ids = (videoIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length === 0) return new Map();

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'status,contentDetails');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);

  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`YouTube videos.list failed (${response.status}): ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const out = new Map();
  for (const item of data?.items || []) {
    if (item?.id) out.set(String(item.id), item);
  }
  return out;
}

export async function verifyCheckpointRecords(
  records,
  { apiKey = process.env.YOUTUBE_API_KEY, fetchFn = globalThis.fetch, now = new Date().toISOString() } = {},
) {
  const resolvedKey = String(apiKey ?? '').trim();
  if (!resolvedKey) {
    throw new Error(
      'YOUTUBE_API_KEY is required for Stage 3 YouTube verification. Run via: doppler --no-check-version run -- node scripts/verify-and-export-song-links.js',
    );
  }

  const uniqueIds = [];
  const seenIds = new Set();
  for (const rec of records || []) {
    const vid = String(rec?.video_id ?? rec?.videoId ?? '').trim();
    if (!vid || seenIds.has(vid)) continue;
    seenIds.add(vid);
    uniqueIds.push(vid);
  }

  const videoMap = new Map();
  let apiCalls = 0;
  for (let i = 0; i < uniqueIds.length; i += MAX_VIDEOS_BATCH) {
    const batch = uniqueIds.slice(i, i + MAX_VIDEOS_BATCH);
    const batchMap = await fetchVideosMetadataBatch(batch, resolvedKey, fetchFn);
    apiCalls += 1;
    for (const [vid, item] of batchMap.entries()) videoMap.set(vid, item);
  }

  const counts = { compatible: 0, not_embeddable: 0, us_blocked: 0, missing_or_deleted: 0, unavailable: 0, unmatched: 0 };
  const verifiedRows = (records || []).map((rec) => {
    const vid = String(rec?.video_id ?? rec?.videoId ?? '').trim();
    const row = evaluateVideoCompatibility(rec, vid ? videoMap.get(vid) : null, { now });
    if (row.is_embeddable === 1 && row.us_playable === 1) counts.compatible += 1;
    else if (row.status_reason === 'unmatched') counts.unmatched += 1;
    else if (row.status_reason === 'missing_or_deleted') counts.missing_or_deleted += 1;
    else if (row.status_reason === 'not_embeddable') counts.not_embeddable += 1;
    else if (row.status_reason === 'us_blocked') counts.us_blocked += 1;
    else counts.unavailable += 1;
    return row;
  });

  return {
    verifiedRows,
    apiCalls,
    uniqueVideoCount: uniqueIds.length,
    counts,
  };
}

export function writeSqlChunks(sqlDir, chunks) {
  mkdirSync(sqlDir, { recursive: true });
  for (const entry of readdirSync(sqlDir, { withFileTypes: true })) {
    if (entry.isFile() && /^chunk-\d+\.sql$/i.test(entry.name)) {
      rmSync(path.join(sqlDir, entry.name), { force: true });
    }
  }
  const writtenPaths = [];
  for (const chunk of chunks) {
    const outPath = path.join(sqlDir, chunk.fileName);
    writeFileSync(outPath, chunk.sql, 'utf8');
    writtenPaths.push(outPath);
  }
  return writtenPaths;
}

export async function runVerifyAndExport({
  inputPath = DEFAULT_CHECKPOINT_PATH,
  verifiedOutPath = DEFAULT_VERIFIED_PATH,
  sqlDir = DEFAULT_SQL_DIR,
  songsPath = DEFAULT_SONGS_PATH,
  snapshotOutPath = DEFAULT_SNAPSHOT_OUT,
  chunkSize = DEFAULT_CHUNK_SIZE,
  skipVerify = false,
  apiKey = process.env.YOUTUBE_API_KEY,
  fetchFn = globalThis.fetch,
  now = new Date().toISOString(),
} = {}) {
  const records = readCheckpointJsonl(inputPath);
  let verifiedRows;
  let verification = { apiCalls: 0, uniqueVideoCount: 0, counts: null };

  if (skipVerify) {
    verifiedRows = records.map((rec) => ({
      ...rec,
      updated_at: String(rec.updated_at ?? rec.updatedAt ?? now),
      checked_at: String(rec.checked_at ?? rec.checkedAt ?? now),
    }));
  } else {
    const res = await verifyCheckpointRecords(records, { apiKey, fetchFn, now });
    verifiedRows = res.verifiedRows;
    verification = { apiCalls: res.apiCalls, uniqueVideoCount: res.uniqueVideoCount, counts: res.counts };
  }

  if (verifiedOutPath) {
    mkdirSync(path.dirname(verifiedOutPath), { recursive: true });
    const jsonl = verifiedRows.map((row) => JSON.stringify(row)).join('\n');
    writeFileSync(verifiedOutPath, jsonl ? `${jsonl}\n` : '', 'utf8');
  }

  const chunks = buildUpsertSqlChunks(verifiedRows, chunkSize);
  const chunkPaths = writeSqlChunks(sqlDir, chunks);

  const catalogSongs = songsPath && existsSync(songsPath) ? JSON.parse(readFileSync(songsPath, 'utf8')) : [];
  const snapshot = buildStaticSongLinksSnapshot(verifiedRows, catalogSongs);
  if (snapshotOutPath) {
    mkdirSync(path.dirname(snapshotOutPath), { recursive: true });
    writeFileSync(snapshotOutPath, JSON.stringify(snapshot), 'utf8');
  }

  return {
    inputCount: records.length,
    verifiedCount: verifiedRows.length,
    snapshotCount: snapshot.length,
    chunkCount: chunks.length,
    chunkPaths,
    verifiedOutPath,
    snapshotOutPath,
    verification,
  };
}

export function parseVerifyArgs(argv = []) {
  const args = {
    inputPath: DEFAULT_CHECKPOINT_PATH,
    verifiedOutPath: DEFAULT_VERIFIED_PATH,
    sqlDir: DEFAULT_SQL_DIR,
    songsPath: DEFAULT_SONGS_PATH,
    snapshotOutPath: DEFAULT_SNAPSHOT_OUT,
    chunkSize: DEFAULT_CHUNK_SIZE,
    skipVerify: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-verify') args.skipVerify = true;
    else if (arg.startsWith('--input=')) args.inputPath = path.resolve(arg.slice('--input='.length));
    else if (arg === '--input' && argv[i + 1]) args.inputPath = path.resolve(argv[++i]);
    else if (arg.startsWith('--checkpoint=')) args.inputPath = path.resolve(arg.slice('--checkpoint='.length));
    else if (arg === '--checkpoint' && argv[i + 1]) args.inputPath = path.resolve(argv[++i]);
    else if (arg.startsWith('--verified-out=')) args.verifiedOutPath = path.resolve(arg.slice('--verified-out='.length));
    else if (arg === '--verified-out' && argv[i + 1]) args.verifiedOutPath = path.resolve(argv[++i]);
    else if (arg.startsWith('--sql-dir=')) args.sqlDir = path.resolve(arg.slice('--sql-dir='.length));
    else if (arg === '--sql-dir' && argv[i + 1]) args.sqlDir = path.resolve(argv[++i]);
    else if (arg.startsWith('--songs=')) args.songsPath = path.resolve(arg.slice('--songs='.length));
    else if (arg === '--songs' && argv[i + 1]) args.songsPath = path.resolve(argv[++i]);
    else if (arg.startsWith('--snapshot-out=')) args.snapshotOutPath = path.resolve(arg.slice('--snapshot-out='.length));
    else if (arg === '--snapshot-out' && argv[i + 1]) args.snapshotOutPath = path.resolve(argv[++i]);
    else if (arg.startsWith('--chunk-size=')) args.chunkSize = Number(arg.slice('--chunk-size='.length));
    else if (arg === '--chunk-size' && argv[i + 1]) args.chunkSize = Number(argv[++i]);
  }
  return args;
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
  const opts = parseVerifyArgs(process.argv.slice(2));
  runVerifyAndExport(opts)
    .then((res) => {
      console.log(
        `✓ Stage 3/4 complete: ${res.verifiedCount} rows (${res.verification.apiCalls} videos.list calls, ${res.verification.uniqueVideoCount} unique IDs), ${res.chunkCount} SQL chunks in ${opts.sqlDir}, ${res.snapshotCount} playable snapshot songs -> ${res.snapshotOutPath}`,
      );
      if (res.verification.counts) console.log(`  Compatibility summary: ${JSON.stringify(res.verification.counts)}`);
    })
    .catch((err) => {
      console.error(`❌ Stage 3/4 failed: ${err.message || err}`);
      process.exit(1);
    });
}
