// Unit tests for Ticket 05 overview telemetry and annual spin volume HTTP route handlers.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/index.js';

describe('overview and years route handlers (Ticket 05)', () => {
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

  it('GET /api/overview returns latestEpisodeId, one-spin totals, and topSongs album', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('AS total_episodes')) {
        return [{
          total_episodes: 1317,
          total_song_plays: 36902,
          unique_artists: 1891,
          unique_albums: 6340,
          unique_songs: 16782,
          earliest_date: { value: '2013-06-23' },
          latest_date: { value: '2026-08-08' },
          latest_episode_id: 'ep-2026-08-08',
          one_spin_artists: '412',
          one_spin_songs: '7890',
        }];
      }
      if (sql.includes('SELECT artist, COUNT(1) AS plays')) {
        return [{ artist: 'Todd Snider', plays: 296 }];
      }
      return [{
        artist: 'Carrie Rodriguez',
        song_title: '50s French Movie',
        album: "She Ain't Me",
        plays: 15,
      }];
    };

    const res = await fetch(`${baseUrl}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.latestEpisodeId).toBe('ep-2026-08-08');
    expect(body.oneSpinArtists).toBe(412);
    expect(body.oneSpinSongs).toBe(7890);
    expect(body.topSongs[0]).toEqual({
      artist: 'Carrie Rodriguez',
      song: '50s French Movie',
      album: "She Ain't Me",
      plays: 15,
    });

    const statsCall = recordedCalls.find((c) => c.sql.includes('AS total_episodes'));
    expect(statsCall.sql).toContain('AS latest_episode_id');
    expect(statsCall.sql).toContain('AS one_spin_artists');
    expect(statsCall.sql).toContain('AS one_spin_songs');
  });

  it('GET /api/overview defaults new fields safely when stats omit them', async () => {
    await ensureServer();
    queryResponder = async (sql) => {
      if (sql.includes('AS total_episodes')) {
        return [{
          total_episodes: 1,
          total_song_plays: 1,
          unique_artists: 1,
          unique_albums: 1,
          unique_songs: 1,
          earliest_date: '2026-08-08',
          latest_date: '2026-08-08',
        }];
      }
      if (sql.includes('SELECT artist, COUNT(1) AS plays')) return [];
      return [{ artist: 'Artist', song_title: 'Song', plays: 1 }];
    };

    const res = await fetch(`${baseUrl}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latestEpisodeId).toBeNull();
    expect(body.oneSpinArtists).toBe(0);
    expect(body.oneSpinSongs).toBe(0);
    expect(body.topSongs[0].album).toBe('');
  });

  it('GET /api/years zero-fills archive series across 2013..2026', async () => {
    await ensureServer();
    queryResponder = async () => [
      { year: 2013, spins: 1376 },
      { year: 2020, spins: '2908' },
      { year: 2026, spins: 1689 },
    ];

    const res = await fetch(`${baseUrl}/api/years`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      years: [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
      spins: [1376, 0, 0, 0, 0, 0, 0, 2908, 0, 0, 0, 0, 0, 1689],
      scope: 'archive',
      artist: null,
      song: null,
    });
    expect(recordedCalls[0].params).toEqual({});
    expect(recordedCalls[0].sql).not.toContain('WHERE');
  });

  it('GET /api/years filters by parameterized artist and song', async () => {
    await ensureServer();
    queryResponder = async () => [{ year: 2019, spins: 4 }, { year: 2024, spins: 2 }];

    const artistRes = await fetch(`${baseUrl}/api/years?artist=${encodeURIComponent('  Todd Snider ')}`);
    expect(artistRes.status).toBe(200);
    const artistBody = await artistRes.json();
    expect(artistBody.scope).toBe('artist');
    expect(artistBody.artist).toBe('Todd Snider');
    expect(artistBody.song).toBeNull();
    expect(artistBody.spins[6]).toBe(4);
    expect(recordedCalls[0].params).toEqual({ artist: 'Todd Snider' });
    expect(recordedCalls[0].sql).toContain('LOWER(artist) = LOWER(@artist)');
    expect(recordedCalls[0].sql).not.toContain('Todd Snider');

    recordedCalls = [];
    const songRes = await fetch(`${baseUrl}/api/years?artist=Todd%20Snider&song=${encodeURIComponent(" Alright Guy ")}`);
    expect(songRes.status).toBe(200);
    const songBody = await songRes.json();
    expect(songBody.scope).toBe('song');
    expect(songBody.artist).toBe('Todd Snider');
    expect(songBody.song).toBe('Alright Guy');
    expect(recordedCalls[0].params).toEqual({ artist: 'Todd Snider', song: 'Alright Guy' });
    expect(recordedCalls[0].sql).toContain('WHERE LOWER(artist) = LOWER(@artist) AND LOWER(song_title) = LOWER(@song)');
  });
});
