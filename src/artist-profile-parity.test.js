// Worker routing and 3-runtime parity tests for GET /api/artists/:name/profile (TDD RED before routes & client API).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientApi from './api.js';
import { writeArtistProfileSnapshots } from '../scripts/static-snapshots.js';
import { encodeArtistProfileKey } from '../server/artistProfileBuilder.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import { createApp } from '../server/index.js';
import worker, { resetWorkerRateLimits } from '../server/worker.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const DATE_COLUMNS = new Set(['air_date', 'earliest_date', 'latest_date']);

const FIXTURE_EPISODES = [
  {
    id: 'ep-2013-07-14',
    airDate: '2013-07-14',
    episodeNumber: null,
    songs: [
      { position: 1, artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Songs for the Daily Planet' },
      { position: 2, artist: 'Lucinda Williams', songTitle: 'Car Wheels', album: 'Car Wheels' },
      { position: 3, artist: 'case/ lang/ veirs', songTitle: 'Atomic Number', album: 'case/lang/veirs' },
    ],
  },
  {
    id: 'ep-2016-04-10',
    airDate: '2016-04-10',
    episodeNumber: 210,
    songs: [
      { position: 1, artist: 'Cory Branan', songTitle: 'Sour Mash', album: 'No-Hit Wonder' },
      { position: 2, artist: 'Todd Snider', songTitle: 'Beer Run', album: 'New Connection' },
      { position: 3, artist: 'Lucinda Williams', songTitle: 'Changed the Locks', album: 'Lucinda Williams' },
      { position: 4, artist: 'cory branan', songTitle: 'The Corner', album: 'Mutt' },
    ],
  },
  {
    id: 'ep-2021-03-01',
    airDate: '2021-03-01',
    episodeNumber: 501,
    songs: [
      { position: 1, artist: 'Cory Branan', songTitle: 'Sour Mash', album: 'No-Hit Wonder' },
      { position: 2, artist: 'case/ lang/ veirs', songTitle: 'Honey and Smoke', album: 'case/lang/veirs' },
      { position: 3, artist: 'John Moreland', songTitle: "You Don't Care for Me Enough to Cry", album: 'In the Throes' },
    ],
  },
  {
    id: 'ep-2023-06-15',
    airDate: '2023-06-15',
    episodeNumber: 650,
    songs: [
      { position: 1, artist: 'Cory Branan', songTitle: 'Skateland', album: 'Adios' },
      { position: 2, artist: 'Cory Branan', songTitle: 'Sour Mash', album: 'No-Hit Wonder' },
      { position: 3, artist: 'Todd Snider', songTitle: 'Play a Train Song', album: 'East Nashville Skyline' },
    ],
  },
  {
    id: 'ep-2026-08-01',
    airDate: '2026-08-01',
    episodeNumber: 830,
    songs: [
      { position: 1, artist: 'Lucinda Williams', songTitle: 'Car Wheels', album: 'Car Wheels' },
      { position: 2, artist: 'Cory Branan', songTitle: 'Prettiest Waitress', album: 'The Hell You Say' },
      { position: 3, artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Songs for the Daily Planet' },
    ],
  },
  {
    id: 'ep-2026-11-11',
    airDate: '2026-11-11',
    episodeNumber: 842,
    songs: [
      { position: 1, artist: 'Todd Snider', songTitle: 'Broke', album: 'New Connection' },
      { position: 2, artist: 'case/ lang/ veirs', songTitle: 'Atomic Number', album: 'case/lang/veirs' },
    ],
  },
];

function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const wrap = (sql, bound = []) => ({
    _sql: sql,
    bind(...args) { return wrap(sql, args); },
    async all() { return { results: sqlite.prepare(sql).all(...bound) }; },
    async first() { return sqlite.prepare(sql).get(...bound) ?? null; },
    async run() { sqlite.prepare(sql).run(...bound); return { success: true }; },
  });
  return {
    sqlite,
    prepare(sql) { return wrap(sql); },
    async batch(stmts) {
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) results.push(/^\s*SELECT\b/i.test(s._sql) ? await s.all() : await s.run());
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
      return results;
    },
  };
}

function createBqSqliteQuery(sqlite, recordedCalls) {
  return async (sql, params = {}) => {
    recordedCalls.push({ sql, params });
    const sqliteSql = sql
      .replace(/`[^`]+\.(episodes|song_plays)`/gi, '$1')
      .replace(/EXTRACT\s*\(\s*YEAR\s+FROM\s+([a-zA-Z0-9_.]+)\s*\)/gi, 'CAST(SUBSTR($1, 1, 4) AS INTEGER)')
      .replace(/\bIF\s*\(/gi, 'IIF(')
      .replace(/\bAS\s+STRING\b/gi, 'AS TEXT')
      .replace(/\bAS\s+INT64\b/gi, 'AS INTEGER');
    const bound = Object.fromEntries(
      Object.entries(params || {}).filter(([k]) => new RegExp(`@${k}\\b`).test(sqliteSql)),
    );
    return sqlite.prepare(sqliteSql).all(bound).map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = DATE_COLUMNS.has(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? { value: v } : v;
      }
      return out;
    });
  };
}

function assertSecurityHeaders(res) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers.get(header)).toBe(value);
  }
}

describe('Artist profile Worker routing and 3-runtime parity', () => {
  const originalFetch = globalThis.fetch;
  let d1;
  let server;
  let expressBaseUrl = '';
  let tempDir = '';
  let bqCalls = [];
  let staticRequests = [];

  beforeAll(async () => {
    d1 = createSqliteD1();
    await ensureD1Schema(d1);
    await upsertEpisodesIntoD1(d1, FIXTURE_EPISODES, { batchSize: 100 });

    tempDir = mkdtempSync(path.join(tmpdir(), 'ttc-artist-parity-'));
    writeArtistProfileSnapshots(FIXTURE_EPISODES, tempDir);

    const app = createApp({
      query: createBqSqliteQuery(d1.sqlite, bqCalls),
      project: 'test-proj',
      dataset: 'test_ds',
    });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        expressBaseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    vi.stubGlobal('fetch', async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/')) throw new Error('ECONNREFUSED');
      staticRequests.push(url);
      const fileName = url.match(/\/data\/artist-profiles\/([^/?#]+)$/)?.[1];
      if (fileName) {
        const filePath = path.join(tempDir, 'artist-profiles', fileName);
        if (existsSync(filePath)) {
          return new Response(readFileSync(filePath, 'utf8'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response('Not found', { status: 404 });
    });
  });

  beforeEach(() => {
    resetWorkerRateLimits();
    bqCalls.length = 0;
    staticRequests.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (server) await new Promise((resolve) => server.close(resolve));
    d1?.sqlite?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('routes GET /api/artists/:name/profile on Worker with CORS, security headers, URI decoding, and error states', async () => {
    const callWorker = (apiPath, headers = {}) =>
      worker.fetch(new Request(`https://idleamericana.com${apiPath}`, { headers }), { DB: d1 });

    const coryRes = await callWorker('/api/artists/Cory%20Branan/profile', { Origin: 'https://idleamericana.com' });
    expect(coryRes.status).toBe(200);
    assertSecurityHeaders(coryRes);
    expect(coryRes.headers.get('Vary')).toBe('Origin');
    expect(coryRes.headers.get('Access-Control-Allow-Origin')).toBe('https://idleamericana.com');
    const coryProfile = await coryRes.json();
    expect(coryProfile.artist).toBe('Cory Branan');

    const slashRes = await callWorker('/api/artists/case%2F%20lang%2F%20veirs/profile');
    expect(slashRes.status).toBe(200);
    assertSecurityHeaders(slashRes);
    expect((await slashRes.json()).artist).toBe('case/ lang/ veirs');

    const paddedRes = await callWorker('/api/artists/%20%20cory%20branan%20%20/profile');
    expect(paddedRes.status).toBe(200);
    expect(await paddedRes.json()).toEqual(coryProfile);

    const blankRes = await callWorker('/api/artists/%20%20/profile');
    expect(blankRes.status).toBe(400);
    expect(blankRes.headers.get('content-type')).toMatch(/application\/json/i);
    expect(await blankRes.json()).toEqual({ error: 'Artist name is required' });
    assertSecurityHeaders(blankRes);

    const malformedRes = await callWorker('/api/artists/%E0%A4%A/profile');
    expect(malformedRes.status).toBe(400);
    assertSecurityHeaders(malformedRes);

    const unknownRes = await callWorker('/api/artists/No%20Such%20Artist/profile');
    expect(unknownRes.status).toBe(404);
    assertSecurityHeaders(unknownRes);

    const noDbRes = await worker.fetch(new Request('https://idleamericana.com/api/artists/Cory%20Branan/profile'), {});
    expect(noDbRes.status).toBe(503);
    assertSecurityHeaders(noDbRes);
  });

  it('serves GET /api/artists/:name/profile on Express with parameterized @artistKey and 404 handling', async () => {
    for (const [encoded, expectedKey, raw] of [
      ['Cory%20Branan', 'cory branan', 'Cory Branan'],
      ['%20%20cory%20branan%20%20', 'cory branan', '  cory branan  '],
      ['case%2F%20lang%2F%20veirs', 'case/ lang/ veirs', 'case/ lang/ veirs'],
    ]) {
      bqCalls.length = 0;
      const res = await originalFetch(`${expressBaseUrl}/api/artists/${encoded}/profile`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.artist.toLowerCase()).toBe(expectedKey);
      const keyedCalls = bqCalls.filter((c) => c.sql.includes('@artistKey'));
      expect(keyedCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of keyedCalls) {
        expect(call.params?.artistKey).toBe(expectedKey);
        expect(call.sql).not.toContain(raw);
      }
    }

    bqCalls.length = 0;
    const missingRes = await originalFetch(`${expressBaseUrl}/api/artists/No%20Such%20Artist/profile`);
    expect(missingRes.status).toBe(404);
    expect(bqCalls.some((c) => c.params?.artistKey === 'no such artist')).toBe(true);

    const blankRes = await originalFetch(`${expressBaseUrl}/api/artists/%20%20/profile`);
    expect(blankRes.status).toBe(400);
    expect(blankRes.headers.get('content-type')).toMatch(/application\/json/i);
    expect(await blankRes.json()).toEqual({ error: 'Artist name is required' });

    const malformedRes = await originalFetch(`${expressBaseUrl}/api/artists/%E0%A4%A/profile`);
    expect(malformedRes.status).toBe(400);
    expect(malformedRes.headers.get('content-type')).toMatch(/application\/json/i);
    const malformedBody = await malformedRes.text();
    expect(malformedBody).not.toMatch(/<!DOCTYPE|<html/i);
    expect(JSON.parse(malformedBody)).toEqual({ error: 'Invalid request' });
  });

  it('loads static artist profiles and returns { data: null } on 404 via clientApi.getArtistProfile', async () => {
    const res = await clientApi.getArtistProfile('case/ lang/ veirs');
    expect(res.mode).toBe('static');
    expect(res.source).toBe('static-json');
    expect(res.data?.artist).toBe('case/ lang/ veirs');
    expect(
      staticRequests.some((u) => u.endsWith(`/data/artist-profiles/${encodeArtistProfileKey('case/ lang/ veirs')}.json`)),
    ).toBe(true);

    const missing = await clientApi.getArtistProfile('No Such Artist');
    expect(missing).toEqual({ data: null, source: 'static-json', mode: 'static' });
  });

  it('produces identical profile JSON across D1 Worker, Express/BigQuery, and static getArtistProfile', async () => {
    const byName = {};
    for (const [name, encoded] of [
      ['Cory Branan', 'Cory%20Branan'],
      ['cory branan', 'cory%20branan'],
      ['case/ lang/ veirs', 'case%2F%20lang%2F%20veirs'],
    ]) {
      const workerRes = await worker.fetch(new Request(`https://idleamericana.com/api/artists/${encoded}/profile`), { DB: d1 });
      const expressRes = await originalFetch(`${expressBaseUrl}/api/artists/${encoded}/profile`);
      expect(workerRes.status).toBe(200);
      expect(expressRes.status).toBe(200);

      const workerProfile = await workerRes.json();
      const expressProfile = await expressRes.json();
      const staticRes = await clientApi.getArtistProfile(name);

      expect(expressProfile).toEqual(workerProfile);
      expect(staticRes.data).toEqual(workerProfile);
      byName[name] = workerProfile;
    }

    expect(byName['cory branan']).toEqual(byName['Cory Branan']);
    expect(byName['Cory Branan'].years.map((y) => y.year)).toEqual(Array.from({ length: 14 }, (_, i) => 2013 + i));
    expect(byName['Cory Branan'].rotation).toMatchObject({ openers: 3, closers: 1, doubledUp: 2 });
    expect(byName['Cory Branan'].playedAlongside.map((p) => p.name)).not.toContain('Cory Branan');
  });
});
