// Local real-time YouTube Music discovery pipeline telemetry server and payload builder.
import http from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMetadataVisualizerPayload } from './song-metadata-visualizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export const DEFAULT_PORT = 4177;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_CATALOG_PATH = path.join(ROOT, '.cache', 'song-links', 'catalog-input.json');
export const DEFAULT_CHECKPOINT_PATH = path.join(ROOT, '.cache', 'song-links', 'checkpoint.jsonl');
export const DEFAULT_STATUS_PATH = path.join(ROOT, '.cache', 'song-links', 'discovery-status.json');
export const DEFAULT_VERIFIED_SNAPSHOT_PATH = path.join(ROOT, 'public', 'data', 'song-links.json');
export const DEFAULT_LOG_PATH = path.join(ROOT, '.cache', 'song-links', 'discovery.log');
const HTML_PATH = path.join(__dirname, 'song-links-visualizer.html');
const METADATA_PANEL_PATH = path.join(__dirname, 'song-metadata-visualizer.html');
const TOKENS_CSS_PATH = path.join(ROOT, 'src', 'styles', 'tokens.css');
const VISUALIZER_CSS_PATH = path.join(__dirname, 'visualizer.css');
const VISUALIZER_CLIENT_JS_PATH = path.join(__dirname, 'visualizer-client.js');
const MAX_LOG_BYTES = 32 * 1024;
const MAX_RECENT = 25;
const TIERS = ['high', 'medium', 'low', 'unmatched'];
const checkpointCache = new Map();
const jsonFileCache = new Map();

const roundNum = (val, digits = 2) => (Number.isFinite(val) ? Math.round(val * 10 ** digits) / 10 ** digits : 0);
const pct = (part, total) => (total > 0 ? roundNum((part / total) * 100, 2) : 0);

function readJsonOptional(filePath) {
  try { return filePath && existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null; } catch { return null; }
}

function readJsonCached(filePath, transform, fallback) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) { jsonFileCache.delete(resolved); return fallback; }
  const st = statSync(resolved);
  const cached = jsonFileCache.get(resolved);
  if (cached && cached.ino === st.ino && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
  const data = transform(readJsonOptional(resolved));
  jsonFileCache.set(resolved, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

function readFileSlice(filePath, startPos, length) {
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, 'r');
  let offset = 0;
  try {
    while (offset < length) {
      const n = readSync(fd, buf, offset, length - offset, startPos + offset);
      if (n <= 0) break;
      offset += n;
    }
  } finally { closeSync(fd); }
  return offset === length ? buf : buf.subarray(0, offset);
}

function applyCheckpointLine(rawLine, entry, fallbackMs) {
  const trimmed = rawLine.trim();
  if (!trimmed) return false;
  let rec;
  try { rec = JSON.parse(trimmed); } catch { return false; }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  const songKey = String(rec.song_key ?? rec.songKey ?? '').trim();
  if (!songKey) return false;

  const rawTier = String(rec.match_tier ?? rec.matchTier ?? 'unmatched').toLowerCase();
  const matchTier = TIERS.includes(rawTier) ? rawTier : 'unmatched';
  const rawTs = rec.checked_at ?? rec.checkedAt ?? null;
  const parsedTs = rawTs ? Date.parse(rawTs) : NaN;
  const checkedAtMs = Number.isFinite(parsedTs) ? parsedTs : fallbackMs;

  const prev = entry.byKey.get(songKey);
  if (prev) entry.tiers[prev.matchTier] -= 1;
  entry.tiers[matchTier] += 1;
  entry.byKey.set(songKey, { matchTier, checkedAtMs });

  const videoId = rec.video_id || rec.videoId || null;
  const score = Number(rec.confidence_score ?? rec.confidenceScore);
  entry.recent.push({
    songKey, artist: String(rec.artist ?? ''), songTitle: String(rec.song_title ?? rec.songTitle ?? ''),
    videoId: videoId ? String(videoId) : null, matchTier, confidenceScore: Number.isFinite(score) ? score : 0,
    checkedAt: rawTs, youtubeUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
  });
  if (entry.recent.length > MAX_RECENT * 2) entry.recent = entry.recent.slice(-MAX_RECENT);
  return true;
}

function readCheckpointIncremental(checkpointPath) {
  const resolved = path.resolve(checkpointPath);
  if (!existsSync(resolved)) {
    checkpointCache.delete(resolved);
    return { byKey: new Map(), tiers: { high: 0, medium: 0, low: 0, unmatched: 0 }, recent: [] };
  }
  const st = statSync(resolved);
  let entry = checkpointCache.get(resolved);
  if (!entry || entry.ino !== st.ino || st.size < entry.offset) {
    entry = { ino: st.ino, offset: 0, byKey: new Map(), tiers: { high: 0, medium: 0, low: 0, unmatched: 0 }, recent: [] };
    checkpointCache.set(resolved, entry);
  }
  if (st.size > entry.offset) {
    const slice = readFileSlice(resolved, entry.offset, st.size - entry.offset);
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl !== -1) {
      for (const line of slice.subarray(0, lastNl + 1).toString('utf8').split(/\r?\n/)) applyCheckpointLine(line, entry, st.mtimeMs);
      entry.offset += lastNl + 1;
    }
    const tailStart = lastNl === -1 ? 0 : lastNl + 1;
    const tailText = slice.subarray(tailStart).toString('utf8').trim();
    if (tailText.startsWith('{') && tailText.endsWith('}') && applyCheckpointLine(tailText, entry, st.mtimeMs)) {
      entry.offset += slice.length - tailStart;
    }
  }
  return entry;
}

export function readLogTail(logPath, maxLines = 40) {
  if (!logPath || maxLines <= 0 || !existsSync(logPath)) return [];
  const st = statSync(logPath);
  if (st.size <= 0) return [];
  const readLen = Math.min(st.size, MAX_LOG_BYTES);
  const startPos = st.size - readLen;
  let text = readFileSlice(logPath, startPos, readLen).toString('utf8');
  if (startPos > 0) { const nl = text.indexOf('\n'); text = nl !== -1 ? text.slice(nl + 1) : ''; }
  return text.split(/\r?\n/).filter((line) => line.length > 0).slice(-maxLines);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

export function buildVisualizerPayload({
  catalogPath = DEFAULT_CATALOG_PATH, checkpointPath = DEFAULT_CHECKPOINT_PATH,
  statusPath = DEFAULT_STATUS_PATH, verifiedSnapshotPath = DEFAULT_VERIFIED_SNAPSHOT_PATH,
  logPath = DEFAULT_LOG_PATH, nowMs = Date.now(),
} = {}) {
  const cp = readCheckpointIncremental(checkpointPath);
  const checkpointKeys = cp.byKey;
  const catalogEntries = readJsonCached(catalogPath, (raw) => (
    Array.isArray(raw) ? raw.map((s) => ({ key: String(s?.song_key ?? s?.songKey ?? ''), plays: Number(s?.totalPlays ?? s?.total_plays ?? 0) })) : []
  ), []);

  let pass1MultiTotal = 0, pass2SingleTotal = 0, pass1Completed = 0, pass2Completed = 0, overallCompleted = 0;
  for (const item of catalogEntries) {
    const done = item.key ? checkpointKeys.has(item.key) : false;
    if (done) overallCompleted += 1;
    if (item.plays >= 2) { pass1MultiTotal += 1; if (done) pass1Completed += 1; }
    else if (item.plays === 1) { pass2SingleTotal += 1; if (done) pass2Completed += 1; }
  }
  const totalSongs = catalogEntries.length;
  const catalog = {
    totalSongs, pass1MultiTotal, pass2SingleTotal, pass1Completed, pass2Completed, overallCompleted,
    overallPct: pct(overallCompleted, totalSongs), pass1Pct: pct(pass1Completed, pass1MultiTotal),
    pass2Pct: pct(pass2Completed, pass2SingleTotal),
    productionLivePool: readJsonCached(verifiedSnapshotPath, (raw) => (Array.isArray(raw) ? raw.length : 0), 0),
  };

  const { high, medium, low, unmatched } = cp.tiers;
  const totalChecked = high + medium + low + unmatched;
  const matchedTotal = high + medium + low;
  const tiers = { high, medium, low, unmatched, totalChecked, matchedTotal, matchRatePct: pct(matchedTotal, totalChecked) };

  const status = readJsonOptional(statusPath);
  const pid = status?.pid ?? null;
  const alive = pid ? isProcessAlive(pid) : false;
  const paceMultiplier = Number(status?.paceMultiplier ?? 1);
  const minJitter = Number(status?.minJitter ?? 0);
  const maxJitter = Number(status?.maxJitter ?? 0);
  const cooldownUntilMs = status?.cooldownUntil ? Date.parse(status.cooldownUntil) : NaN;
  const cooldownRemainingSec = Number.isFinite(cooldownUntilMs) ? Math.max(0, Math.round((cooldownUntilMs - nowMs) / 1000)) : 0;

  const runtime = {
    alive, pid, passMode: status?.passMode ?? null, startedAt: status?.startedAt ?? null, updatedAt: status?.updatedAt ?? null,
    phase: status?.phase || 'idle', batchSize: Number(status?.batchSize ?? 0), batchIndex: Number(status?.batchIndex ?? 0),
    totalBatches: Number(status?.totalBatches ?? 0), batchProcessed: Number(status?.batchProcessed ?? 0),
    paceMultiplier, cleanStreak: Number(status?.cleanStreak ?? 0), minJitter, maxJitter,
    effectiveMinJitter: roundNum(minJitter * paceMultiplier, 3), effectiveMaxJitter: roundNum(maxJitter * paceMultiplier, 3),
    cooldownMin: Number(status?.cooldownMin ?? 0), cooldownMax: Number(status?.cooldownMax ?? 0),
    initialCooldown: Number(status?.initialCooldown ?? 0), cooldownSeconds: Number(status?.cooldownSeconds ?? 0),
    cooldownStartedAt: status?.cooldownStartedAt ?? null, cooldownUntil: status?.cooldownUntil ?? null, cooldownRemainingSec,
    currentSong: status?.currentSong ?? null, runTiers: status?.tiers || null, processedInRun: Number(status?.processedInRun ?? 0),
    pendingTotal: Number(status?.pendingTotal ?? 0), retryCount: Number(status?.retryCount ?? 0),
    recentRetries: Array.isArray(status?.recentRetries) ? [...status.recentRetries].reverse() : [],
  };

  let songsLast15m = 0, songsLast60m = 0;
  const cut15 = nowMs - 15 * 60_000, cut60 = nowMs - 60 * 60_000, upper = nowMs + 5000;
  for (const val of checkpointKeys.values()) {
    if (val.checkedAtMs <= upper && val.checkedAtMs >= cut60) { songsLast60m += 1; if (val.checkedAtMs >= cut15) songsLast15m += 1; }
  }

  const activeRaw = songsLast15m > 0 ? songsLast15m / 15 : songsLast60m / 60;
  const observedRaw = Math.max(songsLast60m / 60, activeRaw);
  const avgJitter = ((minJitter || 1.5) + (maxJitter || 3.0)) / 2 * (paceMultiplier || 1);
  const activeSecPerSong = 1.0 * (0.42 + avgJitter);
  const avgCooldownSec = runtime.batchSize > 0
    ? ((runtime.cooldownMin || 0) + (runtime.cooldownMax || runtime.cooldownMin || 0)) / 2 / runtime.batchSize : 0;
  const configuredRaw = 60 / (activeSecPerSong + avgCooldownSec);
  const startedMs = runtime.startedAt ? Date.parse(runtime.startedAt) : NaN;
  const elapsedRunMin = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 60_000) : 0;
  const canUseObs = observedRaw > 0 && !(alive && runtime.processedInRun === 0) && (songsLast15m > 0 || !alive || elapsedRunMin >= 15);
  const obsWeight = canUseObs
    ? (elapsedRunMin >= 15 || songsLast15m >= 20 ? 1 : Math.min(1, (songsLast15m > 0 ? songsLast15m : songsLast60m) / 20))
    : 0;
  const effectiveRaw = obsWeight * observedRaw + (1 - obsWeight) * configuredRaw;

  const initialDelaySec = alive && runtime.phase === 'initial_cooldown' ? cooldownRemainingSec : 0;
  const pass1Remaining = Math.max(0, pass1MultiTotal - pass1Completed);
  const fullCatalogRemaining = Math.max(0, totalSongs - overallCompleted);
  const calcEta = (rem) => {
    if (rem <= 0) return { seconds: 0, iso: null };
    if (!(effectiveRaw > 0)) return { seconds: null, iso: null };
    const seconds = Math.round((rem / effectiveRaw) * 60 + initialDelaySec);
    return { seconds, iso: new Date(nowMs + seconds * 1000).toISOString() };
  };
  const pass1Eta = calcEta(pass1Remaining), fullEta = calcEta(fullCatalogRemaining);

  return {
    generatedAt: new Date(nowMs).toISOString(), catalog, tiers, runtime,
    throughput: {
      songsLast15m, songsLast60m, activeSongsPerMin: roundNum(activeRaw, 2), observedSongsPerMin: roundNum(observedRaw, 2),
      configuredSongsPerMin: roundNum(configuredRaw, 2), effectiveSongsPerMin: roundNum(effectiveRaw, 2),
      pass1Remaining, pass1EtaSeconds: pass1Eta.seconds, pass1EtaIso: pass1Eta.iso,
      fullCatalogRemaining, fullCatalogEtaSeconds: fullEta.seconds, fullCatalogEtaIso: fullEta.iso,
    },
    recentMatches: cp.recent.slice(-MAX_RECENT).reverse(),
    logTail: readLogTail(logPath, 40),
  };
}

export function createVisualizerServer(options = {}) {
  const htmlPath = options.htmlPath || HTML_PATH;
  const panelPath = options.panelPath || METADATA_PANEL_PATH;
  const tokensPath = options.tokensCssPath || TOKENS_CSS_PATH;
  const cssPath = options.visualizerCssPath || VISUALIZER_CSS_PATH;
  const clientJsPath = options.visualizerClientJsPath || VISUALIZER_CLIENT_JS_PATH;

  return http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    const pathname = new URL(req.url || '/', `http://${DEFAULT_HOST}`).pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/metadata')) {
      try {
        let html = readFileSync(htmlPath, 'utf8');
        if (existsSync(panelPath)) html = html.replace('<!--METADATA_PANEL-->', readFileSync(panelPath, 'utf8'));
        if (pathname === '/metadata' || options.defaultTab === 'metadata') {
          html = html.replace('data-default-tab="links"', 'data-default-tab="metadata"');
        }
        return send(200, 'text/html; charset=utf-8', html);
      } catch (err) {
        return send(500, 'text/plain; charset=utf-8', `Failed to load visualizer HTML: ${err.message}`);
      }
    }
    if (req.method === 'GET' && pathname === '/tokens.css') return send(200, 'text/css; charset=utf-8', readFileSync(tokensPath, 'utf8'));
    if (req.method === 'GET' && pathname === '/visualizer.css') return send(200, 'text/css; charset=utf-8', readFileSync(cssPath, 'utf8'));
    if (req.method === 'GET' && pathname === '/visualizer-client.js') return send(200, 'application/javascript; charset=utf-8', readFileSync(clientJsPath, 'utf8'));
    if (req.method === 'GET' && pathname === '/api/status') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(buildVisualizerPayload(options)));
    }
    if (req.method === 'GET' && pathname === '/api/metadata-status') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(buildMetadataVisualizerPayload(options.metadataOptions || {})));
    }
    if (req.method === 'GET' && pathname === '/healthz') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
    }
    return send(404, 'text/plain; charset=utf-8', '404 Not Found');
  });
}

function parsePort(argv) {
  let raw = process.env.PORT || '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--port=')) raw = argv[i].slice('--port='.length);
    else if (argv[i] === '--port' && argv[i + 1]) raw = argv[++i];
  }
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 && num <= 65535 ? num : DEFAULT_PORT;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return realpathSync(path.resolve(process.argv[1])) === realpathSync(__filename); }
  catch { return path.resolve(process.argv[1]) === __filename; }
}

if (isDirectExecution()) {
  const server = createVisualizerServer();
  const port = parsePort(process.argv.slice(2));
  server.listen(port, DEFAULT_HOST, () => {
    const addr = server.address();
    console.log(`Song Links Visualizer listening at http://${DEFAULT_HOST}:${typeof addr === 'object' && addr ? addr.port : port}`);
  });
}
