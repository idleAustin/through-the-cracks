/**
 * Through the Cracks — Client Data Access Layer
 *
 * Tries the Express API server (http://localhost:3001) first.
 * If the API is offline or unreachable, falls back to pre-computed JSON files in /data/
 */
import {
  fetchStaticJson,
  getStaticEpisodeById,
  getStaticEpisodes,
  normalizeEpisodeDetail,
  normalizeEpisodeSummary,
} from './api-static.js';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001/api' : '/api');

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

async function fetchApiJson(apiEndpoint) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${API_BASE}${apiEndpoint}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      setArchiveMode('live');
      return data;
    }
  } catch {
    // API server unreachable or timed out -> caller falls back to static JSON
  }
  return null;
}

async function fetchWithFallback(apiEndpoint, staticJsonPath) {
  const liveData = await fetchApiJson(apiEndpoint);
  if (liveData !== null) {
    return { data: liveData, source: 'express-api', mode: 'live' };
  }
  const data = await fetchStaticJson(staticJsonPath);
  setArchiveMode('static');
  return { data, source: 'static-json', mode: 'static' };
}

export async function getOverview() {
  return fetchWithFallback('/overview', '/data/overview.json');
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

export async function getArtists(search = '', page = 1, limit = 20) {
  const searchParam = encodeURIComponent(search);
  const result = await fetchWithFallback(`/artists?search=${searchParam}&page=${page}&limit=${limit}`, '/data/artists.json');
  if (result.source === 'express-api') return result;

  let allArtists = result.data;
  if (search) {
    const q = search.toLowerCase();
    allArtists = allArtists.filter((a) => a.name.toLowerCase().includes(q));
  }
  const offset = (page - 1) * limit;
  const paginated = allArtists.slice(offset, offset + limit);
  return {
    data: {
      artists: paginated,
      pagination: {
        page,
        limit,
        total: allArtists.length,
        totalPages: Math.ceil(allArtists.length / limit),
      },
    },
    source: 'static-json',
    mode: 'static',
  };
}

export async function searchAll(query) {
  if (!query || query.trim().length < 2) {
    return { data: { artists: [], songs: [], albums: [] }, source: 'static-json', mode: 'static' };
  }
  const q = encodeURIComponent(query.trim());
  const result = await fetchWithFallback(`/search?q=${q}`, '/data/artists.json');
  if (result.source === 'express-api') return result;

  const [artistsRes, songsRes, albumsRes] = await Promise.all([
    fetchStaticJson('data/artists.json'),
    fetchStaticJson('data/songs.json'),
    fetchStaticJson('data/albums.json'),
  ]);

  const term = query.toLowerCase();
  const matchedArtists = artistsRes.filter((a) => a.name.toLowerCase().includes(term)).slice(0, 10);
  const matchedSongs = songsRes.filter((s) => s.songTitle.toLowerCase().includes(term) || s.artist.toLowerCase().includes(term)).slice(0, 10);
  const matchedAlbums = albumsRes.filter((a) => a.album.toLowerCase().includes(term) || a.artist.toLowerCase().includes(term)).slice(0, 10);

  return {
    data: {
      artists: matchedArtists.map((a) => ({ name: a.name, plays: a.totalPlays })),
      songs: matchedSongs.map((s) => ({ artist: s.artist, songTitle: s.songTitle, album: s.albums?.[0] || '', plays: s.totalPlays })),
      albums: matchedAlbums.map((a) => ({ artist: a.artist, album: a.album, plays: a.totalPlays })),
    },
    source: 'static-json',
    mode: 'static',
  };
}

export async function getSongs(search = '', page = 1, limit = 20) {
  const searchParam = encodeURIComponent(search);
  const result = await fetchWithFallback(`/songs?search=${searchParam}&page=${page}&limit=${limit}`, '/data/songs.json');
  if (result.source === 'express-api') return result;

  let allSongs = result.data;
  if (search) {
    const q = search.toLowerCase();
    allSongs = allSongs.filter((s) => s.artist.toLowerCase().includes(q) || s.songTitle.toLowerCase().includes(q));
  }
  const offset = (page - 1) * limit;
  const paginated = allSongs.slice(offset, offset + limit);
  return {
    data: {
      songs: paginated.map((s) => ({
        artist: s.artist,
        songTitle: s.songTitle,
        album: s.albums?.[0] || '',
        totalPlays: s.totalPlays,
        firstPlayed: s.firstAppearance || '',
        lastPlayed: '',
      })),
      pagination: {
        page,
        limit,
        total: allSongs.length,
        totalPages: Math.ceil(allSongs.length / limit),
      },
    },
    source: 'static-json',
    mode: 'static',
  };
}

export async function getArtistSongs(artistName) {
  const encoded = encodeURIComponent(artistName);
  const result = await fetchWithFallback(`/artists/${encoded}/songs`, '/data/songs.json');
  if (result.source === 'express-api') return result;

  const allSongs = result.data;
  const artistSongs = allSongs.filter((s) => s.artist === artistName);
  const totalPlays = artistSongs.reduce((sum, s) => sum + s.totalPlays, 0);
  const albums = new Set(artistSongs.flatMap((s) => s.albums || []));
  return {
    data: {
      artist: artistName,
      summary: {
        totalPlays,
        uniqueSongs: artistSongs.length,
        uniqueAlbums: albums.size,
        firstAppearance: artistSongs[artistSongs.length - 1]?.firstAppearance || '',
        lastAppearance: artistSongs[0]?.firstAppearance || '',
      },
      songs: artistSongs.map((s) => ({
        songTitle: s.songTitle,
        album: s.albums?.[0] || '',
        totalPlays: s.totalPlays,
        firstPlayed: s.firstAppearance || '',
        lastPlayed: '',
      })),
    },
    source: 'static-json',
    mode: 'static',
  };
}
