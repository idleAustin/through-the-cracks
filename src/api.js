/**
 * Through the Cracks — Client Data Access Layer
 *
 * Tries the Express API server (http://localhost:3001) first.
 * If the API is offline or unreachable, falls back to pre-computed JSON files in /data/
 */
import {
  getStaticArtistProfile,
  getStaticArtistSongs,
  getStaticArtists,
  getStaticSearchAll,
  getStaticSongs,
  parseCatalogOptions,
} from './api-catalog.js';
import {
  fetchStaticJson,
  getStaticEpisodeById,
  getStaticEpisodes,
  getStaticPath,
  getStaticYearSpins,
  normalizeEpisodeDetail,
  normalizeEpisodeSummary,
} from './api-static.js';

export function resolveApiBase({
  explicitApiUrl = import.meta.env.VITE_API_URL,
  isDev = import.meta.env.DEV,
  baseUrl = import.meta.env.BASE_URL,
} = {}) {
  if (explicitApiUrl) return String(explicitApiUrl).replace(/\/+$/, '');
  if (isDev) return 'http://localhost:3001/api';
  return getStaticPath('api', baseUrl);
}

const API_BASE = resolveApiBase();

let currentMode = null;
const archiveModeListeners = new Set();

function setArchiveMode(nextMode) {
  if (nextMode === currentMode) return;
  currentMode = nextMode;
  for (const listener of archiveModeListeners) {
    listener(nextMode);
  }
}

export function getArchiveMode() {
  return currentMode ?? 'static';
}

export function subscribeArchiveMode(listener) {
  archiveModeListeners.add(listener);
  return () => {
    archiveModeListeners.delete(listener);
  };
}

async function fetchApiJson(apiEndpoint, { allow404 = false } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${API_BASE}${apiEndpoint}`, { signal: controller.signal });
    if (allow404 && response.status === 404) {
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (!contentType.includes('text/html')) {
        setArchiveMode('live');
        return { found: false, data: null };
      }
    }
    if (response.ok) {
      const data = await response.json();
      setArchiveMode('live');
      return allow404 ? { found: true, data } : data;
    }
  } catch {
    // API server unreachable or timed out -> caller falls back to static JSON
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}

function normalizeOverview(data) {
  return {
    ...data,
    latestEpisodeId: data?.latestEpisodeId ?? null,
    oneSpinArtists: Number(data?.oneSpinArtists ?? 0),
    oneSpinSongs: Number(data?.oneSpinSongs ?? 0),
    topSongs: Array.isArray(data?.topSongs)
      ? data.topSongs.map((s) => ({ ...s, album: s.album || '' }))
      : [],
  };
}

export async function getOverview() {
  const liveData = await fetchApiJson('/overview');
  if (liveData !== null) {
    return { data: normalizeOverview(liveData), source: 'express-api', mode: 'live' };
  }
  const data = await fetchStaticJson('/data/overview.json');
  setArchiveMode('static');
  return { data: normalizeOverview(data), source: 'static-json', mode: 'static' };
}

export async function getYearSpins({ artist = '', song = '' } = {}) {
  const params = new URLSearchParams();
  const cleanArtist = String(artist || '').trim();
  const cleanSong = String(song || '').trim();
  if (cleanArtist) params.set('artist', cleanArtist);
  if (cleanSong) params.set('song', cleanSong);
  const query = params.toString();
  const liveData = await fetchApiJson(query ? `/years?${query}` : '/years');
  if (liveData !== null) {
    return { data: liveData, source: 'express-api', mode: 'live' };
  }

  const data = await getStaticYearSpins({ artist: cleanArtist, song: cleanSong });
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}

export async function getEpisodes(optionsOrPage = 1, maybeLimit = 20) {
  const opts = typeof optionsOrPage === 'object' && optionsOrPage !== null
    ? optionsOrPage
    : { page: optionsOrPage, limit: maybeLimit };
  const page = Math.max(1, parseInt(opts.page ?? 1, 10) || 1);
  const limit = Math.max(1, parseInt(opts.limit ?? 20, 10) || 20);
  const year = String(opts.year || '').trim();
  const song = String(opts.song || '').trim();
  const artist = String(opts.artist || '').trim();

  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (/^\d{4}$/.test(year)) params.set('year', year);
  if (song) params.set('song', song);
  if (artist) params.set('artist', artist);

  const liveData = await fetchApiJson(`/episodes?${params.toString()}`);
  if (liveData !== null) {
    const items = (liveData.items || liveData.episodes || []).map(normalizeEpisodeSummary);
    const total = Number(liveData.total ?? liveData.pagination?.total ?? items.length);
    const pagination = liveData.pagination || {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
    return {
      data: {
        ...liveData,
        items,
        episodes: items,
        total,
        page: Number(liveData.page ?? pagination.page ?? page),
        limit: Number(liveData.limit ?? pagination.limit ?? limit),
        pagination,
      },
      source: 'express-api',
      mode: 'live',
    };
  }

  const data = await getStaticEpisodes({ year, song, artist, page, limit });
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}

export async function getEpisodeById(id) {
  const liveData = await fetchApiJson(`/episodes/${encodeURIComponent(id)}`);
  if (liveData !== null) {
    return {
      data: normalizeEpisodeDetail(liveData, liveData.playlist || liveData.songs || []),
      source: 'express-api',
      mode: 'live',
    };
  }

  const data = await getStaticEpisodeById(id);
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}

function buildCatalogQuery({ search, sort, cap, page, limit }) {
  const params = new URLSearchParams({
    sort,
    page: String(page),
    limit: String(limit),
  });
  if (search) params.set('search', search);
  if (cap) params.set('cap', String(cap));
  return params.toString();
}

export async function getArtists(optionsOrSearch = '', maybePage = 1, maybeLimit = 25) {
  const opts = parseCatalogOptions(optionsOrSearch, maybePage, maybeLimit);
  const liveData = await fetchApiJson(`/artists?${buildCatalogQuery(opts)}`);
  if (liveData !== null) {
    const items = liveData.items || liveData.artists || [];
    return {
      data: { ...liveData, items, artists: items },
      source: 'express-api',
      mode: 'live',
    };
  }

  const data = await getStaticArtists(opts);
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}

export async function getSongs(optionsOrSearch = '', maybePage = 1, maybeLimit = 25) {
  const opts = parseCatalogOptions(optionsOrSearch, maybePage, maybeLimit);
  const liveData = await fetchApiJson(`/songs?${buildCatalogQuery(opts)}`);
  if (liveData !== null) {
    const items = liveData.items || liveData.songs || [];
    return {
      data: { ...liveData, items, songs: items },
      source: 'express-api',
      mode: 'live',
    };
  }

  const data = await getStaticSongs(opts);
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}

export async function getArtistSongs(artistName) {
  const liveData = await fetchApiJson(`/artists/${encodeURIComponent(artistName)}/songs`);
  if (liveData !== null) {
    return { data: liveData, source: 'express-api', mode: 'live' };
  }

  const data = await getStaticArtistSongs(artistName);
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}

export async function getArtistProfile(artistName) {
  if (!String(artistName ?? '').trim()) {
    return getStaticArtistProfile(artistName);
  }
  const liveResult = await fetchApiJson(`/artists/${encodeURIComponent(artistName)}/profile`, { allow404: true });
  if (liveResult !== null) {
    return { data: liveResult.data, source: 'express-api', mode: 'live' };
  }

  const staticResult = await getStaticArtistProfile(artistName);
  setArchiveMode('static');
  return staticResult;
}

export async function searchAll(query) {
  if (!query || query.trim().length < 2) {
    return { data: { artists: [], songs: [], albums: [] }, source: 'static-json', mode: 'static' };
  }

  const liveData = await fetchApiJson(`/search?q=${encodeURIComponent(query.trim())}`);
  if (liveData !== null) {
    return { data: liveData, source: 'express-api', mode: 'live' };
  }

  const data = await getStaticSearchAll(query);
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}
