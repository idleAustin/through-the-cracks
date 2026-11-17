// Metadata Atlas client adapter (/api/atlas live-first with /data/metadata-atlas.json fallback) and filter projections.
import { resolveApiBase, setArchiveMode } from './api-runtime.js';
import { fetchStaticJson } from './api-static.js';

const LIVE_TIMEOUT_MS = 2000;
let cachedAtlas = null;
let inFlightEntry = null;

function createAbortError() {
  return Object.assign(new Error('Metadata atlas request aborted.'), { name: 'AbortError' });
}

function isValidAtlasShape(p) {
  return Boolean(
    p?.summary && typeof p.summary === 'object' && !Array.isArray(p.summary)
    && Array.isArray(p.decades)
    && p.states && typeof p.states === 'object' && !Array.isArray(p.states),
  );
}

export function resetMetadataAtlasCache() { cachedAtlas = null; inFlightEntry = null; }

export function decadeForYear(year) {
  const num = Number(year);
  if (num < 1960) return { id: 'pre-1960s', label: 'Pre-1960s', startYear: 1900 };
  const dec = Math.floor(num / 10) * 10;
  return { id: `${dec}s`, label: `${dec}s`, startYear: dec };
}

async function loadMetadataAtlas(entry) {
  const controller = new AbortController();
  entry.controller = controller;
  const timeoutId = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${resolveApiBase()}/atlas`, { signal: controller.signal });
    const ct = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (res.ok && !ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
      const data = await res.json();
      if (isValidAtlasShape(data)) {
        if (entry.abortedByCallers) throw createAbortError();
        setArchiveMode('live');
        return (cachedAtlas = { data, source: 'express-api', mode: 'live' });
      }
    }
  } catch { if (entry.abortedByCallers) throw createAbortError(); } finally { clearTimeout(timeoutId); }
  if (entry.abortedByCallers) throw createAbortError();
  const staticData = await fetchStaticJson('/data/metadata-atlas.json');
  if (entry.abortedByCallers) throw createAbortError();
  if (!isValidAtlasShape(staticData)) throw new Error('Metadata atlas snapshot has invalid shape.');
  setArchiveMode('static');
  return (cachedAtlas = { data: staticData, source: 'static-json', mode: 'static' });
}

export async function getMetadataAtlas({ signal, forceRefresh = false } = {}) {
  if (signal?.aborted) throw createAbortError();
  if (!forceRefresh && cachedAtlas) { setArchiveMode(cachedAtlas.mode); return cachedAtlas; }
  if (forceRefresh) { cachedAtlas = null; inFlightEntry = null; }
  let entry = inFlightEntry;
  if (!entry) {
    entry = { waiters: 0, abortedByCallers: false, controller: null, promise: null };
    inFlightEntry = entry;
    entry.promise = loadMetadataAtlas(entry).finally(() => { if (inFlightEntry === entry) inFlightEntry = null; });
  }
  entry.waiters += 1;
  if (!signal) return entry.promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); fn(arg); } };
    const onAbort = () => {
      if (settled) return;
      if ((entry.waiters = Math.max(0, entry.waiters - 1)) === 0) {
        entry.abortedByCallers = true;
        entry.controller?.abort();
        if (inFlightEntry === entry) inFlightEntry = null;
      }
      settle(reject, createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then((v) => settle(resolve, v), (e) => settle(reject, e));
  });
}

export function computeFilteredAtlas(atlasData, { selectedDecade = '', selectedYear = null, selectedState = '', mapMode = 'recorded', includeMastering = false } = {}) {
  if (!atlasData) return null;
  const cube = atlasData.yearStateCube || [];
  let decades = atlasData.decades || [];
  if (selectedState) {
    const yearTopMap = new Map();
    for (const dec of decades) for (const yr of dec.years || []) yearTopMap.set(yr.year, yr.topSongs || []);
    const buckets = new Map();
    for (const [yr, st, recS, recP, allS, allP, origS, origP] of cube) {
      if (st !== selectedState) continue;
      const sc = mapMode === 'artist' ? origS : (includeMastering ? allS : recS);
      const sp = mapMode === 'artist' ? origP : (includeMastering ? allP : recP);
      if (sc <= 0 && sp <= 0) continue;
      const meta = decadeForYear(yr);
      if (!buckets.has(meta.id)) buckets.set(meta.id, { ...meta, years: [] });
      buckets.get(meta.id).years.push({ year: yr, songCount: sc, spinCount: sp, coverCount: 0, topSongs: yearTopMap.get(yr) || [] });
    }
    decades = [...buckets.values()].sort((a, b) => a.startYear - b.startYear).map((dec) => {
      dec.years.sort((a, b) => a.year - b.year);
      const songCount = dec.years.reduce((s, y) => s + y.songCount, 0);
      const spinCount = dec.years.reduce((s, y) => s + y.spinCount, 0);
      const peakYear = dec.years.slice().sort((a, b) => b.songCount - a.songCount || b.spinCount - a.spinCount)[0]?.year || null;
      return { ...dec, songCount, spinCount, coverCount: 0, peakYear };
    });
  }
  let states = atlasData.states || {};
  if (selectedYear || selectedDecade) {
    const agg = new Map();
    for (const [yr, st, recS, recP, allS, allP, origS, origP] of cube) {
      if (selectedYear ? yr !== selectedYear : decadeForYear(yr).id !== selectedDecade) continue;
      const c = agg.get(st) || [0, 0, 0, 0, 0, 0];
      c[0] += recS; c[1] += recP; c[2] += allS; c[3] += allP; c[4] += origS; c[5] += origP;
      agg.set(st, c);
    }
    states = Object.fromEntries(Object.entries(states).map(([code, base]) => {
      const v = agg.get(code) || [0, 0, 0, 0, 0, 0];
      return [code, { ...base, recorded: { ...base.recorded, songs: v[0], spins: v[1] }, allStudios: { ...base.allStudios, songs: v[2], spins: v[3] }, artistOrigin: { ...base.artistOrigin, songs: v[4], spins: v[5] }, magnetDelta: v[0] - v[4] }];
    }));
  }
  return { ...atlasData, decades, states };
}
