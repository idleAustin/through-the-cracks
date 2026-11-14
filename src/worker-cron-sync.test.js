// Integration tests for Worker Cron scheduled(), POST /api/ingest, cache epoch invalidation, and native R2 song-links sync.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertSongLink } from '../server/d1Playlist.js';
import { withCache } from '../server/d1Rollups.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';
import { syncR2SongLinksFromD1 } from '../server/workerSnapshotSync.js';

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

const ytItem = (id, duration = 'PT4M05S') => ({
  id,
  status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true },
  contentDetails: { duration },
});

const makePost = (id, title, content, published) => ({
  id, title, content, published, url: `https://eddirmeyer.blogspot.com/2026/11/${id}.html`,
});

async function seedSongs(db, count) {
  const episodes = [];
  for (let i = 1; i <= count; i += 1) {
    episodes.push({
      id: `ep-${i}`,
      airDate: `2026-10-${String(((i - 1) % 28) + 1).padStart(2, '0')}`,
      title: `Through the Cracks #${i}`,
      songs: [{ position: 1, artist: `Artist ${String(i).padStart(3, '0')}`, songTitle: `Song ${String(i).padStart(3, '0')}`, album: 'Album' }],
    });
  }
  await upsertEpisodesIntoD1(db, episodes, { batchSize: 500 });
}

describe('Worker Cron, POST /api/ingest, cache epoch invalidation, and native R2 sync', () => {
  const dbs = [];
  const trackDb = async () => {
    const db = createSqliteD1();
    dbs.push(db);
    await ensureD1Schema(db);
    return db;
  };

  beforeEach(() => resetWorkerRateLimits());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (dbs.length) dbs.pop().sqlite.close();
  });

  it('invalidates D1 + Edge cache epoch and writes R2 v1/song-links.json + v1/manifest.json on scheduled() when changesMade is true', async () => {
    const db = await trackDb();
    await seedSongs(db, 1);
    const cacheStore = stubEdgeCache();

    // Prime D1 cache and Edge Cache at current epoch.
    const cachedOverview = await withCache(db, 'overview_sentinel', async () => ({ stale: true }));
    expect(cachedOverview).toEqual({ stale: true });
    await withCache(db, 'playlist_pool', async () => [{ stale: true }]);
    const warmOverview = await worker.fetch(new Request('https://idleamericana.com/api/overview'), { DB: db });
    expect(warmOverview.status).toBe(200);
    const firstKey = [...cacheStore.keys()][0];
    cacheStore.set(firstKey, jsonRes({ totalEpisodes: 9999 }));

    const r2 = createMemoryR2({
      'v1/manifest.json': { version: 1, updatedAt: '2026-11-01T00:00:00.000Z', totalEpisodes: 1, totalSongPlays: 1, latestEpisodeId: 'ep-1' },
      'v1/song-links.json': [],
    });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/blogger/')) return jsonRes({ items: [] });
      if (String(url).includes('/search?')) {
        return jsonRes({ items: [{ id: { videoId: 'yt-cron-1' }, snippet: { title: 'Song 001', channelTitle: 'Artist 001 - Topic' } }] });
      }
      return jsonRes({ items: [ytItem('yt-cron-1')] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cronRes = await worker.scheduled(
      {},
      { DB: db, SNAPSHOT_BUCKET: r2, BLOGGER_API_KEY: 'bk', BLOGGER_BLOG_ID: 'bid', YOUTUBE_API_KEY: 'yk' },
      { waitUntil: () => {} },
    );
    expect(cronRes).toMatchObject({
      episodesUpserted: 0,
      linkResolution: { resolvedCount: 1, changesMade: true, externalFetches: 2 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 Blogger + 1 search + 1 videos.list (0 extra fetches for R2!)
    expect(r2.puts).toEqual(['v1/song-links.json', 'v1/manifest.json']);
    expect(JSON.parse(r2.store.get('v1/song-links.json'))).toHaveLength(1);
    expect(JSON.parse(r2.store.get('v1/song-links.json'))[0]).toMatchObject({ videoId: 'yt-cron-1', durationSeconds: 245 });
    expect(JSON.parse(r2.store.get('v1/manifest.json'))).toMatchObject({
      version: 1, totalEpisodes: 1, totalSongPlays: 1, latestEpisodeId: 'ep-1',
    });

    // Stale /vN Edge Cache key is bypassed after epoch bump, and D1 cache was cleared.
    const postCronOverview = await worker.fetch(new Request('https://idleamericana.com/api/overview'), { DB: db });
    expect((await postCronOverview.json()).totalEpisodes).toBe(1);
    expect([...cacheStore.keys()].at(-1)).not.toBe(firstKey);

    const freshSentinel = await withCache(db, 'overview_sentinel', async () => ({ fresh: true }));
    expect(freshSentinel).toEqual({ fresh: true });
    const freshPool = await withCache(db, 'playlist_pool', async () => []);
    expect(freshPool.map((s) => s.videoId)).toEqual(['yt-cron-1']);

    const playlistRes = await worker.fetch(new Request('https://idleamericana.com/api/playlist/random?count=5'), { DB: db, SNAPSHOT_BUCKET: r2 });
    expect((await playlistRes.json()).songs.map((s) => s.videoId)).toEqual(['yt-cron-1']);

    // No-op scheduled() without changesMade skips R2 writes.
    r2.puts.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ items: [] })));
    const noopCron = await worker.scheduled({}, { DB: db, SNAPSHOT_BUCKET: r2, BLOGGER_API_KEY: 'bk', BLOGGER_BLOG_ID: 'bid' }, { waitUntil: () => {} });
    expect(noopCron.linkResolution).toMatchObject({ skipped: 'missing_youtube_api_key', changesMade: false });
    expect(r2.puts).toEqual([]);
  });

  it('computes manifest counts from D1 when v1/manifest.json does not yet exist in R2', async () => {
    const db = await trackDb();
    await seedSongs(db, 2);
    await upsertSongLink(db, {
      song_key: 'artist 001|||song 001', artist: 'Artist 001', song_title: 'Song 001',
      video_id: 'yt-1', confidence_score: 90, match_tier: 'high', is_embeddable: 1, us_playable: 1, status_reason: 'ok',
    });
    const r2 = createMemoryR2();
    const out = await syncR2SongLinksFromD1(db, r2, { updatedAt: '2026-11-14T06:00:00.000Z' });
    expect(out).toEqual({ updatedObjects: ['v1/song-links.json', 'v1/manifest.json'], songLinksCount: 1 });
    expect(JSON.parse(r2.store.get('v1/manifest.json'))).toEqual({
      version: 1, updatedAt: '2026-11-14T06:00:00.000Z', totalEpisodes: 2, totalSongPlays: 2, latestEpisodeId: 'ep-2',
    });
  });

  it('stays <= 33 total external fetch() calls and <= 2506 quota units across 2 Blogger pages + full Cron YouTube cycle', async () => {
    const db = await trackDb();
    await seedSongs(db, 30);
    for (let i = 31; i <= 300; i += 1) {
      await upsertSongLink(db, {
        song_key: `linked artist ${i}|||linked song ${i}`, artist: `Linked Artist ${i}`, song_title: `Linked Song ${i}`,
        video_id: `rec-${String(i).padStart(3, '0')}`, confidence_score: 90, match_tier: 'high',
        is_embeddable: 1, us_playable: 1, status_reason: 'ok',
        checked_at: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      });
    }

    let bloggerPage = 0;
    const allUrls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      allUrls.push(String(url));
      const u = new URL(url);
      if (u.pathname.includes('/blogger/')) {
        bloggerPage += 1;
        return jsonRes(bloggerPage === 1 ? { items: [], nextPageToken: 'p2' } : { items: [] });
      }
      if (u.pathname.endsWith('/search')) {
        const m = u.searchParams.get('q').match(/(\d{3})/)?.[1] || '001';
        return jsonRes({ items: [{ id: { videoId: `new-${m}` }, snippet: { title: `Song ${m}`, channelTitle: `Artist ${m} - Topic` } }] });
      }
      return jsonRes({ items: u.searchParams.get('id').split(',').map((id) => ytItem(id)) });
    }));

    const r2 = createMemoryR2();
    const res = await worker.scheduled(
      {},
      { DB: db, SNAPSHOT_BUCKET: r2, BLOGGER_API_KEY: 'bk', BLOGGER_BLOG_ID: 'bid', YOUTUBE_API_KEY: 'yk' },
      { waitUntil: () => {} },
    );
    expect(allUrls).toHaveLength(33);
    expect(allUrls.length).toBeLessThanOrEqual(33);
    expect(res.linkResolution).toMatchObject({ externalFetches: 31, quotaUnits: 2506, resolvedCount: 25, recheckedCount: 250 });
    expect(r2.puts).toEqual(['v1/song-links.json', 'v1/manifest.json']);
  });

  it('enforces POST /api/ingest Bearer auth, skips YouTube unless resolveLinks=true, and commits Blogger Episodes independently on YouTube failure', async () => {
    const db = await trackDb();
    await seedSongs(db, 1);
    const r2 = createMemoryR2();
    const env = { DB: db, SNAPSHOT_BUCKET: r2, INGEST_SECRET: 'sec', BLOGGER_API_KEY: 'bk', BLOGGER_BLOG_ID: 'bid', YOUTUBE_API_KEY: 'yk' };

    expect((await worker.fetch(new Request('https://idleamericana.com/api/ingest', { method: 'POST' }), { ...env, INGEST_SECRET: '' })).status).toBe(503);
    expect((await worker.fetch(new Request('https://idleamericana.com/api/ingest', { method: 'POST' }), env)).status).toBe(401);
    expect((await worker.fetch(new Request('https://idleamericana.com/api/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer wrong' },
    }), env)).status).toBe(401);

    // Empty body skips YouTube cleanly.
    const emptyFetch = vi.fn(async () => jsonRes({ items: [] }));
    vi.stubGlobal('fetch', emptyFetch);
    const emptyRes = await worker.fetch(new Request('https://idleamericana.com/api/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer sec' }, body: '',
    }), env);
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json()).not.toHaveProperty('linkResolution');
    expect(emptyFetch).toHaveBeenCalledTimes(1);

    // { resolveLinks: true } resolves links and syncs R2 via waitUntil.
    const pending1 = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/blogger/')) return jsonRes({ items: [] });
      if (String(url).includes('/search?')) {
        return jsonRes({ items: [{ id: { videoId: 'yt-post-1' }, snippet: { title: 'Song 001', channelTitle: 'Artist 001 - Topic' } }] });
      }
      return jsonRes({ items: [ytItem('yt-post-1')] });
    }));
    const withLinks = await worker.fetch(new Request('https://idleamericana.com/api/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer sec' }, body: JSON.stringify({ incremental: true, resolveLinks: true }),
    }), env, { waitUntil: (p) => pending1.push(p) });
    await Promise.all(pending1);
    expect(withLinks.status).toBe(200);
    expect((await withLinks.json()).linkResolution).toMatchObject({ resolvedCount: 1, changesMade: true });
    expect(r2.puts).toEqual(['v1/song-links.json', 'v1/manifest.json']);

    // Blogger Episode commits independently even when YouTube returns 429 or throws a network error.
    const pending2 = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/blogger/')) {
        return jsonRes({
          items: [makePost('ep-post-fail', "Playlist for WEVL's Through The Cracks, Wednesday 11/18/2026", '<p>Todd Snider - Alright Guy - Viva Satellite</p>', '2026-11-18T18:00:00Z')],
        });
      }
      return jsonRes({ error: { message: 'Too many requests' } }, 429);
    }));
    const res429 = await worker.fetch(new Request('https://idleamericana.com/api/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer sec', 'CF-Connecting-IP': '10.0.0.9' }, body: JSON.stringify({ incremental: true, resolveLinks: true }),
    }), env, { waitUntil: (p) => pending2.push(p) });
    await Promise.all(pending2);
    expect(res429.status).toBe(200);
    expect(await res429.json()).toMatchObject({
      episodesUpserted: 1, songPlaysUpserted: 1, linkResolution: { stoppedEarlyReason: 'http_429', unmatchedCount: 0, changesMade: false },
    });
    expect(db.sqlite.prepare("SELECT id FROM episodes WHERE id = 'ep-post-fail'").get()).toEqual({ id: 'ep-post-fail' });

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/blogger/')) {
        return jsonRes({
          items: [makePost('ep-cron-throw', "Playlist for WEVL's Through The Cracks, Wednesday 11/25/2026", '<p>Gillian Welch - Look at Miss Ohio - Soul Journey</p>', '2026-11-25T18:00:00Z')],
        });
      }
      throw new TypeError('YouTube network down');
    }));
    const resThrow = await worker.scheduled({}, env, { waitUntil: () => {} });
    expect(resThrow).toMatchObject({
      episodesUpserted: 1, songPlaysUpserted: 1, linkResolution: { stoppedEarlyReason: 'network_error', unmatchedCount: 0, changesMade: false },
    });
    expect(db.sqlite.prepare("SELECT id FROM episodes WHERE id = 'ep-cron-throw'").get()).toEqual({ id: 'ep-cron-throw' });
  });
});
