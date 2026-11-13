// Unit tests for Ticket 04 queryUtils helpers and catalog HTTP route handlers.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/index.js';
import {
  computeCappedPagination,
  parseCapParam,
  parseSortParam,
} from '../server/routes/queryUtils.js';

describe('queryUtils Ticket 04 helpers', () => {
  it('parses sort and cap parameters safely', () => {
    expect(parseSortParam('obscure')).toBe('obscure');
    expect(parseSortParam('top')).toBe('top');
    expect(parseSortParam('invalid')).toBe('top');
    expect(parseSortParam(undefined)).toBe('top');

    expect(parseCapParam('10')).toBe(10);
    expect(parseCapParam(25)).toBe(25);
    expect(parseCapParam('50')).toBe(50);
    expect(parseCapParam('100')).toBe(100);
    expect(parseCapParam('all')).toBeNull();
    expect(parseCapParam('200')).toBeNull();
    expect(parseCapParam(undefined)).toBeNull();
  });

  it('computes capped pagination including empty and out-of-range pages', () => {
    expect(computeCappedPagination({ rawTotal: 120, cap: 25, page: 2, limit: 20 })).toEqual({
      total: 25,
      effectiveLimit: 5,
      offset: 20,
      totalPages: 2,
    });
    expect(computeCappedPagination({ rawTotal: 120, cap: 25, page: 3, limit: 20 })).toEqual({
      total: 25,
      effectiveLimit: 0,
      offset: 40,
      totalPages: 2,
    });
    expect(computeCappedPagination({ rawTotal: 0, cap: 50, page: 1, limit: 20 })).toEqual({
      total: 0,
      effectiveLimit: 0,
      offset: 0,
      totalPages: 0,
    });
  });
});

describe('catalog route handlers (Ticket 04)', () => {
  let server;
  let baseUrl = '';
  let recordedCalls = [];
  let queryResponder = async () => [];

  beforeEach(() => {
    recordedCalls = [];
    queryResponder = async () => [];
  });

  async function ensureServer() {
    if (server) return;
    const app = createApp({
      query: async (sql, params = {}) => {
        recordedCalls.push({ sql, params });
        return queryResponder(sql, params);
      },
      project: 'test-proj',
      dataset: 'test_ds',
    });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  }

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('GET /api/artists supports parameterized search, sort=obscure, and cap bounds', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('COUNT(DISTINCT artist)')) return [{ total: 42 }];
      return [{
        name: 'Obscure Folk',
        total_plays: 1,
        unique_songs: 1,
        unique_albums: 1,
        first_appearance: { value: '2014-01-05' },
        last_appearance: { value: '2014-01-05' },
      }];
    };

    const res = await fetch(`${baseUrl}/api/artists?search=${encodeURIComponent(" O'Brien ")}&sort=obscure&cap=25&page=2&limit=20`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.unboundedTotal).toBe(42);
    expect(body.total).toBe(25);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(20);
    expect(body.pagination).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
    expect(body.items).toEqual(body.artists);
    expect(body.items[0].name).toBe('Obscure Folk');

    expect(recordedCalls).toHaveLength(2);
    for (const call of recordedCalls) {
      expect(call.params).toEqual({ searchLike: "%o'brien%" });
      expect(call.sql).toContain('WHERE LOWER(artist) LIKE @searchLike');
      expect(call.sql).not.toContain("o'brien");
    }
    expect(recordedCalls[1].sql).toContain('ORDER BY total_plays ASC, first_appearance ASC, LOWER(artist) ASC');
    expect(recordedCalls[1].sql).toContain('LIMIT 5 OFFSET 20');
  });

  it('GET /api/artists skips listQuery when page exceeds capped total', async () => {
    await ensureServer();
    queryResponder = async () => [{ total: 100 }];

    const res = await fetch(`${baseUrl}/api/artists?cap=10&page=2&limit=20`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      items: [],
      artists: [],
      total: 10,
      unboundedTotal: 100,
      page: 2,
      limit: 20,
      pagination: { page: 2, limit: 20, total: 10, totalPages: 1 },
    });
    expect(recordedCalls).toHaveLength(1);
  });

  it('GET /api/songs searches artist, song_title, and album with sort and cap', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('SELECT COUNT(1) AS total')) return [{ total: 30 }];
      return [{
        artist: 'Bob Dylan',
        song_title: 'Like a Rolling Stone',
        album: 'Highway 61 Revisited',
        total_plays: 14,
        first_played: { value: '2015-02-01' },
        last_played: { value: '2025-11-01' },
      }];
    };

    const res = await fetch(`${baseUrl}/api/songs?search=Highway&sort=top&cap=10&page=1&limit=20`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(10);
    expect(body.unboundedTotal).toBe(30);
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 10, totalPages: 1 });
    expect(body.items).toEqual(body.songs);
    expect(body.items[0].album).toBe('Highway 61 Revisited');

    expect(recordedCalls[0].params).toEqual({ searchLike: '%highway%' });
    expect(recordedCalls[0].sql).toContain('LOWER(artist) LIKE @searchLike OR LOWER(song_title) LIKE @searchLike OR LOWER(album) LIKE @searchLike');
    expect(recordedCalls[1].sql).toContain('ORDER BY total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC');
    expect(recordedCalls[1].sql).toContain('LIMIT 10 OFFSET 0');
  });

  it('GET /api/artists/:name/songs returns top-level albums and per-song albums', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('GROUP BY song_title')) {
        return [{
          song_title: 'Alright Guy',
          album: 'Songs for the Daily Planet',
          albums: ['Songs for the Daily Planet', 'Near Truths'],
          total_plays: 11,
          first_played: { value: '2013-06-23' },
          last_played: { value: '2026-08-01' },
        }];
      }
      if (sql.includes('GROUP BY album')) {
        return [
          { album: 'Songs for the Daily Planet', total_plays: 9 },
          { album: 'Near Truths', total_plays: 2 },
        ];
      }
      return [{
        total_plays: 11,
        unique_songs: 1,
        unique_albums: 2,
        first_appearance: { value: '2013-06-23' },
        last_appearance: { value: '2026-08-01' },
      }];
    };

    const res = await fetch(`${baseUrl}/api/artists/Todd%20Snider/songs`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.albums).toEqual(['Songs for the Daily Planet', 'Near Truths']);
    expect(body.songs[0].albums).toEqual(['Songs for the Daily Planet', 'Near Truths']);
    expect(body.summary.uniqueAlbums).toBe(2);
  });

  it('GET /api/search parameterizes searchLike and includes uniqueSongs on artists', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('AS unique_songs')) {
        return [{ name: 'Bob Dylan', plays: 266, unique_songs: 74 }];
      }
      if (sql.includes('WHERE LOWER(song_title) LIKE')) {
        return [{ artist: 'Bob Dylan', song_title: 'Tangled Up in Blue', album: 'Blood on the Tracks', plays: 12 }];
      }
      return [{ artist: 'Bob Dylan', album: 'Blood on the Tracks', plays: 20 }];
    };

    const res = await fetch(`${baseUrl}/api/search?q=dylan`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.artists).toEqual([{ name: 'Bob Dylan', plays: 266, uniqueSongs: 74 }]);
    for (const call of recordedCalls) {
      expect(call.params).toEqual({ searchLike: '%dylan%' });
    }
  });
});
