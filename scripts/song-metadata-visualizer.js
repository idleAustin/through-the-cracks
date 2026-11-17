#!/usr/bin/env node
// Song Metadata & Pre-Run Data Load telemetry builder and standalone /metadata server.
import http from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const META_CACHE_DIR = path.join(ROOT, '.cache', 'song-metadata');

export const DEFAULT_META_PORT = 4178;
export const DEFAULT_META_HOST = '127.0.0.1';
export const DEFAULT_META_CATALOG_PATH = path.join(META_CACHE_DIR, 'catalog-input.json');
export const DEFAULT_META_CHECKPOINT_PATH = path.join(META_CACHE_DIR, 'checkpoint.jsonl');
export const DEFAULT_META_STATUS_PATH = path.join(META_CACHE_DIR, 'discovery-status.json');
export const DEFAULT_META_SUMMARY_PATH = path.join(META_CACHE_DIR, 'summary.json');
export const DEFAULT_META_LOG_PATH = path.join(META_CACHE_DIR, 'discovery.log');
export const DEFAULT_META_SQLITE_PATH = path.join(META_CACHE_DIR, 'song-metadata.sqlite');
export const DEFAULT_META_HTTP_CACHE_PATH = path.join(META_CACHE_DIR, 'http-cache.sqlite');

const CONFIGURED_SONGS_PER_MIN = 38.5;
const PASS1_STEADY_SONGS_PER_MIN = 27.0;
const MAX_RECENT = 25;
const MAX_LOG_BYTES = 32 * 1024;
const catalogCache = new Map();
const checkpointCache = new Map();

const roundNum = (val, digits = 1) => (Number.isFinite(val) ? Math.round(val * 10 ** digits) / 10 ** digits : 0);
const pct = (part, total) => (total > 0 ? roundNum((part / total) * 100, 1) : 0);

function readJsonOptional(filePath) {
  try { return filePath && existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null; } catch { return null; }
}

function fileSizeBytes(filePath) {
  try { return filePath && existsSync(filePath) ? statSync(filePath).size : 0; } catch { return 0; }
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

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

export function readLogTail(logPath, maxLines = 40) {
  if (!logPath || maxLines <= 0 || !existsSync(logPath)) return [];
  const st = statSync(logPath);
  if (st.size <= 0) return [];
  const readLen = Math.min(st.size, MAX_LOG_BYTES);
  const startPos = st.size - readLen;
  let text = readFileSlice(logPath, startPos, readLen).toString('utf8');
  if (startPos > 0) { const nl = text.indexOf('\n'); text = nl !== -1 ? text.slice(nl + 1) : ''; }
  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function readMetaCatalogCached(catalogPath) {
  if (!catalogPath || !existsSync(catalogPath)) return null;
  const resolved = path.resolve(catalogPath);
  const st = statSync(resolved);
  const cached = catalogCache.get(resolved);
  if (cached && cached.ino === st.ino && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
  const raw = readJsonOptional(resolved);
  if (!raw || !Array.isArray(raw.songs)) return null;
  const data = {
    stats: raw.stats || {},
    artistsCount: Array.isArray(raw.artists) ? raw.artists.length : Number(raw.stats?.totalArtists || 0),
    songs: raw.songs.map((s) => ({
      key: String(s?.song_key || ''), artist: String(s?.artist || ''), albumKey: s?.album_key || null,
      isSingle: Boolean(s?.is_single), plays: Number(s?.totalPlays || 0),
    })),
    albums: (Array.isArray(raw.albums) ? raw.albums : []).map((a) => ({
      albumKey: String(a?.albumKey || ''), artist: String(a?.artist || ''), album: String(a?.album || ''),
      totalPlays: Number(a?.totalPlays || 0), maxSongPlays: Number(a?.maxSongPlays || 0),
      songCount: Number(a?.songCount || 0), multiSpinCount: Number(a?.multiSpinCount || 0),
      songKeys: Array.isArray(a?.songKeys) ? a.songKeys : [],
    })),
  };
  catalogCache.set(resolved, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

function applyMetaCheckpointLine(rawLine, entry, fallbackMs) {
  const trimmed = rawLine.trim();
  if (!trimmed) return false;
  let rec;
  try { rec = JSON.parse(trimmed); } catch { return false; }
  const songKey = String(rec?.song_key || '').trim();
  if (!songKey) return false;
  const rawTs = rec.checked_at || null;
  const parsedTs = rawTs ? Date.parse(rawTs) : NaN;
  const checkedAtMs = Number.isFinite(parsedTs) ? parsedTs : fallbackMs;
  const prev = entry.byKey.get(songKey) || {};
  const writers = [...(rec.mb?.writers || []), ...(rec.discogs?.writers || []), ...(rec.shs?.writers || [])];
  const merged = {
    checkedAtMs,
    mbFound: Boolean(prev.mbFound || rec.mb?.found),
    discogsFound: Boolean(prev.discogsFound || rec.discogs?.found),
    wikiFound: Boolean(prev.wikiFound || rec.artist_profile?.wiki_summary),
    shsFound: Boolean(prev.shsFound || rec.shs?.found),
    releaseYear: rec.mb?.release_year || rec.discogs?.release_year || rec.shs?.perf_year || prev.releaseYear || null,
    writersCount: Math.max(Number(prev.writersCount || 0), writers.length),
  };
  entry.byKey.set(songKey, merged);
  entry.recent.push({
    songKey, artist: String(rec.artist || ''), songTitle: String(rec.song_title || ''), album: String(rec.album || ''),
    releaseYear: merged.releaseYear, writers: writers.slice(0, 4),
    sourcesChecked: Array.isArray(rec.sources_checked) ? rec.sources_checked : [],
    mbFound: merged.mbFound, discogsFound: merged.discogsFound, wikiFound: merged.wikiFound, shsFound: merged.shsFound,
    checkedAt: rawTs,
  });
  if (entry.recent.length > MAX_RECENT * 2) entry.recent = entry.recent.slice(-MAX_RECENT);
  return true;
}

function readMetaCheckpointIncremental(checkpointPath) {
  const empty = () => ({ byKey: new Map(), recent: [] });
  if (!checkpointPath || !existsSync(checkpointPath)) { checkpointCache.delete(path.resolve(checkpointPath || '')); return empty(); }
  const resolved = path.resolve(checkpointPath);
  const st = statSync(resolved);
  let entry = checkpointCache.get(resolved);
  if (!entry || entry.ino !== st.ino || st.size < entry.offset) {
    entry = { ino: st.ino, offset: 0, byKey: new Map(), recent: [] };
    checkpointCache.set(resolved, entry);
  }
  if (st.size > entry.offset) {
    const slice = readFileSlice(resolved, entry.offset, st.size - entry.offset);
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl !== -1) {
      for (const line of slice.subarray(0, lastNl + 1).toString('utf8').split(/\r?\n/)) applyMetaCheckpointLine(line, entry, st.mtimeMs);
      entry.offset += lastNl + 1;
    }
    const tailStart = lastNl === -1 ? 0 : lastNl + 1;
    const tail = slice.subarray(tailStart).toString('utf8').trim();
    if (tail.startsWith('{') && tail.endsWith('}') && applyMetaCheckpointLine(tail, entry, st.mtimeMs)) {
      entry.offset += slice.length - tailStart;
    }
  }
  return entry;
}

function computeSpinTiers(songs, byKey) {
  const buckets = [
    { id: 'staples', label: 'Staples (10+ Spins)', min: 10, max: Infinity, total: 0, completed: 0 },
    { id: 'favorites', label: 'Favorites (5-9 Spins)', min: 5, max: 9, total: 0, completed: 0 },
    { id: 'rotation', label: 'Rotation (2-4 Spins)', min: 2, max: 4, total: 0, completed: 0 },
    { id: 'deep_cuts', label: '1-Spin Deep Cuts', min: 0, max: 1, total: 0, completed: 0 },
  ];
  for (const s of songs) {
    const tier = buckets.find((b) => s.plays >= b.min && s.plays <= b.max) || buckets[3];
    tier.total += 1;
    if (byKey.has(s.key)) tier.completed += 1;
  }
  return buckets.map(({ id, label, total, completed }) => ({ id, label, total, completed, pct: pct(completed, total) }));
}

export function buildMetadataVisualizerPayload({
  catalogPath = DEFAULT_META_CATALOG_PATH,
  checkpointPath = DEFAULT_META_CHECKPOINT_PATH,
  statusPath = DEFAULT_META_STATUS_PATH,
  summaryPath = DEFAULT_META_SUMMARY_PATH,
  logPath = DEFAULT_META_LOG_PATH,
  sqlitePath = DEFAULT_META_SQLITE_PATH,
  httpCachePath = DEFAULT_META_HTTP_CACHE_PATH,
  nowMs = Date.now(),
} = {}) {
  const cat = readMetaCatalogCached(catalogPath);
  const cp = readMetaCheckpointIncremental(checkpointPath);
  const byKey = cp.byKey;
  const songs = cat?.songs || [];
  const albums = cat?.albums || [];

  let pass1MultiTotal = 0, pass2SingleTotal = 0, highSpinSongs = 0, albumCoveredSongs = 0, singleSongs = 0;
  let multiSpinAlbumSongsTotal = 0, multiSpinSinglesTotal = 0;
  let overallCompleted = 0, pass1Completed = 0, pass2Completed = 0, pass1RemainingSingles = 0, fullRemainingSingles = 0;
  const multiSpinKeys = new Set();
  const artistAgg = new Map();

  for (const s of songs) {
    const done = byKey.has(s.key);
    if (done) overallCompleted += 1;
    if (s.isSingle) { singleSongs += 1; if (!done) fullRemainingSingles += 1; } else { albumCoveredSongs += 1; }
    if (s.plays >= 5) highSpinSongs += 1;
    if (s.plays >= 2) {
      multiSpinKeys.add(s.key);
      pass1MultiTotal += 1;
      if (done) pass1Completed += 1;
      if (s.isSingle) { multiSpinSinglesTotal += 1; if (!done) pass1RemainingSingles += 1; }
      else { multiSpinAlbumSongsTotal += 1; }
    } else {
      pass2SingleTotal += 1;
      if (done) pass2Completed += 1;
    }
    let a = artistAgg.get(s.artist);
    if (!a) { a = { artist: s.artist, songCount: 0, totalPlays: 0, completedCount: 0 }; artistAgg.set(s.artist, a); }
    a.songCount += 1; a.totalPlays += s.plays; if (done) a.completedCount += 1;
  }

  let albumsCompleted = 0, albumsTouched = 0, multiSpinAlbumsTotal = 0;
  let pass1RemainingAlbums = 0, fullRemainingAlbums = 0;
  const upcomingAlbums = [];
  for (const alb of albums) {
    if (alb.multiSpinCount > 0) multiSpinAlbumsTotal += 1;
    let completedCount = 0;
    let needsMulti = false;
    for (const k of alb.songKeys) {
      if (byKey.has(k)) completedCount += 1;
      else if (multiSpinKeys.has(k)) needsMulti = true;
    }
    if (completedCount > 0) albumsTouched += 1;
    if (alb.songKeys.length > 0 && completedCount >= alb.songKeys.length) albumsCompleted += 1;
    else {
      fullRemainingAlbums += 1;
      if (upcomingAlbums.length < 20) {
        upcomingAlbums.push({
          albumKey: alb.albumKey, artist: alb.artist, album: alb.album, totalPlays: alb.totalPlays,
          maxSongPlays: alb.maxSongPlays, songCount: alb.songCount, multiSpinCount: alb.multiSpinCount, completedCount,
        });
      }
    }
    if (needsMulti) pass1RemainingAlbums += 1;
  }

  const topArtistsLoad = [...artistAgg.values()]
    .sort((a, b) => b.songCount - a.songCount || b.totalPlays - a.totalPlays)
    .slice(0, 12)
    .map((a) => ({ ...a, pct: pct(a.completedCount, a.songCount) }));

  let mbHits = 0, discogsHits = 0, wikiHits = 0, shsHits = 0, anyHitCount = 0;
  let songsLast15m = 0, songsLast60m = 0;
  const cut15 = nowMs - 15 * 60_000, cut60 = nowMs - 60 * 60_000, upper = nowMs + 5000;
  for (const v of byKey.values()) {
    if (v.mbFound) mbHits += 1;
    if (v.discogsFound) discogsHits += 1;
    if (v.wikiFound) wikiHits += 1;
    if (v.shsFound) shsHits += 1;
    if (v.mbFound || v.discogsFound || v.wikiFound || v.shsFound) anyHitCount += 1;
    if (v.checkedAtMs <= upper && v.checkedAtMs >= cut60) {
      songsLast60m += 1;
      if (v.checkedAtMs >= cut15) songsLast15m += 1;
    }
  }

  const totalChecked = byKey.size;
  const status = readJsonOptional(statusPath);
  const summary = readJsonOptional(summaryPath);
  const pid = status?.pid ?? null;
  const alive = pid ? isProcessAlive(pid) : false;
  const phase = status?.phase === 'running' && !alive ? 'stale' : (status?.phase || 'idle');

  let completedArtists = 0;
  for (const a of artistAgg.values()) {
    if (a.completedCount > 0) completedArtists += 1;
  }
  const remainingArtists = Math.max(0, artistAgg.size - completedArtists);

  const observedRaw = Math.max(songsLast60m / 60, songsLast15m > 0 ? songsLast15m / 15 : 0);
  const obsWeight = alive && observedRaw > 0 ? Math.min(1, Math.max(songsLast15m, songsLast60m) / 30) : 0;
  const pass1Rate = obsWeight * observedRaw + (1 - obsWeight) * PASS1_STEADY_SONGS_PER_MIN;
  const fullRate = obsWeight * observedRaw + (1 - obsWeight) * CONFIGURED_SONGS_PER_MIN;
  const pass1Remaining = Math.max(0, pass1MultiTotal - pass1Completed);
  const fullCatalogRemaining = Math.max(0, songs.length - overallCompleted);
  const calcEta = (rem, rate) => {
    if (rem <= 0) return { seconds: 0, iso: null };
    if (!(rate > 0)) return { seconds: null, iso: null };
    const seconds = Math.round((rem / rate) * 60);
    return { seconds, iso: new Date(nowMs + seconds * 1000).toISOString() };
  };
  const pass1Eta = calcEta(pass1Remaining, pass1Rate);
  const fullEta = calcEta(fullCatalogRemaining, fullRate);
  const effectiveRaw = fullRate;
  const totalSongs = songs.length;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    catalog: {
      prepared: Boolean(cat), totalSongs, totalArtists: cat?.artistsCount || 0,
      albumGroupCount: albums.length, albumCoveredSongs, albumCoveredPct: pct(albumCoveredSongs, totalSongs),
      singleSongs, pass1MultiTotal, pass2SingleTotal, highSpinSongs,
      multiSpinAlbumsTotal, multiSpinAlbumSongsTotal, multiSpinSinglesTotal,
      overallCompleted, overallPct: pct(overallCompleted, totalSongs),
      pass1Completed, pass1Pct: pct(pass1Completed, pass1MultiTotal),
      pass2Completed, pass2Pct: pct(pass2Completed, pass2SingleTotal),
      albumsCompleted, albumsTouched, albumsPct: pct(albumsCompleted, albums.length),
      reconciledSongs: Number(summary?.discoveredSongs || 0),
      sqliteExists: Boolean(sqlitePath && existsSync(sqlitePath)),
      sqliteBytes: fileSizeBytes(sqlitePath), httpCacheBytes: fileSizeBytes(httpCachePath),
    },
    spinTiers: computeSpinTiers(songs, byKey),
    workload: {
      pass1RemainingAlbums, pass1RemainingSingles,
      pass1EstMbRequests: Math.round(pass1RemainingAlbums * 2.6 + pass1RemainingSingles * 1.8 + remainingArtists * 2.0),
      pass1EstDiscogsRequests: Math.round(pass1RemainingAlbums * 2.25 + pass1RemainingSingles * 1.8),
      fullRemainingAlbums, fullRemainingSingles,
      fullEstMbRequests: Math.round(fullRemainingAlbums * 2.4 + fullRemainingSingles * 1.8 + remainingArtists * 2.0),
      fullEstDiscogsRequests: Math.round(fullRemainingAlbums * 2.25 + fullRemainingSingles * 1.8),
    },
    runtime: {
      alive, pid, phase, passFilter: status?.passFilter ?? null,
      sources: Array.isArray(status?.sources) ? status.sources : [], authModes: status?.authModes || null,
      startedAt: status?.startedAt ?? null, updatedAt: status?.updatedAt ?? null,
      albumsProcessed: Number(status?.albumsProcessed ?? 0), totalAlbumsTarget: Number(status?.totalAlbumsTarget ?? 0),
      songsWritten: Number(status?.songsWritten ?? 0), totalSongsTarget: Number(status?.totalSongsTarget ?? 0),
      currentItem: status?.currentItem ?? null, errorCount: Number(status?.errorCount ?? 0),
      rateStats: status?.rateStats || null,
    },
    throughput: {
      songsLast15m, songsLast60m, observedSongsPerMin: roundNum(observedRaw, 2),
      configuredSongsPerMin: CONFIGURED_SONGS_PER_MIN, effectiveSongsPerMin: roundNum(effectiveRaw, 2),
      pass1Remaining, pass1EtaSeconds: pass1Eta.seconds, pass1EtaIso: pass1Eta.iso,
      fullCatalogRemaining, fullCatalogEtaSeconds: fullEta.seconds, fullCatalogEtaIso: fullEta.iso,
    },
    sources: {
      totalChecked, mbHits, mbPct: pct(mbHits, totalChecked),
      discogsHits, discogsPct: pct(discogsHits, totalChecked),
      wikiHits, wikiPct: pct(wikiHits, totalChecked),
      shsHits, shsPct: pct(shsHits, totalChecked),
      anyHitCount, anyHitPct: pct(anyHitCount, totalChecked),
    },
    reconciled: summary || null, upcomingAlbums, topArtistsLoad,
    recentCheckpoints: cp.recent.slice(-MAX_RECENT).reverse(),
    logTail: readLogTail(logPath, 40),
  };
}

export function createMetadataVisualizerServer(options = {}) {
  const htmlPath = options.htmlPath || path.join(__dirname, 'song-links-visualizer.html');
  const panelPath = options.panelPath || path.join(__dirname, 'song-metadata-visualizer.html');
  return http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    const pathname = new URL(req.url || '/', `http://${DEFAULT_META_HOST}`).pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/metadata')) {
      let html = readFileSync(htmlPath, 'utf8');
      if (existsSync(panelPath)) html = html.replace('<!--METADATA_PANEL-->', readFileSync(panelPath, 'utf8'));
      html = html.replace('data-default-tab="links"', 'data-default-tab="metadata"');
      return send(200, 'text/html; charset=utf-8', html);
    }
    if (req.method === 'GET' && pathname === '/tokens.css') return send(200, 'text/css; charset=utf-8', readFileSync(path.join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8'));
    if (req.method === 'GET' && pathname === '/visualizer.css') return send(200, 'text/css; charset=utf-8', readFileSync(path.join(__dirname, 'visualizer.css'), 'utf8'));
    if (req.method === 'GET' && pathname === '/visualizer-client.js') return send(200, 'application/javascript; charset=utf-8', readFileSync(path.join(__dirname, 'visualizer-client.js'), 'utf8'));
    if (req.method === 'GET' && pathname === '/api/metadata-status') return send(200, 'application/json; charset=utf-8', JSON.stringify(buildMetadataVisualizerPayload(options)));
    if (req.method === 'GET' && pathname === '/healthz') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
    return send(404, 'text/plain; charset=utf-8', '404 Not Found');
  });
}

const isEntrypoint = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isEntrypoint) {
  const argPort = process.argv.slice(2).find((a) => a.startsWith('--port='))?.slice('--port='.length);
  const port = Number(argPort || process.env.PORT || DEFAULT_META_PORT) || DEFAULT_META_PORT;
  createMetadataVisualizerServer().listen(port, DEFAULT_META_HOST, () => {
    console.log(`Song metadata visualizer listening at http://${DEFAULT_META_HOST}:${port}/metadata`);
  });
}
