// Tests for 4-hour smart broadcast catch-up schedule, Worker cron gating, and CI freshness preflight.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateRefreshNeeded } from '../scripts/check-refresh-needed.js';
import {
  CATCHUP_WORKER_CRONS,
  PRIMARY_WORKER_CRON,
  getExpectedLatestBroadcastDate,
  isArchiveUpToDate,
  isCatchupCron,
  isPrimaryMaintenanceWindow,
} from '../server/broadcastSchedule.js';
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

function createMemoryR2() {
  const store = new Map();
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

const totalChanges = (db) => Number(db.sqlite.prepare('SELECT total_changes() AS c').get().c);
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const makePost = (id, titleDate, airIso, content) => ({
  id, title: `Playlist for WEVL's Through The Cracks, ${titleDate}`,
  content, published: `${airIso}T18:00:00Z`, url: `https://eddirmeyer.blogspot.com/2026/11/${id}.html`,
});
const makeAtomEntry = (id, titleDate, airIso) => ({
  id: { $t: `tag:blogger.com,1999:blog-1.post-${id}` },
  title: { $t: `Playlist for WEVL's Through The Cracks, ${titleDate}` },
  content: { $t: '<p>Todd Snider - Broke - New Connection</p>' },
  published: { $t: `${airIso}T18:00:00Z` },
  updated: { $t: `${airIso}T18:00:00Z` },
  link: [{ rel: 'alternate', href: `https://eddirmeyer.blogspot.com/2026/11/${id}.html` }],
});

describe('broadcastSchedule helpers', () => {
  it('computes expected broadcast date across CST/CDT cutoffs and Sun/Mon/Thu/Fri catch-up windows', () => {
    // CDT (UTC-5): Wed 2026-07-08 16:00 CT == 21:00Z
    expect(getExpectedLatestBroadcastDate(new Date('2026-07-08T20:59:00Z'))).toBe('2026-07-04');
    expect(getExpectedLatestBroadcastDate(new Date('2026-07-08T21:00:00Z'))).toBe('2026-07-08');
    // CST (UTC-6): Wed 2026-11-18 16:00 CT == 22:00Z; Sat 2026-11-21 13:00 CT == 19:00Z
    expect(getExpectedLatestBroadcastDate(new Date('2026-11-18T21:59:00Z'))).toBe('2026-11-14');
    expect(getExpectedLatestBroadcastDate(new Date('2026-11-18T22:00:00Z'))).toBe('2026-11-18');
    expect(getExpectedLatestBroadcastDate(new Date('2026-11-21T18:59:00Z'))).toBe('2026-11-18');
    expect(getExpectedLatestBroadcastDate(new Date('2026-11-21T19:00:00Z'))).toBe('2026-11-21');
    // Sun & Mon after Sat 11/21 show, Thu after Wed 11/25 show
    expect(getExpectedLatestBroadcastDate(new Date('2026-11-22T06:00:00Z'))).toBe('2026-11-21');
    expect(getExpectedLatestBroadcastDate(new Date('2026-11-23T18:00:00Z'))).toBe('2026-11-21');
    expect(getExpectedLatestBroadcastDate(new Date('2026-11-26T06:00:00Z'))).toBe('2026-11-25');

    expect(isArchiveUpToDate('2026-11-21', new Date('2026-11-22T06:00:00Z'))).toBe(true);
    expect(isArchiveUpToDate('2026-11-18', new Date('2026-11-22T06:00:00Z'))).toBe(false);
    expect(isCatchupCron({})).toBe(false);
    expect(isCatchupCron({ cron: PRIMARY_WORKER_CRON })).toBe(false);
    expect(isCatchupCron({ cron: CATCHUP_WORKER_CRONS[0] })).toBe(true);
    expect(isPrimaryMaintenanceWindow(new Date('2026-11-22T06:17:00Z'))).toBe(true);
    expect(isPrimaryMaintenanceWindow(new Date('2026-11-22T10:17:00Z'))).toBe(false);
  });
});

describe('Worker 4-hour catch-up scheduled() gating', () => {
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

  it('short-circuits with 0 fetches/writes once up to date, skips YouTube until new post arrives, heals drift, and keeps primary recheck', async () => {
    const db = await trackDb();
    const r2 = createMemoryR2();
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-18', airDate: '2026-11-18', title: "Playlist for WEVL's Through The Cracks, Wednesday 11/18/2026",
      songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }],
    }]);
    await syncR2SnapshotsFromD1(db, r2);
    r2.puts.length = 0;

    // 1. Late post not published yet on Sun 11/22 10:00 UTC -> 1 Blogger call, 0 YouTube calls, 0 D1/R2 writes.
    const fetchMock = vi.fn(async () => jsonRes({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { DB: db, SNAPSHOT_BUCKET: r2, BLOGGER_API_KEY: 'bk', BLOGGER_BLOG_ID: 'bid', YOUTUBE_API_KEY: 'yk' };
    const beforeLate = totalChanges(db);
    const lateController = { cron: CATCHUP_WORKER_CRONS[0], scheduledTime: Date.parse('2026-11-22T10:00:00Z') };

    const resWait = await worker.scheduled(lateController, env, { waitUntil: () => {} });
    expect(resWait).toMatchObject({ episodesUpserted: 0, r2Sync: { mode: 'skipped', archiveDrift: false } });
    expect(resWait).not.toHaveProperty('linkResolution');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(totalChanges(db) - beforeLate).toBe(0);
    expect(r2.puts).toEqual([]);

    // 2. Host posts 11/21 at 8 AM -> 14:00 UTC tick ingests episode, resolves its YouTube link, and syncs R2.
    const arrivedFetch = vi.fn(async (url) => {
      if (String(url).includes('/blogger/')) {
        return jsonRes({ items: [makePost('ep-21', 'Saturday 11/21/2026', '2026-11-21', '<p>John Prine - Paradise - John Prine</p>')] });
      }
      if (String(url).includes('/search?')) {
        return jsonRes({ items: [{ id: { videoId: 'yt-paradise' }, snippet: { title: 'Paradise', channelTitle: 'John Prine - Topic' } }] });
      }
      return jsonRes({ items: [{ id: 'yt-paradise', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { duration: 'PT3M10S' } }] });
    });
    vi.stubGlobal('fetch', arrivedFetch);
    const resArrived = await worker.scheduled(
      { cron: CATCHUP_WORKER_CRONS[0], scheduledTime: Date.parse('2026-11-22T14:00:00Z') },
      env,
      { waitUntil: () => {} },
    );
    expect(resArrived).toMatchObject({
      episodesUpserted: 1,
      latestAirDate: '2026-11-21',
      linkResolution: { resolvedCount: 1, changesMade: true },
      r2Sync: { mode: 'full' },
    });
    expect(JSON.parse(r2.store.get('v1/overview.json')).dateRange.latest).toBe('2026-11-21');

    // 3. Subsequent 18:00 UTC tick short-circuits completely (0 fetches, 0 writes).
    const idleFetch = vi.fn();
    vi.stubGlobal('fetch', idleFetch);
    r2.puts.length = 0;
    const beforeSkip = totalChanges(db);
    const resSkip = await worker.scheduled(
      { cron: CATCHUP_WORKER_CRONS[0], scheduledTime: Date.parse('2026-11-22T18:00:00Z') },
      env,
      { waitUntil: () => {} },
    );
    expect(resSkip).toEqual({ skipped: 'up_to_date', expectedBroadcastDate: '2026-11-21', latestAirDate: '2026-11-21' });
    expect(idleFetch).not.toHaveBeenCalled();
    expect(totalChanges(db) - beforeSkip).toBe(0);
    expect(r2.puts).toEqual([]);

    // 4. Primary 06:00 UTC cron still runs YouTube recheck even when episodesUpserted === 0.
    const primaryFetch = vi.fn(async (url) => {
      if (String(url).includes('/blogger/')) return jsonRes({ items: [] });
      return jsonRes({ items: [{ id: 'yt-paradise', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { duration: 'PT3M10S' } }] });
    });
    vi.stubGlobal('fetch', primaryFetch);
    const resPrimary = await worker.scheduled({ cron: PRIMARY_WORKER_CRON }, env, { waitUntil: () => {} });
    expect(resPrimary.linkResolution).toMatchObject({ recheckedCount: 1, externalFetches: 1 });

    // 5. Catch-up cron still heals R2 drift even if D1 already has 11/21.
    r2.store.set('v1/manifest.json', JSON.stringify({ version: 1, updatedAt: '2026-11-18T00:00:00Z', totalEpisodes: 1, totalSongPlays: 1, latestEpisodeId: 'ep-18' }));
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ items: [] })));
    const resDrift = await worker.scheduled(
      { cron: CATCHUP_WORKER_CRONS[1], scheduledTime: Date.parse('2026-11-23T02:00:00Z') },
      env,
      { waitUntil: () => {} },
    );
    expect(resDrift).toMatchObject({ episodesUpserted: 0, r2Sync: { mode: 'full', archiveDrift: true } });
    expect(JSON.parse(r2.store.get('v1/manifest.json')).totalEpisodes).toBe(2);
  });
});

describe('scripts/check-refresh-needed.js evaluateRefreshNeeded', () => {
  const mkFetch = ({ ov = { dateRange: { latest: '2026-11-18' }, latestEpisodeId: 'ep-18' }, ovStatus = 200, atlasOk = true, blogEntries = [makeAtomEntry('ep-18', 'Wednesday 11/18/2026', '2026-11-18')], blogStatus = 200 }) =>
    vi.fn(async (url) => {
      const s = String(url);
      if (s.endsWith('/overview')) return jsonRes(ov, ovStatus);
      if (s.endsWith('/atlas')) return atlasOk ? jsonRes({ summary: { totalSongs: 16285 } }) : jsonRes({ error: 'down' }, 503);
      return blogStatus === 200 ? jsonRes({ feed: { entry: blogEntries } }) : jsonRes({ error: 'upstream' }, blogStatus);
    });

  it('evaluates skip/run decisions across late posts, up-to-date state, drift, and Blogger outages', async () => {
    const snap18 = { dateRange: { latest: '2026-11-18' }, latestEpisodeId: 'ep-18' };
    const snap21 = { dateRange: { latest: '2026-11-21' }, latestEpisodeId: 'ep-21' };

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap18, now: new Date('2026-11-22T10:17:00Z'), fetchImpl: mkFetch({}),
    })).toMatchObject({ shouldRun: false, reason: 'no_new_blog_post_yet', expectedBroadcastDate: '2026-11-21' });

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap21,
      now: new Date('2026-11-22T18:17:00Z'),
      fetchImpl: mkFetch({ ov: snap21, blogEntries: [makeAtomEntry('ep-21', 'Saturday 11/21/2026', '2026-11-21')] }),
    })).toMatchObject({ shouldRun: false, reason: 'up_to_date' });

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap18,
      now: new Date('2026-11-22T14:17:00Z'),
      fetchImpl: mkFetch({ ov: snap21, blogEntries: [makeAtomEntry('ep-21', 'Saturday 11/21/2026', '2026-11-21')] }),
    })).toMatchObject({ shouldRun: true, reason: 'new_blog_post_detected', bloggerLatestDate: '2026-11-21' });

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap21, now: new Date('2026-11-22T14:17:00Z'), fetchImpl: mkFetch({ ov: snap18 }),
    })).toMatchObject({ shouldRun: true, reason: 'prod_behind_snapshot' });

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap21, now: new Date('2026-11-22T14:17:00Z'), fetchImpl: mkFetch({ ov: snap21, atlasOk: false }),
    })).toMatchObject({ shouldRun: true, reason: 'atlas_unhealthy' });

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap18, now: new Date('2026-11-22T06:17:00Z'), fetchImpl: mkFetch({ blogStatus: 503 }),
    })).toMatchObject({ shouldRun: true, reason: 'blogger_check_failed_primary_window' });

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap18, now: new Date('2026-11-22T10:17:00Z'), fetchImpl: mkFetch({ blogStatus: 503 }),
    })).toMatchObject({ shouldRun: false, reason: 'blogger_check_failed_retry_later' });

    expect(await evaluateRefreshNeeded({
      snapshotOverview: snap18,
      now: new Date('2026-11-22T10:17:00Z'),
      fetchImpl: mkFetch({
        ov: { dateRange: { latest: 'not-a-date' } },
        blogEntries: [{ link: 'bad', title: { $t: 123 } }, makeAtomEntry('ep-18', 'Wednesday 11/18/2026', '2026-11-18')],
      }),
    })).toMatchObject({ shouldRun: true, reason: 'prod_behind_snapshot', prodLatestDate: null });
  });
});
