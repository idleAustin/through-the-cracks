// End-to-end SQLite-backed Cloudflare D1 schema, SQL snapshot-parity, and Worker HTTP/Cron integration tests.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getD1ArtistSongs, getD1Artists, getD1EpisodeById, getD1Episodes,
  getD1Overview, getD1Search, getD1Songs, getD1YearSpins,
} from '../server/d1Queries.js';
import { ensureD1Schema, ingestBloggerToD1, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';

const DATA_DIR = path.resolve(process.cwd(), 'public', 'data');
const readJson = (name) => JSON.parse(readFileSync(path.join(DATA_DIR, name), 'utf8'));

function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const wrap = (sql, bound = []) => ({
    _sql: sql,
    _bound: bound,
    bind(...args) {
      return wrap(sql, args);
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...bound) };
    },
    async first() {
      return sqlite.prepare(sql).get(...bound) ?? null;
    },
    async run() {
      sqlite.prepare(sql).run(...bound);
      return { success: true };
    },
  });

  return {
    sqlite,
    prepare(sql) {
      return wrap(sql);
    },
    async batch(stmts) {
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) {
          results.push(/^\s*SELECT\b/i.test(s._sql) ? await s.all() : await s.run());
        }
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
      return results;
    },
  };
}

function createMockAssets() {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/index.html') return new Response('<html>SPA Shell</html>', { status: 200 });
      return new Response('Not Found', { status: 404 });
    },
  };
}

describe('D1 schema, incremental ingestion, and SQL parity with static snapshots', () => {
  const snapshotEpisodes = readJson('episodes.json');
  const snapshotOverview = readJson('overview.json');
  const snapshotYearSpins = readJson('year-spins.json');
  let realDb;

  beforeAll(async () => {
    realDb = createSqliteD1();
    await ensureD1Schema(realDb);
    await upsertEpisodesIntoD1(realDb, snapshotEpisodes, { batchSize: 400 });
  });

  beforeEach(() => resetWorkerRateLimits());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(() => realDb?.sqlite?.close());

  it('ensureD1Schema + upsertEpisodesIntoD1 replaces stale song_plays rows idempotently', async () => {
    const db = createSqliteD1();
    await ensureD1Schema(db);

    const makeSongs = (count) =>
      Array.from({ length: count }, (_, i) => ({
        position: i + 1,
        artist: `Artist ${i + 1}`,
        songTitle: `Song ${i + 1}`,
        album: `Album ${i + 1}`,
        rawLine: `Artist ${i + 1} - Song ${i + 1} - Album ${i + 1}`,
      }));

    await upsertEpisodesIntoD1(db, [{ id: 'ep-1', airDate: '2026-11-11', title: 'Ep 1', songs: makeSongs(3) }]);
    expect((await db.prepare('SELECT song_count FROM episodes WHERE id = ?').bind('ep-1').first()).song_count).toBe(3);
    expect((await db.prepare('SELECT COUNT(1) AS cnt FROM song_plays WHERE episode_id = ?').bind('ep-1').first()).cnt).toBe(3);

    await upsertEpisodesIntoD1(db, [{ id: 'ep-1', airDate: '2026-11-11', title: 'Ep 1', songs: makeSongs(2) }]);
    expect((await db.prepare('SELECT song_count FROM episodes WHERE id = ?').bind('ep-1').first()).song_count).toBe(2);
    expect((await db.prepare('SELECT position FROM song_plays WHERE episode_id = ? ORDER BY position').bind('ep-1').all()).results)
      .toEqual([{ position: 1 }, { position: 2 }]);
  });

  it('ingestBloggerToD1 computes 14-day lookback startDateIso and parses Blogger posts', async () => {
    const db = createSqliteD1();
    await ensureD1Schema(db);
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-prev',
      airDate: '2026-11-11',
      title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
      songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }],
    }]);

    let capturedArgs = null;
    const result = await ingestBloggerToD1({
      db,
      blogId: 'blog-123',
      apiKey: 'key-123',
      lookbackDays: 14,
      fetcher: async (args) => {
        capturedArgs = args;
        return [
          { id: 'ignore', title: 'Holiday Promo Notice', content: '<p>No tracks</p>' },
          {
            id: 'ep-new',
            title: "Playlist for WEVL's Through The Cracks, Saturday 11/14/2026",
            content: '<p>Bob Dylan - Tangled Up In Blue - Blood On The Tracks<br />John Prine - Paradise - John Prine</p>',
            published: '2026-11-14T18:00:00Z',
            url: 'https://eddirmeyer.blogspot.com/2026/11/new.html',
          },
        ];
      },
    });

    expect(capturedArgs).toEqual({ blogId: 'blog-123', apiKey: 'key-123', startDateIso: '2026-10-28T00:00:00.000Z' });
    expect(result).toMatchObject({ mode: 'incremental', fetchedPosts: 2, episodesUpserted: 1, songPlaysUpserted: 2, latestAirDate: '2026-11-14' });
    expect((await getD1EpisodeById(db, 'ep-new')).songs).toHaveLength(2);
  });

  it('matches public/data/overview.json across SQL aggregates and executes all D1 query functions', async () => {
    const ov = await getD1Overview(realDb);
    expect(ov.totalEpisodes).toBe(1344);
    expect(ov.totalSongPlays).toBe(37678);
    expect(ov.uniqueArtists).toBe(1917);
    expect(ov.uniqueAlbums).toBe(6451);
    expect(ov.uniqueSongs).toBe(17134);
    expect(ov.oneSpinArtists).toBe(654);
    expect(ov.oneSpinSongs).toBe(8000);
    expect(ov.latestEpisodeId).toBe('4423069433994810612');
    expect(ov.dateRange).toEqual(snapshotOverview.dateRange);
    expect(ov.topArtists).toEqual(snapshotOverview.topArtists);
    expect(ov.topSongs).toEqual(snapshotOverview.topSongs);

    const archiveYears = await getD1YearSpins(realDb);
    expect(archiveYears).toEqual({ years: snapshotYearSpins.years, spins: snapshotYearSpins.archive, scope: 'archive', artist: null, song: null });
    const songYears = await getD1YearSpins(realDb, { artist: 'Carrie Rodriguez', song: '50s French Movie' });
    expect(songYears).toEqual({
      years: snapshotYearSpins.years,
      spins: snapshotYearSpins.songs['50s French Movie\tCarrie Rodriguez'],
      scope: 'song',
      artist: 'Carrie Rodriguez',
      song: '50s French Movie',
    });

    const filteredEps = await getD1Episodes(realDb, { year: '2026', artist: 'Carrie Rodriguez', song: '50s French Movie' });
    expect(filteredEps.total).toBeGreaterThanOrEqual(1);
    expect(filteredEps.episodes.every((e) => e.airDate.startsWith('2026-'))).toBe(true);
    expect((await getD1EpisodeById(realDb, snapshotOverview.latestEpisodeId)).songs.length).toBeGreaterThan(0);
    expect(await getD1EpisodeById(realDb, 'nonexistent-episode-id')).toBeNull();

    const obscureArtists = await getD1Artists(realDb, { sort: 'obscure', cap: '10', page: '1', limit: '5' });
    expect(obscureArtists.total).toBe(10);
    expect(obscureArtists.items[0].totalPlays).toBe(1);
    expect((await getD1Artists(realDb, { search: 'todd snider' })).items[0].name).toBe('Todd Snider');

    const toddCatalog = await getD1ArtistSongs(realDb, 'Todd Snider');
    expect(toddCatalog.summary.totalPlays).toBe(305);
    expect(toddCatalog.albums.length).toBeGreaterThan(5);
    expect((await getD1Songs(realDb, { search: 'French Movie' })).items[0]).toMatchObject({ artist: 'Carrie Rodriguez', songTitle: '50s French Movie' });

    expect(await getD1Search(realDb, { q: 'a' })).toEqual({ artists: [], songs: [], albums: [] });
    const dylanSearch = await getD1Search(realDb, { q: 'dylan' });
    expect(dylanSearch.artists.some((a) => a.name === 'Bob Dylan')).toBe(true);
    expect(dylanSearch.songs.length).toBeGreaterThan(0);
    expect(dylanSearch.albums.length).toBeGreaterThan(0);
  });

  it('routes /through-the-cracks/api/* reads, CORS/security headers, and SPA asset fallbacks through worker.fetch', async () => {
    const env = { DB: realDb, ASSETS: createMockAssets() };
    const call = (reqPath, headers = {}) => worker.fetch(new Request(`https://idleamericana.com${reqPath}`, { headers }), env);

    const health = await call('/through-the-cracks/api/health', { Origin: 'https://idleamericana.com' });
    expect(health.status).toBe(200);
    expect(health.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(health.headers.get('X-Frame-Options')).toBe('DENY');
    expect(health.headers.get('Access-Control-Allow-Origin')).toBe('https://idleamericana.com');
    expect(await health.json()).toMatchObject({ status: 'ok', runtime: 'cloudflare-worker', database: 'd1' });

    const untrusted = await call('/through-the-cracks/api/overview', { Origin: 'https://evil.example' });
    expect(untrusted.status).toBe(200);
    expect(untrusted.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await untrusted.json()).totalEpisodes).toBe(1344);

    expect((await (await call('/through-the-cracks/api/years?artist=Todd%20Snider')).json()).scope).toBe('artist');
    expect((await (await call('/through-the-cracks/api/episodes?year=2026&limit=5')).json()).episodes).toHaveLength(5);
    expect((await call(`/through-the-cracks/api/episodes/${snapshotOverview.latestEpisodeId}`)).status).toBe(200);
    expect((await call('/through-the-cracks/api/episodes/missing-ep')).status).toBe(404);
    expect((await (await call('/through-the-cracks/api/artists?search=snider')).json()).items[0].name).toBe('Todd Snider');
    expect((await (await call('/through-the-cracks/api/artists/Todd%20Snider/songs')).json()).summary.totalPlays).toBe(305);
    expect((await (await call('/through-the-cracks/api/songs?search=french')).json()).items[0].songTitle).toBe('50s French Movie');
    expect((await (await call('/through-the-cracks/api/search?q=dylan')).json()).artists[0].name).toBe('Bob Dylan');

    const spaRes = await call('/through-the-cracks/artists');
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain('SPA Shell');
    expect((await call('/through-the-cracks/assets/missing.js')).status).toBe(404);
  });

  it('enforces auth, size limit, Blogger fetch, D1 cache invalidation, Cron scheduled, and rate limits', async () => {
    const db = createSqliteD1();
    await ensureD1Schema(db);
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-seed',
      airDate: '2026-11-11',
      title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
      songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }],
    }]);

    const overviewBefore = await (await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/overview'), { DB: db })).json();
    expect(overviewBefore.totalEpisodes).toBe(1);

    const noSecret = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', { method: 'POST' }), { DB: db });
    expect(noSecret.status).toBe(503);

    const env = { DB: db, INGEST_SECRET: 'super-secret-token', BLOGGER_API_KEY: 'api-key', BLOGGER_BLOG_ID: 'blog-1' };
    const badAuth = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
    }), env);
    expect(badAuth.status).toBe(401);

    const tooLarge = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer super-secret-token' },
      body: 'x'.repeat(16_385),
    }), env);
    expect(tooLarge.status).toBe(413);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: 'ep-live',
        title: "Playlist for WEVL's Through The Cracks, Saturday 11/14/2026",
        content: '<p>John Prine - Sam Stone - John Prine</p>',
        published: '2026-11-14T18:00:00Z',
        url: 'https://eddirmeyer.blogspot.com/2026/11/ep-live.html',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const okIngest = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer super-secret-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ incremental: true }),
    }), env);
    expect(okIngest.status).toBe(200);
    expect(await okIngest.json()).toMatchObject({ episodesUpserted: 1, songPlaysUpserted: 1, latestAirDate: '2026-11-14' });

    const overviewAfterIngest = await (await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/overview'), { DB: db })).json();
    expect(overviewAfterIngest.totalEpisodes).toBe(2);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: 'ep-cron',
        title: "Playlist for WEVL's Through The Cracks, Wednesday 11/18/2026",
        content: '<p>Lucinda Williams - Car Wheels - Car Wheels</p>',
        published: '2026-11-18T18:00:00Z',
        url: 'https://eddirmeyer.blogspot.com/2026/11/ep-cron.html',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const waited = [];
    const cronRes = await worker.scheduled({}, env, { waitUntil: (p) => waited.push(p) });
    expect(waited).toHaveLength(1);
    expect(cronRes).toMatchObject({ episodesUpserted: 1, latestAirDate: '2026-11-18' });

    const overviewAfterCron = await (await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/overview'), { DB: db })).json();
    expect(overviewAfterCron.totalEpisodes).toBe(3);

    resetWorkerRateLimits();
    for (let i = 0; i < 5; i += 1) {
      const r = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.10', Authorization: 'Bearer wrong' },
      }), env);
      expect(r.status).toBe(401);
    }
    const ingest429 = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.10', Authorization: 'Bearer wrong' },
    }), env);
    expect(ingest429.status).toBe(429);
    expect(ingest429.headers.get('Retry-After')).toBe('60');

    for (let i = 0; i < 180; i += 1) {
      const r = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/health', {
        headers: { 'CF-Connecting-IP': '203.0.113.11' },
      }), env);
      expect(r.status).toBe(200);
    }
    const read429 = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/health', {
      headers: { 'CF-Connecting-IP': '203.0.113.11' },
    }), env);
    expect(read429.status).toBe(429);
    expect(read429.headers.get('Retry-After')).toBe('60');
  });
});
