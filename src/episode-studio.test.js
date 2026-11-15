// Unit, cross-runtime parity, and Web-API guard tests for Episode Studio Log & Provenance.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEpisodeById, getEpisodes } from './api.js';
import { UPSERT_SONG_LINK_SQL } from '../server/d1Playlist.js';
import { getD1EpisodeById, getD1Episodes } from '../server/d1Episodes.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import { buildEnrichedEpisodeDetail, getBroadcastDayOfWeek, parseBroadcastDayParam } from '../server/episodeDetailBuilder.js';
import { createApp } from '../server/index.js';
import { serveEpisodeDetailFromR2, serveEpisodesFromR2 } from '../server/r2Episodes.js';
import { resetPlaylistSnapshotCache } from '../server/routes/playlist.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';
import { syncR2SnapshotsFromD1 } from '../server/workerSnapshots.js';

const STRIPPED_KEYS = ['title', 'episodeNumber', 'episode_number', 'dayOfWeek', 'publishedAt'];
const PROVENANCE_KEYS = ['dna', 'debutArtists', 'doubledArtists', 'topStaplePlayCount', 'opener', 'closer', 'prevEpisodeId', 'nextEpisodeId'];
const FIXTURE_EPISODES = [
  { id: 'ep-6', airDate: '2026-11-14', title: 'Legacy #6', episodeNumber: 600, dayOfWeek: 'Saturday', publishedAt: '2026-11-15T00:00:00Z', url: 'https://wevl.org/6', songs: [
    { position: 1, artist: 'Townes Van Zandt', songTitle: 'Pancho and Lefty', album: 'The Late Great' },
    { position: 2, artist: 'Debut Duo', songTitle: '100% Proof', featuredArtist: 'Emmylou Harris', album: 'Under_Cover' },
    { position: 3, artist: 'Solo Stranger', songTitle: 'Lone Pine', album: 'Single Trail' },
    { position: 4, artist: 'Veteran Band', songTitle: 'Dust_Bowl', album: 'Highway 61' },
    { position: 5, artist: 'Debut Duo', songTitle: '100% Proof', featuredArtist: 'Emmylou Harris', album: 'Under_Cover' },
  ] },
  { id: 'ep-5', airDate: '2026-11-11', url: 'https://wevl.org/5', songs: [{ position: 1, artist: 'Townes Van Zandt', songTitle: 'Pancho and Lefty', album: 'The Late Great' }, { position: 2, artist: 'Mile Markers', songTitle: '1000 Miles', album: 'Long Road' }] },
  { id: 'ep-4', airDate: '2025-11-08', url: 'https://wevl.org/4', songs: [{ position: 1, artist: 'Townes Van Zandt', songTitle: 'Pancho and Lefty', album: 'The Late Great' }, { position: 2, artist: 'Veteran Band', songTitle: 'Dust_Bowl', album: 'Highway 61' }] },
  { id: 'ep-3', airDate: '2025-06-11', url: 'https://wevl.org/3', songs: [{ position: 1, artist: 'Townes Van Zandt', songTitle: 'Pancho and Lefty', album: 'The Late Great' }, { position: 2, artist: 'Road Crew', songTitle: 'Dusty Road', album: 'Gravel' }] },
  { id: 'ep-2', airDate: '2024-06-15', url: 'https://wevl.org/2', songs: [{ position: 1, artist: 'Townes Van Zandt', songTitle: 'Pancho and Lefty', album: 'The Late Great' }, { position: 2, artist: 'Twin Singer', songTitle: 'Same Tune', featuredArtist: 'Larry Nager', album: 'Live in Louisville' }] },
  { id: 'ep-1', airDate: '2024-01-06', url: 'https://wevl.org/1', songs: [{ position: 1, artist: 'Townes Van Zandt', songTitle: 'Pancho and Lefty', album: 'The Late Great' }, { position: 2, artist: 'Twin Singer', songTitle: 'Same Tune', album: 'Studio Cut' }] },
];
const FIXTURE_LINKS = [
  ['townes van zandt|||pancho and lefty', 'Townes Van Zandt', 'Pancho and Lefty', 'vid-pancho123', 215, 1, 1],
  ['solo stranger|||lone pine', 'Solo Stranger', 'Lone Pine', 'vid-lone45678', 184, 1, 1],
  ['veteran band|||dust_bowl', 'Veteran Band', 'Dust_Bowl', 'vid-blocked99', 200, 0, 1],
];
function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const wrap = (sql, bound = []) => ({
    _sql: sql, bind: (...args) => wrap(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...bound) }),
    first: async () => sqlite.prepare(sql).get(...bound) ?? null,
    run: async () => { sqlite.prepare(sql).run(...bound); return { success: true }; },
  });
  return {
    sqlite, prepare: (sql) => wrap(sql),
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
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) {
      const raw = store.get(key);
      return raw === undefined ? null : { text: async () => raw, json: async () => JSON.parse(raw) };
    },
    async put(key, val) { store.set(key, typeof val === 'string' ? val : String(val)); },
  };
}
function createBqSqliteQuery(sqlite, bqCalls) {
  return async (sql, params = {}) => {
    bqCalls.push({ sql, params });
    let sqliteSql = sql
      .replace(/`[^`]+\.(episodes|song_plays)`/gi, '$1')
      .replace(/EXTRACT\s*\(\s*YEAR\s+FROM\s+([a-zA-Z0-9_.]+)\s*\)/gi, 'CAST(SUBSTR($1, 1, 4) AS INTEGER)')
      .replace(/EXTRACT\s*\(\s*DAYOFWEEK\s+FROM\s+([a-zA-Z0-9_.]+)\s*\)/gi, "(CAST(STRFTIME('%w', $1) AS INTEGER) + 1)")
      .replace(/\bCAST\s*\(\s*([^)]+?)\s+AS\s+STRING\s*\)/gi, 'CAST($1 AS TEXT)')
      .replace(/\bDATE\s*\(\s*(@[a-zA-Z0-9_]+)\s*\)/gi, '$1')
      .replace(/LIKE\s+(@[a-zA-Z0-9_]+)/gi, "LIKE $1 ESCAPE '\\'");
    const bound = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (Array.isArray(v) && sqliteSql.includes(`UNNEST(@${k})`)) {
        const names = v.map((_, i) => `@_${k}_${i}`);
        sqliteSql = sqliteSql.replaceAll(`UNNEST(@${k})`, `(${names.join(', ')})`);
        v.forEach((item, i) => { bound[`_${k}_${i}`] = item; });
      } else if (new RegExp(`@${k}\\b`).test(sqliteSql)) {
        bound[k] = v;
      }
    }
    return sqlite.prepare(sqliteSql).all(bound).map((row) => ({
      ...row,
      ...(typeof row.air_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.air_date) ? { air_date: { value: row.air_date } } : {}),
    }));
  };
}
function assertNoStrippedFields(ep) {
  for (const key of STRIPPED_KEYS) expect(ep).not.toHaveProperty(key);
  for (const track of ep.playlist || ep.songs || []) {
    for (const key of STRIPPED_KEYS) expect(track).not.toHaveProperty(key);
  }
}
function assertBareShape(ep) {
  assertNoStrippedFields(ep);
  for (const key of PROVENANCE_KEYS) expect(ep).not.toHaveProperty(key);
  for (const track of ep.playlist || ep.songs || []) {
    expect(track).not.toHaveProperty('totalPlays');
    expect(track).not.toHaveProperty('isSongDebut');
    expect(track).not.toHaveProperty('videoId');
  }
}
describe('episodeDetailBuilder unit helpers', () => {
  it('resolves broadcast weekdays and parses day params cleanly', () => {
    expect(getBroadcastDayOfWeek('2026-11-14')).toBe('Saturday');
    expect(getBroadcastDayOfWeek('2026-11-11')).toBe('Wednesday');
    expect(getBroadcastDayOfWeek({ value: '2026-11-14' })).toBe('Saturday');
    expect(getBroadcastDayOfWeek('not-a-date')).toBe('');
    expect(getBroadcastDayOfWeek('2026-02-30')).toBe('');
    expect(parseBroadcastDayParam('sat')).toMatchObject({ name: 'Saturday', sqliteDow: '6', bqDow: 7 });
    expect(parseBroadcastDayParam('Saturday')).toMatchObject({ name: 'Saturday', sqliteDow: '6', bqDow: 7 });
    expect(parseBroadcastDayParam('wed')).toMatchObject({ name: 'Wednesday', sqliteDow: '3', bqDow: 4 });
    expect(parseBroadcastDayParam('Wednesday')).toMatchObject({ name: 'Wednesday', sqliteDow: '3', bqDow: 4 });
    expect(parseBroadcastDayParam('friday')).toBeNull();
    expect(parseBroadcastDayParam('')).toBeNull();
  });
  it('computes 5-metric DNA, deduplicates intra-episode song debuts, attaches video links, and strips legacy fields', () => {
    const detail = buildEnrichedEpisodeDetail({
      episode: FIXTURE_EPISODES[0],
      tracks: FIXTURE_EPISODES[0].songs,
      songStatsByKey: new Map([
        ['townes van zandt|||pancho and lefty', { totalPlays: 6, firstPlayed: '2024-01-06', lastPlayed: '2026-11-14' }],
        ['debut duo|||100% proof', { totalPlays: 2, firstPlayed: '2026-11-14', lastPlayed: '2026-11-14' }],
        ['solo stranger|||lone pine', { totalPlays: 1, firstPlayed: '2026-11-14', lastPlayed: '2026-11-14' }],
        ['veteran band|||dust_bowl', { totalPlays: 2, firstPlayed: '2025-11-08', lastPlayed: '2026-11-14' }],
      ]),
      artistFirstByKey: new Map([['townes van zandt', '2024-01-06'], ['debut duo', '2026-11-14'], ['solo stranger', '2026-11-14'], ['veteran band', '2025-11-08']]),
      playableLinksByKey: new Map([
        ['townes van zandt|||pancho and lefty', { videoId: 'vid-pancho123', durationSeconds: 215 }],
        ['solo stranger|||lone pine', { videoId: 'vid-lone45678', durationSeconds: 184 }],
      ]),
      prevEpisodeId: 'ep-7',
      nextEpisodeId: 'ep-5',
    });
    expect(detail.dna).toEqual({
      debutSongCount: 2, debutArtistCount: 2, artistDebutSpinCount: 3, onlySpinCount: 1, stapleCount: 1, playableCount: 2,
    });
    expect(detail.debutArtists).toEqual(['Debut Duo', 'Solo Stranger']);
    expect(detail.doubledArtists).toEqual(['Debut Duo']);
    expect(detail.topStaplePlayCount).toBe(6);
    expect(detail.opener).toEqual({ artist: 'Townes Van Zandt', songTitle: 'Pancho and Lefty' });
    expect(detail.closer).toEqual({ artist: 'Debut Duo', songTitle: '100% Proof' });
    expect(detail.prevEpisodeId).toBe('ep-7');
    expect(detail.nextEpisodeId).toBe('ep-5');
    expect(detail.playlist[0]).toMatchObject({ isStaple: true, isSongDebut: false, videoId: 'vid-pancho123', durationSeconds: 215 });
    expect(detail.playlist[1]).toMatchObject({ isSongDebut: true, isArtistDebut: true, featuredArtist: 'Emmylou Harris', videoId: null, durationSeconds: null });
    expect(detail.playlist[2]).toMatchObject({ isSongDebut: true, isArtistDebut: true, isOnlySpin: true, videoId: 'vid-lone45678', durationSeconds: 184 });
    expect(detail.playlist[4]).toMatchObject({ isSongDebut: false, isArtistDebut: true });
    assertNoStrippedFields(detail);
  });
});
describe('Episode Studio cross-runtime parity (D1 rollup/raw, Worker R2, Express, Static) & Web-API guard', () => {
  const originalFetch = globalThis.fetch;
  let rollupDb;
  let rawDb;
  let r2Bucket;
  let server;
  let expressBaseUrl = '';
  let tempDir = '';
  let bqCalls = [];

  beforeAll(async () => {
    rollupDb = createSqliteD1();
    rawDb = createSqliteD1();
    await Promise.all([ensureD1Schema(rollupDb), ensureD1Schema(rawDb)]);
    await Promise.all([upsertEpisodesIntoD1(rollupDb, FIXTURE_EPISODES), upsertEpisodesIntoD1(rawDb, FIXTURE_EPISODES)]);
    for (const db of [rollupDb, rawDb]) {
      await db.batch(FIXTURE_LINKS.map(([key, artist, songTitle, vid, dur, embed, us]) =>
        db.prepare(UPSERT_SONG_LINK_SQL).bind(key, artist, songTitle, vid, songTitle, artist, '', 'video', dur, 95, 'high', embed, us, 'ok', '2026-11-15', '2026-11-15'),
      ));
    }
    rawDb.sqlite.exec('DROP TABLE cache_blobs; DROP TABLE artist_rollups; DROP TABLE song_rollups; DROP TABLE album_rollups;');
    r2Bucket = createMemoryR2();
    await syncR2SnapshotsFromD1(rollupDb, r2Bucket);
    tempDir = mkdtempSync(path.join(tmpdir(), 'ttc-ep-studio-'));
    const snapshotPath = path.join(tempDir, 'song-links.json');
    writeFileSync(snapshotPath, r2Bucket.store.get('v1/song-links.json'), 'utf8');
    const app = createApp({ query: createBqSqliteQuery(rollupDb.sqlite, bqCalls), project: 'test-proj', dataset: 'test_ds', playlistSnapshotPath: snapshotPath });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => { expressBaseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
  });

  beforeEach(() => { bqCalls.length = 0; resetWorkerRateLimits(); });
  afterAll(async () => {
    vi.unstubAllGlobals();
    resetPlaylistSnapshotCache();
    rollupDb?.sqlite?.close();
    rawDb?.sqlite?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  function stubStaticFetch() {
    vi.stubGlobal('fetch', async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith(expressBaseUrl)) return originalFetch(input, init);
      if (url.includes('/api/')) throw new Error('ECONNREFUSED');
      const m = url.match(/\/data\/(episodes-index|songs|artists|song-links|playlists\/\d{4})\.json$/);
      const raw = m ? r2Bucket.store.get(`v1/${m[1]}.json`) : undefined;
      return raw ? new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('Not found', { status: 404 });
    });
  }
  it('matches q (song, artist, featuredArtist, album, airDate), LIKE wildcards (%, _), and day across all runtimes', async () => {
    const r2Idx = JSON.parse(r2Bucket.store.get('v1/episodes-index.json'));
    const loadR2 = async (k) => (r2Bucket.store.has(k) ? JSON.parse(r2Bucket.store.get(k)) : null);
    stubStaticFetch();
    const cases = [
      [{ q: '100%' }, ['ep-6']], // escapes % so '1000 Miles' (ep-5) does not match
      [{ q: 'dust_' }, ['ep-6', 'ep-4']], // escapes _ so 'Dusty Road' (ep-3) does not match
      [{ q: 'emmylou' }, ['ep-6']],
      [{ q: 'under_cover' }, ['ep-6']],
      [{ q: '2026-11-11' }, ['ep-5']],
      [{ q: 'townes' }, ['ep-6', 'ep-5', 'ep-4', 'ep-3', 'ep-2', 'ep-1']],
      [{ day: 'Saturday' }, ['ep-6', 'ep-4', 'ep-2', 'ep-1']],
      [{ day: 'Wednesday' }, ['ep-5', 'ep-3']],
      [{ q: 'dust_', day: 'Saturday' }, ['ep-6', 'ep-4']],
      [{ q: 'live in louisville' }, ['ep-2']], // matches ep-2 album without leaking ep-1 (same song/artist)
      [{ q: 'larry nager' }, ['ep-2']], // matches ep-2 featuredArtist without leaking ep-1
      [{ q: 'studio cut' }, ['ep-1']],
      [{ q: 'same tune' }, ['ep-2', 'ep-1']],
    ];
    for (const [params, expectedIds] of cases) {
      const qs = new URLSearchParams(params).toString();
      const [d1Rollup, d1Raw, r2List, expList, staticList] = await Promise.all([
        getD1Episodes(rollupDb, params),
        getD1Episodes(rawDb, params),
        serveEpisodesFromR2(r2Idx, params, loadR2),
        originalFetch(`${expressBaseUrl}/api/episodes?${qs}`).then((r) => r.json()),
        getEpisodes(params).then((r) => r.data),
      ]);
      for (const out of [d1Rollup, d1Raw, r2List, expList, staticList]) {
        expect(out.episodes.map((e) => e.id)).toEqual(expectedIds);
        expect(out.total).toBe(expectedIds.length);
      }
    }
    const qLikes = new Set(bqCalls.map((c) => c.params?.qLike).filter(Boolean));
    expect(qLikes).toContain('%100\\%%');
    expect(qLikes).toContain('%dust\\_%');
  });
  it('clamps oversized page and limit params to safe finite bounds across D1, Express, R2, and Static', async () => {
    const r2Idx = JSON.parse(r2Bucket.store.get('v1/episodes-index.json'));
    const loadR2 = async (k) => (r2Bucket.store.has(k) ? JSON.parse(r2Bucket.store.get(k)) : null);
    stubStaticFetch();
    const bounds = { page: '999999999999', limit: '999' };
    const [d1Rollup, d1Raw, expList, staticList, r2List] = await Promise.all([
      getD1Episodes(rollupDb, bounds),
      getD1Episodes(rawDb, bounds),
      originalFetch(`${expressBaseUrl}/api/episodes?page=999999999999&limit=999`).then((r) => r.json()),
      getEpisodes({ page: 999999999999, limit: 999 }).then((r) => r.data),
      serveEpisodesFromR2(r2Idx, bounds, loadR2),
    ]);
    for (const out of [d1Rollup, d1Raw, expList, staticList]) {
      const pageVal = out.page ?? out.pagination?.page;
      const limitVal = out.limit ?? out.pagination?.limit;
      expect(Number.isSafeInteger(pageVal) && pageVal >= 1 && pageVal <= 1_000_000).toBe(true);
      expect(limitVal).toBeLessThanOrEqual(100);
      expect(limitVal).toBeGreaterThanOrEqual(1);
      expect(out.episodes).toEqual([]);
      expect(out.total).toBe(6);
    }
    expect(r2List.limit).toBeLessThanOrEqual(100);
    expect(Number.isSafeInteger(r2List.page)).toBe(true);
    expect(r2List.episodes).toEqual([]);
    expect(r2List.total).toBe(6);
  });
  it('aligns ?provenance=1 detail and bare detail omission across D1 rollup/raw, R2, Express, and Static', async () => {
    const loadR2 = async (k) => (r2Bucket.store.has(k) ? JSON.parse(r2Bucket.store.get(k)) : null);
    stubStaticFetch();
    const [d1Rollup, d1Raw, r2Det, expDet, staticDet] = await Promise.all([
      getD1EpisodeById(rollupDb, 'ep-6', { provenance: '1' }),
      getD1EpisodeById(rawDb, 'ep-6', { provenance: '1' }),
      serveEpisodeDetailFromR2('ep-6', { loadShared: loadR2, readSongLinks: () => loadR2('v1/song-links.json'), query: { provenance: '1' } }).then((r) => r.data),
      originalFetch(`${expressBaseUrl}/api/episodes/ep-6?provenance=1`).then((r) => r.json()),
      getEpisodeById('ep-6', { provenance: true }).then((r) => r.data),
    ]);
    for (const detail of [d1Rollup, d1Raw, r2Det, expDet, staticDet]) {
      expect(detail).toEqual(d1Rollup);
      expect(detail.dna).toEqual({ debutSongCount: 2, debutArtistCount: 2, artistDebutSpinCount: 3, onlySpinCount: 1, stapleCount: 1, playableCount: 2 });
      expect(detail.prevEpisodeId).toBeNull();
      expect(detail.nextEpisodeId).toBe('ep-5');
      assertNoStrippedFields(detail);
    }
    const [d1Bare, r2Bare, expBare, staticBare] = await Promise.all([
      getD1EpisodeById(rollupDb, 'ep-6'),
      serveEpisodeDetailFromR2('ep-6', { loadShared: loadR2 }).then((r) => r.data),
      originalFetch(`${expressBaseUrl}/api/episodes/ep-6`).then((r) => r.json()),
      getEpisodeById('ep-6').then((r) => r.data),
    ]);
    for (const bare of [d1Bare, r2Bare, expBare, staticBare]) {
      expect(bare.id).toBe('ep-6');
      expect(bare.playlist).toHaveLength(5);
      assertBareShape(bare);
    }
  });
  it('serves Worker R2 routes with 0 D1 queries and handles missing v1/song-links.json gracefully', async () => {
    let d1Calls = 0;
    const countingDb = { prepare() { d1Calls += 1; throw new Error('D1 should not run'); }, batch() { d1Calls += 1; throw new Error('D1 should not run'); } };
    const listRes = await worker.fetch(new Request('https://idleamericana.com/api/episodes?q=100%25&day=Saturday'), { DB: countingDb, SNAPSHOT_BUCKET: r2Bucket });
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).episodes.map((e) => e.id)).toEqual(['ep-6']);
    const detRes = await worker.fetch(new Request('https://idleamericana.com/api/episodes/ep-6?provenance=1'), { DB: countingDb, SNAPSHOT_BUCKET: r2Bucket });
    expect(detRes.status).toBe(200);
    expect((await detRes.json()).dna.playableCount).toBe(2);
    expect(d1Calls).toBe(0);

    const noLinksR2 = createMemoryR2(Object.fromEntries([...r2Bucket.store.entries()].filter(([k]) => k !== 'v1/song-links.json')));
    resetWorkerRateLimits();
    const noLinksRes = await worker.fetch(new Request('https://idleamericana.com/api/episodes/ep-6?provenance=1'), { DB: countingDb, SNAPSHOT_BUCKET: noLinksR2 });
    expect(noLinksRes.status).toBe(200);
    expect((await noLinksRes.json()).dna.playableCount).toBe(0);
    expect(d1Calls).toBe(0);
  });
  it('keeps Web-API-only runtime modules free of node: imports', () => {
    for (const rel of ['server/episodeDetailBuilder.js', 'server/d1Episodes.js', 'server/r2Episodes.js']) {
      expect(readFileSync(path.join(process.cwd(), rel), 'utf8')).not.toMatch(/from\s+['"]node:|import\s*\(\s*['"]node:/);
    }
  });
});
