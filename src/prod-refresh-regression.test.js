// Regression tests for O(N+M) playlist pool, R2 drift healing, sync error propagation, and Edge Cache versioning.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadD1PlaylistPool, upsertSongLink } from '../server/d1Playlist.js';
import { clearD1Cache } from '../server/d1Rollups.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';
import { syncR2SnapshotsFromD1 } from '../server/workerSnapshotSync.js';

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
  const puts = [];
  return {
    store,
    puts,
    async get(key) {
      const raw = store.get(key);
      return raw === undefined ? null : { text: async () => raw, json: async () => JSON.parse(raw) };
    },
    async put(key, val) {
      puts.push(key);
      store.set(key, typeof val === 'string' ? val : String(val));
    },
  };
}

function stubEdgeCache() {
  const store = new Map();
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  vi.stubGlobal('caches', {
    default: {
      match: async (req) => store.get(keyOf(req))?.clone(),
      put: async (req, res) => { store.set(keyOf(req), res.clone()); },
    },
  });
  return store;
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Production auto-refresh regressions', () => {
  const dbs = [];
  const trackDb = async () => {
    const db = createSqliteD1();
    dbs.push(db);
    await ensureD1Schema(db);
    return db;
  };

  beforeEach(() => {
    resetWorkerRateLimits();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (dbs.length) dbs.pop().sqlite.close();
  });

  it('loads D1 playlist pool without O(N*M) joins and preserves alias/Unicode hydration and sort order', async () => {
    const db = await trackDb();
    await upsertEpisodesIntoD1(db, [
      {
        id: 'ep-1', airDate: '2026-11-11', title: 'Show 1',
        songs: [
          { position: 1, artist: 'The Beatles', songTitle: 'In My Life', album: 'Rubber Soul' },
          { position: 2, artist: 'Susan McKeown & The Chanting House', songTitle: 'Cé Leis É?', album: 'Bones' },
        ],
      },
      {
        id: 'ep-2', airDate: '2026-11-18', title: 'Show 2',
        songs: [
          { position: 1, artist: 'The Beatles', songTitle: 'In My Life', album: 'Rubber Soul' },
          { position: 2, artist: 'The Beatles', songTitle: 'In My Life', album: 'Rubber Soul' },
        ],
      },
    ]);
    await upsertSongLink(db, {
      songKey: 'beatles|||in my life', artist: 'beatles', songTitle: 'In My Life',
      videoId: 'vid-beatles', confidenceScore: 95, matchTier: 'high', isEmbeddable: 1, usPlayable: 1,
    });
    await upsertSongLink(db, {
      artist: 'Susan McKeown & The Chanting House', songTitle: 'Cé Leis É?',
      videoId: 'vid-susan', confidenceScore: 95, matchTier: 'high', isEmbeddable: 1, usPlayable: 1,
    });

    const queries = [];
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => { queries.push(sql); return origPrepare(sql); };
    clearD1Cache(db);
    const pool = await loadD1PlaylistPool(db);
    db.prepare = origPrepare;

    expect(queries.some((sql) => /\bJOIN\b/i.test(sql))).toBe(false);
    for (const sql of queries) {
      const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
      expect(plan.some((r) => /LEFT-JOIN/i.test(r.detail))).toBe(false);
    }
    expect(pool.map((r) => [r.songKey, r.totalPlays, r.album])).toEqual([
      ['beatles|||in my life', 3, 'Rubber Soul'],
      ['susan mckeown & the chanting house|||cé leis é?', 1, 'Bones'],
    ]);
  });

  it('heals R2/D1 archive drift on scheduled() and awaitSync POST /api/ingest even when episodesUpserted=0', async () => {
    const db = await trackDb();
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-1', airDate: '2026-11-14', title: "Playlist for WEVL's Through The Cracks, Saturday 11/14/2026",
      songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }],
    }]);
    const r2 = createMemoryR2();
    await syncR2SnapshotsFromD1(db, r2);

    // Advance D1 to ep-2 (2026-11-18) while R2 stays stuck at ep-1 (2026-11-14).
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-2', airDate: '2026-11-18', title: "Playlist for WEVL's Through The Cracks, Wednesday 11/18/2026",
      songs: [{ position: 1, artist: 'Jack Barksdale', songTitle: 'Before the Rain', album: 'Voices' }],
    }]);
    r2.puts.length = 0;

    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ items: [] })));
    const env = { DB: db, SNAPSHOT_BUCKET: r2, INGEST_SECRET: 'sec', BLOGGER_API_KEY: 'bk', BLOGGER_BLOG_ID: 'bid' };

    const cronRes = await worker.scheduled({}, env, { waitUntil: () => {} });
    expect(cronRes).toMatchObject({ episodesUpserted: 0, r2Sync: { mode: 'full', archiveDrift: true } });
    expect(JSON.parse(r2.store.get('v1/manifest.json'))).toMatchObject({
      totalEpisodes: 2, totalSongPlays: 2, latestEpisodeId: 'ep-2',
    });
    expect(JSON.parse(r2.store.get('v1/overview.json')).dateRange.latest).toBe('2026-11-18');

    // Also verify POST /api/ingest with { awaitSync: true } heals drift and { forceSync: true } forces full sync.
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-3', airDate: '2026-11-21', title: "Playlist for WEVL's Through The Cracks, Saturday 11/21/2026",
      songs: [{ position: 1, artist: 'Lucinda Williams', songTitle: 'Car Wheels', album: 'Car Wheels' }],
    }]);
    const driftIngest = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer sec', 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.0.1' },
      body: JSON.stringify({ incremental: true, awaitSync: true }),
    }), env);
    expect(driftIngest.status).toBe(200);
    expect(driftIngest.headers.get('Cache-Control')).toBe('no-store');
    expect(await driftIngest.json()).toMatchObject({ episodesUpserted: 0, r2Sync: { mode: 'full', archiveDrift: true } });
    expect(JSON.parse(r2.store.get('v1/overview.json')).dateRange.latest).toBe('2026-11-21');

    r2.puts.length = 0;
    const forceIngest = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer sec', 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.0.2' },
      body: JSON.stringify({ incremental: true, forceSync: true, awaitSync: true }),
    }), env);
    expect(forceIngest.status).toBe(200);
    expect(await forceIngest.json()).toMatchObject({ r2Sync: { mode: 'full', archiveDrift: false } });
    expect(r2.puts).toContain('v1/overview.json');
  });

  it('propagates R2 sync failures on scheduled() and awaitSync POST /api/ingest while redacting secrets', async () => {
    const db = await trackDb();
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-1', airDate: '2026-11-18', title: "Playlist for WEVL's Through The Cracks, Wednesday 11/18/2026",
      songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }],
    }]);
    const brokenR2 = {
      async get() { return { json: async () => ({ version: 1, totalEpisodes: 0, totalSongPlays: 0, latestEpisodeId: '' }) }; },
      async put() { throw new Error('R2 write failed https://api.cloudflare.com?token=SECRET_R2_TOK'); },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ items: [] })));
    const env = { DB: db, SNAPSHOT_BUCKET: brokenR2, INGEST_SECRET: 'sec', BLOGGER_API_KEY: 'bk', BLOGGER_BLOG_ID: 'bid' };

    await expect(worker.scheduled({}, env, { waitUntil: () => {} })).rejects.toThrow(/R2 write failed/);

    const res = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer sec', 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.2.0.1' },
      body: JSON.stringify({ incremental: true, forceSync: true, awaitSync: true }),
    }), env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('token=[REDACTED]');
    expect(logged).not.toContain('SECRET_R2_TOK');
  });

  it('invalidates cross-colo Edge Cache automatically when R2 v1/manifest.json updatedAt changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'));
    stubEdgeCache();

    const r2 = createMemoryR2({
      'v1/manifest.json': { version: 1, updatedAt: '2026-11-18T06:00:00.000Z', totalEpisodes: 1345, totalSongPlays: 37690, latestEpisodeId: 'ep-1' },
      'v1/overview.json': { totalEpisodes: 1345, totalSongPlays: 37690, dateRange: { earliest: '2013-06-22', latest: '2026-11-14' } },
    });

    const first = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/overview'), { SNAPSHOT_BUCKET: r2 });
    expect((await first.json()).dateRange.latest).toBe('2026-11-14');

    // Simulate an external update (e.g. another PoP or CI push-atlas --bump-manifest) without bumping local cacheEpoch.
    r2.store.set('v1/overview.json', JSON.stringify({ totalEpisodes: 1346, totalSongPlays: 37718, dateRange: { earliest: '2013-06-22', latest: '2026-11-18' } }));
    r2.store.set('v1/manifest.json', JSON.stringify({ version: 1, updatedAt: '2026-11-20T06:17:00.000Z', totalEpisodes: 1346, totalSongPlays: 37718, latestEpisodeId: 'ep-2' }));

    vi.advanceTimersByTime(61_000);
    const second = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/overview'), { SNAPSHOT_BUCKET: r2 });
    const body = await second.json();
    expect(body.totalEpisodes).toBe(1346);
    expect(body.dateRange.latest).toBe('2026-11-18');
  });
});
