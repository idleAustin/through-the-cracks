// Unit and integration tests for Ticket 03 episodes filtering, pagination, stripped metadata, and sharded static snapshots.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEpisodeById, getEpisodes } from './api.js';
import { createApp } from '../server/index.js';

const EPISODES_FIXTURE = [
  {
    id: 'ep-2026-08-08',
    airDate: '2026-08-08',
    songCount: 27,
    url: 'https://wevl.org/2026-08-08',
    songs: [
      { position: 1, artist: 'Jonathan Byrd', song: 'Prairie Girl', songTitle: 'Prairie Girl', album: 'The Law & The Lonesome' },
      { position: 2, artist: 'Todd Snider', song: 'Alright Guy', songTitle: 'Alright Guy', album: 'Songs for the Daily Planet' },
    ],
  },
  {
    id: 'ep-2026-08-01',
    airDate: '2026-08-01',
    songCount: 24,
    url: null,
    songs: [{ position: 1, artist: 'Lucinda Williams', song: 'Car Wheels', songTitle: 'Car Wheels', album: 'Car Wheels' }],
  },
  {
    id: 'ep-2025-12-20',
    airDate: '2025-12-20',
    songCount: 22,
    url: 'https://wevl.org/2025-12-20',
    songs: [{ position: 1, artist: 'Jonathan Byrd', song: 'Prairie Girl', songTitle: 'Prairie Girl', album: 'The Law & The Lonesome' }],
  },
];

const STATIC_SNAPSHOTS = {
  '/data/episodes-index.json': {
    episodes: EPISODES_FIXTURE.map(({ id, airDate, songCount, url }) => ({ id, air_date: airDate, song_count: songCount, url })),
    songEpisodes: {
      'prairie girl\tjonathan byrd': ['ep-2026-08-08', 'ep-2025-12-20'],
      'alright guy\ttodd snider': ['ep-2026-08-08'],
      'car wheels\tlucinda williams': ['ep-2026-08-01'],
    },
  },
  '/data/playlists/2026.json': {
    'ep-2026-08-08': EPISODES_FIXTURE[0].songs,
    'ep-2026-08-01': EPISODES_FIXTURE[1].songs,
  },
  '/data/playlists/2025.json': { 'ep-2025-12-20': EPISODES_FIXTURE[2].songs },
};

function fakeQuery(sql, params = {}) {
  if (sql.includes('WHERE id = @id')) {
    const match = EPISODES_FIXTURE.find((ep) => ep.id === params.id);
    return match ? [{ id: match.id, air_date: { value: match.airDate }, url: match.url, song_count: match.songCount }] : [];
  }
  if (sql.includes('WHERE episode_id = @id')) {
    const match = EPISODES_FIXTURE.find((ep) => ep.id === params.id);
    return (match?.songs || []).map((s) => ({ position: s.position, artist: s.artist, song_title: s.songTitle, album: s.album, raw_line: '' }));
  }

  let filtered = [...EPISODES_FIXTURE].sort((a, b) => b.airDate.localeCompare(a.airDate));
  if (params.year) filtered = filtered.filter((ep) => ep.airDate.startsWith(String(params.year)));
  if (params.song) {
    const songQ = String(params.song).toLowerCase();
    const artistQ = params.artist ? String(params.artist).toLowerCase() : null;
    filtered = filtered.filter((ep) =>
      ep.songs.some((s) => s.songTitle.toLowerCase() === songQ && (!artistQ || s.artist.toLowerCase() === artistQ)),
    );
  } else if (params.artist) {
    const artistQ = String(params.artist).toLowerCase();
    filtered = filtered.filter((ep) => ep.songs.some((s) => s.artist.toLowerCase() === artistQ));
  }
  if (/COUNT\(/i.test(sql)) return [{ total: filtered.length }];

  const limitMatch = sql.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i);
  const limit = Number(params.limit ?? limitMatch?.[1] ?? 20);
  const offset = Number(params.offset ?? limitMatch?.[2] ?? 0);
  return filtered.slice(offset, offset + limit).map((ep) => ({
    id: ep.id,
    air_date: { value: ep.airDate },
    url: ep.url,
    song_count: ep.songCount,
  }));
}

function assertStrippedEpisode(ep) {
  expect(ep).not.toHaveProperty('title');
  expect(ep).not.toHaveProperty('episodeNumber');
  expect(ep).not.toHaveProperty('episode_number');
  expect(ep.airDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof ep.songCount).toBe('number');
}

describe('Ticket 03 episodes API + sharded static snapshot contract', () => {
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
      const match = url.match(/\/data\/(?:playlists\/\d{4}|episodes-index)\.json$/);
      if (match && STATIC_SNAPSHOTS[match[0]]) {
        return new Response(JSON.stringify(STATIC_SNAPSHOTS[match[0]]), { status: 200, headers: { 'content-type': 'application/json' } });
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
    it(`filters by year, song + artist, paginates newest-first, and strips title/episodeNumber in ${mode} mode`, async () => {
      apiMode = mode === 'live' ? 'live' : 'offline';

      const allRes = await getEpisodes({ page: 1, limit: 2 });
      expect(allRes.mode).toBe(mode);
      expect(allRes.data.episodes.map((e) => e.airDate)).toEqual(['2026-08-08', '2026-08-01']);
      expect(allRes.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      allRes.data.episodes.forEach(assertStrippedEpisode);

      const page2 = await getEpisodes({ page: 2, limit: 2 });
      expect(page2.data.episodes.map((e) => e.id)).toEqual(['ep-2025-12-20']);

      const byYear = await getEpisodes({ year: '2026', page: 1, limit: 20 });
      expect(byYear.data.episodes.map((e) => e.id)).toEqual(['ep-2026-08-08', 'ep-2026-08-01']);
      expect(byYear.data.pagination.total).toBe(2);

      const bySong = await getEpisodes({ song: 'Prairie Girl', artist: 'Jonathan Byrd', page: 1, limit: 20 });
      expect(bySong.data.episodes.map((e) => e.id)).toEqual(['ep-2026-08-08', 'ep-2025-12-20']);
      expect(bySong.data.pagination.total).toBe(2);

      const byYearAndSong = await getEpisodes({ year: '2025', song: 'Prairie Girl', artist: 'Jonathan Byrd', page: 1, limit: 20 });
      expect(byYearAndSong.data.episodes.map((e) => e.id)).toEqual(['ep-2025-12-20']);
      expect(byYearAndSong.data.pagination.total).toBe(1);

      const detail = await getEpisodeById('ep-2026-08-08');
      expect(detail.mode).toBe(mode);
      assertStrippedEpisode(detail.data);
      const tracks = detail.data.songs ?? detail.data.playlist;
      expect(tracks[0]).toMatchObject({ position: 1, artist: 'Jonathan Byrd', songTitle: 'Prairie Girl' });

      if (mode === 'static') {
        expect(requestedUrls.some((u) => u.includes('/data/episodes-index.json'))).toBe(true);
        expect(requestedUrls.some((u) => u.includes('/data/playlists/2026.json'))).toBe(true);
        expect(requestedUrls.some((u) => u.includes('/data/episodes.json'))).toBe(false);
      }
    });
  }
});
