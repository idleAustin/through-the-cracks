// Unit and integration tests for Ticket 04 artists/songs sort, cap, search, and artist-songs catalog contracts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getArtistSongs, getArtists, getSongs } from './api.js';
import { getStaticSearchAll, getStaticSongs } from './api-catalog.js';
import { createApp } from '../server/index.js';

const EXTRA_ARTISTS = Array.from({ length: 6 }, (_, i) => ({
  name: `Extra Artist ${i + 1}`,
  totalPlays: 20 - i,
  uniqueSongs: 2,
  uniqueAlbums: 1,
  firstAppearance: '2018-01-01',
  lastAppearance: '2024-01-01',
}));

const ARTISTS_FIXTURE = [
  { name: 'Todd Snider', totalPlays: 296, uniqueSongs: 195, uniqueAlbums: 70, firstAppearance: '2013-09-15', lastAppearance: '2026-07-29' },
  { name: 'Lucinda Williams', totalPlays: 220, uniqueSongs: 41, uniqueAlbums: 15, firstAppearance: '2013-07-07', lastAppearance: '2026-08-08' },
  { name: 'Bob Dylan', totalPlays: 220, uniqueSongs: 60, uniqueAlbums: 25, firstAppearance: '2013-06-23', lastAppearance: '2026-07-01' },
  ...EXTRA_ARTISTS,
  { name: 'Adam Later', totalPlays: 1, uniqueSongs: 1, uniqueAlbums: 1, firstAppearance: '2016-05-22', lastAppearance: '2016-05-22' },
  { name: 'Zed Early', totalPlays: 1, uniqueSongs: 1, uniqueAlbums: 1, firstAppearance: '2014-01-05', lastAppearance: '2014-01-05' },
  { name: 'Alpha SameDate', totalPlays: 1, uniqueSongs: 1, uniqueAlbums: 1, firstAppearance: '2014-01-05', lastAppearance: '2014-01-05' },
];

const EXTRA_SONGS = Array.from({ length: 6 }, (_, i) => ({
  artist: 'Session Band',
  songTitle: `Filler Track ${i + 1}`,
  album: 'Filler LP',
  albums: ['Filler LP'],
  totalPlays: 8 - i,
  firstAppearance: '2019-03-01',
  lastAppearance: '2024-03-01',
}));

const SONGS_FIXTURE = [
  { artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Songs for the Daily Planet', albums: ['Songs for the Daily Planet', 'Near Truths and Hotel Rooms'], totalPlays: 15, firstAppearance: '2013-09-15', lastAppearance: '2026-07-29' },
  { artist: 'Todd Snider', songTitle: 'Beer Run', album: 'New Connection', albums: ['New Connection'], featuredArtists: ['Jason Isbell'], totalPlays: 10, firstAppearance: '2014-02-01', lastAppearance: '2025-05-10' },
  { artist: 'William Lee Ellis', songTitle: 'Rider On Your Soul', album: 'Conqueroo', albums: ['Conqueroo', 'Live On TTC'], featuredArtists: ['Larry Nager'], totalPlays: 11, firstAppearance: '2013-10-02', lastAppearance: '2026-09-26' },
  { artist: 'Carrie Rodriguez', songTitle: '50s French Movie', album: 'Seven Angels On A Bicycle', albums: ['Seven Angels On A Bicycle', 'Live In Louisville'], totalPlays: 10, firstAppearance: '2013-08-28', lastAppearance: '2026-07-18' },
  ...EXTRA_SONGS,
  { artist: 'Artist C', songTitle: 'Later Track', album: 'Modern Wax', albums: ['Modern Wax'], totalPlays: 1, firstAppearance: '2020-01-10', lastAppearance: '2020-01-10' },
  { artist: 'Artist B', songTitle: 'Early Track', album: 'Rare Vault', albums: ['Rare Vault'], totalPlays: 1, firstAppearance: '2013-07-01', lastAppearance: '2013-07-01' },
  { artist: 'Artist A', songTitle: 'Aardvark Blues', album: 'Dusty Tape', albums: ['Dusty Tape'], totalPlays: 1, firstAppearance: '2013-07-01', lastAppearance: '2013-07-01' },
];

function extractSearch(sql, params) {
  if (params.searchLike) return String(params.searchLike).replace(/^%|%$/g, '').toLowerCase();
  if (params.search) return String(params.search).toLowerCase();
  const m = sql.match(/LIKE\s+'%([^%']+)%'/i);
  return m ? m[1].toLowerCase() : '';
}

function sliceSql(sql, items) {
  const pageMatch = sql.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i);
  const limit = Number(pageMatch?.[1] ?? 25);
  const offset = Number(pageMatch?.[2] ?? 0);
  return items.slice(offset, offset + limit);
}

function fakeQuery(sql, params = {}) {
  if (sql.includes('WHERE artist = @artistName')) {
    const artistSongs = SONGS_FIXTURE.filter((s) => s.artist === params.artistName);
    if (sql.includes('AS unique_songs')) {
      const albums = new Set(artistSongs.flatMap((s) => s.albums));
      return [{
        total_plays: artistSongs.reduce((sum, s) => sum + s.totalPlays, 0),
        unique_songs: artistSongs.length,
        unique_albums: albums.size,
        first_appearance: { value: '2013-09-15' },
        last_appearance: { value: '2026-07-29' },
      }];
    }
    if (sql.includes('AS album') && !sql.includes('GROUP BY song_title')) {
      return [...new Set(artistSongs.flatMap((s) => s.albums))].sort().map((album) => ({ album, total_plays: 1 }));
    }
    return artistSongs.map((s) => ({
      song_title: s.songTitle,
      album: s.album,
      albums: s.albums,
      total_plays: s.totalPlays,
      first_played: { value: s.firstAppearance },
      last_played: { value: s.lastAppearance },
    }));
  }

  const q = extractSearch(sql, params);
  const isObscure = /total_plays\s+ASC/i.test(sql);

  if (sql.includes('GROUP BY artist, song_title')) {
    const filtered = SONGS_FIXTURE.filter((s) =>
      !q || s.songTitle.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q) || s.albums.some((a) => a.toLowerCase().includes(q)),
    ).sort((a, b) => isObscure
      ? a.totalPlays - b.totalPlays || a.firstAppearance.localeCompare(b.firstAppearance) || a.songTitle.localeCompare(b.songTitle)
      : b.totalPlays - a.totalPlays || a.songTitle.localeCompare(b.songTitle));
    if (/COUNT\(/i.test(sql) && !/ARRAY_AGG/i.test(sql)) return [{ total: filtered.length }];
    return sliceSql(sql, filtered).map((s) => ({
      artist: s.artist,
      song_title: s.songTitle,
      album: s.album,
      total_plays: s.totalPlays,
      first_played: { value: s.firstAppearance },
      last_played: { value: s.lastAppearance },
    }));
  }

  if (sql.includes('COUNT(DISTINCT artist)')) {
    return [{ total: ARTISTS_FIXTURE.filter((a) => !q || a.name.toLowerCase().includes(q)).length }];
  }
  if (sql.includes('GROUP BY artist')) {
    const filtered = ARTISTS_FIXTURE.filter((a) => !q || a.name.toLowerCase().includes(q))
      .sort((a, b) => isObscure
        ? a.totalPlays - b.totalPlays || a.firstAppearance.localeCompare(b.firstAppearance) || a.name.localeCompare(b.name)
        : b.totalPlays - a.totalPlays || a.name.localeCompare(b.name));
    return sliceSql(sql, filtered).map((a) => ({
      name: a.name,
      total_plays: a.totalPlays,
      unique_songs: a.uniqueSongs,
      unique_albums: a.uniqueAlbums,
      first_appearance: { value: a.firstAppearance },
      last_appearance: { value: a.lastAppearance },
    }));
  }
  return [];
}

describe('Ticket 04 catalog sort, cap, album search, and artist-songs contracts', () => {
  const originalFetch = globalThis.fetch;
  let server;
  let baseUrl = '';
  let apiMode = 'live';

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
        if (apiMode === 'offline') throw new Error('ECONNREFUSED');
        return originalFetch(`${baseUrl}${url.slice(url.indexOf('/api/'))}`, init);
      }
      if (url.endsWith('/data/artists.json')) {
        return new Response(JSON.stringify(ARTISTS_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/data/songs.json')) {
        return new Response(JSON.stringify(SONGS_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/data/albums.json')) {
        return new Response(JSON.stringify([{ artist: 'Todd Snider', album: 'New Connection', totalPlays: 10 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
  });

  afterEach(() => { apiMode = 'live'; });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  for (const mode of ['live', 'static']) {
    it(`orders top/obscure with tie-breakers, bounds cap before pagination, and exposes albums in ${mode} mode`, async () => {
      apiMode = mode === 'live' ? 'live' : 'offline';

      const topArtists = await getArtists({ sort: 'top', cap: 'all', page: 1, limit: 12 });
      expect(topArtists.mode).toBe(mode);
      expect(topArtists.data.pagination.total).toBe(12);
      expect(topArtists.data.artists.map((a) => a.name).slice(0, 3)).toEqual(['Todd Snider', 'Bob Dylan', 'Lucinda Williams']);

      const obscureArtists = await getArtists({ sort: 'obscure', cap: 'all', page: 1, limit: 12 });
      expect(obscureArtists.data.artists.map((a) => a.name).slice(0, 3)).toEqual(['Alpha SameDate', 'Zed Early', 'Adam Later']);

      const cappedPage1 = await getArtists({ sort: 'top', cap: 10, page: 1, limit: 4 });
      expect(cappedPage1.data.pagination).toMatchObject({ page: 1, limit: 4, total: 10, totalPages: 3 });
      expect(cappedPage1.data.artists).toHaveLength(4);

      const cappedPage3 = await getArtists({ sort: 'top', cap: 10, page: 3, limit: 4 });
      expect(cappedPage3.data.artists).toHaveLength(2);
      const cappedPage4 = await getArtists({ sort: 'top', cap: 10, page: 4, limit: 4 });
      expect(cappedPage4.data.artists).toEqual([]);

      const obscureSongs = await getSongs({ sort: 'obscure', cap: 'all', page: 1, limit: 12 });
      expect(obscureSongs.data.songs.map((s) => s.songTitle).slice(0, 3)).toEqual(['Aardvark Blues', 'Early Track', 'Later Track']);

      const cappedSongs = await getSongs({ sort: 'top', cap: 10, page: 1, limit: 4 });
      expect(cappedSongs.data.pagination).toMatchObject({ page: 1, limit: 4, total: 10, totalPages: 3 });

      expect((await getSongs({ search: 'Beer Run', page: 1, limit: 10 })).data.songs.map((s) => s.songTitle)).toEqual(['Beer Run']);
      expect((await getSongs({ search: 'Carrie Rodriguez', page: 1, limit: 10 })).data.songs.map((s) => s.songTitle)).toEqual(['50s French Movie']);
      expect((await getSongs({ search: 'Louisville', page: 1, limit: 10 })).data.songs.map((s) => s.songTitle)).toEqual(['50s French Movie']);

      const inspector = await getArtistSongs('Todd Snider');
      expect(inspector.mode).toBe(mode);
      expect(inspector.data.albums).toEqual(expect.arrayContaining(['Near Truths and Hotel Rooms', 'New Connection', 'Songs for the Daily Planet']));
      expect(inspector.data.songs[0].albums ?? [inspector.data.songs[0].album]).toContain('Songs for the Daily Planet');
    });
  }

  it('getStaticSongs and getStaticSearchAll match featuredArtists in static mode', async () => {
    const songRes = await getStaticSongs({ search: 'isbell', sort: 'top', cap: null, page: 1, limit: 10 });
    expect(songRes.songs).toHaveLength(1);
    expect(songRes.songs[0]).toMatchObject({ artist: 'Todd Snider', songTitle: 'Beer Run', album: 'New Connection' });

    const searchRes = await getStaticSearchAll('isbell');
    expect(searchRes.artists).toEqual([]);
    expect(searchRes.albums).toEqual([]);
    expect(searchRes.songs).toEqual([
      { artist: 'Todd Snider', songTitle: 'Beer Run', album: 'New Connection', plays: 10 },
    ]);

    const larrySongs = await getStaticSongs({ search: 'larry nager', sort: 'top', cap: null, page: 1, limit: 10 });
    expect(larrySongs.songs[0]).toMatchObject({ artist: 'William Lee Ellis', songTitle: 'Rider On Your Soul', totalPlays: 11 });
    expect((await getStaticSearchAll('larry nager')).songs[0]).toMatchObject({
      artist: 'William Lee Ellis', songTitle: 'Rider On Your Soul', plays: 11,
    });
  });
});
