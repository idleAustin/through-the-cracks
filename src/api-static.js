// Static JSON snapshot loader, episodes index cache, and yearly playlist shard helpers.

export function getStaticPath(relativePath, baseUrl = import.meta.env.BASE_URL) {
  const base = baseUrl || '/';
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return base.endsWith('/') ? `${base}${cleanPath}` : `${base}/${cleanPath}`;
}

export async function fetchStaticJson(relativePath) {
  const fullStaticPath = getStaticPath(relativePath);
  const response = await fetch(fullStaticPath);
  if (!response.ok) {
    throw new Error(`Failed to load data from ${fullStaticPath} (${response.status})`);
  }
  return response.json();
}

export async function fetchStaticJsonAllow404(relativePath) {
  const fullStaticPath = getStaticPath(relativePath);
  const response = await fetch(fullStaticPath);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load data from ${fullStaticPath} (${response.status})`);
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    return null;
  }
  if (typeof response.text !== 'function') return response.json();
  const trimmed = (await response.text()).trim();
  if (!trimmed || trimmed.startsWith('<')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    if (!contentType.includes('json')) return null;
    throw err;
  }
}

export function normalizeEpisodeSummary(ep) {
  const airDate = String(ep.airDate || ep.air_date || '').slice(0, 10);
  const songCount = Number(
    ep.songCount ?? ep.song_count ?? ep.songs?.length ?? ep.playlist?.length ?? 0,
  );
  return {
    id: ep.id,
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
  return {
    position: Number(track.position ?? index + 1),
    song: track.song ?? songTitle,
    songTitle,
    artist: track.artist || '',
    ...(featuredArtist ? { featuredArtist } : {}),
    album: track.album || '',
    ...(releaseKind && releaseKind !== 'album' ? { releaseKind } : {}),
  };
}

export function normalizeEpisodeDetail(ep, rawTracks) {
  const summary = normalizeEpisodeSummary(ep);
  const playlist = (Array.isArray(rawTracks) ? rawTracks : []).map(normalizeTrack);
  return {
    ...summary,
    playlist,
    songs: playlist,
  };
}

function compareNewestFirst(a, b) {
  return b.airDate.localeCompare(a.airDate) || String(b.id).localeCompare(String(a.id));
}

function extractYears(episodes) {
  const set = new Set();
  for (const ep of episodes) {
    if (/^\d{4}/.test(ep.airDate)) {
      set.add(ep.airDate.slice(0, 4));
    }
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
      const years = extractYears(episodes);
      const byId = new Map(episodes.map((ep) => [ep.id, ep]));
      cachedIndex = {
        episodes,
        byId,
        years,
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
      if (hit) matches.add(ep.id);
    }
    return matches;
  }

  const map = index.songEpisodes || {};
  if (songQuery && artistQuery) {
    for (const epId of map[`${songQuery}\t${artistQuery}`] || []) {
      matches.add(epId);
    }
    return matches;
  }

  for (const [key, epIds] of Object.entries(map)) {
    const sep = key.indexOf('\t');
    const keySong = sep === -1 ? key : key.slice(0, sep);
    const keyArtist = sep === -1 ? '' : key.slice(sep + 1);
    if (songQuery && keySong !== songQuery) continue;
    if (artistQuery && keyArtist !== artistQuery) continue;
    for (const epId of epIds) matches.add(epId);
  }
  return matches;
}

export async function getStaticEpisodes({ year = '', song = '', artist = '', page = 1, limit = 20 }) {
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

  const total = filtered.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  return {
    items,
    episodes: items,
    years: index.years,
    total,
    page,
    limit,
    pagination: { page, limit, total, totalPages },
  };
}

export async function getStaticEpisodeById(id) {
  const index = await loadEpisodesIndex();
  const summary = index.byId.get(id);
  if (!summary) throw new Error('Episode not found');

  if (index.legacyEpisodes) {
    const match = index.legacyEpisodes.find((ep) => ep.id === id);
    return normalizeEpisodeDetail(summary, match?.songs || match?.playlist || []);
  }

  const year = summary.airDate.slice(0, 4);
  const shard = /^\d{4}$/.test(year) ? await loadYearPlaylistShard(year) : null;
  if (shard === null) {
    const legacyList = await fetchStaticJson('/data/episodes.json');
    const match = (Array.isArray(legacyList) ? legacyList : []).find((ep) => ep.id === id);
    if (!match) throw new Error('Episode not found');
    return normalizeEpisodeDetail(summary, match.songs || match.playlist || []);
  }

  return normalizeEpisodeDetail(summary, shard[id] || []);
}

const DEFAULT_YEAR_SPINS_YEARS = [
  2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
];

let cachedYearSpins = null;
let inFlightYearSpins = null;

async function loadYearSpins() {
  if (cachedYearSpins) return cachedYearSpins;
  if (inFlightYearSpins) return inFlightYearSpins;

  inFlightYearSpins = fetchStaticJson('/data/year-spins.json')
    .then((json) => {
      cachedYearSpins = json;
      return json;
    })
    .finally(() => {
      inFlightYearSpins = null;
    });

  return inFlightYearSpins;
}

function findEntryCaseInsensitive(record, targetKey) {
  if (!record || !targetKey) return null;
  if (Object.prototype.hasOwnProperty.call(record, targetKey)) {
    return record[targetKey];
  }
  const needle = targetKey.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === needle) return value;
  }
  return null;
}

export async function getStaticYearSpins({ artist = '', song = '' } = {}) {
  const payload = await loadYearSpins();
  const years = Array.isArray(payload?.years) && payload.years.length > 0
    ? payload.years
    : DEFAULT_YEAR_SPINS_YEARS;
  const align = (series) => years.map((_, i) => Number(series?.[i] || 0));

  const cleanArtist = String(artist || '').trim();
  const cleanSong = String(song || '').trim();

  if (cleanSong) {
    let series = null;
    const songsMap = payload?.songs || {};
    if (cleanArtist) {
      series = findEntryCaseInsensitive(songsMap, `${cleanSong}\t${cleanArtist}`);
    } else {
      const needle = cleanSong.toLowerCase();
      const summed = years.map(() => 0);
      let matched = false;
      for (const [key, counts] of Object.entries(songsMap)) {
        const tab = key.indexOf('\t');
        const keySong = tab === -1 ? key : key.slice(0, tab);
        if (keySong.toLowerCase() === needle && Array.isArray(counts)) {
          matched = true;
          for (let i = 0; i < years.length; i += 1) {
            summed[i] += Number(counts[i] || 0);
          }
        }
      }
      if (matched) series = summed;
    }
    return {
      years,
      spins: align(series),
      scope: 'song',
      artist: cleanArtist || null,
      song: cleanSong,
    };
  }

  if (cleanArtist) {
    const series = findEntryCaseInsensitive(payload?.artists || {}, cleanArtist);
    return {
      years,
      spins: align(series),
      scope: 'artist',
      artist: cleanArtist,
      song: null,
    };
  }

  return {
    years,
    spins: align(payload?.archive),
    scope: 'archive',
    artist: null,
    song: null,
  };
}
