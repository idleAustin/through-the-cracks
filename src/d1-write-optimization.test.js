// Tests for D1 write-optimization fixes: lookback diffing, incremental rollups, index drops, and song_links guards.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePost } from '../scripts/blogger-parser.js';
import { buildUpsertSqlChunks, formatUpsertSongLinkStatement } from '../scripts/song-links-export-helpers.js';
import { getD1ArtistProfile } from '../server/d1ArtistProfile.js';
import {
  clearD1Cache, getD1Artists, getD1Overview, getD1Search, getD1Songs, getD1YearSpins,
} from '../server/d1Queries.js';
import { rebuildD1Rollups } from '../server/d1Rollups.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import {
  UPDATE_RECHECK_PLAYABILITY_SQL, UPDATE_RECHECK_TIMESTAMP_ONLY_SQL, runIncrementalSongLinksCron,
} from '../server/d1SongLinksCron.js';
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
    store, puts,
    async get(key) {
      const raw = store.get(key);
      return raw === undefined ? null : { text: async () => raw, json: async () => JSON.parse(raw) };
    },
    async put(key, val) { puts.push(key); store.set(key, typeof val === 'string' ? val : String(val)); },
  };
}

const totalChanges = (db) => Number(db.sqlite.prepare('SELECT total_changes() AS c').get().c);
async function recordSql(db, fn) {
  const orig = db.prepare.bind(db);
  const queries = [];
  db.prepare = (sql) => { queries.push(sql); return orig(sql); };
  try { return { result: await fn(), queries }; } finally { db.prepare = orig; }
}
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ytItem = (id, { embeddable = true, duration = 'PT3M40S' } = {}) =>
  ({ id, status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable }, contentDetails: { duration } });
const makePost = (id, titleDate, airIso, content) =>
  ({ id, title: `Playlist for WEVL's Through The Cracks, ${titleDate}`, content, published: `${airIso}T18:00:00Z`, url: `https://eddirmeyer.blogspot.com/2026/11/${id}.html` });
const makeEp = (id, airDate, songs) => ({
  id, airDate, dayOfWeek: 'Wednesday', episodeNumber: Number(String(id).replace(/\D/g, '')) || 1,
  publishedAt: `${airDate}T18:00:00Z`, title: `Playlist for WEVL's Through The Cracks, ${airDate}`,
  url: `https://eddirmeyer.blogspot.com/2026/11/${id}.html`,
  songs: songs.map((s, idx) => ({
    position: s.position ?? idx + 1, artist: s.artist ?? '', featuredArtist: s.featuredArtist ?? '',
    songTitle: s.songTitle ?? '', album: s.album ?? '', releaseKind: s.releaseKind ?? 'album',
    rawLine: s.rawLine ?? `${s.artist ?? ''} - ${s.songTitle ?? ''} - ${s.album ?? ''}`,
  })),
});

describe('D1 write-optimization fixes', () => {
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

  it('no-ops with 0 SQLite row mutations and 0 R2 puts across 14-day lookback Cron and POST /api/ingest', async () => {
    const db = await trackDb();
    const r2 = createMemoryR2();
    const posts = [
      makePost('ep-1', 'Sunday 11/08/2026', '2026-11-08', '<p>Todd Snider - Broke - New Connection</p><div>#1343</div>'),
      makePost('ep-2', 'Wednesday 11/11/2026', '2026-11-11', '<p>Bob Dylan - Tangled Up In Blue - Blood On The Tracks</p><div>#1344</div>'),
      makePost('ep-3', 'Saturday 11/14/2026', '2026-11-14', '<p>John Prine - Sam Stone - John Prine</p><div>#1345</div>'),
    ];
    await upsertEpisodesIntoD1(db, posts.map(parsePost));
    await syncR2SnapshotsFromD1(db, r2);
    expect(r2.store.has('v1/manifest.json')).toBe(true);
    r2.puts.length = 0;

    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ items: posts })));
    const env = { DB: db, SNAPSHOT_BUCKET: r2, INGEST_SECRET: 'write-opt-secret', BLOGGER_API_KEY: 'k', BLOGGER_BLOG_ID: 'b' };

    const beforeCron = totalChanges(db);
    const cronRes = await worker.scheduled({}, env, { waitUntil: () => {} });
    expect(cronRes).toMatchObject({ episodesUpserted: 0, episodesUnchanged: 3, songPlaysUpserted: 0 });
    expect(totalChanges(db) - beforeCron).toBe(0);
    expect(r2.puts).toHaveLength(0);

    const beforeIngest = totalChanges(db);
    const waited = [];
    const ingestRes = await worker.fetch(
      new Request('https://idleamericana.com/through-the-cracks/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer write-opt-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ incremental: true }),
      }),
      env,
      { waitUntil: (p) => waited.push(p) },
    );
    await Promise.all(waited);
    expect(ingestRes.status).toBe(200);
    expect(await ingestRes.json()).toMatchObject({ episodesUpserted: 0, episodesUnchanged: 3, songPlaysUpserted: 0 });
    expect(totalChanges(db) - beforeIngest).toBe(0);
    expect(r2.puts).toHaveLength(0);
  });

  it('rewrites only the changed or newly added Episode across metadata and Spin diffs', async () => {
    const db = await trackDb();
    const t0 = '2026-11-01T00:00:00.000Z';
    const t1 = '2026-11-15T00:00:00.000Z';
    const ep1 = makeEp('ep-1', '2026-11-08', [{ artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }]);
    let ep2 = makeEp('ep-2', '2026-11-11', [
      { artist: 'Bob Dylan', songTitle: 'Tangled Up In Blue', album: 'Blood On The Tracks' },
      { artist: 'John Prine', songTitle: 'Paradise', album: 'John Prine' },
    ]);
    const ep3 = makeEp('ep-3', '2026-11-14', [{ artist: 'Lucinda Williams', songTitle: 'Car Wheels', album: 'Car Wheels' }]);
    await upsertEpisodesIntoD1(db, [ep1, ep2, ep3], { now: t0 });

    const mutations = [
      (ep) => ({ ...ep, title: 'Updated Episode Title' }),
      (ep) => ({ ...ep, url: 'https://eddirmeyer.blogspot.com/2026/11/ep-2-updated.html' }),
      (ep) => ({ ...ep, songs: [{ ...ep.songs[0], songTitle: 'Simple Twist Of Fate' }, ep.songs[1]] }),
      (ep) => ({ ...ep, songs: [{ ...ep.songs[0], artist: 'The Band' }, ep.songs[1]] }),
      (ep) => ({ ...ep, songs: [{ ...ep.songs[0], featuredArtist: 'Emmylou Harris' }, ep.songs[1]] }),
      (ep) => ({ ...ep, songs: [{ ...ep.songs[0], album: 'Desire' }, ep.songs[1]] }),
      (ep) => ({ ...ep, songs: [{ ...ep.songs[0], releaseKind: 'single' }, ep.songs[1]] }),
      (ep) => ({ ...ep, songs: ep.songs.slice(0, 1) }),
    ];

    for (const mutate of mutations) {
      ep2 = mutate(ep2);
      const res = await upsertEpisodesIntoD1(db, [ep1, ep2, ep3], { now: t1 });
      expect(res).toMatchObject({ episodesUpserted: 1, episodesUnchanged: 2, songPlaysUpserted: ep2.songs.length });
      const byId = Object.fromEntries(db.sqlite.prepare('SELECT id, ingested_at, song_count FROM episodes').all().map((r) => [r.id, r]));
      expect([byId['ep-1'].ingested_at, byId['ep-3'].ingested_at, byId['ep-2'].ingested_at]).toEqual([t0, t0, t1]);
    }
    expect(db.sqlite.prepare('SELECT song_count FROM episodes WHERE id = ?').get('ep-2').song_count).toBe(1);
    expect(db.sqlite.prepare('SELECT COUNT(1) AS c FROM song_plays WHERE episode_id = ?').get('ep-2').c).toBe(1);

    const ep4 = makeEp('ep-4', '2026-11-18', [{ artist: 'Gillian Welch', songTitle: 'Look At Miss Ohio', album: 'Soul Journey' }]);
    expect(await upsertEpisodesIntoD1(db, [ep2, ep3, ep4], { now: t1 })).toMatchObject({
      episodesUpserted: 1, episodesUnchanged: 2, songPlaysUpserted: 1,
    });
  });

  it('maintains 100% query and rollup parity between incremental updates and full rebuildD1Rollups', async () => {
    const dbInc = await trackDb();
    const dbFull = await trackDb();
    const ep1 = makeEp('ep-1', '2024-05-01', [
      { artist: 'Anaïs Mitchell', songTitle: 'Wait For Me', album: 'Hadestown' },
      { artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Daily Planet' },
      { artist: 'John Prine', songTitle: 'Sam Stone', album: 'John Prine' },
      { artist: 'Downranked Artist', songTitle: 'Fade One', album: 'Fade LP' },
      { artist: '', songTitle: 'Station Promo', album: '', releaseKind: 'single' },
    ]);
    const ep2 = makeEp('ep-2', '2025-06-01', [
      { artist: 'Béla Fleck', featuredArtist: 'Abigail Washburn', songTitle: 'Shotgun Blues', album: 'Echo In The Valley' },
      { artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' },
      { artist: 'John Prine', songTitle: 'Paradise', album: 'John Prine' },
    ]);
    const ep3Initial = makeEp('ep-3', '2026-11-01', [
      { artist: 'Anaïs Mitchell', songTitle: 'Why We Build The Wall', album: 'Hadestown' },
      { artist: 'Béla Fleck', songTitle: 'Vertigo', album: 'My Bluegrass Heart' },
      { artist: 'Ephemeral Artist', songTitle: 'Vanishing Song', album: 'Vanishing Album' },
      { artist: 'Downranked Artist', songTitle: 'Fade Two', album: 'Fade LP' },
      { artist: 'John Prine', songTitle: 'Angel From Montgomery', album: 'John Prine' },
    ]);
    const ep4 = makeEp('ep-4', '2026-11-04', [{ artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' }]);
    const ep5 = makeEp('ep-5', '2026-11-08', [
      { artist: 'Anaïs Mitchell', songTitle: 'Young Man In America', album: 'Young Man In America' },
      { artist: 'Béla Fleck', featuredArtist: 'Sierra Hull', songTitle: 'Charm School', album: '', releaseKind: 'single' },
    ]);
    const ep3Edited = makeEp('ep-3', '2026-11-01', [
      { artist: 'Anaïs Mitchell', songTitle: 'Why We Build The Wall', album: 'Hadestown' },
      { artist: 'Béla Fleck', songTitle: 'Vertigo', album: 'My Bluegrass Heart' },
      { artist: 'Todd Snider', songTitle: 'Play A Train Song', album: 'East Nashville Skyline' },
      { artist: 'Anaïs Mitchell', songTitle: 'Any Way The Wind Blows', album: 'Hadestown' },
    ]);

    await upsertEpisodesIntoD1(dbInc, [ep1, ep2, ep3Initial, ep4]);
    await upsertEpisodesIntoD1(dbInc, [ep5]);
    await upsertEpisodesIntoD1(dbInc, [ep3Edited]);
    expect(dbInc.sqlite.prepare("SELECT COUNT(1) AS c FROM artist_rollups WHERE artist_key = 'ephemeral artist'").get().c).toBe(0);

    await upsertEpisodesIntoD1(dbFull, [ep1, ep2, ep3Edited, ep4, ep5], { skipUnchanged: false });
    await rebuildD1Rollups(dbFull);

    clearD1Cache(dbInc);
    clearD1Cache(dbFull);
    for (const run of [
      (d) => getD1Overview(d),
      (d) => getD1YearSpins(d),
      (d) => getD1YearSpins(d, { artist: 'Anaïs Mitchell' }),
      (d) => getD1Artists(d, { sort: 'top' }),
      (d) => getD1Artists(d, { sort: 'obscure' }),
      (d) => getD1Songs(d, { sort: 'top' }),
      (d) => getD1Songs(d, { sort: 'obscure' }),
      (d) => getD1Songs(d, { search: 'Sierra Hull' }),
      (d) => getD1Search(d, { q: 'anaïs' }),
      (d) => getD1Search(d, { q: 'sierra' }),
      (d) => getD1Search(d, { q: 'hadestown' }),
      (d) => getD1ArtistProfile(d, 'Anaïs Mitchell'),
      (d) => getD1ArtistProfile(d, 'Béla Fleck'),
    ]) expect(await run(dbInc)).toEqual(await run(dbFull));

    for (const [tbl, order] of [
      ['artist_rollups', 'artist_key'],
      ['album_rollups', 'artist_key, album_key'],
      ['song_rollups', 'artist_key, song_key'],
    ]) {
      expect(dbInc.sqlite.prepare(`SELECT * FROM ${tbl} ORDER BY ${order}`).all())
        .toEqual(dbFull.sqlite.prepare(`SELECT * FROM ${tbl} ORDER BY ${order}`).all());
    }
  });

  it('keeps incremental 1-Episode write volume tiny on a 60-artist / 300-song catalog and falls back cleanly at >200 artists', async () => {
    const db = await trackDb();
    const episodes = Array.from({ length: 15 }, (_, e) => makeEp(
      `ep-${e + 1}`,
      `2026-10-${String(e + 1).padStart(2, '0')}`,
      Array.from({ length: 20 }, (__, s) => {
        const idx = e * 20 + s;
        const aNum = String((idx % 60) + 1).padStart(2, '0');
        return { artist: `Artist ${aNum}`, songTitle: `Song ${idx + 1}`, album: `Album ${aNum}` };
      }),
    ));
    await upsertEpisodesIntoD1(db, episodes);

    const beforeInc = totalChanges(db);
    await upsertEpisodesIntoD1(db, [makeEp('ep-16', '2026-11-16', [{ artist: 'Artist 01', songTitle: 'Song 1', album: 'Album 01' }])]);
    const incChanges = totalChanges(db) - beforeInc;

    const beforeRebuild = totalChanges(db);
    await rebuildD1Rollups(db);
    const rebuildChanges = totalChanges(db) - beforeRebuild;
    expect(incChanges).toBeLessThan(rebuildChanges * 0.25);

    const db200 = await trackDb();
    const db200Full = await trackDb();
    const seedEp = makeEp('ep-seed', '2026-11-01', [{ artist: 'Seed Artist', songTitle: 'Seed Song', album: 'Seed LP' }]);
    const bulkEp = makeEp('ep-bulk', '2026-11-10', Array.from({ length: 205 }, (_, i) => ({
      artist: `Bulk Artist ${String(i + 1).padStart(3, '0')}`, songTitle: `Bulk Song ${i + 1}`, album: `Bulk LP ${i + 1}`,
    })));
    await upsertEpisodesIntoD1(db200, [seedEp]);
    const { queries } = await recordSql(db200, () => upsertEpisodesIntoD1(db200, [bulkEp]));
    expect(queries).toContain('DELETE FROM artist_rollups');
    expect(queries.some((sql) => sql.startsWith('DELETE FROM artist_rollups WHERE artist_key IN'))).toBe(false);

    await upsertEpisodesIntoD1(db200Full, [seedEp, bulkEp], { skipUnchanged: false });
    expect(await getD1Overview(db200)).toEqual(await getD1Overview(db200Full));
  });

  it('drops legacy song_plays indexes idempotently in ensureD1Schema while preserving active indexes', async () => {
    const db = await trackDb();
    db.sqlite.exec(`
      CREATE INDEX idx_song_plays_artist ON song_plays(artist);
      CREATE INDEX idx_song_plays_featured_lower ON song_plays(LOWER(TRIM(featured_artist)));
      CREATE INDEX idx_song_plays_album_lower ON song_plays(LOWER(TRIM(album)));
    `);
    await ensureD1Schema(db);

    const indexNames = db.sqlite.prepare('PRAGMA index_list(song_plays)').all().map((r) => r.name);
    for (const legacy of ['idx_song_plays_artist', 'idx_song_plays_featured_lower', 'idx_song_plays_album_lower']) {
      expect(indexNames).not.toContain(legacy);
    }
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_song_plays_episode_pos', 'idx_song_plays_air_date', 'idx_song_plays_artist_lower', 'idx_song_plays_song_lower',
    ]));
  });

  it('guards song_links SQL chunks against unchanged writes/manual rows and avoids index writes on unchanged Cron rechecks', async () => {
    const db = await trackDb();
    const autoRow = {
      song_key: 'todd snider|||broke', artist: 'Todd Snider', song_title: 'Broke',
      video_id: 'vid-1', yt_title: 'Broke', yt_artist: 'Todd Snider', yt_album: null,
      result_type: 'song', duration_seconds: 210, confidence_score: 95, match_tier: 'exact',
      is_embeddable: 1, us_playable: 1, status_reason: 'ok',
      checked_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
    };
    const manualRow = {
      ...autoRow, song_key: 'john prine|||sam stone', artist: 'John Prine', song_title: 'Sam Stone',
      video_id: 'manual-vid', yt_title: 'Sam Stone (Manual)', yt_artist: 'John Prine', match_tier: 'manual',
    };

    const b1 = totalChanges(db);
    db.sqlite.exec(buildUpsertSqlChunks([autoRow, manualRow], 10)[0].sql);
    expect(totalChanges(db) - b1).toBe(2);

    const b2 = totalChanges(db);
    db.sqlite.exec(buildUpsertSqlChunks([
      { ...autoRow, checked_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
      { ...manualRow, video_id: 'overwrite-attempt', match_tier: 'exact', checked_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
    ], 10)[0].sql);
    expect(totalChanges(db) - b2).toBe(0);
    expect(db.sqlite.prepare('SELECT checked_at FROM song_links WHERE song_key = ?').get(autoRow.song_key).checked_at)
      .toBe('2026-11-01T00:00:00Z');
    expect(db.sqlite.prepare('SELECT video_id, match_tier, checked_at FROM song_links WHERE song_key = ?').get(manualRow.song_key))
      .toEqual({ video_id: 'manual-vid', match_tier: 'manual', checked_at: '2026-11-01T00:00:00Z' });

    for (const patch of [{ video_id: 'vid-2' }, { is_embeddable: 0 }, { us_playable: 0 }, { status_reason: 'not_embeddable' }]) {
      Object.assign(autoRow, patch, { checked_at: '2026-11-16T01:00:00Z', updated_at: '2026-11-16T01:00:00Z' });
      const beforeMut = totalChanges(db);
      db.sqlite.exec(formatUpsertSongLinkStatement(autoRow));
      expect(totalChanges(db) - beforeMut).toBe(1);
    }

    const cronDb = await trackDb();
    cronDb.sqlite.exec(buildUpsertSqlChunks([
      { ...autoRow, song_key: 'a|||one', artist: 'A', song_title: 'One', video_id: 'v-keep', is_embeddable: 1, us_playable: 1, status_reason: 'ok', checked_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' },
      { ...autoRow, song_key: 'b|||two', artist: 'B', song_title: 'Two', video_id: 'v-deg', is_embeddable: 1, us_playable: 1, status_reason: 'ok', checked_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' },
    ], 10)[0].sql);

    const run1 = await recordSql(cronDb, () => runIncrementalSongLinksCron({
      db: cronDb, apiKey: 'yt-key', maxNewSongs: 0, now: () => '2026-11-16T06:00:00Z',
      fetchImpl: async () => jsonRes({ items: [ytItem('v-keep'), ytItem('v-deg')] }),
    }));
    expect(run1.result).toMatchObject({ recheckedCount: 2, playabilityChangedCount: 0, changesMade: false });
    expect(run1.queries.filter((s) => s === UPDATE_RECHECK_TIMESTAMP_ONLY_SQL)).toHaveLength(2);
    expect(run1.queries).not.toContain(UPDATE_RECHECK_PLAYABILITY_SQL);
    expect(cronDb.sqlite.prepare("SELECT checked_at FROM song_links WHERE song_key = 'a|||one'").get().checked_at)
      .toBe('2026-11-16T06:00:00Z');

    const run2 = await recordSql(cronDb, () => runIncrementalSongLinksCron({
      db: cronDb, apiKey: 'yt-key', maxNewSongs: 0, now: () => '2026-11-16T12:00:00Z',
      fetchImpl: async () => jsonRes({ items: [ytItem('v-keep'), ytItem('v-deg', { embeddable: false })] }),
    }));
    expect(run2.result).toMatchObject({ recheckedCount: 2, playabilityChangedCount: 1, changesMade: true });
    expect(run2.queries.filter((s) => s === UPDATE_RECHECK_TIMESTAMP_ONLY_SQL)).toHaveLength(1);
    expect(run2.queries.filter((s) => s === UPDATE_RECHECK_PLAYABILITY_SQL)).toHaveLength(1);
    expect(cronDb.sqlite.prepare("SELECT is_embeddable, status_reason FROM song_links WHERE song_key = 'b|||two'").get())
      .toEqual({ is_embeddable: 0, status_reason: 'not_embeddable' });
  });
});
