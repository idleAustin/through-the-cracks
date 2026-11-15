// Browser localStorage persistence (2-hour TTL) for the Broadcast Booth (/playlist) queue and active slot.
import {
  DEFAULT_PLAYLIST_FILTERS,
  PLAYLIST_MODE_OPTIONS,
  isValidVideoId,
} from './playlist-helpers.js';

export const PLAYLIST_STORAGE_KEY = 'ttc:playlist-session:v1';
export const PLAYLIST_STORAGE_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_STORED_PLAYLIST_QUEUE = 25;
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;

const VALID_MODES = new Set(PLAYLIST_MODE_OPTIONS.map((opt) => opt.value));

function getSafeLocalStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function toSafeString(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return fallback;
}

function toSafeNumber(value, fallback = NaN) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizePlaylistFilters(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawMode = toSafeString(source.mode).trim();
  const mode = VALID_MODES.has(rawMode) ? rawMode : DEFAULT_PLAYLIST_FILTERS.mode;
  const minScore = toSafeNumber(source.minScore) === 65 ? 65 : DEFAULT_PLAYLIST_FILTERS.minScore;
  const rawOne = source.onePerArtist;
  const rawOneText = typeof rawOne === 'string' ? rawOne.trim().toLowerCase() : '';
  const onePerArtist =
    rawOne !== false
    && rawOne !== 0
    && rawOneText !== 'false'
    && rawOneText !== '0';
  return { mode, minScore, onePerArtist };
}

function normalizeStoredSong(song) {
  if (!song || typeof song !== 'object' || Array.isArray(song)) return null;
  const rawVideoId = typeof song.videoId === 'string' ? song.videoId.trim() : '';
  if (!isValidVideoId(rawVideoId)) return null;

  const rawDuration = song.durationSeconds;
  const parsedDuration =
    rawDuration === null || rawDuration === undefined || rawDuration === ''
      ? null
      : toSafeNumber(rawDuration, NaN);
  const rawPlays = toSafeNumber(song.totalPlays, 0);
  const rawConfidence = toSafeNumber(song.confidenceScore, 0);
  const tier = toSafeString(song.matchTier, 'unmatched');

  return {
    songKey: toSafeString(song.songKey),
    artist: toSafeString(song.artist),
    songTitle: toSafeString(song.songTitle),
    album: toSafeString(song.album),
    totalPlays: Number.isFinite(rawPlays) ? rawPlays : 0,
    videoId: rawVideoId,
    ytTitle: toSafeString(song.ytTitle),
    ytArtist: toSafeString(song.ytArtist),
    durationSeconds: parsedDuration !== null && Number.isFinite(parsedDuration) ? parsedDuration : null,
    confidenceScore: Number.isFinite(rawConfidence) ? rawConfidence : 0,
    matchTier: tier || 'unmatched',
  };
}

export function areSamePlaylistFilters(a, b) {
  try {
    const left = normalizePlaylistFilters(a);
    const right = normalizePlaylistFilters(b);
    return (
      left.mode === right.mode
      && left.minScore === right.minScore
      && left.onePerArtist === right.onePerArtist
    );
  } catch {
    return false;
  }
}

export function clearStoredPlaylistSession() {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(PLAYLIST_STORAGE_KEY);
  } catch {
    // Ignore storage removal errors in restricted browsing contexts.
  }
}

export function readStoredPlaylistSession(expectedFilters = null, now = Date.now()) {
  const storage = getSafeLocalStorage();
  if (!storage) return null;

  let raw = null;
  try {
    raw = storage.getItem(PLAYLIST_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const safeNow = toSafeNumber(now, Date.now());

    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || parsed.version !== 1
      || typeof parsed.savedAt !== 'number'
      || !Number.isFinite(parsed.savedAt)
      || parsed.savedAt > safeNow + MAX_FUTURE_CLOCK_SKEW_MS
      || safeNow - parsed.savedAt > PLAYLIST_STORAGE_TTL_MS
      || !parsed.filters
      || typeof parsed.filters !== 'object'
      || Array.isArray(parsed.filters)
      || !Array.isArray(parsed.queue)
      || parsed.queue.length === 0
      || parsed.queue.length > MAX_STORED_PLAYLIST_QUEUE
    ) {
      clearStoredPlaylistSession();
      return null;
    }

    const queue = [];
    for (const item of parsed.queue) {
      const normalized = normalizeStoredSong(item);
      if (!normalized) {
        clearStoredPlaylistSession();
        return null;
      }
      queue.push(normalized);
    }

    const filters = normalizePlaylistFilters(parsed.filters);
    if (expectedFilters && !areSamePlaylistFilters(filters, expectedFilters)) {
      return null;
    }

    const rawPoolSize = toSafeNumber(parsed.poolSize, NaN);
    const poolSize = Number.isFinite(rawPoolSize) && rawPoolSize >= queue.length
      ? Math.trunc(rawPoolSize)
      : queue.length;
    const rawActiveIndex = toSafeNumber(parsed.activeIndex, NaN);
    const activeIndex = Number.isFinite(rawActiveIndex)
      ? Math.min(Math.max(0, Math.trunc(rawActiveIndex)), queue.length - 1)
      : 0;

    return {
      version: 1,
      savedAt: parsed.savedAt,
      filters,
      queue,
      poolSize,
      activeIndex,
    };
  } catch {
    clearStoredPlaylistSession();
    return null;
  }
}

export function writeStoredPlaylistSession(
  { filters, queue, poolSize, activeIndex } = {},
  now = Date.now(),
) {
  try {
    if (!Array.isArray(queue) || queue.length === 0) return false;
    const boundedQueue = queue.slice(0, MAX_STORED_PLAYLIST_QUEUE);
    const normalizedQueue = [];
    for (const item of boundedQueue) {
      const normalized = normalizeStoredSong(item);
      if (!normalized) return false;
      normalizedQueue.push(normalized);
    }

    const storage = getSafeLocalStorage();
    if (!storage) return false;

    const normalizedFilters = normalizePlaylistFilters(filters);
    const rawPoolSize = toSafeNumber(poolSize, NaN);
    const normalizedPoolSize = Number.isFinite(rawPoolSize) && rawPoolSize >= normalizedQueue.length
      ? Math.trunc(rawPoolSize)
      : normalizedQueue.length;
    const rawActiveIndex = toSafeNumber(activeIndex, NaN);
    const clampedActiveIndex = Number.isFinite(rawActiveIndex)
      ? Math.min(Math.max(0, Math.trunc(rawActiveIndex)), normalizedQueue.length - 1)
      : 0;
    const safeNow = toSafeNumber(now, Date.now());

    const payload = {
      version: 1,
      savedAt: safeNow,
      filters: normalizedFilters,
      queue: normalizedQueue,
      poolSize: normalizedPoolSize,
      activeIndex: clampedActiveIndex,
    };

    storage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
