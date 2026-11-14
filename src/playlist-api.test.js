// Unit and integration tests for Playlist canonical keying, randomizer bounds, D1 song_links, Worker, and Express routes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getD1RandomPlaylist, loadD1PlaylistPool, upsertSongLink } from '../server/d1Playlist.js';
import { clearD1Cache } from '../server/d1Rollups.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import { createApp } from '../server/index.js';
import { buildSongKey, drawRandomPlaylist, parsePlaylistQuery } from '../server/playlistBuilder.js';
import { resetPlaylistSnapshotCache } from '../server/routes/playlist.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';

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
  };
}

async function recordSql(db, fn) {
  const orig = db.prepare.bind(db);
  const queries = [];
  db.prepare = (sql) => { queries.push(sql); return orig(sql); };
  try { return { result: await fn(), queries }; } finally { db.prepare = orig; }
}

function makePoolRows(count = 14, overrides = {}) {
  return Array.from({ length: count }, (_, idx) => ({
    song_key: `artist ${idx + 1}|||song ${idx + 1}`,
    artist: idx === 0 ? 'Crosby, Stills & Nash' : `Artist ${idx + 1}`,
    song_title: `Song ${idx + 1}`,
    album: `Album ${idx + 1}`,
    total_plays: idx < 5 ? 5 : idx < 10 ? 2 : 0,
    video_id: `vid-${String(idx + 1).padStart(2, '0')}`,
    yt_title: `Song ${idx + 1}`,
    yt_artist: idx === 0 ? 'Crosby, Stills & Nash' : `Artist ${idx + 1}`,
    duration_seconds: 190 + idx,
    confidence_score: 92,
    match_tier: 'high',
    is_embeddable: 1,
    us_playable: 1,
    ...overrides,
  }));
}

function assertSecurityHeaders(res) {
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
}

describe('buildSongKey, parsePlaylistQuery, and drawRandomPlaylist', () => {
  it('normalizes canonical artist aliases, Unicode punctuation, and whitespace in buildSongKey', () => {
    expect(buildSongKey('Todd Snider', 'Alright Guy')).toBe('todd snider|||alright guy');
    expect(buildSongKey('beatles', 'In My Life')).toBe(buildSongKey('The Beatles', 'in my life'));
    expect(buildSongKey('willis nelson', 'Blue Eyes Crying')).toBe(buildSongKey('Willie Nelson', 'blue eyes crying'));
    expect(buildSongKey('jj cale', 'After Midnight')).toBe('j.j. cale|||after midnight');
    expect(buildSongKey("  Ramblin\u2019 Jack Elliot\u00A0", "Don\u2019t Think Twice \u2014 Live "))
      .toBe(buildSongKey("Ramblin' Jack Elliott", "don't think twice - live"));
  });

  it('clamps count 1..25 and minScore 0..100, validates mode, and preserves commas in URLSearchParams', () => {
    expect(parsePlaylistQuery(new URLSearchParams())).toEqual({
      count: 10, minScore: 85, mode: 'all', onePerArtist: true, exclude: [], excludeArtist: [],
    });
    expect(parsePlaylistQuery('count=0&minScore=-10&onePerArtist=false')).toMatchObject({
      count: 1, minScore: 0, onePerArtist: false,
    });
    expect(parsePlaylistQuery('count=99&minScore=150&onePerArtist=0')).toMatchObject({
      count: 25, minScore: 100, onePerArtist: false,
    });
    expect(parsePlaylistQuery('count=abc&minScore=0')).toMatchObject({ count: 10, minScore: 0 });
    expect(parsePlaylistQuery('mode=invalid')).toEqual({ error: 'Invalid playlist mode', status: 400 });

    const params = new URLSearchParams();
    params.append('excludeArtist', 'Crosby, Stills & Nash');
    params.append('excludeArtist', 'Todd Snider');
    expect(parsePlaylistQuery(params).excludeArtist).toEqual(['Crosby, Stills & Nash', 'Todd Snider']);
  });

  it('enforces mode filters, onePerArtist pass-2 fill, poolSize before exclusions, and strict playability', () => {
    const rawPool = [
      ...makePoolRows(12),
      ...makePoolRows(1, { video_id: 'vid-low-score', artist: 'Low Score', song_title: 'Low', confidence_score: 70 }),
      ...makePoolRows(1, { video_id: 'vid-unembed', artist: 'Blocked', song_title: 'NoEmbed', is_embeddable: 0 }),
      ...makePoolRows(1, { video_id: 'vid-non-us', artist: 'Geo', song_title: 'NonUS', us_playable: 0 }),
      { song_key: 'missing|||flags', artist: 'Missing Flags', song_title: 'Unchecked', total_plays: 4, video_id: 'vid-missing-flags', confidence_score: 95 },
    ];

    expect(drawRandomPlaylist(rawPool, 'mode=bogus')).toEqual({ error: 'Invalid playlist mode', status: 400 });

    const params = new URLSearchParams('count=9&exclude=vid-02,vid-03');
    params.append('excludeArtist', 'Crosby, Stills & Nash');
    const strictDraw = drawRandomPlaylist(rawPool, params);
    expect(strictDraw.poolSize).toBe(12);
    expect(strictDraw.count).toBe(9);
    expect(strictDraw.songs.map((s) => s.videoId)).not.toContain('vid-02');
    expect(strictDraw.songs.map((s) => s.videoId)).not.toContain('vid-03');
    expect(strictDraw.songs.map((s) => s.artist)).not.toContain('Crosby, Stills & Nash');
    expect(strictDraw.songs.map((s) => s.videoId)).not.toContain('vid-missing-flags');
    expect(new Set(strictDraw.songs.map((s) => s.artist)).size).toBe(9);

    const assumedDraw = drawRandomPlaylist(rawPool, 'count=25&minScore=85', { assumedPlayable: true });
    expect(assumedDraw.poolSize).toBe(13);
    expect(assumedDraw.songs.map((s) => s.videoId)).toContain('vid-missing-flags');
    expect(assumedDraw.songs.map((s) => s.videoId)).not.toContain('vid-unembed');
    expect(assumedDraw.songs.map((s) => s.videoId)).not.toContain('vid-non-us');

    expect(drawRandomPlaylist(rawPool, 'mode=favorites&count=25').poolSize).toBe(5);
    expect(drawRandomPlaylist(rawPool, 'mode=deep_cuts&count=25').poolSize).toBe(5);

    const threeArtistPool = Array.from({ length: 12 }, (_, i) => ({
      song_key: `a${(i % 3) + 1}|||s${i}`,
      artist: `Artist ${(i % 3) + 1}`,
      song_title: `Track ${i}`,
      total_plays: 2,
      video_id: `v-${i}`,
      confidence_score: 95,
      is_embeddable: 1,
      us_playable: 1,
    }));
    const filled = drawRandomPlaylist(threeArtistPool, { count: 10, onePerArtist: true });
    expect(filled.count).toBe(10);
    expect(new Set(filled.songs.map((s) => s.videoId)).size).toBe(10);
    expect(new Set(filled.songs.slice(0, 3).map((s) => s.artist)).size).toBe(3);
  });
});

describe('D1 song_links schema, manual protection, and rollup/raw fallback', () => {
  it('creates song_links + indexes, protects manual rows on upsert, and invalidates pool cache cleanly', async () => {
    const db = createSqliteD1();
    try {
      await ensureD1Schema(db);
      const objects = db.sqlite
        .prepare("SELECT type, name FROM sqlite_master WHERE name IN ('song_links', 'idx_song_links_random_pool', 'idx_song_links_tier')")
        .all();
      expect(objects.map((r) => `${r.type}:${r.name}`).sort()).toEqual([
        'index:idx_song_links_random_pool',
        'index:idx_song_links_tier',
        'table:song_links',
      ]);

      await upsertEpisodesIntoD1(db, [
        {
          id: 'ep-1', airDate: '2026-10-01', title: 'Show 1',
          songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Viva Satellite' }],
        },
        {
          id: 'ep-2', airDate: '2026-10-08', title: 'Show 2',
          songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Viva Satellite' }],
        },
      ]);

      await upsertSongLink(db, {
        artist: 'Todd Snider', songTitle: 'Alright Guy', videoId: 'manual-vid',
        confidenceScore: 100, matchTier: 'manual', isEmbeddable: 1, usPlayable: 1,
      });
      await upsertSongLink(db, {
        artist: 'Todd Snider', songTitle: 'Alright Guy', videoId: 'auto-vid',
        confidenceScore: 72, matchTier: 'medium', isEmbeddable: 1, usPlayable: 1,
      });

      const saved = db.sqlite.prepare('SELECT video_id, confidence_score, match_tier FROM song_links').get();
      expect(saved).toEqual({ video_id: 'manual-vid', confidence_score: 100, match_tier: 'manual' });

      await upsertSongLink(db, {
        artist: 'Lucinda Williams', songTitle: 'Car Wheels', videoId: 'lw-1',
        confidenceScore: 86, matchTier: 'medium', isEmbeddable: 1, usPlayable: 1,
      });
      await upsertSongLink(db, {
        artist: 'Lucinda Williams', songTitle: 'Car Wheels', videoId: 'lw-2',
        confidenceScore: 98, matchTier: 'high', isEmbeddable: 1, usPlayable: 1,
      });
      await upsertSongLink(db, {
        artist: 'Blocked Artist', songTitle: 'Blocked Song', videoId: 'blk-1',
        confidenceScore: 99, matchTier: 'high', isEmbeddable: 0, usPlayable: 1,
      });

      clearD1Cache(db);
      const rollupRec = await recordSql(db, () => loadD1PlaylistPool(db));
      expect(rollupRec.queries.some((sql) => /\bsong_rollups\b/i.test(sql))).toBe(true);
      expect(rollupRec.queries.some((sql) => /\bsong_plays\b/i.test(sql))).toBe(false);
      expect(rollupRec.result).toHaveLength(2);
      expect(rollupRec.result.find((r) => r.videoId === 'manual-vid')).toMatchObject({
        totalPlays: 2, album: 'Viva Satellite', isEmbeddable: true, usPlayable: true,
      });

      const cachedRec = await recordSql(db, () => loadD1PlaylistPool(db));
      expect(cachedRec.queries).toHaveLength(0);

      db.sqlite.exec('DELETE FROM song_rollups');
      clearD1Cache(db);
      const fallbackRec = await recordSql(db, () => loadD1PlaylistPool(db));
      expect(fallbackRec.queries.some((sql) => /\bsong_plays\b/i.test(sql))).toBe(true);
      expect(fallbackRec.result.find((r) => r.videoId === 'manual-vid')).toMatchObject({
        totalPlays: 2, album: 'Viva Satellite',
      });

      expect(await getD1RandomPlaylist(db, new URLSearchParams('mode=bad'))).toEqual({
        error: 'Invalid playlist mode', status: 400,
      });
      const drawn = await getD1RandomPlaylist(db, new URLSearchParams('count=5&minScore=85'));
      expect(drawn.poolSize).toBe(2);
      expect(drawn.songs.map((s) => s.videoId).sort()).toEqual(['lw-2', 'manual-vid']);
    } finally { db.sqlite.close(); }
  });
});

describe('Cloudflare Worker GET /api/playlist/random', () => {
  beforeEach(() => resetWorkerRateLimits());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('bypasses Edge Cache, enforces no-store + CORS + security headers, validates mode, and enforces rate limit', async () => {
    const cacheMatch = vi.fn(async () => undefined);
    const cachePut = vi.fn(async () => undefined);
    vi.stubGlobal('caches', { default: { match: cacheMatch, put: cachePut } });

    const r2 = createMemoryR2({ 'v1/song-links.json': makePoolRows(12) });
    const env = { SNAPSHOT_BUCKET: r2 };

    const resA = await worker.fetch(new Request('https://idleamericana.com/api/playlist/random?count=5', {
      headers: { Origin: 'https://idleamericana.com', 'CF-Connecting-IP': '10.0.0.1' },
    }), env);
    expect(resA.status).toBe(200);
    expect(resA.headers.get('Cache-Control')).toBe('no-store');
    expect(resA.headers.get('Access-Control-Allow-Origin')).toBe('https://idleamericana.com');
    assertSecurityHeaders(resA);
    expect((await resA.json()).songs).toHaveLength(5);

    const resB = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/playlist/random?count=10&excludeArtist=Crosby%2C%20Stills%20%26%20Nash', {
      headers: { Origin: 'https://evil.example', 'CF-Connecting-IP': '10.0.0.1' },
    }), env);
    expect(resB.status).toBe(200);
    expect(resB.headers.get('Cache-Control')).toBe('no-store');
    expect(resB.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await resB.json()).songs.map((s) => s.artist)).not.toContain('Crosby, Stills & Nash');
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();

    const badMode = await worker.fetch(new Request('https://idleamericana.com/api/playlist/random?mode=nope', {
      headers: { 'CF-Connecting-IP': '10.0.0.1' },
    }), env);
    expect(badMode.status).toBe(400);
    expect(badMode.headers.get('Cache-Control')).toBe('no-store');
    assertSecurityHeaders(badMode);
    expect(await badMode.json()).toEqual({ error: 'Invalid playlist mode' });

    for (let i = 0; i < 180; i += 1) {
      const ok = await worker.fetch(new Request('https://idleamericana.com/api/playlist/random?count=1', {
        headers: { 'CF-Connecting-IP': '10.0.0.2' },
      }), env);
      expect(ok.status).toBe(200);
    }
    const limited = await worker.fetch(new Request('https://idleamericana.com/api/playlist/random?count=1', {
      headers: { 'CF-Connecting-IP': '10.0.0.2' },
    }), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
    assertSecurityHeaders(limited);
  });

  it('serves R2 v1/song-links.json with 0 D1 calls, falls back to D1 if absent, and returns 503 if unconfigured', async () => {
    const throwingDb = { prepare: vi.fn(() => { throw new Error('D1 should not be called'); }) };
    const r2Populated = createMemoryR2({ 'v1/song-links.json': makePoolRows(12) });

    const r2Res = await worker.fetch(
      new Request('https://idleamericana.com/through-the-cracks/api/playlist/random?count=4'),
      { DB: throwingDb, SNAPSHOT_BUCKET: r2Populated },
    );
    expect(r2Res.status).toBe(200);
    expect(r2Res.headers.get('Cache-Control')).toBe('no-store');
    expect(throwingDb.prepare).not.toHaveBeenCalled();
    expect((await r2Res.json()).songs).toHaveLength(4);

    const db = createSqliteD1();
    try {
      await ensureD1Schema(db);
      await upsertSongLink(db, {
        artist: 'John Prine', songTitle: 'Sam Stone', videoId: 'jp-sam',
        confidenceScore: 95, matchTier: 'high', isEmbeddable: 1, usPlayable: 1,
      });
      const r2Empty = createMemoryR2();
      const d1FallbackRes = await worker.fetch(
        new Request('https://idleamericana.com/api/playlist/random?count=5'),
        { DB: db, SNAPSHOT_BUCKET: r2Empty },
      );
      expect(d1FallbackRes.status).toBe(200);
      expect(d1FallbackRes.headers.get('Cache-Control')).toBe('no-store');
      expect((await d1FallbackRes.json()).songs.map((s) => s.videoId)).toEqual(['jp-sam']);
    } finally { db.sqlite.close(); }

    const unconfigured = await worker.fetch(new Request('https://idleamericana.com/api/playlist/random'), {});
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get('Cache-Control')).toBe('no-store');

    const emptyR2NoDb = await worker.fetch(
      new Request('https://idleamericana.com/api/playlist/random'),
      { SNAPSHOT_BUCKET: createMemoryR2() },
    );
    expect(emptyR2NoDb.status).toBe(503);
    expect(emptyR2NoDb.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('Express createApp({ playlistSnapshotPath }) GET /api/playlist/random', () => {
  const tempDirs = [];
  const servers = [];

  async function startApp(playlistSnapshotPath) {
    const app = createApp({ query: async () => [], playlistSnapshotPath });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  function writeSnapshot(payload) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ttc-playlist-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'song-links.json');
    writeFileSync(filePath, JSON.stringify(payload), 'utf8');
    return filePath;
  }

  afterEach(() => resetPlaylistSnapshotCache());
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('returns 200 with no-store, preserves repeated excludeArtist commas, validates mode, and returns 503 when missing/empty', async () => {
    const validBase = await startApp(writeSnapshot(makePoolRows(14)));
    const directRes = await fetch(`${validBase}/api/playlist/random?count=5`);
    expect(directRes.status).toBe(200);
    expect(directRes.headers.get('cache-control')).toBe('no-store');
    expect((await directRes.json()).songs).toHaveLength(5);

    const okRes = await fetch(
      `${validBase}/through-the-cracks/api/playlist/random?count=10&excludeArtist=Crosby%2C%20Stills%20%26%20Nash&excludeArtist=Artist%202`,
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('cache-control')).toBe('no-store');
    const okBody = await okRes.json();
    expect(okBody.songs).toHaveLength(10);
    expect(okBody.songs.map((s) => s.artist)).not.toContain('Crosby, Stills & Nash');
    expect(okBody.songs.map((s) => s.artist)).not.toContain('Artist 2');

    const badRes = await fetch(`${validBase}/api/playlist/random?mode=unknown`);
    expect(badRes.status).toBe(400);
    expect(badRes.headers.get('cache-control')).toBe('no-store');
    expect(await badRes.json()).toEqual({ error: 'Invalid playlist mode' });

    const missingBase = await startApp(path.join(tmpdir(), 'does-not-exist-song-links.json'));
    const missingRes = await fetch(`${missingBase}/api/playlist/random`);
    expect(missingRes.status).toBe(503);
    expect(missingRes.headers.get('cache-control')).toBe('no-store');

    const emptyBase = await startApp(writeSnapshot([]));
    const emptyRes = await fetch(`${emptyBase}/api/playlist/random`);
    expect(emptyRes.status).toBe(503);
    expect(emptyRes.headers.get('cache-control')).toBe('no-store');
  });
});
