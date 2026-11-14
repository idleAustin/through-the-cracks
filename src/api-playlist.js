// Uncached random Playlist client adapter with live /api/playlist/random and static song-links.json fallback.
import { drawRandomPlaylist } from '../server/playlistBuilder.js';
import { resolveApiBase, setArchiveMode } from './api-runtime.js';
import { fetchStaticJson } from './api-static.js';

const LIVE_TIMEOUT_MS = 2000;
const MAX_EXCLUDE_ITEMS = 25;

let cachedStaticPool = null;
let inFlightStaticPool = null;

export function resetStaticPlaylistPoolCache() {
  cachedStaticPool = null;
  inFlightStaticPool = null;
}

function normalizeExcludeIds(exclude) {
  const raw = Array.isArray(exclude)
    ? exclude
    : typeof exclude === 'string'
      ? exclude.split(',')
      : [];
  const items = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(id);
    if (items.length >= MAX_EXCLUDE_ITEMS) break;
  }
  return items;
}

function normalizeExcludeArtists(excludeArtist) {
  const raw = Array.isArray(excludeArtist)
    ? excludeArtist
    : typeof excludeArtist === 'string'
      ? [excludeArtist]
      : [];
  const artists = [];
  const seen = new Set();
  for (const entry of raw) {
    const artist = String(entry ?? '').trim();
    if (!artist) continue;
    const key = artist.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    artists.push(artist);
    if (artists.length >= MAX_EXCLUDE_ITEMS) break;
  }
  return artists;
}

export function buildRandomPlaylistParams(options = {}) {
  const params = new URLSearchParams();
  const count = options.count !== undefined && options.count !== null ? options.count : 10;
  const minScore = options.minScore !== undefined && options.minScore !== null ? options.minScore : 85;
  const mode = options.mode !== undefined && options.mode !== null ? options.mode : 'all';
  const onePerArtist =
    options.onePerArtist === undefined || options.onePerArtist === null
      ? true
      : Boolean(options.onePerArtist);

  params.set('count', String(count));
  params.set('minScore', String(minScore));
  params.set('mode', String(mode));
  params.set('onePerArtist', String(onePerArtist));

  const excludeIds = normalizeExcludeIds(options.exclude);
  if (excludeIds.length > 0) {
    params.set('exclude', excludeIds.join(','));
  }

  for (const artist of normalizeExcludeArtists(options.excludeArtist)) {
    params.append('excludeArtist', artist);
  }

  return params;
}

function normalizePlaylistResponse(payload) {
  const songs = Array.isArray(payload?.songs)
    ? payload.songs.map((song) => ({
      songKey: String(song?.songKey ?? ''),
      artist: String(song?.artist ?? ''),
      songTitle: String(song?.songTitle ?? ''),
      album: String(song?.album ?? ''),
      totalPlays: Number(song?.totalPlays ?? 0),
      videoId: String(song?.videoId ?? ''),
      ytTitle: String(song?.ytTitle ?? ''),
      ytArtist: String(song?.ytArtist ?? ''),
      durationSeconds:
        song?.durationSeconds === null || song?.durationSeconds === undefined
          ? null
          : Number(song.durationSeconds),
      confidenceScore: Number(song?.confidenceScore ?? 0),
      matchTier: String(song?.matchTier ?? 'unmatched'),
    }))
    : [];

  return {
    count: Number(payload?.count ?? songs.length),
    poolSize: Number(payload?.poolSize ?? 0),
    minScore: Number(payload?.minScore ?? 85),
    mode: String(payload?.mode ?? 'all'),
    onePerArtist: Boolean(payload?.onePerArtist ?? true),
    songs,
  };
}

function createAbortError() {
  return Object.assign(new Error('Playlist request aborted.'), { name: 'AbortError' });
}

async function fetchLiveRandomPlaylist(params, externalSignal) {
  if (externalSignal?.aborted) {
    throw createAbortError();
  }

  const apiBase = resolveApiBase();
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LIVE_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(`${apiBase}/playlist/random?${params.toString()}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();

    if (response.status === 400 && contentType.includes('application/json')) {
      const errorBody = await response.json().catch(() => null);
      if (errorBody?.error) {
        setArchiveMode('live');
        throw Object.assign(new Error(errorBody.error), { status: 400 });
      }
    }

    if (response.ok) {
      const payload = await response.json();
      if (payload && Array.isArray(payload.songs)) {
        setArchiveMode('live');
        return normalizePlaylistResponse(payload);
      }
    }
  } catch (err) {
    if (externalSignal?.aborted && !timedOut) {
      throw createAbortError();
    }
    if (err?.status === 400) throw err;
    // Live API unreachable, timed out, 503, or returned non-JSON SPA HTML -> fall back to static snapshot.
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }

  return null;
}

async function loadStaticSongLinksPool() {
  if (cachedStaticPool) return cachedStaticPool;
  if (inFlightStaticPool) return inFlightStaticPool;

  inFlightStaticPool = fetchStaticJson('/data/song-links.json')
    .then((payload) => {
      const pool = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.songs)
          ? payload.songs
          : [];
      cachedStaticPool = pool;
      return pool;
    })
    .finally(() => {
      inFlightStaticPool = null;
    });

  return inFlightStaticPool;
}

export async function getRandomPlaylist(options = {}) {
  const params = buildRandomPlaylistParams(options);
  const externalSignal = options.signal;
  const staticOnly = import.meta.env.VITE_STATIC_MODE === 'true' || options.staticOnly === true;

  if (externalSignal?.aborted) {
    throw createAbortError();
  }

  if (!staticOnly) {
    const liveData = await fetchLiveRandomPlaylist(params, externalSignal);
    if (liveData !== null) {
      return { data: liveData, source: 'express-api', mode: 'live' };
    }
  }

  const pool = await loadStaticSongLinksPool();
  if (externalSignal?.aborted) {
    throw createAbortError();
  }

  const drawn = drawRandomPlaylist(pool, params, { assumedPlayable: true });
  if (drawn?.error) {
    throw Object.assign(new Error(drawn.error), { status: drawn.status || 400 });
  }

  setArchiveMode('static');
  return { data: drawn, source: 'static-json', mode: 'static' };
}
