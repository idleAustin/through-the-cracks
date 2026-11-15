// Static episode snapshot loaders, normalization helpers, and static /episodes pagination & detail adapters.
import { getBroadcastDayOfWeek, parseBroadcastDayParam } from '../server/episodeDetailBuilder.js';
import { collectQueryEpisodeIds, enrichStaticEpisode, loadStaticSongs } from './api-episodes-provenance.js';
import { fetchStaticJson, fetchStaticJsonAllow404 } from './api-runtime.js';

const OPTIONAL_TRACK_FIELDS = [
  'totalPlays',
  'firstPlayed',
  'lastPlayed',
  'isSongDebut',
  'isArtistDebut',
  'isOnlySpin',
  'isStaple',
  'videoId',
  'durationSeconds',
];

const OPTIONAL_DETAIL_FIELDS = [
  'dna',
  'debutArtists',
  'doubledArtists',
  'topStaplePlayCount',
  'opener',
  'closer',
  'prevEpisodeId',
  'nextEpisodeId',
];

function stripControlChars(value) {
  let out = '';
  for (const ch of String(value || '')) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

export function normalizeEpisodeSummary(ep) {
  const airDate = String(ep.airDate || ep.air_date || '').slice(0, 10);
  const songCount = Number(
    ep.songCount ?? ep.song_count ?? ep.songs?.length ?? ep.playlist?.length ?? 0,
  );
  return {
    id: String(ep.id ?? ''),
    air_date: airDate,
    airDate,
    song_count: songCount,
    songCount,
    url: ep.url || null,
  };
}

export function normalizeTrack(track, index) {
  const songTitle = track.songTitle ?? track.song_title ?? track.song ?? '';
  const featuredArtist = track.featuredArtist || track.featured_artist || '';
  const releaseKind = track.releaseKind || track.release_kind || '';
  const out = {
    position: Number(track.position ?? index + 1),
    song: track.song ?? songTitle,
    songTitle,
    artist: track.artist || '',
    ...(featuredArtist ? { featuredArtist } : {}),
    album: track.album || '',
    ...(releaseKind && releaseKind !== 'album' ? { releaseKind } : {}),
  };
  for (const field of OPTIONAL_TRACK_FIELDS) {
    if (Object.hasOwn(track, field) && track[field] !== undefined) {
      out[field] = track[field];
    }
  }
  return out;
}

export function normalizeEpisodeDetail(ep, rawTracks) {
  const summary = normalizeEpisodeSummary(ep);
  const playlist = (Array.isArray(rawTracks) ? rawTracks : []).map(normalizeTrack);
  const out = { ...summary, playlist, songs: playlist };
  if (ep && typeof ep === 'object') {
    for (const field of OPTIONAL_DETAIL_FIELDS) {
      if (Object.hasOwn(ep, field) && ep[field] !== undefined) {
        out[field] = ep[field];
      }
    }
  }
  return out;
}

function compareNewestFirst(a, b) {
  return b.airDate.localeCompare(a.airDate) || String(b.id).localeCompare(String(a.id));
}

function extractYears(episodes) {
  const set = new Set();
  for (const ep of episodes) {
    if (/^\d{4}/.test(ep.airDate)) set.add(ep.airDate.slice(0, 4));
  }
  return Array.from(set).sort((a, b) => b.localeCompare(a));
}

let cachedIndex = null;
let inFlightIndex = null;
const playlistShardCache = new Map();
const playlistShardInFlight = new Map();

async function loadEpisodesIndex() {
  if (cachedIndex) return cachedIndex;
  if (inFlightIndex) return inFlightIndex;

  inFlightIndex = (async () => {
    const indexJson = await fetchStaticJsonAllow404('/data/episodes-index.json');
    if (indexJson) {
      const episodes = (indexJson.episodes || [])
        .map(normalizeEpisodeSummary)
        .sort(compareNewestFirst);
      cachedIndex = {
        episodes,
        byId: new Map(episodes.map((ep) => [ep.id, ep])),
        years: extractYears(episodes),
        songEpisodes: indexJson.songEpisodes || {},
        legacyEpisodes: null,
      };
      return cachedIndex;
    }

    // Legacy fallback only when episodes-index.json returns 404 (e.g. older static fixtures).
    const legacyList = await fetchStaticJson('/data/episodes.json');
    const episodes = (Array.isArray(legacyList) ? legacyList : [])
      .map(normalizeEpisodeSummary)
      .sort(compareNewestFirst);
    return {
      episodes,
      byId: new Map(episodes.map((ep) => [ep.id, ep])),
      years: extractYears(episodes),
      songEpisodes: null,
      legacyEpisodes: Array.isArray(legacyList) ? legacyList : [],
    };
  })().finally(() => {
    inFlightIndex = null;
  });

  return inFlightIndex;
}

async function loadYearPlaylistShard(year) {
  if (playlistShardCache.has(year)) return playlistShardCache.get(year);
  if (playlistShardInFlight.has(year)) return playlistShardInFlight.get(year);

  const promise = fetchStaticJsonAllow404(`/data/playlists/${year}.json`)
    .then((shard) => {
      if (shard) playlistShardCache.set(year, shard);
      return shard;
    })
    .finally(() => {
      playlistShardInFlight.delete(year);
    });

  playlistShardInFlight.set(year, promise);
  return promise;
}

function collectMatchingSongEpisodeIds(index, songQuery, artistQuery) {
  const matches = new Set();
  if (index.legacyEpisodes) {
    for (const ep of index.legacyEpisodes) {
      const tracks = ep.songs || ep.playlist || [];
      const hit = tracks.some((t) => {
        const title = String(t.songTitle ?? t.song_title ?? t.song ?? '').trim().toLowerCase();
        const artist = String(t.artist || '').trim().toLowerCase();
        if (songQuery && title !== songQuery) return false;
        if (artistQuery && artist !== artistQuery) return false;
        return Boolean(songQuery || artistQuery);
      });
      if (hit) matches.add(String(ep.id ?? ''));
    }
    return matches;
  }

  const map = index.songEpisodes || {};
  if (songQuery && artistQuery) {
    for (const epId of map[`${songQuery}\t${artistQuery}`] || []) matches.add(String(epId));
    return matches;
  }

  for (const [key, epIds] of Object.entries(map)) {
    const sep = key.indexOf('\t');
    const keySong = sep === -1 ? key : key.slice(0, sep);
    const keyArtist = sep === -1 ? '' : key.slice(sep + 1);
    if (songQuery && keySong !== songQuery) continue;
    if (artistQuery && keyArtist !== artistQuery) continue;
    for (const epId of epIds) matches.add(String(epId));
  }
  return matches;
}

export async function getStaticEpisodes({
  year = '', song = '', artist = '', q = '', day = '', page = 1, limit = 20,
} = {}) {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 40)));
  const safePage = Math.min(1_000_000, Math.max(1, Math.trunc(Number(page) || 1)));
  const index = await loadEpisodesIndex();
  let filtered = index.episodes;

  const songQuery = String(song || '').trim().toLowerCase();
  const artistQuery = String(artist || '').trim().toLowerCase();
  if (songQuery || artistQuery) {
    const matchingIds = collectMatchingSongEpisodeIds(index, songQuery, artistQuery);
    filtered = filtered.filter((ep) => matchingIds.has(ep.id));
  }

  const cleanYear = String(year || '').trim();
  if (/^\d{4}$/.test(cleanYear)) {
    filtered = filtered.filter((ep) => ep.airDate.startsWith(cleanYear));
  }

  const parsedDay = parseBroadcastDayParam(day);
  if (parsedDay) {
    filtered = filtered.filter((ep) => getBroadcastDayOfWeek(ep.airDate) === parsedDay.name);
  }

  const cleanQ = stripControlChars(q).trim().slice(0, 120).toLowerCase();
  if (cleanQ) {
    const songsJson = index.legacyEpisodes ? null : await loadStaticSongs();
    const qIds = await collectQueryEpisodeIds({
      index,
      songsJson,
      qLower: cleanQ,
      loadYearShard: loadYearPlaylistShard,
    });
    filtered = filtered.filter((ep) => ep.airDate.toLowerCase().includes(cleanQ) || qIds.has(ep.id));
  }

  const total = filtered.length;
  const totalPages = Math.ceil(total / safeLimit);
  const offset = (safePage - 1) * safeLimit;
  const items = filtered.slice(offset, offset + safeLimit);

  return {
    items,
    episodes: items,
    years: index.years,
    total,
    page: safePage,
    limit: safeLimit,
    pagination: { page: safePage, limit: safeLimit, total, totalPages },
  };
}

export async function getStaticEpisodeById(id, { provenance = false } = {}) {
  const lookupId = String(id ?? '');
  const index = await loadEpisodesIndex();
  const summary = index.byId.get(lookupId);
  if (!summary) throw new Error('Episode not found');

  let rawTracks;
  if (index.legacyEpisodes) {
    const match = index.legacyEpisodes.find((ep) => String(ep.id ?? '') === lookupId);
    rawTracks = match?.songs || match?.playlist || [];
  } else {
    const year = summary.airDate.slice(0, 4);
    const shard = /^\d{4}$/.test(year) ? await loadYearPlaylistShard(year) : null;
    if (shard === null) {
      const legacyList = await fetchStaticJson('/data/episodes.json');
      const match = (Array.isArray(legacyList) ? legacyList : []).find((ep) => String(ep.id ?? '') === lookupId);
      if (!match) throw new Error('Episode not found');
      rawTracks = match.songs || match.playlist || [];
    } else {
      rawTracks = shard[lookupId] || [];
    }
  }

  if (!provenance) return normalizeEpisodeDetail(summary, rawTracks);
  return enrichStaticEpisode({ summary, rawTracks, episodes: index.episodes, normalizeTrack });
}
