// Unit tests for Cloudflare Worker HTTP API, auth, rate limiting, SPA assets, and Cron handler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { resetWorkerRateLimits } from '../server/worker.js';

function createFakeD1(rowsBySql = []) {
  return {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) { bound = args; return stmt; },
        async all() {
          for (const rule of rowsBySql) {
            if (rule.match(sql, bound)) return { results: rule.rows };
          }
          return { results: [] };
        },
        async first() {
          for (const rule of rowsBySql) {
            if (rule.match(sql, bound)) return rule.rows[0] ?? null;
          }
          return null;
        },
      };
      return stmt;
    },
    async batch() {
      return [];
    },
  };
}

function assertSecurityHeaders(res) {
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
}

describe('Cloudflare Worker entrypoint (server/worker.js)', () => {
  beforeEach(() => {
    resetWorkerRateLimits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns /api/health with security headers and strict CORS allowlist', async () => {
    const allowedRes = await worker.fetch(
      new Request('https://idleamericana.com/api/health', {
        headers: { Origin: 'https://idleamericana.com' },
      }),
      {},
    );
    expect(allowedRes.status).toBe(200);
    assertSecurityHeaders(allowedRes);
    expect(allowedRes.headers.get('Vary')).toBe('Origin');
    expect(allowedRes.headers.get('Access-Control-Allow-Origin')).toBe('https://idleamericana.com');
    expect(await allowedRes.json()).toMatchObject({
      status: 'ok',
      runtime: 'cloudflare-worker',
      database: 'unconfigured',
    });

    const deniedRes = await worker.fetch(
      new Request('https://idleamericana.com/through-the-cracks/api/health', {
        headers: { Origin: 'https://evil.example' },
      }),
      { DB: createFakeD1() },
    );
    expect(deniedRes.status).toBe(200);
    expect(deniedRes.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await deniedRes.json()).toMatchObject({ database: 'd1' });

    const preflight = await worker.fetch(
      new Request('https://idleamericana.com/api/episodes', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      }),
      {},
    );
    expect(preflight.status).toBe(204);
    assertSecurityHeaders(preflight);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('enforces 503 without DB and serves D1 read routes + URI validation', async () => {
    const noDb = await worker.fetch(new Request('https://idleamericana.com/api/overview'), {});
    expect(noDb.status).toBe(503);
    assertSecurityHeaders(noDb);

    const db = createFakeD1([
      {
        match: (s) => s.includes('FROM episodes WHERE id = ?'),
        rows: [{ id: 'ep-1', air_date: '2026-08-01', url: null, song_count: 1 }],
      },
      {
        match: (s) => s.includes('FROM song_plays WHERE episode_id = ?'),
        rows: [{ position: 1, artist: 'Todd Snider', song_title: 'Alright Guy', album: '' }],
      },
    ]);

    const epRes = await worker.fetch(new Request('https://idleamericana.com/through-the-cracks/api/episodes/ep-1'), { DB: db });
    expect(epRes.status).toBe(200);
    expect(await epRes.json()).toMatchObject({ id: 'ep-1', airDate: '2026-08-01', songCount: 1 });

    const missingRes = await worker.fetch(
      new Request('https://idleamericana.com/api/episodes/missing'),
      { DB: createFakeD1([]) },
    );
    expect(missingRes.status).toBe(404);

    const badId = await worker.fetch(new Request('https://idleamericana.com/api/episodes/%E0%A4%A'), { DB: db });
    expect(badId.status).toBe(400);

    const badArtist = await worker.fetch(new Request('https://idleamericana.com/api/artists/%E0%A4%A/songs'), { DB: db });
    expect(badArtist.status).toBe(400);

    for (const path of ['/api/overview', '/api/years', '/api/episodes', '/api/artists', '/api/artists/Todd%20Snider/songs', '/api/songs', '/api/search?q=dy']) {
      const r = await worker.fetch(new Request(`https://idleamericana.com${path}`), { DB: db });
      expect(r.status).toBe(200);
      assertSecurityHeaders(r);
    }

    const notFoundApi = await worker.fetch(new Request('https://idleamericana.com/api/unknown'), { DB: db });
    expect(notFoundApi.status).toBe(404);
  });

  it('enforces auth, body cap, DB checks, and rate limits on POST /api/ingest', async () => {
    const wrongMethod = await worker.fetch(new Request('https://idleamericana.com/api/ingest', { method: 'GET' }), {});
    expect(wrongMethod.status).toBe(405);

    const noSecret = await worker.fetch(new Request('https://idleamericana.com/api/ingest', { method: 'POST' }), {});
    expect(noSecret.status).toBe(503);

    const env = { INGEST_SECRET: 'super-secret-token' };
    const unauth = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token', 'CF-Connecting-IP': '1.2.3.4' },
      }),
      env,
    );
    expect(unauth.status).toBe(401);

    const oversized = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer super-secret-token', 'CF-Connecting-IP': '1.2.3.4' },
        body: 'x'.repeat(16_385),
      }),
      env,
    );
    expect(oversized.status).toBe(413);

    const badJson = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer super-secret-token', 'CF-Connecting-IP': '1.2.3.4' },
        body: '{invalid',
      }),
      env,
    );
    expect(badJson.status).toBe(400);

    const validNoDb = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer super-secret-token', 'CF-Connecting-IP': '1.2.3.4' },
        body: JSON.stringify({ incremental: true }),
      }),
      env,
    );
    expect(validNoDb.status).toBe(503);

    const fifthAllowed = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer super-secret-token', 'CF-Connecting-IP': '1.2.3.4' },
      }),
      env,
    );
    expect(fifthAllowed.status).toBe(503);

    const limited = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer super-secret-token', 'CF-Connecting-IP': '1.2.3.4' },
      }),
      env,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    assertSecurityHeaders(limited);

    const readRes = await worker.fetch(
      new Request('https://idleamericana.com/api/health', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      env,
    );
    expect(readRes.status).toBe(200);

    const oversizedHeader = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer super-secret-token',
          'Content-Length': '16385',
          'CF-Connecting-IP': '5.6.7.8',
        },
        body: '{}',
      }),
      env,
    );
    expect(oversizedHeader.status).toBe(413);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ feed: { entry: [] } }), { status: 200 }),
    );
    const okIngest = await worker.fetch(
      new Request('https://idleamericana.com/api/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer super-secret-token', 'CF-Connecting-IP': '5.6.7.8' },
        body: JSON.stringify({ incremental: false }),
      }),
      { ...env, DB: createFakeD1([]) },
    );
    expect(okIngest.status).toBe(200);
    expect(await okIngest.json()).toMatchObject({ mode: 'full', episodesUpserted: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves ASSETS with SPA fallback, clones immutable responses, and handles scheduled()', async () => {
    const fetchedPaths = [];
    const assets = {
      async fetch(req) {
        const path = new URL(req.url).pathname;
        fetchedPaths.push(path);
        if (path === '/index.html') {
          const res = new Response('<html>SPA</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
          Object.defineProperty(res.headers, 'set', {
            value: () => { throw new TypeError("Can't modify immutable headers"); },
          });
          return res;
        }
        return new Response('Not Found', { status: 404 });
      },
    };

    const spaRes = await worker.fetch(
      new Request('https://idleamericana.com/through-the-cracks/episodes'),
      { ASSETS: assets },
    );
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toBe('<html>SPA</html>');
    assertSecurityHeaders(spaRes);
    expect(fetchedPaths).toEqual(['/episodes', '/index.html']);

    const dataRes = await worker.fetch(
      new Request('https://idleamericana.com/through-the-cracks/data/missing.json'),
      { ASSETS: assets },
    );
    expect(dataRes.status).toBe(404);
    assertSecurityHeaders(dataRes);

    const noAssets = await worker.fetch(new Request('https://idleamericana.com/'), {});
    expect(noAssets.status).toBe(404);
    assertSecurityHeaders(noAssets);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ feed: { entry: [] } }), { status: 200 }),
    );
    const waitUntil = vi.fn();
    const db = createFakeD1([{ match: (s) => s.includes('MAX(air_date)'), rows: [{ latest_date: '2026-08-08' }] }]);
    const cronResult = await worker.scheduled({}, { DB: db }, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cronResult).toMatchObject({ mode: 'incremental', episodesUpserted: 0 });
  });
});
