// Unit tests for Ticket 03 episodes list and detail HTTP route handlers.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/index.js';

describe('episodes route handlers (Ticket 03)', () => {
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
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('lists episodes with dual field names and strips legacy metadata fields', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('SELECT COUNT(1) AS total')) return [{ total: 2 }];
      return [{
        id: '2024-05-11',
        air_date: { value: '2024-05-11' },
        url: '',
        song_count: '22',
      }];
    };

    const res = await fetch(`${baseUrl}/api/episodes?page=1&limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      items: [{
        id: '2024-05-11',
        air_date: '2024-05-11',
        airDate: '2024-05-11',
        song_count: 22,
        songCount: 22,
        url: null,
      }],
      episodes: [{
        id: '2024-05-11',
        air_date: '2024-05-11',
        airDate: '2024-05-11',
        song_count: 22,
        songCount: 22,
        url: null,
      }],
      total: 2,
      page: 1,
      limit: 10,
      pagination: { page: 1, limit: 10, total: 2, totalPages: 1 },
    });

    const listCall = recordedCalls.find((c) => c.sql.includes('ORDER BY e.air_date DESC, e.id DESC'));
    expect(listCall).toBeDefined();
    expect(listCall.sql).toContain('LIMIT 10 OFFSET 0');
    expect(listCall.sql).not.toContain('title');
    expect(listCall.sql).not.toContain('episode_number');
    expect(listCall.sql).not.toContain('day_of_week');
    expect(listCall.sql).not.toContain('published_at');
  });

  it('filters episodes using parameterized year, song, and artist params', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('SELECT COUNT(1) AS total')) return [{ total: 0 }];
      return [];
    };

    const url = `${baseUrl}/api/episodes?year=2024&song=${encodeURIComponent('  Alright Guy ')}&artist=${encodeURIComponent(' Todd Snider ')}&page=2&limit=5`;
    const res = await fetch(url);
    expect(res.status).toBe(200);

    expect(recordedCalls).toHaveLength(2);
    for (const call of recordedCalls) {
      expect(call.params).toEqual({
        year: 2024,
        song: 'alright guy',
        artist: 'todd snider',
      });
      expect(call.sql).toContain('EXTRACT(YEAR FROM e.air_date) = @year');
      expect(call.sql).toContain('e.id IN (SELECT DISTINCT sp.episode_id FROM `test-proj.test_ds.song_plays` sp WHERE LOWER(TRIM(sp.song_title)) = @song AND LOWER(TRIM(sp.artist)) = @artist)');
      expect(call.sql).not.toContain('Alright Guy');
      expect(call.sql).not.toContain('Todd Snider');
      expect(call.sql).not.toContain('2024');
    }

    const listCall = recordedCalls.find((c) => c.sql.includes('LIMIT 5 OFFSET 5'));
    expect(listCall).toBeDefined();
  });

  it('ignores non-4-digit year parameters instead of interpolating or failing', async () => {
    await ensureServer();
    queryResponder = async (sql) => (sql.includes('COUNT(1)') ? [{ total: 0 }] : []);

    const res = await fetch(`${baseUrl}/api/episodes?year=2024;DROP`);
    expect(res.status).toBe(200);
    for (const call of recordedCalls) {
      expect(call.params).toEqual({});
      expect(call.sql).not.toContain('EXTRACT(YEAR');
      expect(call.sql).not.toContain('DROP');
    }
  });

  it('returns episode detail with playlist/songs and strips legacy metadata', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('FROM `test-proj.test_ds.episodes`')) {
        return [{ id: 'ep-1', air_date: { value: '2026-08-01' }, url: null, song_count: 1 }];
      }
      return [{ position: '1', artist: 'Todd Snider', song_title: 'Alright Guy', album: null }];
    };

    const res = await fetch(`${baseUrl}/api/episodes/ep-1`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      id: 'ep-1',
      air_date: '2026-08-01',
      airDate: '2026-08-01',
      song_count: 1,
      songCount: 1,
      url: null,
      playlist: [{
        position: 1,
        song: 'Alright Guy',
        songTitle: 'Alright Guy',
        artist: 'Todd Snider',
        album: '',
      }],
      songs: [{
        position: 1,
        song: 'Alright Guy',
        songTitle: 'Alright Guy',
        artist: 'Todd Snider',
        album: '',
      }],
    });
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('episodeNumber');
    expect(body).not.toHaveProperty('dayOfWeek');
    expect(body).not.toHaveProperty('publishedAt');
    expect(recordedCalls[0].params).toEqual({ id: 'ep-1' });
    expect(recordedCalls[1].params).toEqual({ id: 'ep-1' });
    expect(recordedCalls[1].sql).not.toContain('raw_line');
  });

  it('returns 404 when episode id is not found', async () => {
    await ensureServer();
    const res = await fetch(`${baseUrl}/api/episodes/missing-ep`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Episode not found' });
    expect(recordedCalls).toHaveLength(1);
  });
});
