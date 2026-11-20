// Tests for Metadata Atlas snapshot, R2 manifest, Express/Worker /api/atlas routes, client adapter, and treemap utils.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSnapshotPlan } from '../scripts/seed-r2.js';
import { writeCacheBlob } from '../server/d1Rollups.js';
import { ensureD1Schema } from '../server/d1Schema.js';
import { createApp } from '../server/index.js';
import { resetAtlasSnapshotCache } from '../server/routes/atlas.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';
import { computeFilteredAtlas, getMetadataAtlas, resetMetadataAtlasCache } from './api-atlas.js';
import { getArchiveMode } from './api-runtime.js';
import { collectPeakYears, computeHeatIntensity, squarifyLayout, summarizeCoverage } from './utils/atlas-treemap.js';

const ROOT = process.cwd();
const ATLAS_SNAPSHOT_PATH = path.join(ROOT, 'public', 'data', 'metadata-atlas.json');
const ATLAS_SNAPSHOT = JSON.parse(readFileSync(ATLAS_SNAPSHOT_PATH, 'utf8'));

function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const wrap = (sql, bound = []) => ({
    _sql: sql,
    bind: (...args) => wrap(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...bound) }),
    first: async () => sqlite.prepare(sql).get(...bound) ?? null,
    run: async () => { sqlite.prepare(sql).run(...bound); return { success: true }; },
  });
  return {
    sqlite,
    prepare: (sql) => wrap(sql),
    async batch(stmts) {
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) results.push(/^\s*SELECT\b/i.test(s._sql) ? await s.all() : await s.run());
        sqlite.exec('COMMIT');
      } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
      return results;
    },
  };
}

function createMemoryR2(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    get: vi.fn(async (key) => {
      const raw = store.get(key);
      return raw === undefined ? null : { text: async () => raw, json: async () => JSON.parse(raw) };
    }),
  };
}

function stubEdgeCache() {
  const store = new Map();
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  const putSpy = vi.fn(async (req, res) => { store.set(keyOf(req), res.clone()); });
  vi.stubGlobal('caches', {
    default: {
      match: vi.fn(async (req) => store.get(keyOf(req))?.clone()),
      put: putSpy,
    },
  });
  return { store, putSpy };
}

describe('Metadata Atlas snapshot, Express, Worker, client adapter, and treemap utils', () => {
  const servers = [];

  async function startExpress(atlasSnapshotPath) {
    const app = createApp({ query: async () => [], atlasSnapshotPath });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  beforeEach(() => {
    resetWorkerRateLimits();
    resetMetadataAtlasCache();
    resetAtlasSnapshotCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetMetadataAtlasCache();
    resetAtlasSnapshotCache();
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  });

  it('validates public/data/metadata-atlas.json and R2 collectSnapshotPlan manifest', () => {
    expect(ATLAS_SNAPSHOT.summary.totalSongs).toBeGreaterThanOrEqual(16285);
    expect(ATLAS_SNAPSHOT.summary.songsWithYear).toBeGreaterThanOrEqual(14199);
    expect(ATLAS_SNAPSHOT.decades).toHaveLength(8);
    expect(Object.keys(ATLAS_SNAPSHOT.states)).toHaveLength(51);
    for (const code of ['AK', 'HI', 'DC', 'TN']) {
      expect(ATLAS_SNAPSHOT.states[code]).toBeTruthy();
    }
    expect(ATLAS_SNAPSHOT.crateSample.length).toBeGreaterThan(0);
    expect(ATLAS_SNAPSHOT.yearStateCube.length).toBeGreaterThan(0);
    expect(ATLAS_SNAPSHOT.curiosities.producers.length).toBeGreaterThan(0);
    expect(ATLAS_SNAPSHOT.curiosities.timeCapsules?.vintageGems?.length).toBeGreaterThan(0);

    const cityNames = (code) => (ATLAS_SNAPSHOT.states[code]?.artistOrigin?.topCities || []).map((c) => c.name);
    expect(ATLAS_SNAPSHOT.states.DC.artistOrigin.artists).toBeGreaterThanOrEqual(6);
    expect(cityNames('DC')).toContain('Washington, D.C.');
    expect(cityNames('WA')).not.toContain('Washington, D.C.');
    for (const leakedCity of ['Little Rock', 'Mobile', 'Shreveport']) {
      expect(cityNames('TN')).not.toContain(leakedCity);
    }

    const { entries } = collectSnapshotPlan();
    expect(entries.some((entry) => entry.relPath === 'metadata-atlas.json')).toBe(true);
  });

  it('serves Express /api/atlas and /through-the-cracks/api/atlas with Cache-Control and 503 no-store when missing', async () => {
    const okBase = await startExpress(ATLAS_SNAPSHOT_PATH);
    for (const route of ['/api/atlas', '/through-the-cracks/api/atlas']) {
      const res = await fetch(`${okBase}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('max-age=300');
      const body = await res.json();
      expect(body.summary.totalSongs).toBe(ATLAS_SNAPSHOT.summary.totalSongs);
      expect(body.decades).toHaveLength(8);
    }

    const missingBase = await startExpress(path.join(tmpdir(), 'missing-metadata-atlas.json'));
    const missRes = await fetch(`${missingBase}/api/atlas`);
    expect(missRes.status).toBe(503);
    expect(missRes.headers.get('cache-control')).toBe('no-store');
    expect(await missRes.json()).toEqual({ error: 'Metadata atlas snapshot unavailable' });
  });

  it('serves Worker GET /api/atlas from R2 and Edge Cache without D1 queries', async () => {
    const { store, putSpy } = stubEdgeCache();
    const r2 = createMemoryR2({
      'v1/manifest.json': { version: 1, updatedAt: '2026-11-14T06:00:00Z', totalEpisodes: 1344, totalSongPlays: 37731, latestEpisodeId: 'ep-1' },
      'v1/metadata-atlas.json': ATLAS_SNAPSHOT,
    });
    const db = { prepare: vi.fn(() => { throw new Error('D1 should not be queried on R2 hit'); }) };

    const first = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { DB: db, SNAPSHOT_BUCKET: r2 });
    expect(first.status).toBe(200);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(r2.get).toHaveBeenCalledTimes(2);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
    expect((await first.json()).summary.songsWithYear).toBe(ATLAS_SNAPSHOT.summary.songsWithYear);

    const second = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/atlas'), { DB: db, SNAPSHOT_BUCKET: r2 });
    expect(second.status).toBe(200);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(r2.get).toHaveBeenCalledTimes(2);
    expect((await second.json()).summary.totalSongs).toBe(ATLAS_SNAPSHOT.summary.totalSongs);
  });

  it('falls back to D1 cache_blobs, ASSETS JSON, and uncached 503 on malformed/missing atlas', async () => {
    const db = createSqliteD1();
    try {
      await ensureD1Schema(db);
      await writeCacheBlob(db, 'metadata_atlas', ATLAS_SNAPSHOT);
      const d1Res = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { DB: db });
      expect(d1Res.status).toBe(200);
      expect((await d1Res.json()).summary.totalSongs).toBe(ATLAS_SNAPSHOT.summary.totalSongs);
    } finally {
      db.sqlite.close();
    }

    const emptyDb = createSqliteD1();
    try {
      await ensureD1Schema(emptyDb);
      const assetsOk = {
        fetch: vi.fn(async (req) => {
          expect(new URL(req.url).pathname).toBe('/data/metadata-atlas.json');
          return new Response(JSON.stringify(ATLAS_SNAPSHOT), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }),
      };
      const assetsNoDb = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { ASSETS: assetsOk });
      expect(assetsNoDb.status).toBe(200);
      const assetsHit = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { DB: emptyDb, ASSETS: assetsOk });
      expect(assetsHit.status).toBe(200);
      expect(assetsOk.fetch).toHaveBeenCalledTimes(2);
      expect((await assetsHit.json()).summary.songsWithYear).toBe(ATLAS_SNAPSHOT.summary.songsWithYear);

      const prefixedAssets = {
        fetch: vi.fn(async (req) => {
          const p = new URL(req.url).pathname;
          if (p === '/data/metadata-atlas.json') {
            return new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
          }
          if (p === '/through-the-cracks/data/metadata-atlas.json') {
            return new Response(JSON.stringify(ATLAS_SNAPSHOT), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response('Not found', { status: 404 });
        }),
      };
      const prefixedRes = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/atlas'), { DB: emptyDb, ASSETS: prefixedAssets });
      expect(prefixedRes.status).toBe(200);
      expect((await prefixedRes.json()).summary.totalSongs).toBe(ATLAS_SNAPSHOT.summary.totalSongs);
      expect(prefixedAssets.fetch.mock.calls.map((c) => new URL(c[0].url).pathname)).toEqual([
        '/data/metadata-atlas.json',
        '/through-the-cracks/data/metadata-atlas.json',
      ]);

      const { store, putSpy } = stubEdgeCache();
      const htmlFallbackAssets = { fetch: vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })) };
      const htmlRes = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { ASSETS: htmlFallbackAssets });
      expect(htmlRes.status).toBe(503);
      expect(await htmlRes.json()).toEqual({ error: 'Metadata atlas snapshot unavailable' });

      const badJsonAssets = { fetch: vi.fn(async () => new Response('{bad-json', { status: 200, headers: { 'Content-Type': 'application/json' } })) };
      const badJsonRes = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { ASSETS: badJsonAssets });
      expect(badJsonRes.status).toBe(503);
      expect(await badJsonRes.json()).toEqual({ error: 'Metadata atlas snapshot unavailable' });

      const emptyRes = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), {});
      expect(emptyRes.status).toBe(503);

      const unseededRes = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { DB: emptyDb });
      expect(unseededRes.status).toBe(503);
      expect(unseededRes.headers.get('cache-control')).toBe('no-store');
      expect(await unseededRes.json()).toEqual({ error: 'Metadata atlas snapshot unavailable' });
      expect(putSpy).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    } finally {
      emptyDb.sqlite.close();
    }
  });

  it('fails over from corrupt or non-object R2 v1/metadata-atlas.json to ASSETS 200 or 503 no-store', async () => {
    const manifest = { version: 1, updatedAt: '2026-11-14T06:00:00Z', totalEpisodes: 1344, totalSongPlays: 37731, latestEpisodeId: 'ep-1' };
    const assetsOk = { fetch: vi.fn(async () => new Response(JSON.stringify(ATLAS_SNAPSHOT), { status: 200, headers: { 'Content-Type': 'application/json' } })) };

    for (const badBody of [[], { summary: {} }, '{not-json']) {
      const badR2 = createMemoryR2({ 'v1/manifest.json': manifest, 'v1/metadata-atlas.json': badBody });
      const resOk = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { SNAPSHOT_BUCKET: badR2, ASSETS: assetsOk });
      expect(resOk.status).toBe(200);
      expect((await resOk.json()).summary.totalSongs).toBe(ATLAS_SNAPSHOT.summary.totalSongs);
    }

    for (const badShape of [[], { summary: {} }]) {
      const badR2 = createMemoryR2({ 'v1/manifest.json': manifest, 'v1/metadata-atlas.json': badShape });
      const res503 = await worker.fetch(new Request('https://idleamericana.com/api/atlas'), { SNAPSHOT_BUCKET: badR2 });
      expect(res503.status).toBe(503);
      expect(res503.headers.get('cache-control')).toBe('no-store');
      expect(await res503.json()).toEqual({ error: 'Metadata atlas snapshot unavailable' });
    }
  });

  it('loads client getMetadataAtlas live-first and static fallback, and computes filtered projections', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ATLAS_SNAPSHOT), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const liveRes = await getMetadataAtlas();
    expect(liveRes).toMatchObject({ mode: 'live', source: 'express-api' });
    expect(liveRes.data.summary.totalSongs).toBe(ATLAS_SNAPSHOT.summary.totalSongs);
    expect(getArchiveMode()).toBe('live');

    resetMetadataAtlasCache();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/api/atlas')) return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
      if (target.endsWith('/data/metadata-atlas.json')) {
        return new Response(JSON.stringify(ATLAS_SNAPSHOT), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    }));
    const staticRes = await getMetadataAtlas();
    expect(staticRes).toMatchObject({ mode: 'static', source: 'static-json' });
    expect(staticRes.data.summary.songsWithYear).toBe(ATLAS_SNAPSHOT.summary.songsWithYear);
    expect(getArchiveMode()).toBe('static');

    const tnDefault = computeFilteredAtlas(ATLAS_SNAPSHOT, { selectedState: 'TN', selectedDecade: '1970s' });
    const tn70Default = tnDefault.decades.find((d) => d.id === '1970s');
    const tnMastering = computeFilteredAtlas(ATLAS_SNAPSHOT, { selectedState: 'TN', selectedDecade: '1970s', includeMastering: true });
    const tn70Mastering = tnMastering.decades.find((d) => d.id === '1970s');
    expect(tn70Mastering.songCount).toBeGreaterThan(tn70Default.songCount);

    const [, , recS, recP, , , origS, origP] = ATLAS_SNAPSHOT.yearStateCube.find(([y, s]) => y === 1972 && s === 'TN');
    expect([recS, recP, origS, origP]).toEqual([19, 38, 8, 19]);
    const tnArtist = computeFilteredAtlas(ATLAS_SNAPSHOT, { selectedState: 'TN', mapMode: 'artist' });
    expect(tnArtist.decades.find((d) => d.id === '1970s').years.find((y) => y.year === 1972)).toMatchObject({ songCount: origS, spinCount: origP });

    const year1972 = computeFilteredAtlas(ATLAS_SNAPSHOT, { selectedYear: 1972, mapMode: 'magnet' });
    expect(year1972.states.TN.recorded).toMatchObject({ songs: recS, spins: recP });
    expect(year1972.states.TN.artistOrigin).toMatchObject({ songs: origS, spins: origP });
    expect(year1972.states.TN.magnetDelta).toBe(11);
  });

  it('computes squarifyLayout, computeHeatIntensity, collectPeakYears, and summarizeCoverage', () => {
    expect(squarifyLayout([], 0, 0, 100, 100)).toEqual([]);
    const rects = squarifyLayout([{ id: 'a', value: 60 }, { id: 'b', value: 30 }, { id: 'c', value: 10 }, { id: 'z', value: 0 }], 10, 20, 400, 200);
    expect(rects).toHaveLength(3);
    expect(rects.reduce((s, r) => s + r.w * r.h, 0)).toBeCloseTo(400 * 200, 5);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(10);
      expect(r.y).toBeGreaterThanOrEqual(20);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }

    expect(computeHeatIntensity(10, 10, 10)).toBe(28);
    expect(computeHeatIntensity(0, 0, 100)).toBe(3);
    expect(computeHeatIntensity(100, 0, 100)).toBe(45);
    expect(computeHeatIntensity(50, 0, 100)).toBeGreaterThan(3);

    const peakSongs = collectPeakYears(ATLAS_SNAPSHOT.decades, 'songs', 5);
    const peakSpins = collectPeakYears(ATLAS_SNAPSHOT.decades, 'spins', 5);
    expect(peakSongs).toHaveLength(5);
    expect(peakSongs[0].value).toBeGreaterThanOrEqual(peakSongs[1].value);
    expect(peakSpins[0].spinCount).toBeGreaterThanOrEqual(peakSpins[1].spinCount);

    expect(summarizeCoverage(0, 0)).toBeNull();
    expect(summarizeCoverage(16285, 14199)).toEqual({ total: 16285, dated: 14199, undated: 2086, datedPct: '87.2', undatedPct: '12.8' });
    expect(summarizeCoverage(100, 150)).toEqual({ total: 100, dated: 100, undated: 0, datedPct: '100.0', undatedPct: '0.0' });
  });
});
