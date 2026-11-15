// Unit tests for Worker R2 song-links snapshot caching/invalidation and browser 2-hour playlist session persistence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { resetWorkerRateLimits } from '../server/worker.js';
import { bumpWorkerCacheEpoch, readR2SongLinksSnapshot } from '../server/workerSnapshots.js';
import {
  MAX_STORED_PLAYLIST_QUEUE,
  PLAYLIST_STORAGE_KEY,
  PLAYLIST_STORAGE_TTL_MS,
  areSamePlaylistFilters,
  clearStoredPlaylistSession,
  readStoredPlaylistSession,
  writeStoredPlaylistSession,
} from './utils/playlist-storage.js';

function createTrackedR2(initial = {}) {
  const store = new Map(
    Object.entries(initial).map(([k, v]) => [k, v === null ? null : typeof v === 'string' ? v : JSON.stringify(v)]),
  );
  const getCounts = new Map();
  return {
    getCounts,
    countFor: (key) => getCounts.get(key) || 0,
    setJson(key, val) {
      if (val === null || val === undefined) store.delete(key);
      else store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
    },
    async get(key) {
      getCounts.set(key, (getCounts.get(key) || 0) + 1);
      const raw = store.get(key);
      if (raw === undefined || raw === null) return null;
      return {
        text: async () => raw,
        json: async () => JSON.parse(raw),
      };
    },
  };
}

function createMemoryStorage({ throwOnGet = false, throwOnSet = false, throwOnRemove = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(key) {
      if (throwOnGet) {
        const err = new Error('Storage access denied');
        err.name = 'SecurityError';
        throw err;
      }
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throwOnSet) {
        const err = new Error('Quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(key, String(value));
    },
    removeItem(key) {
      if (throwOnRemove) {
        const err = new Error('Storage removal denied');
        err.name = 'SecurityError';
        throw err;
      }
      map.delete(key);
    },
  };
}

const makeSong = (videoId, artist, songTitle, album, totalPlays, confidenceScore, durationSeconds) => ({
  songKey: `${artist.toLowerCase()}|||${songTitle.toLowerCase()}`,
  artist, songTitle, album, totalPlays, videoId,
  ytTitle: songTitle, ytArtist: artist, durationSeconds, confidenceScore, matchTier: 'high',
});

const makeManifest = (updatedAt = '2026-11-15T06:00:00.000Z') => ({
  version: 1, updatedAt, totalEpisodes: 100, totalSongPlays: 2000, latestEpisodeId: 'ep-100',
});

const SAMPLE_POOL_V1 = [
  makeSong('vid_jp_001', 'John Prine', 'Sam Stone', 'John Prine', 6, 98, 255),
  makeSong('vid_ts_001', 'Todd Snider', 'Alright Guy', 'Songs for the Daily Planet', 8, 99, 212),
];

const SAMPLE_POOL_V2 = [
  ...SAMPLE_POOL_V1,
  makeSong('vid_lw_001', 'Lucinda Williams', 'Car Wheels', 'Car Wheels on a Gravel Road', 5, 97, 284),
];

describe('Worker R2 song-links snapshot caching and invalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    resetWorkerRateLimits();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('caches manifest-backed v1/song-links.json across repeated reads and /api/playlist/random calls within 60s', async () => {
    const bucket = createTrackedR2({
      'v1/manifest.json': makeManifest(),
      'v1/song-links.json': { songs: SAMPLE_POOL_V1 },
    });
    const env = { SNAPSHOT_BUCKET: bucket };

    const first = await readR2SongLinksSnapshot(env);
    expect(first).toEqual(SAMPLE_POOL_V1);

    vi.advanceTimersByTime(30_000);
    const second = await readR2SongLinksSnapshot(env);
    expect(second).toEqual(SAMPLE_POOL_V1);

    const apiRes = await worker.fetch(new Request('https://idleamericana.com/api/playlist/random?count=2'), env);
    expect(apiRes.status).toBe(200);
    expect(apiRes.headers.get('Cache-Control')).toBe('no-store');
    const apiBody = await apiRes.json();
    expect(apiBody.poolSize).toBe(2);
    expect(apiBody.songs).toHaveLength(2);

    expect(bucket.countFor('v1/manifest.json')).toBe(1);
    expect(bucket.countFor('v1/song-links.json')).toBe(1);
  });

  it('re-checks v1/manifest.json after 60s without re-fetching unchanged song-links, and re-reads when updatedAt changes', async () => {
    const bucket = createTrackedR2({
      'v1/manifest.json': makeManifest(),
      'v1/song-links.json': SAMPLE_POOL_V1,
    });
    const env = { SNAPSHOT_BUCKET: bucket };

    expect(await readR2SongLinksSnapshot(env)).toHaveLength(2);
    expect(bucket.countFor('v1/manifest.json')).toBe(1);
    expect(bucket.countFor('v1/song-links.json')).toBe(1);

    // Past 60s with identical manifest: manifest is re-read, but v1/song-links.json stays cached!
    vi.advanceTimersByTime(60_001);
    expect(await readR2SongLinksSnapshot(env)).toHaveLength(2);
    expect(bucket.countFor('v1/manifest.json')).toBe(2);
    expect(bucket.countFor('v1/song-links.json')).toBe(1);

    // Update manifest.updatedAt + song-links payload, then advance past another 60s TTL window.
    bucket.setJson('v1/manifest.json', makeManifest('2026-11-15T06:05:00.000Z'));
    bucket.setJson('v1/song-links.json', { songs: SAMPLE_POOL_V2 });

    vi.advanceTimersByTime(60_001);
    const refreshed = await readR2SongLinksSnapshot(env);
    expect(refreshed).toHaveLength(3);
    expect(bucket.countFor('v1/manifest.json')).toBe(3);
    expect(bucket.countFor('v1/song-links.json')).toBe(2);
  });

  it('caches fallback v1/song-links.json for 60s when v1/manifest.json is absent, then refreshes after TTL', async () => {
    const bucket = createTrackedR2({ 'v1/song-links.json': { songs: SAMPLE_POOL_V1 } });
    const env = { SNAPSHOT_BUCKET: bucket };

    expect(await readR2SongLinksSnapshot(env)).toHaveLength(2);
    vi.advanceTimersByTime(20_000);
    expect(await readR2SongLinksSnapshot(env)).toHaveLength(2);
    vi.advanceTimersByTime(39_999);
    expect(await readR2SongLinksSnapshot(env)).toHaveLength(2);
    expect(bucket.countFor('v1/song-links.json')).toBe(1);

    bucket.setJson('v1/song-links.json', SAMPLE_POOL_V2);
    vi.advanceTimersByTime(2);
    expect(await readR2SongLinksSnapshot(env)).toHaveLength(3);
    expect(bucket.countFor('v1/song-links.json')).toBe(2);
  });

  it('immediately invalidates both manifest-backed and fallback caches on bumpWorkerCacheEpoch / resetWorkerRateLimits', async () => {
    const manifestBucket = createTrackedR2({ 'v1/manifest.json': makeManifest(), 'v1/song-links.json': SAMPLE_POOL_V1 });
    const fallbackBucket = createTrackedR2({ 'v1/song-links.json': SAMPLE_POOL_V1 });

    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: manifestBucket })).toHaveLength(2);
    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: fallbackBucket })).toHaveLength(2);

    manifestBucket.setJson('v1/song-links.json', SAMPLE_POOL_V2);
    fallbackBucket.setJson('v1/song-links.json', SAMPLE_POOL_V2);

    bumpWorkerCacheEpoch();
    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: manifestBucket })).toHaveLength(3);
    expect(manifestBucket.countFor('v1/song-links.json')).toBe(2);
    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: fallbackBucket })).toHaveLength(3);
    expect(fallbackBucket.countFor('v1/song-links.json')).toBe(2);

    manifestBucket.setJson('v1/song-links.json', SAMPLE_POOL_V1);
    fallbackBucket.setJson('v1/song-links.json', SAMPLE_POOL_V1);
    resetWorkerRateLimits();
    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: manifestBucket })).toHaveLength(2);
    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: fallbackBucket })).toHaveLength(2);
    expect(manifestBucket.countFor('v1/song-links.json')).toBe(3);
    expect(fallbackBucket.countFor('v1/song-links.json')).toBe(3);
  });

  it('returns null without poisoning caches when v1/song-links.json is missing or invalid', async () => {
    expect(await readR2SongLinksSnapshot(null)).toBeNull();
    expect(await readR2SongLinksSnapshot({})).toBeNull();

    const manifestNoLinks = createTrackedR2({ 'v1/manifest.json': makeManifest() });
    const fallbackNoLinks = createTrackedR2({});

    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: manifestNoLinks })).toBeNull();
    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: fallbackNoLinks })).toBeNull();

    // Writing v1/song-links.json immediately succeeds on the next call (no negative-cache poisoning).
    manifestNoLinks.setJson('v1/song-links.json', SAMPLE_POOL_V1);
    fallbackNoLinks.setJson('v1/song-links.json', { songs: SAMPLE_POOL_V1 });

    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: manifestNoLinks })).toHaveLength(2);
    expect(await readR2SongLinksSnapshot({ SNAPSHOT_BUCKET: fallbackNoLinks })).toHaveLength(2);
  });
});

describe('playlist-storage 2-hour localStorage session helpers', () => {
  let localStorageMock;

  beforeEach(() => {
    localStorageMock = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: localStorageMock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes and reads within 2-hour TTL while normalizing filters, song fields, poolSize, and clamped activeIndex', () => {
    expect(PLAYLIST_STORAGE_TTL_MS).toBe(2 * 60 * 60 * 1000);
    expect(areSamePlaylistFilters(
      { mode: 'favorites', minScore: '65', onePerArtist: 'false' },
      { mode: 'favorites', minScore: 65, onePerArtist: false },
    )).toBe(true);
    expect(areSamePlaylistFilters(
      { mode: 'invalid_mode', minScore: 999, onePerArtist: '1' },
      { mode: 'all', minScore: 85, onePerArtist: true },
    )).toBe(true);

    const t0 = 1_700_000_000_000;
    const wrote = writeStoredPlaylistSession(
      {
        filters: { mode: 'bogus', minScore: '65', onePerArtist: '0' },
        queue: [
          { ...SAMPLE_POOL_V1[0], videoId: '  vid_jp_001  ', durationSeconds: '' },
          SAMPLE_POOL_V1[1],
        ],
        poolSize: 1,
        activeIndex: 99,
      },
      t0,
    );
    expect(wrote).toBe(true);

    const atBoundary = readStoredPlaylistSession(null, t0 + PLAYLIST_STORAGE_TTL_MS);
    expect(atBoundary).toEqual({
      version: 1,
      savedAt: t0,
      filters: { mode: 'all', minScore: 65, onePerArtist: false },
      queue: [
        { ...SAMPLE_POOL_V1[0], durationSeconds: null },
        SAMPLE_POOL_V1[1],
      ],
      poolSize: 2,
      activeIndex: 1,
    });

    // Negative activeIndex clamps to 0.
    writeStoredPlaylistSession({ filters: { mode: 'favorites' }, queue: SAMPLE_POOL_V1, poolSize: 25, activeIndex: -4 }, t0);
    const clampedLow = readStoredPlaylistSession({ mode: 'favorites', minScore: 85, onePerArtist: true }, t0 + 5000);
    expect(clampedLow?.activeIndex).toBe(0);
    expect(clampedLow?.poolSize).toBe(25);
  });

  it('expires stale sessions at savedAt + PLAYLIST_STORAGE_TTL_MS + 1 and removes localStorage entry', () => {
    const t0 = 1_700_000_000_000;
    writeStoredPlaylistSession({ filters: { mode: 'all' }, queue: SAMPLE_POOL_V1, poolSize: 10, activeIndex: 1 }, t0);
    expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(true);

    const expired = readStoredPlaylistSession(null, t0 + PLAYLIST_STORAGE_TTL_MS + 1);
    expect(expired).toBeNull();
    expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(false);
  });

  it('rejects and cleans up corrupt JSON, wrong version, empty queues, and invalid videoIds', () => {
    const t0 = 1_700_000_000_000;

    expect(writeStoredPlaylistSession({ filters: {}, queue: [] }, t0)).toBe(false);
    expect(writeStoredPlaylistSession({
      filters: {},
      queue: [{ ...SAMPLE_POOL_V1[0], videoId: 'bad/id?list=evil' }],
    }, t0)).toBe(false);
    expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(false);

    const invalidPayloads = [
      '{corrupt-json',
      JSON.stringify({ version: 2, savedAt: t0, filters: {}, queue: SAMPLE_POOL_V1 }),
      JSON.stringify({ version: 1, savedAt: t0, filters: {}, queue: [] }),
      JSON.stringify({
        version: 1,
        savedAt: t0,
        filters: { mode: 'all', minScore: 85, onePerArtist: true },
        queue: [{ ...SAMPLE_POOL_V1[0], videoId: 'abc&autoplay=1' }],
      }),
    ];

    for (const bad of invalidPayloads) {
      localStorageMock.map.set(PLAYLIST_STORAGE_KEY, bad);
      expect(readStoredPlaylistSession(null, t0 + 100)).toBeNull();
      expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(false);
    }
  });

  it('returns null non-destructively when expectedFilters do not match stored filters', () => {
    const t0 = 1_700_000_000_000;
    writeStoredPlaylistSession(
      { filters: { mode: 'favorites', minScore: 85, onePerArtist: true }, queue: SAMPLE_POOL_V1, poolSize: 11, activeIndex: 1 },
      t0,
    );

    expect(readStoredPlaylistSession({ mode: 'deep_cuts', minScore: 85, onePerArtist: true }, t0 + 1000)).toBeNull();
    expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(true);

    const preserved = readStoredPlaylistSession({ mode: 'favorites', minScore: 85, onePerArtist: true }, t0 + 1000);
    expect(preserved?.queue).toHaveLength(2);
    expect(preserved?.activeIndex).toBe(1);

    clearStoredPlaylistSession();
    expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(false);
  });

  it('swallows QuotaExceededError, SecurityError, and missing window without throwing', () => {
    const t0 = 1_700_000_000_000;

    vi.stubGlobal('window', {
      localStorage: createMemoryStorage({ throwOnGet: true, throwOnSet: true, throwOnRemove: true }),
    });
    expect(() => clearStoredPlaylistSession()).not.toThrow();
    expect(writeStoredPlaylistSession({ filters: {}, queue: SAMPLE_POOL_V1 }, t0)).toBe(false);
    expect(readStoredPlaylistSession(null, t0)).toBeNull();

    const restrictedWin = {};
    Object.defineProperty(restrictedWin, 'localStorage', {
      get() {
        throw new Error('Blocked by browser privacy settings');
      },
    });
    vi.stubGlobal('window', restrictedWin);
    expect(() => clearStoredPlaylistSession()).not.toThrow();
    expect(writeStoredPlaylistSession({ filters: {}, queue: SAMPLE_POOL_V1 }, t0)).toBe(false);
    expect(readStoredPlaylistSession(null, t0)).toBeNull();

    vi.stubGlobal('window', undefined);
    expect(writeStoredPlaylistSession({ filters: {}, queue: SAMPLE_POOL_V1 }, t0)).toBe(false);
    expect(readStoredPlaylistSession(null, t0)).toBeNull();
  });

  it('guards hostile toString/valueOf objects, future savedAt > now + 60_000, and MAX_STORED_PLAYLIST_QUEUE (25)', () => {
    const t0 = 1_700_000_000_000;
    const poison = { toString: null, valueOf: null };

    expect(MAX_STORED_PLAYLIST_QUEUE).toBe(25);
    expect(areSamePlaylistFilters({ mode: poison, minScore: poison, onePerArtist: poison }, {})).toBe(true);

    localStorageMock.map.set(PLAYLIST_STORAGE_KEY, JSON.stringify({
      version: 1,
      savedAt: t0 + 60_000,
      filters: { mode: poison, minScore: poison, onePerArtist: poison },
      poolSize: poison,
      activeIndex: poison,
      queue: [{ videoId: 'vid_ok_01', artist: poison, songTitle: poison, totalPlays: poison, durationSeconds: poison, matchTier: poison }],
    }));
    const coerced = readStoredPlaylistSession(null, t0);
    expect(coerced?.queue[0]).toMatchObject({ videoId: 'vid_ok_01', artist: '', songTitle: '', totalPlays: 0, durationSeconds: null, matchTier: 'unmatched' });

    // Future clock skew > 60_000ms is rejected and cleared.
    localStorageMock.map.set(PLAYLIST_STORAGE_KEY, JSON.stringify({ version: 1, savedAt: t0 + 60_001, filters: {}, queue: SAMPLE_POOL_V1 }));
    expect(readStoredPlaylistSession(null, t0)).toBeNull();
    expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(false);

    // Write slices queues > 25 down to 25; read rejects & clears tampered queues > 25.
    const thirtySongs = Array.from({ length: 30 }, (_, i) => makeSong(`vid_q_${i}`, `Artist ${i}`, `Song ${i}`, 'LP', 3, 95, 200));
    expect(writeStoredPlaylistSession({ filters: {}, queue: thirtySongs, activeIndex: 29 }, t0)).toBe(true);
    const sliced = readStoredPlaylistSession(null, t0);
    expect(sliced?.queue).toHaveLength(25);
    expect(sliced?.activeIndex).toBe(24);

    localStorageMock.map.set(PLAYLIST_STORAGE_KEY, JSON.stringify({ version: 1, savedAt: t0, filters: {}, queue: thirtySongs.slice(0, 26) }));
    expect(readStoredPlaylistSession(null, t0)).toBeNull();
    expect(localStorageMock.map.has(PLAYLIST_STORAGE_KEY)).toBe(false);
  });
});
