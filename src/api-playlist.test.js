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
});
