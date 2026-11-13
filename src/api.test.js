// Integration smoke tests at the client archive data-access and Express route boundary.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getArtistSongs,
  getArtists,
  getEpisodeById,
  getEpisodes,
  getOverview,
  getSongs,
  resolveApiBase,
  searchAll,
} from './api.js';
import { getStaticPath } from './api-static.js';
import { createApp } from '../server/index.js';

const STATIC_DATA = {
  '/data/overview.json': {
    totalEpisodes: 2,
    totalSongPlays: 4,
    uniqueArtists: 2,
    uniqueAlbums: 2,
    uniqueSongs: 2,
    dateRange: { earliest: '2013-06-23', latest: '2026-08-08' },
    topArtists: [{ name: 'Todd Snider', plays: 3 }],
    topSongs: [{ artist: 'Carrie Rodriguez', song: '50s French Movie', plays: 15 }],
  },
  '/data/artists.json': [
    {
      name: 'Todd Snider',
      totalPlays: 296,
      uniqueSongs: 52,
      uniqueAlbums: 18,
      firstAppearance: '2013-06-23',
      lastAppearance: '2026-08-01',
    },
    {
      name: 'Lucinda Williams',
      totalPlays: 220,
      uniqueSongs: 41,
      uniqueAlbums: 15,
      firstAppearance: '2013-07-07',
      lastAppearance: '2026-08-08',
    },
  ],
  '/data/songs.json': [
    {
      artist: 'Carrie Rodriguez',
      songTitle: '50s French Movie',
      albums: ['She Ain\'t Me'],
      totalPlays: 15,
      firstAppearance: '2014-03-01',
    },
    {
      artist: 'Todd Snider',
      songTitle: 'Alright Guy',
      albums: ['Songs for the Daily Planet'],
      totalPlays: 11,
      firstAppearance: '2013-06-23',
    },
  ],
  '/data/episodes.json': [
    {
      id: 'ep-2',
      title: 'Episode #1317',
      airDate: '2026-08-08',
      dayOfWeek: 'Saturday',
      episodeNumber: 1317,
      url: 'https://example.com/ep-2',
      songCount: 28,
      songs: [{ position: 1, artist: 'Lucinda Williams', songTitle: 'Car Wheels', album: 'Car Wheels', rawLine: '' }],
    },
    {
      id: 'ep-1',
      title: 'Episode #1316',
      airDate: '2026-08-01',
      dayOfWeek: 'Saturday',
      episodeNumber: 1316,
      url: 'https://example.com/ep-1',
      songCount: 24,
      songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Songs for the Daily Planet', rawLine: '' }],
    },
  ],
  '/data/albums.json': [
    { artist: 'Bob Dylan', album: 'Highway 61 Revisited', totalPlays: 18 },
  ],
};

function fakeQuery(sql, params = {}) {
  if (sql.includes('AS total_episodes')) {
    return [{
      total_episodes: 1317,
      total_song_plays: 36902,
      unique_artists: 1891,
      unique_albums: 6340,
      unique_songs: 16782,
      earliest_date: { value: '2013-06-23' },
      latest_date: { value: '2026-08-08' },
    }];
  }
  if (sql.includes('SELECT artist, COUNT(1) AS plays')) {
    if (sql.includes('WHERE LOWER(artist) LIKE')) {
      return [{ name: 'Bob Dylan', plays: 266 }];
    }
    return [{ artist: 'Todd Snider', plays: 296 }];
  }
  if (sql.includes('SELECT artist, song_title, COUNT(1) AS plays')) {
    return [{ artist: 'Carrie Rodriguez', song_title: '50s French Movie', plays: 15 }];
  }
  if (sql.includes('FROM `test-proj.test_ds.episodes`') && sql.includes('WHERE id = @id')) {
    if (params.id !== 'ep-1') return [];
    return [{
      id: 'ep-1',
      title: 'Episode #1316',
      air_date: { value: '2026-08-01' },
      day_of_week: 'Saturday',
      episode_number: 1316,
      published_at: { value: '2026-08-01T12:00:00Z' },
      url: 'https://example.com/ep-1',
      song_count: 24,
    }];
  }
  if (sql.includes('FROM `test-proj.test_ds.song_plays`') && sql.includes('WHERE episode_id = @id')) {
    return [{ position: 1, artist: 'Todd Snider', song_title: 'Alright Guy', album: 'Songs for the Daily Planet', raw_line: 'Todd Snider - Alright Guy' }];
  }
  if (sql.includes('FROM `test-proj.test_ds.episodes`') && sql.includes('ORDER BY e.air_date DESC, e.id DESC')) {
    return [{
      id: 'ep-1',
      air_date: { value: '2026-08-01' },
      url: 'https://example.com/ep-1',
      song_count: 24,
    }];
  }
  if (sql.includes('SELECT COUNT(1) AS total') && sql.includes('FROM `test-proj.test_ds.episodes`')) {
    return [{ total: 1 }];
  }
  if (sql.includes('artist AS name') && sql.includes('COUNT(1) AS total_plays')) {
    return [{
      name: 'Todd Snider',
      total_plays: 296,
      unique_songs: 52,
      unique_albums: 18,
      first_appearance: { value: '2013-06-23' },
      last_appearance: { value: '2026-08-01' },
    }];
  }
  if (sql.includes('COUNT(DISTINCT artist) AS total')) return [{ total: 1 }];
  if (sql.includes('WHERE artist = @artistName') && sql.includes('GROUP BY song_title')) {
    return [{
      song_title: 'Alright Guy',
      album: 'Songs for the Daily Planet',
      total_plays: 11,
      first_played: { value: '2013-06-23' },
      last_played: { value: '2026-08-01' },
    }];
  }
  if (sql.includes('WHERE artist = @artistName') && sql.includes('AS unique_songs')) {
    return [{
      total_plays: 296,
      unique_songs: 52,
      unique_albums: 18,
      first_appearance: { value: '2013-06-23' },
      last_appearance: { value: '2026-08-01' },
    }];
  }
  if (sql.includes('ARRAY_AGG(album') && sql.includes('GROUP BY artist, song_title')) {
    return [{
      artist: 'Carrie Rodriguez',
      song_title: '50s French Movie',
      album: 'She Ain\'t Me',
      total_plays: 15,
      first_played: { value: '2014-03-01' },
      last_played: { value: '2026-07-01' },
    }];
  }
  if (sql.includes('SELECT COUNT(1) AS total FROM (')) return [{ total: 1 }];
  if (sql.includes('WHERE LOWER(artist) LIKE')) return [{ name: 'Bob Dylan', plays: 266 }];
  if (sql.includes('WHERE LOWER(song_title) LIKE')) {
    return [{ artist: 'Bob Dylan', song_title: 'Like a Rolling Stone', album: 'Highway 61 Revisited', plays: 14 }];
  }
  if (sql.includes('WHERE LOWER(album) LIKE')) {
    return [{ artist: 'Bob Dylan', album: 'Highway 61 Revisited', plays: 18 }];
  }
  return [];
}

describe('archive client api + express route seam', () => {
  const originalFetch = globalThis.fetch;
  let server;
  let baseUrl = '';
  let apiMode = 'live';

  beforeAll(async () => {
    const app = createApp({ query: fakeQuery, project: 'test-proj', dataset: 'test_ds' });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    vi.stubGlobal('fetch', async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/')) {
        if (apiMode === 'error') {
          return new Response(JSON.stringify({ error: 'Unavailable' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (apiMode === 'offline') {
          throw new Error('ECONNREFUSED');
        }
        const apiPath = url.slice(url.indexOf('/api/'));
        return originalFetch(`${baseUrl}${apiPath}`, init);
      }

      const dataMatch = url.match(/\/data\/[a-z-]+\.json$/);
      if (dataMatch && STATIC_DATA[dataMatch[0]]) {
        return new Response(JSON.stringify(STATIC_DATA[dataMatch[0]]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
  });

  afterEach(() => {
    apiMode = 'live';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('serves live archive endpoints through Express when API is reachable', async () => {
    const overview = await getOverview();
    expect(overview.source).toBe('express-api');
    expect(overview.data.totalEpisodes).toBe(1317);
    expect(overview.data.topArtists[0]).toEqual({ name: 'Todd Snider', plays: 296 });

    const artists = await getArtists('', 1, 20);
    expect(artists.source).toBe('express-api');
    expect(artists.data.artists[0].name).toBe('Todd Snider');

    const artistSongs = await getArtistSongs('Todd Snider');
    expect(artistSongs.source).toBe('express-api');
    expect(artistSongs.data.summary.totalPlays).toBe(296);
    expect(artistSongs.data.songs[0].songTitle).toBe('Alright Guy');

    const songs = await getSongs('', 1, 20);
    expect(songs.source).toBe('express-api');
    expect(songs.data.songs[0].songTitle).toBe('50s French Movie');

    const episodes = await getEpisodes(1, 20);
    expect(episodes.source).toBe('express-api');
    expect(episodes.data.episodes[0].id).toBe('ep-1');

    const episode = await getEpisodeById('ep-1');
    expect(episode.source).toBe('express-api');
    expect(episode.data.songs[0].songTitle).toBe('Alright Guy');

    const search = await searchAll('dylan');
    expect(search.source).toBe('express-api');
    expect(search.data.artists[0].name).toBe('Bob Dylan');
    expect(search.data.albums[0].album).toBe('Highway 61 Revisited');
  });

  it('falls back transparently to static JSON payloads when API fails or rejects', async () => {
    apiMode = 'offline';
    const overview = await getOverview();
    expect(overview.source).toBe('static-json');
    expect(overview.data.totalEpisodes).toBe(2);

    apiMode = 'error';
    const artists = await getArtists('lucinda', 1, 10);
    expect(artists.source).toBe('static-json');
    expect(artists.data.artists.map((a) => a.name)).toEqual(['Lucinda Williams']);

    const songs = await getSongs('movie', 1, 10);
    expect(songs.source).toBe('static-json');
    expect(songs.data.songs[0].album).toBe("She Ain't Me");

    const episodes = await getEpisodes(1, 1);
    expect(episodes.source).toBe('static-json');
    expect(episodes.data.episodes).toHaveLength(1);
    expect(episodes.data.pagination.totalPages).toBe(2);

    const episode = await getEpisodeById('ep-1');
    expect(episode.source).toBe('static-json');
    expect(episode.data.airDate).toBe('2026-08-01');

    const artistSongs = await getArtistSongs('Todd Snider');
    expect(artistSongs.source).toBe('static-json');
    expect(artistSongs.data.summary.totalPlays).toBe(11);

    const search = await searchAll('dylan');
    expect(search.source).toBe('static-json');
    expect(search.data.albums[0].album).toBe('Highway 61 Revisited');
  });

  it('resolves subpath-aware API bases and static asset paths cleanly', () => {
    expect(resolveApiBase({ isDev: false, baseUrl: '/through-the-cracks/' })).toBe('/through-the-cracks/api');
    expect(resolveApiBase({ isDev: false, baseUrl: '/through-the-cracks' })).toBe('/through-the-cracks/api');
    expect(resolveApiBase({ isDev: false, baseUrl: '/' })).toBe('/api');
    expect(
      resolveApiBase({ explicitApiUrl: 'https://idleamericana.com/through-the-cracks/api/', isDev: false, baseUrl: '/' }),
    ).toBe('https://idleamericana.com/through-the-cracks/api');
    expect(resolveApiBase({ isDev: true, baseUrl: '/through-the-cracks/' })).toBe('http://localhost:3001/api');
    expect(getStaticPath('/data/overview.json', '/through-the-cracks/')).toBe('/through-the-cracks/data/overview.json');
  });
});
