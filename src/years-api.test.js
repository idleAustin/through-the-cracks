// Unit and integration tests for Ticket 05 getYearSpins and getOverview latestEpisodeId/album contracts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getOverview, getYearSpins } from './api.js';
import { createApp } from '../server/index.js';

const YEARS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const ARCHIVE_SPINS = [1376, 2764, 2754, 2810, 2790, 2780, 2800, 2760, 2750, 2770, 2820, 2850, 2830, 1248];
const TODD_SPINS = [2, 10, 8, 14, 9, 8, 25, 13, 14, 14, 28, 77, 68, 6];
const FRENCH_MOVIE_SPINS = [3, 3, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 3];

const STATIC_OVERVIEW = {
  latestEpisodeId: '492815995999333864',
  totalEpisodes: 1317,
  totalSongPlays: 36902,
  uniqueArtists: 1891,
  uniqueAlbums: 6340,
  uniqueSongs: 16782,
  dateRange: { earliest: '2013-06-23', latest: '2026-08-08' },
  topArtists: [{ name: 'Todd Snider', plays: 296 }],
  topSongs: [{ artist: 'Carrie Rodriguez', song: '50s French Movie', album: 'Seven Angels On A Bicycle', plays: 15 }],
};

const STATIC_YEAR_SPINS = {
  years: YEARS,
  archive: ARCHIVE_SPINS,
  artists: { 'Todd Snider': TODD_SPINS },
  songs: { '50s French Movie\tCarrie Rodriguez': FRENCH_MOVIE_SPINS },
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
      latest_episode_id: '492815995999333864',
      one_spin_artists: 980,
      one_spin_songs: 12100,
    }];
  }
  if (sql.includes('SELECT artist, COUNT(1) AS plays')) return [{ artist: 'Todd Snider', plays: 296 }];
  if (sql.includes('SELECT artist, song_title, COUNT(1) AS plays')) {
    return [{ artist: 'Carrie Rodriguez', song_title: '50s French Movie', album: 'Seven Angels On A Bicycle', plays: 15 }];
  }
  if (sql.includes('EXTRACT(YEAR FROM air_date)')) {
    let counts = ARCHIVE_SPINS;
    if (params.song && params.artist) {
      counts = STATIC_YEAR_SPINS.songs[`${params.song}\t${params.artist}`] || Array(14).fill(0);
    } else if (params.artist) {
      counts = STATIC_YEAR_SPINS.artists[params.artist] || Array(14).fill(0);
    }
    return YEARS.map((year, i) => ({ year, spins: counts[i] })).filter((r) => r.spins > 0);
  }
  return [];
}

describe('Ticket 05 getYearSpins & getOverview contracts', () => {
  const originalFetch = globalThis.fetch;
  let server;
  let baseUrl = '';
  let apiMode = 'live';
  let requestedUrls = [];

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
      requestedUrls.push(url);
      if (url.includes('/api/')) {
        if (apiMode === 'offline') throw new Error('ECONNREFUSED');
        return originalFetch(`${baseUrl}${url.slice(url.indexOf('/api/'))}`, init);
      }
      if (url.endsWith('/data/overview.json')) {
        return new Response(JSON.stringify(STATIC_OVERVIEW), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/data/year-spins.json')) {
        return new Response(JSON.stringify(STATIC_YEAR_SPINS), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    });
  });

  afterEach(() => {
    apiMode = 'live';
    requestedUrls = [];
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  for (const mode of ['live', 'static']) {
    it(`resolves archive, artist, song, and zero-filled unknown series in ${mode} mode`, async () => {
      apiMode = mode === 'live' ? 'live' : 'offline';

      const ov = await getOverview();
      expect(ov.mode).toBe(mode);
      expect(ov.data.latestEpisodeId).toBe('492815995999333864');
      expect(ov.data.topSongs[0].album).toBe('Seven Angels On A Bicycle');

      const archive = await getYearSpins();
      expect(archive.mode).toBe(mode);
      expect(archive.data.scope).toBe('archive');
      expect(archive.data.years).toEqual(YEARS);
      expect(archive.data.spins).toEqual(ARCHIVE_SPINS);

      const artist = await getYearSpins({ artist: 'Todd Snider' });
      expect(artist.data.scope).toBe('artist');
      expect(artist.data.spins).toEqual(TODD_SPINS);

      const song = await getYearSpins({ artist: 'Carrie Rodriguez', song: '50s French Movie' });
      expect(song.data.scope).toBe('song');
      expect(song.data.spins).toEqual(FRENCH_MOVIE_SPINS);

      const unknown = await getYearSpins({ artist: 'Unknown Artist', song: 'Missing Track' });
      expect(unknown.data.years).toEqual(YEARS);
      expect(unknown.data.spins).toEqual(Array(14).fill(0));

      if (mode === 'static') {
        expect(requestedUrls.some((u) => u.includes('/data/year-spins.json'))).toBe(true);
        expect(requestedUrls.some((u) => u.includes('/data/episodes.json'))).toBe(false);
      }
    });
  }
});
