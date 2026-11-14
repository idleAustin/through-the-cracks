// Unit and boundary tests for the uncached random Playlist client adapter and static snapshot fallback.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArchiveMode, getRandomPlaylist } from './api.js';
import {
  buildRandomPlaylistParams,
  getRandomPlaylist as getRandomPlaylistDirect,
  resetStaticPlaylistPoolCache,
} from './api-playlist.js';

function makeStaticPool(count = 20) {
  return Array.from({ length: count }, (_, idx) => ({
    songKey: `artist ${idx + 1}|||song ${idx + 1}`,
    artist: idx === 0 ? 'Crosby, Stills & Nash' : `Artist ${idx + 1}`,
    songTitle: `Song ${idx + 1}`,
    album: `Album ${idx + 1}`,
    totalPlays: idx < 5 ? 5 : 1,
    videoId: `vid-${String(idx + 1).padStart(2, '0')}`,
    ytTitle: `Song ${idx + 1}`,
    ytArtist: idx === 0 ? 'Crosby, Stills & Nash' : `Artist ${idx + 1}`,
    durationSeconds: 180 + idx,
    confidenceScore: 95,
    matchTier: 'high',
  }));
}

describe('api-playlist client adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetStaticPlaylistPoolCache();
  });

  it('re-exports getRandomPlaylist from src/api.js', () => {
    expect(getRandomPlaylist).toBe(getRandomPlaylistDirect);
  });

  it('encodes exclude <= 25 comma-joined and repeated excludeArtist preserving internal commas', () => {
    const exclude = Array.from({ length: 30 }, (_, i) => `vid-${i + 1}`);
    const params = buildRandomPlaylistParams({
      count: 10,
      minScore: 85,
      mode: 'favorites',
      onePerArtist: false,
      exclude,
      excludeArtist: ['Crosby, Stills & Nash', 'Todd Snider', 'crosby, stills & nash'],
    });

    expect(params.get('count')).toBe('10');
    expect(params.get('minScore')).toBe('85');
    expect(params.get('mode')).toBe('favorites');
    expect(params.get('onePerArtist')).toBe('false');
    expect(params.get('exclude').split(',')).toHaveLength(25);
    expect(params.getAll('excludeArtist')).toEqual(['Crosby, Stills & Nash', 'Todd Snider']);
  });

  it('bypasses in-flight deduplication and uses cache: no-store on live /api/playlist/random calls', async () => {
    let callNum = 0;
    const fetchSpy = vi.fn(async (url, init) => {
      callNum += 1;
      expect(String(url)).toContain('/api/playlist/random?');
      expect(init?.cache).toBe('no-store');
      return new Response(
        JSON.stringify({
          count: 1,
          poolSize: 99,
          minScore: 85,
          mode: 'all',
          onePerArtist: true,
          songs: [{ songKey: `a|||s${callNum}`, artist: 'Artist', songTitle: `Song ${callNum}`, videoId: `id-${callNum}`, confidenceScore: 95 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const [first, second] = await Promise.all([getRandomPlaylist(), getRandomPlaylist()]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(first.mode).toBe('live');
    expect(second.mode).toBe('live');
    expect(first.data.songs[0].videoId).not.toBe(second.data.songs[0].videoId);
    expect(getArchiveMode()).toBe('live');
  });

  it('falls back cleanly to cached static song-links.json on 503 or SPA HTML without sharing draw outputs', async () => {
    const pool = makeStaticPool(20);
    let staticDownloads = 0;
    const fetchSpy = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/api/playlist/random')) {
        if (staticDownloads === 0) {
          return new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 });
        }
        return new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (target.endsWith('data/song-links.json')) {
        staticDownloads += 1;
        return new Response(JSON.stringify(pool), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const [drawA, drawB] = await Promise.all([
      getRandomPlaylist({ count: 5, excludeArtist: ['Crosby, Stills & Nash'] }),
      getRandomPlaylist({ count: 5, exclude: ['vid-02', 'vid-03'] }),
    ]);

    expect(staticDownloads).toBe(1);
    expect(drawA.mode).toBe('static');
    expect(drawB.mode).toBe('static');
    expect(getArchiveMode()).toBe('static');
    expect(drawA.data.songs).toHaveLength(5);
    expect(drawB.data.songs).toHaveLength(5);
    expect(drawA.data.songs.some((s) => s.artist === 'Crosby, Stills & Nash')).toBe(false);
    expect(drawB.data.songs.some((s) => s.videoId === 'vid-02' || s.videoId === 'vid-03')).toBe(false);

    // Subsequent static fallback reuses cached in-memory pool without re-fetching song-links.json.
    const drawC = await getRandomPlaylist({ count: 5 });
    expect(staticDownloads).toBe(1);
    expect(drawC.data.songs).toHaveLength(5);
  });

  it('surfaces live HTTP 400 validation errors instead of masking them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid playlist mode' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })),
    );

    await expect(getRandomPlaylist({ mode: 'invalid_mode' })).rejects.toThrow('Invalid playlist mode');
  });

  it('aborts superseded live requests without falling back to static song-links.json', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const promise = getRandomPlaylist({ mode: 'favorites', signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('sends repeated comma-safe excludeArtist params and bypasses dedup for concurrent swap calls', async () => {
    const controllers = [];
    const requests = [];
    const resolvers = [];
    const fetchSpy = vi.fn((url, init) => {
      const parsed = new URL(String(url), 'http://127.0.0.1');
      requests.push({ url: parsed, signal: init?.signal, cache: init?.cache });
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const swapCtrlA = new AbortController();
    const swapCtrlB = new AbortController();
    controllers.push(swapCtrlA, swapCtrlB);

    const swapPromiseA = getRandomPlaylist({
      count: 1,
      mode: 'all',
      minScore: 85,
      onePerArtist: true,
      exclude: ['vid-01', 'vid-02'],
      excludeArtist: ['Crosby, Stills & Nash', 'Simon & Garfunkel'],
      signal: swapCtrlA.signal,
    });
    const swapPromiseB = getRandomPlaylist({
      count: 1,
      mode: 'all',
      minScore: 85,
      onePerArtist: true,
      exclude: ['vid-01', 'vid-03'],
      excludeArtist: ['Crosby, Stills & Nash', 'John Prine'],
      signal: swapCtrlB.signal,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(requests[1].signal).toBeInstanceOf(AbortSignal);
    expect(requests[0].signal).not.toBe(requests[1].signal);
    expect(requests[0].cache).toBe('no-store');
    expect(requests[1].cache).toBe('no-store');
    expect(requests[0].url.searchParams.get('count')).toBe('1');
    expect(requests[0].url.searchParams.get('exclude')).toBe('vid-01,vid-02');
    expect(requests[0].url.searchParams.getAll('excludeArtist')).toEqual([
      'Crosby, Stills & Nash',
      'Simon & Garfunkel',
    ]);
    expect(requests[1].url.searchParams.getAll('excludeArtist')).toEqual([
      'Crosby, Stills & Nash',
      'John Prine',
    ]);

    // Resolve swap B before swap A to verify concurrent swap isolation.
    resolvers[1](new Response(
      JSON.stringify({
        count: 1,
        poolSize: 40,
        songs: [{ songKey: 'a|||b', artist: 'Replacement B', songTitle: 'Swap B', videoId: 'rep-b', confidenceScore: 95 }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    resolvers[0](new Response(
      JSON.stringify({
        count: 1,
        poolSize: 40,
        songs: [{ songKey: 'a|||a', artist: 'Replacement A', songTitle: 'Swap A', videoId: 'rep-a', confidenceScore: 98 }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const [resA, resB] = await Promise.all([swapPromiseA, swapPromiseB]);
    expect(resA.data.songs[0].videoId).toBe('rep-a');
    expect(resB.data.songs[0].videoId).toBe('rep-b');
  });

  it('aborts pending static fallback cleanly and enforces diversity/pass-2 fill in staticOnly mode', async () => {
    const sparseStaticPool = [
      ...Array.from({ length: 4 }, (_, i) => ({
        songKey: `jason isbell|||ji${i}`,
        artist: i % 2 === 0 ? '  Jason Isbell  ' : 'jason isbell',
        songTitle: `JI ${i}`,
        totalPlays: 5,
        videoId: `ji-${i}`,
        confidenceScore: 96,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        songKey: `todd snider|||ts${i}`,
        artist: i % 2 === 0 ? 'Todd Snider' : ' TODD SNIDER ',
        songTitle: `TS ${i}`,
        totalPlays: 4,
        videoId: `ts-${i}`,
        confidenceScore: 92,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        songKey: `john prine|||jp${i}`,
        artist: 'John Prine',
        songTitle: `JP ${i}`,
        totalPlays: 3,
        videoId: `jp-${i}`,
        confidenceScore: 90,
      })),
    ];

    let releaseStatic;
    const fetchSpy = vi.fn(() => new Promise((resolve) => {
      releaseStatic = () => resolve(new Response(JSON.stringify(sparseStaticPool), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const abortCtrl = new AbortController();
    const abortedStatic = getRandomPlaylist({ staticOnly: true, signal: abortCtrl.signal });
    abortCtrl.abort();
    releaseStatic();
    await expect(abortedStatic).rejects.toMatchObject({ name: 'AbortError' });

    const staticDraw = await getRandomPlaylist({
      staticOnly: true,
      count: 10,
      mode: 'favorites',
      minScore: 85,
      onePerArtist: true,
    });
    expect(staticDraw.mode).toBe('static');
    expect(staticDraw.data.poolSize).toBe(12);
    expect(staticDraw.data.count).toBe(10);
    expect(new Set(staticDraw.data.songs.slice(0, 3).map((s) => s.artist.trim().toLowerCase())).size).toBe(3);
  });
});
