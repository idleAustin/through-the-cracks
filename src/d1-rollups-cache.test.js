// Tests for D1 schema parity, rollup-vs-raw SQL equivalence, chunked cache_blobs, Edge Cache, R2 fallback, and seed scripts.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeArtistProfileKey } from '../server/artistProfileBuilder.js';
import { getD1ArtistProfile } from '../server/d1ArtistProfile.js';
import {
  clearD1Cache, getD1Artists, getD1Episodes, getD1Overview, getD1Search, getD1Songs, getD1YearSpins,
} from '../server/d1Queries.js';
import { MAX_BLOB_CHUNK_CHARS, readCacheBlob, writeCacheBlob } from '../server/d1Rollups.js';
import { DDL_STATEMENTS, ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';
import { PUBLIC_API_CACHE_CONTROL } from '../server/workerSnapshots.js';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'public', 'data');
const SEED_SQL_PATH = path.join(ROOT, '.cache', 'd1-seed.sql');
const readJson = (rel) => JSON.parse(readFileSync(path.join(DATA_DIR, rel), 'utf8'));
const normSql = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

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
    store,
    async get(key) {
      const raw = store.get(key);
      return raw === undefined ? null : { text: async () => raw, json: async () => JSON.parse(raw) };
    },
    async put(key, val) { store.set(key, typeof val === 'string' ? val : String(val)); },
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

async function recordSql(db, fn) {
  const orig = db.prepare.bind(db);
  const queries = [];
  db.prepare = (sql) => { queries.push(sql); return orig(sql); };
  try { return { result: await fn(), queries }; } finally { db.prepare = orig; }
}

const makePost = (id, title, content, published) => ({
  id, title, content, published, url: `https://eddirmeyer.blogspot.com/2026/11/${id}.html`,
});

describe('D1 rollups, Edge Cache, R2 fallback, and seed script parity', () => {
  const snapshotEpisodes = readJson('episodes.json');
  const snapshotOverview = readJson('overview.json');
  const hadSeedSql = existsSync(SEED_SQL_PATH);
  const prevSeedSql = hadSeedSql ? readFileSync(SEED_SQL_PATH) : null;
  let rollupDb;
  let rawDb;

  beforeAll(async () => {
    rollupDb = createSqliteD1();
    await ensureD1Schema(rollupDb);
    await upsertEpisodesIntoD1(rollupDb, snapshotEpisodes, { batchSize: 500 });
    rawDb = createSqliteD1();
    await ensureD1Schema(rawDb);
    await upsertEpisodesIntoD1(rawDb, snapshotEpisodes, { batchSize: 500 });
    rawDb.sqlite.exec('DROP TABLE cache_blobs; DROP TABLE artist_rollups; DROP TABLE song_rollups; DROP TABLE album_rollups;');
  }, 20_000);

  beforeEach(() => resetWorkerRateLimits());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(() => {
    rollupDb?.sqlite?.close();
    rawDb?.sqlite?.close();
    if (!hadSeedSql) rmSync(SEED_SQL_PATH, { force: true });
    else if (prevSeedSql !== null) writeFileSync(SEED_SQL_PATH, prevSeedSql);
  });

  it('keeps server/schema.sql in exact parity with DDL_STATEMENTS', () => {
    const schemaStmts = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8')
      .replace(/--[^\n]*/g, '').split(';').map(normSql).filter(Boolean);
    const ddlStmts = DDL_STATEMENTS.map(normSql);
    const names = (stmts, kind) =>
      stmts.map((s) => s.match(new RegExp(`^CREATE ${kind} IF NOT EXISTS (\\w+)`, 'i'))?.[1]).filter(Boolean);

    expect(names(schemaStmts, 'TABLE')).toEqual(names(ddlStmts, 'TABLE'));
    expect(names(schemaStmts, 'INDEX')).toEqual(names(ddlStmts, 'INDEX'));
    expect(schemaStmts).toEqual(ddlStmts);
  });

  it('matches raw song_plays fallback across rollup queries without scanning song_plays', async () => {
    const countOf = (t) => Number(rollupDb.sqlite.prepare(`SELECT COUNT(1) AS c FROM ${t}`).get().c);
    expect([countOf('artist_rollups'), countOf('song_rollups'), countOf('album_rollups')]).toEqual([1292, 16285, 5199]);
    expect(rollupDb.sqlite.prepare('SELECT DISTINCT blob_key FROM cache_blobs ORDER BY blob_key').all().map((r) => r.blob_key))
      .toEqual(['overview', 'year_spins_archive']);

    clearD1Cache(rollupDb);
    for (const run of [
      () => getD1Overview(rollupDb),
      () => getD1Artists(rollupDb, { sort: 'top' }),
      () => getD1Songs(rollupDb, { sort: 'top' }),
      () => getD1Search(rollupDb, { q: 'dylan' }),
    ]) {
      const { queries } = await recordSql(rollupDb, run);
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.some((sql) => /\bFROM\s+song_plays\b/i.test(sql))).toBe(false);
      expect(queries.every((sql) => /\b(cache_blobs|artist_rollups|song_rollups|album_rollups)\b/i.test(sql))).toBe(true);
    }

    const profRec = await recordSql(rollupDb, () => getD1ArtistProfile(rollupDb, 'Todd Snider'));
    expect(profRec.queries.some((s) => /\bcache_blobs\b/i.test(s))).toBe(true);
    expect(profRec.queries.some((s) => /\bartist_rollups\b/i.test(s))).toBe(true);
    expect(profRec.queries.some((s) => /neighbor_variants|GROUP BY year|FROM song_plays\s+WHERE LENGTH/i.test(s))).toBe(false);

    clearD1Cache(rollupDb);
    clearD1Cache(rawDb);
    for (const run of [
      (db) => getD1Overview(db),
      (db) => getD1YearSpins(db),
      (db) => getD1YearSpins(db, { artist: 'Todd Snider' }),
      (db) => getD1YearSpins(db, { artist: 'Carrie Rodriguez', song: '50s French Movie' }),
      (db) => getD1Episodes(db),
      (db) => getD1Artists(db, { sort: 'top' }),
      (db) => getD1Artists(db, { sort: 'obscure' }),
      (db) => getD1Artists(db, { search: 'snider' }),
      (db) => getD1Artists(db, { search: '%_' }),
      (db) => getD1Songs(db, { sort: 'top' }),
      (db) => getD1Songs(db, { sort: 'obscure' }),
      (db) => getD1Songs(db, { search: 'larry nager' }),
      (db) => getD1Search(db, { q: 'dylan' }),
      (db) => getD1Search(db, { q: 'larry nager' }),
      (db) => getD1ArtistProfile(db, 'Todd Snider'),
    ]) {
      expect(await run(rollupDb)).toEqual(await run(rawDb));
    }
  });

  it('roundtrips oversized cache_blobs across >= 3 chunks in SQLite', async () => {
    const db = createSqliteD1();
    try {
      await ensureD1Schema(db);
      const payload = { blob: 'a'.repeat(MAX_BLOB_CHUNK_CHARS * 2 + 120_000), nested: { tags: ['americana'], count: 9 } };
      expect(JSON.stringify(payload).length).toBeGreaterThan(900_000);

      await writeCacheBlob(db, 'large-test', payload);
      const rows = db.sqlite.prepare("SELECT chunk_index FROM cache_blobs WHERE blob_key = 'large-test' ORDER BY chunk_index").all();
      expect(rows.map((r) => r.chunk_index)).toEqual([0, 1, 2]);
      expect(await readCacheBlob(db, 'large-test')).toEqual(payload);
    } finally { db.sqlite.close(); }
  });

  it('caches GET responses in Edge Cache, isolates Origin CORS headers, and busts epoch on ingest', async () => {
    const db = createSqliteD1();
    try {
      await ensureD1Schema(db);
      await upsertEpisodesIntoD1(db, [{
        id: 'ep-1', airDate: '2026-11-11', title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
        songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }],
      }]);
      const cacheStore = stubEdgeCache();
      const env = { DB: db, INGEST_SECRET: 'edge-secret', BLOGGER_API_KEY: 'k', BLOGGER_BLOG_ID: 'b' };

      const first = await recordSql(db, () =>
        worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/overview', {
          headers: { Origin: 'https://idleamericana.com' },
        }), env),
      );
      expect(first.result.status).toBe(200);
      expect(first.queries.length).toBeGreaterThan(0);
      expect(first.result.headers.get('Cache-Control')).toBe(PUBLIC_API_CACHE_CONTROL);
      expect(first.result.headers.get('Access-Control-Allow-Origin')).toBe('https://idleamericana.com');
      expect((await first.result.json()).totalEpisodes).toBe(1);
      expect(cacheStore.size).toBe(1);

      clearD1Cache(db);
      const second = await recordSql(db, () =>
        worker.fetch(new Request('https://idleamericana.com/api/overview', {
          headers: { Origin: 'https://evil.example' },
        }), env),
      );
      expect(second.result.status).toBe(200);
      expect(second.queries).toHaveLength(0);
      expect(second.result.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(second.result.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(second.result.headers.get('X-Frame-Options')).toBe('DENY');
      expect(second.result.headers.get('Cache-Control')).toBe(PUBLIC_API_CACHE_CONTROL);
      expect((await second.result.json()).totalEpisodes).toBe(1);

      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        items: [makePost('ep-2', "Playlist for WEVL's Through The Cracks, Saturday 11/14/2026", '<p>John Prine - Sam Stone - John Prine</p>', '2026-11-14T18:00:00Z')],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

      const ingestRes = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer edge-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ incremental: true }),
      }), env);
      expect(ingestRes.status).toBe(200);
      expect((await ingestRes.json()).episodesUpserted).toBe(1);

      const third = await recordSql(db, () =>
        worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/overview'), env),
      );
      expect(third.result.status).toBe(200);
      expect(third.queries.length).toBeGreaterThan(0);
      expect((await third.result.json()).totalEpisodes).toBe(2);
      expect(cacheStore.size).toBe(2);
    } finally { db.sqlite.close(); }
  });

  it('serves all read routes from SNAPSHOT_BUCKET with 0 D1 calls and syncs R2 on scheduled()', async () => {
    const toddKey = `v1/artist-profiles/${encodeArtistProfileKey('Todd Snider')}.json`;
    const r2 = createMemoryR2({
      'v1/manifest.json': {
        version: 1, updatedAt: '2026-11-14T06:00:10.731Z',
        totalEpisodes: snapshotOverview.totalEpisodes, totalSongPlays: snapshotOverview.totalSongPlays,
        latestEpisodeId: snapshotOverview.latestEpisodeId,
      },
      'v1/overview.json': snapshotOverview,
      'v1/year-spins.json': readJson('year-spins.json'),
      'v1/episodes-index.json': readJson('episodes-index.json'),
      'v1/artists.json': readJson('artists.json'),
      'v1/songs.json': readJson('songs.json'),
      'v1/albums.json': readJson('albums.json'),
      'v1/years.json': readJson('years.json'),
      'v1/playlists/2026.json': readJson('playlists/2026.json'),
      [toddKey]: readJson(`artist-profiles/${encodeArtistProfileKey('Todd Snider')}.json`),
    });
    const throwingDb = {
      prepare: vi.fn(() => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit (code: 7500)"); }),
    };
    const fetchR2 = async (reqPath) => {
      const res = await worker.fetch(new Request(`https://idleamericana.com${reqPath}`), { DB: throwingDb, SNAPSHOT_BUCKET: r2 });
      expect(res.status).toBe(200);
      return res.json();
    };

    expect((await fetchR2('/api/overview')).totalEpisodes).toBe(1344);
    expect((await fetchR2('/api/years')).scope).toBe('archive');
    expect((await fetchR2('/api/episodes')).total).toBe(1344);
    expect((await fetchR2(`/api/episodes/${snapshotOverview.latestEpisodeId}`)).playlist.length).toBeGreaterThan(0);
    expect((await fetchR2('/api/artists')).total).toBe(1292);
    expect((await fetchR2('/api/artists/Todd%20Snider/songs')).summary.totalPlays).toBe(308);
    expect((await fetchR2('/api/artists/Todd%20Snider/profile')).summary.totalPlays).toBe(308);
    expect((await fetchR2('/api/songs')).total).toBe(16285);
    expect((await fetchR2('/api/search?q=dylan')).artists.some((a) => a.name === 'Bob Dylan')).toBe(true);
    expect(throwingDb.prepare).not.toHaveBeenCalled();

    const syncDb = createSqliteD1();
    try {
      await ensureD1Schema(syncDb);
      await upsertEpisodesIntoD1(syncDb, [{
        id: 'ep-init', airDate: '2026-11-11', title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
        songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }],
      }]);
      const syncBucket = createMemoryR2();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        items: [makePost('ep-cron', "Playlist for WEVL's Through The Cracks, Wednesday 11/18/2026", '<p>Lucinda Williams - Car Wheels - Car Wheels</p>', '2026-11-18T18:00:00Z')],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

      const cronRes = await worker.scheduled(
        {}, { DB: syncDb, SNAPSHOT_BUCKET: syncBucket, BLOGGER_API_KEY: 'k', BLOGGER_BLOG_ID: 'b' }, { waitUntil: () => {} },
      );
      expect(cronRes).toMatchObject({ episodesUpserted: 1, latestAirDate: '2026-11-18' });
      for (const k of [
        'v1/manifest.json', 'v1/overview.json', 'v1/years.json', 'v1/year-spins.json',
        'v1/episodes-index.json', 'v1/artists.json', 'v1/songs.json', 'v1/albums.json', 'v1/playlists/2026.json',
      ]) expect(syncBucket.store.has(k)).toBe(true);
      expect(JSON.parse(syncBucket.store.get('v1/manifest.json'))).toMatchObject({
        totalEpisodes: 2, totalSongPlays: 2, latestEpisodeId: 'ep-cron',
      });
      const afterSync = await worker.fetch(new Request('https://idleamericana.com/api/overview'), { DB: throwingDb, SNAPSHOT_BUCKET: syncBucket });
      expect(afterSync.status).toBe(200);
      expect((await afterSync.json()).totalEpisodes).toBe(2);
      expect(throwingDb.prepare).not.toHaveBeenCalled();
    } finally { syncDb.sqlite.close(); }
  });

  it('generates transaction-free .cache/d1-seed.sql via seed-d1.js and previews v1/manifest.json via seed-r2.js --dry-run', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-d1.js')], { cwd: ROOT, encoding: 'utf8' });
    const seedSql = readFileSync(SEED_SQL_PATH, 'utf8');
    expect(seedSql).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);

    const mem = new DatabaseSync(':memory:');
    try {
      mem.exec(seedSql);
      const count = (tbl) => Number(mem.prepare(`SELECT COUNT(1) AS c FROM ${tbl}`).get().c);
      expect([count('episodes'), count('song_plays'), count('artist_rollups'), count('song_rollups'), count('album_rollups')])
        .toEqual([1344, 37659, 1292, 16285, 5199]);
      expect(mem.prepare('SELECT DISTINCT blob_key FROM cache_blobs ORDER BY blob_key').all().map((r) => r.blob_key))
        .toEqual(['overview', 'year_spins_archive']);
    } finally { mem.close(); }

    const dryRunOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-r2.js'), '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
    expect(dryRunOut).toContain('v1/manifest.json');
  }, 15_000);
});
