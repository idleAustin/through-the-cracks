// Integration tests for archive mode state, subscription notifications, and dual-failure rejection.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getArchiveMode, getArtists, getEpisodes, getOverview, getSongs, searchAll, subscribeArchiveMode,
} from './api.js';
import { createApp } from '../server/index.js';

const STATIC_DATA = {
  '/data/overview.json': { totalEpisodes: 2, totalSongPlays: 4, uniqueArtists: 2, uniqueAlbums: 1, uniqueSongs: 2, dateRange: { earliest: '2013-06-23', latest: '2026-08-08' }, topArtists: [], topSongs: [] },
  '/data/artists.json': [{ name: 'Todd Snider', totalPlays: 296, uniqueSongs: 52, uniqueAlbums: 18, firstAppearance: '2013-06-23', lastAppearance: '2026-08-01' }],
  '/data/songs.json': [{ artist: 'Todd Snider', songTitle: 'Alright Guy', albums: ['Songs for the Daily Planet'], totalPlays: 11, firstAppearance: '2013-06-23' }],
  '/data/episodes.json': [{ id: 'ep-1', title: 'Episode #1316', airDate: '2026-08-01', dayOfWeek: 'Saturday', episodeNumber: 1316, url: 'https://example.com/ep-1', songCount: 24, songs: [] }],
  '/data/albums.json': [{ artist: 'Bob Dylan', album: 'Highway 61 Revisited', totalPlays: 18 }],
};

function fakeQuery(sql) {
  if (sql.includes('AS total_episodes')) {
    return [{ total_episodes: 1317, total_song_plays: 36902, unique_artists: 1891, unique_albums: 6340, unique_songs: 16782, earliest_date: { value: '2013-06-23' }, latest_date: { value: '2026-08-08' } }];
  }
  if (sql.includes('SELECT artist, COUNT(1) AS plays')) {
    return sql.includes('WHERE LOWER(artist) LIKE') ? [{ name: 'Bob Dylan', plays: 266 }] : [{ artist: 'Todd Snider', plays: 296 }];
  }
  if (sql.includes('SELECT artist, song_title, COUNT(1) AS plays')) return [{ artist: 'Carrie Rodriguez', song_title: '50s French Movie', plays: 15 }];
  if (sql.includes('FROM `test-proj.test_ds.episodes`') && sql.includes('ORDER BY air_date DESC')) {
    return [{ id: 'ep-1', title: 'Episode #1316', air_date: { value: '2026-08-01' }, day_of_week: 'Saturday', episode_number: 1316, published_at: { value: '2026-08-01T12:00:00Z' }, url: 'https://example.com/ep-1', song_count: 24 }];
  }
  if (sql.includes('SELECT COUNT(1) as total FROM `test-proj.test_ds.episodes`')) return [{ total: 1 }];
  if (sql.includes('artist AS name') && sql.includes('COUNT(1) AS total_plays')) {
    return [{ name: 'Todd Snider', total_plays: 296, unique_songs: 52, unique_albums: 18, first_appearance: { value: '2013-06-23' }, last_appearance: { value: '2026-08-01' } }];
  }
  if (sql.includes('COUNT(DISTINCT artist) AS total')) return [{ total: 1 }];
  if (sql.includes('ARRAY_AGG(album') && sql.includes('GROUP BY artist, song_title')) {
    return [{ artist: 'Carrie Rodriguez', song_title: '50s French Movie', album: "She Ain't Me", total_plays: 15, first_played: { value: '2014-03-01' }, last_played: { value: '2026-07-01' } }];
  }
  if (sql.includes('SELECT COUNT(1) AS total FROM (')) return [{ total: 1 }];
  if (sql.includes('WHERE LOWER(artist) LIKE')) return [{ name: 'Bob Dylan', plays: 266 }];
  if (sql.includes('WHERE LOWER(song_title) LIKE')) return [{ artist: 'Bob Dylan', song_title: 'Like a Rolling Stone', album: 'Highway 61 Revisited', plays: 14 }];
  if (sql.includes('WHERE LOWER(album) LIKE')) return [{ artist: 'Bob Dylan', album: 'Highway 61 Revisited', plays: 18 }];
  return [];
}

describe('archive mode state and error recovery', () => {
  const originalFetch = globalThis.fetch;
  let server;
  let baseUrl = '';
  let apiMode = 'live';
  let staticStatus = 200;

  beforeAll(async () => {
    const app = createApp({ query: fakeQuery, project: 'test-proj', dataset: 'test_ds' });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
    vi.stubGlobal('fetch', async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/')) {
        if (apiMode === 'error') return new Response(JSON.stringify({ error: 'Unavailable' }), { status: 500, headers: { 'content-type': 'application/json' } });
        if (apiMode === 'offline') throw new Error('ECONNREFUSED');
        return originalFetch(`${baseUrl}${url.slice(url.indexOf('/api/'))}`, init);
      }
      const dataMatch = url.match(/\/data\/[a-z-]+\.json$/);
      if (staticStatus === 200 && dataMatch && STATIC_DATA[dataMatch[0]]) {
        return new Response(JSON.stringify(STATIC_DATA[dataMatch[0]]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Unavailable', { status: staticStatus === 200 ? 404 : staticStatus });
    });
  });

  afterEach(() => {
    apiMode = 'live';
    staticStatus = 200;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('tags live Express responses with mode "live" and updates getArchiveMode()', async () => {
    const results = await Promise.all([getOverview(), getArtists(), getSongs(), getEpisodes(), searchAll('dylan')]);
    for (const result of results) {
      expect(result.source).toBe('express-api');
      expect(result.mode).toBe('live');
    }
    expect(getArchiveMode()).toBe('live');
  });

  it('tags static fallback responses with mode "static" on network error or HTTP 500', async () => {
    apiMode = 'offline';
    const overview = await getOverview();
    expect(overview.source).toBe('static-json');
    expect(overview.mode).toBe('static');
    expect(getArchiveMode()).toBe('static');

    apiMode = 'error';
    const results = await Promise.all([getArtists('todd'), getSongs('alright'), getEpisodes(), searchAll('dylan')]);
    for (const result of results) {
      expect(result.source).toBe('static-json');
      expect(result.mode).toBe('static');
    }
    expect(getArchiveMode()).toBe('static');
  });

  it('notifies subscribeArchiveMode listeners on mode changes until unsubscribed', async () => {
    await getOverview();
    const listener = vi.fn();
    const unsubscribe = subscribeArchiveMode(listener);

    apiMode = 'offline';
    await getOverview();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith('static');

    apiMode = 'error';
    await getArtists();
    expect(listener).toHaveBeenCalledTimes(1);

    apiMode = 'live';
    await getSongs();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith('live');

    unsubscribe();
    apiMode = 'offline';
    await getOverview();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects all archive loaders when both API and static JSON fail with 404 or 503', async () => {
    for (const [api, status] of [['error', 404], ['offline', 503]]) {
      apiMode = api;
      staticStatus = status;
      await expect(getOverview()).rejects.toThrow();
      await expect(getArtists()).rejects.toThrow();
      await expect(getSongs()).rejects.toThrow();
      await expect(getEpisodes()).rejects.toThrow();
      await expect(searchAll('dylan')).rejects.toThrow();
    }
  });
});
