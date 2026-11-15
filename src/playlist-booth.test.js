// Unit tests for Broadcast Booth filter URL parsing, swap exclusion builders, queue exports, and artist-diversity draws.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawRandomPlaylist } from '../server/playlistBuilder.js';
import {
  DEFAULT_PLAYLIST_FILTERS,
  applyPlaylistFiltersToSearchParams,
  areDefaultPlaylistFilters,
  buildSwapExcludeArtists,
  buildSwapExcludeIds,
  buildYouTubeQueueUrl,
  copyTextToClipboard,
  formatPlaylistText,
  isValidVideoId,
  parsePlaylistFilters,
} from './utils/playlist-helpers.js';

describe('playlist-helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses filter URL params with safe defaults and normalizes invalid values', () => {
    expect(parsePlaylistFilters(new URLSearchParams())).toEqual({
      mode: 'all',
      minScore: 85,
      onePerArtist: true,
    });
    expect(parsePlaylistFilters('?mode=favorites&minScore=65&onePerArtist=false')).toEqual({
      mode: 'favorites',
      minScore: 65,
      onePerArtist: false,
    });
    expect(parsePlaylistFilters('?mode=deep_cuts&onePerArtist=0')).toEqual({
      mode: 'deep_cuts',
      minScore: 85,
      onePerArtist: false,
    });
    expect(parsePlaylistFilters('?mode=bogus&minScore=40')).toEqual({
      mode: 'all',
      minScore: 85,
      onePerArtist: true,
    });
    expect(parsePlaylistFilters('?mode=favorites&minScore=85&onePerArtist=FALSE')).toEqual({
      mode: 'favorites',
      minScore: 85,
      onePerArtist: false,
    });
    expect(parsePlaylistFilters('?mode=deep_cuts&minScore=999&onePerArtist=yes')).toEqual({
      mode: 'deep_cuts',
      minScore: 85,
      onePerArtist: true,
    });
  });

  it('serializes non-default filter params and clears defaults back to clean URL params', () => {
    const custom = applyPlaylistFiltersToSearchParams(new URLSearchParams('extra=keep'), {
      mode: 'favorites',
      minScore: 65,
      onePerArtist: false,
    });
    expect(custom.toString()).toBe('extra=keep&mode=favorites&minScore=65&onePerArtist=false');
    expect(areDefaultPlaylistFilters({ mode: 'favorites', minScore: 65, onePerArtist: false })).toBe(false);

    const reset = applyPlaylistFiltersToSearchParams(custom, DEFAULT_PLAYLIST_FILTERS);
    expect(reset.toString()).toBe('extra=keep');
    expect(areDefaultPlaylistFilters(DEFAULT_PLAYLIST_FILTERS)).toBe(true);
    expect(areDefaultPlaylistFilters({ mode: 'all', minScore: 65, onePerArtist: true })).toBe(false);
    expect(areDefaultPlaylistFilters({ mode: 'all', minScore: 85, onePerArtist: false })).toBe(false);
  });

  it('builds up to 25 swap-excluded videoIds and comma-safe artist exclusions respecting onePerArtist', () => {
    const queue = Array.from({ length: 10 }, (_, idx) => ({
      videoId: `vid-${idx + 1}`,
      artist: idx === 0 ? 'Crosby, Stills & Nash' : idx === 1 ? '  Jason Isbell  ' : `Artist ${idx + 1}`,
    }));

    const excludeIds = buildSwapExcludeIds(
      queue,
      2,
      ['vid-1', 'vid-3', '', ...Array.from({ length: 22 }, (_, idx) => `extra-${idx + 1}`)],
    );
    expect(excludeIds).toHaveLength(25);
    expect(excludeIds[0]).toBe('vid-3');
    expect(excludeIds).toContain('vid-1');
    expect(excludeIds).toContain('vid-10');
    expect(new Set(excludeIds).size).toBe(25);

    const dupArtistsQueue = [
      ...queue,
      { videoId: 'vid-11', artist: 'jason isbell' },
      ...Array.from({ length: 20 }, (_, idx) => ({ videoId: `vid-ex-${idx}`, artist: `Extra Artist ${idx}` })),
    ];
    const cappedArtists = buildSwapExcludeArtists(dupArtistsQueue, 1, true);
    expect(cappedArtists).toHaveLength(25);
    expect(cappedArtists).toContain('Crosby, Stills & Nash');
    expect(cappedArtists.filter((a) => a.toLowerCase() === 'jason isbell')).toHaveLength(1);

    const smallExcludeArtists = buildSwapExcludeArtists(queue, 0, true);
    expect(smallExcludeArtists).toHaveLength(10);
    expect(smallExcludeArtists[smallExcludeArtists.length - 1]).toBe('Crosby, Stills & Nash');
    expect(buildSwapExcludeArtists(queue, 0, false)).toEqual([]);
  });

  it('validates YouTube videoIds with a strict allowlist and filters invalid IDs out of queue URLs', () => {
    expect(isValidVideoId('aYdxQ05nOSo')).toBe(true);
    expect(isValidVideoId('  vid_01-AB  ')).toBe(true);
    expect(isValidVideoId('a'.repeat(64))).toBe(true);

    expect(isValidVideoId('')).toBe(false);
    expect(isValidVideoId('   ')).toBe(false);
    expect(isValidVideoId(null)).toBe(false);
    expect(isValidVideoId(12345)).toBe(false);
    expect(isValidVideoId('a'.repeat(65))).toBe(false);
    expect(isValidVideoId('bad/id?list=evil')).toBe(false);
    expect(isValidVideoId('abc&autoplay=1')).toBe(false);
    expect(isValidVideoId('javascript:alert(1)')).toBe(false);

    expect(buildYouTubeQueueUrl([
      { videoId: '  abc123  ', artist: 'John Prine', songTitle: 'Sam Stone' },
      { videoId: 'bad/id?x=1', artist: 'Bad', songTitle: 'Injected' },
      { videoId: '', artist: 'Empty', songTitle: 'Blank' },
      { videoId: 'def_456-7', artist: 'Todd Snider', songTitle: 'Alright Guy' },
    ])).toBe('https://www.youtube.com/watch_videos?video_ids=abc123,def_456-7');
    expect(buildYouTubeQueueUrl([{ videoId: '../bad' }])).toBe('');
  });

  it('formats YouTube queue export URLs, plain-text copy output, and handles clipboard fallbacks', async () => {
    const queue = [
      { videoId: 'abc123', artist: 'John Prine', songTitle: 'Angel from Montgomery' },
      { videoId: 'def456', artist: 'Crosby, Stills & Nash', songTitle: 'Suite: Judy Blue Eyes' },
    ];

    expect(buildYouTubeQueueUrl([])).toBe('');
    expect(buildYouTubeQueueUrl([{ artist: 'No Id', songTitle: 'Missing' }])).toBe('');
    expect(buildYouTubeQueueUrl(queue)).toBe('https://www.youtube.com/watch_videos?video_ids=abc123,def456');
    expect(formatPlaylistText([])).toBe('');
    expect(formatPlaylistText(queue)).toBe(
      '1. John Prine — Angel from Montgomery\n2. Crosby, Stills & Nash — Suite: Judy Blue Eyes',
    );

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyTextToClipboard(formatPlaylistText(queue))).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(await copyTextToClipboard('')).toBe(false);

    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    expect(await copyTextToClipboard('hello')).toBe(false);

    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const select = vi.fn();
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      body: { appendChild, removeChild },
      createElement: () => ({ value: '', style: {}, setAttribute: vi.fn(), select }),
      execCommand,
    });
    expect(await copyTextToClipboard('1. John Prine — Angel from Montgomery')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(select).toHaveBeenCalledTimes(1);
  });
});

function makeEligibleSong(videoId, artist, songTitle, totalPlays = 4, confidenceScore = 95) {
  return {
    song_key: `${artist.trim().toLowerCase()}|||${songTitle.toLowerCase()}`,
    artist,
    song_title: songTitle,
    album: 'Archive LP',
    total_plays: totalPlays,
    video_id: videoId,
    confidence_score: confidenceScore,
    is_embeddable: 1,
    us_playable: 1,
  };
}

describe('drawRandomPlaylist artist diversity and second-pass fill', () => {
  it('enforces LOWER(TRIM(artist)) diversity for whitespace and case variants', () => {
    const pool = [
      makeEligibleSong('ji-1', '  Jason Isbell  ', 'Cover Me Up'),
      makeEligibleSong('ji-2', 'jason isbell', '24 Frames'),
      makeEligibleSong('ji-3', 'JASON ISBELL', 'If We Were Vampires'),
      ...Array.from({ length: 9 }, (_, idx) => (
        makeEligibleSong(`other-${idx + 1}`, `Distinct Artist ${idx + 1}`, `Song ${idx + 1}`)
      )),
    ];

    const diverseDraw = drawRandomPlaylist(pool, { count: 10, onePerArtist: true });
    expect(diverseDraw.poolSize).toBe(12);
    expect(diverseDraw.count).toBe(10);
    expect(new Set(diverseDraw.songs.map((s) => s.videoId)).size).toBe(10);
    expect(diverseDraw.songs.filter((s) => s.artist.trim().toLowerCase() === 'jason isbell')).toHaveLength(1);
    expect(new Set(diverseDraw.songs.map((s) => s.artist.trim().toLowerCase())).size).toBe(10);

    const repeatAllowedDraw = drawRandomPlaylist(pool, { count: 12, onePerArtist: false });
    expect(repeatAllowedDraw.count).toBe(12);
    expect(repeatAllowedDraw.songs.filter((s) => s.artist.trim().toLowerCase() === 'jason isbell')).toHaveLength(3);

    const excludedDraw = drawRandomPlaylist(pool, { count: 9, excludeArtist: ['  jason isbell  '] });
    expect(excludedDraw.poolSize).toBe(12);
    expect(excludedDraw.count).toBe(9);
    expect(excludedDraw.songs.some((s) => s.artist.trim().toLowerCase() === 'jason isbell')).toBe(false);

    // When non-excluded distinct artists < count, pass 2 still fills to count using available videoIds.
    const pass2Excluded = drawRandomPlaylist(pool, { count: 10, excludeArtist: ['  jason isbell  '] });
    expect(pass2Excluded.count).toBe(10);
  });

  it('gracefully fills to count via second pass when filtered pool has fewer distinct artists than count', () => {
    const pool = [
      makeEligibleSong('fav-ji-1', '  Jason Isbell  ', 'Cover Me Up', 5, 96),
      makeEligibleSong('fav-ji-2', 'jason isbell', '24 Frames', 4, 94),
      makeEligibleSong('fav-ji-3', 'JASON ISBELL', 'Stockholm', 3, 91),
      makeEligibleSong('fav-ji-4', 'Jason Isbell', 'Alabama Pines', 6, 98),
      makeEligibleSong('fav-ts-1', '  Todd Snider', 'Alright Guy', 8, 99),
      makeEligibleSong('fav-ts-2', 'todd snider  ', 'Beer Run', 5, 92),
      makeEligibleSong('fav-ts-3', 'TODD SNIDER', 'Statisticians Blues', 4, 90),
      makeEligibleSong('fav-ts-4', 'Todd Snider', 'Conservatives Song', 3, 88),
      makeEligibleSong('fav-lw-1', 'Lucinda Williams', 'Car Wheels', 7, 97),
      makeEligibleSong('fav-lw-2', ' lucinda williams ', 'Changed the Locks', 4, 93),
      makeEligibleSong('fav-lw-3', 'LUCINDA WILLIAMS', 'Drunken Angel', 3, 89),
      makeEligibleSong('fav-lw-4', 'Lucinda Williams', 'Right in Time', 3, 86),
      // Filtered out by mode=favorites or minScore=85:
      makeEligibleSong('deep-1', 'Deep Artist A', 'One Spin', 1, 99),
      makeEligibleSong('deep-2', 'Deep Artist B', 'Two Spins', 2, 99),
      makeEligibleSong('low-1', 'Low Confidence', 'Fuzzy Match', 9, 72),
    ];

    const drawn = drawRandomPlaylist(pool, 'mode=favorites&minScore=85&onePerArtist=true&count=10');
    expect(drawn.poolSize).toBe(12);
    expect(drawn.count).toBe(10);
    expect(new Set(drawn.songs.map((s) => s.videoId)).size).toBe(10);
    expect(drawn.songs.every((s) => s.totalPlays >= 3 && s.confidenceScore >= 85)).toBe(true);
    expect(new Set(drawn.songs.slice(0, 3).map((s) => s.artist.trim().toLowerCase())).size).toBe(3);

    const shortPool = pool.slice(0, 4);
    const shortDrawn = drawRandomPlaylist(shortPool, { count: 10, onePerArtist: true });
    expect(shortDrawn.poolSize).toBe(4);
    expect(shortDrawn.count).toBe(4);
    expect(new Set(shortDrawn.songs.map((s) => s.videoId)).size).toBe(4);
  });
});
