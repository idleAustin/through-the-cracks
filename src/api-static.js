// Static JSON snapshot loader, episodes index cache, and yearly playlist shard helpers.

export function getStaticPath(relativePath) {
  const base = import.meta.env.BASE_URL || '/';
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

async function fetchStaticJsonAllow404(relativePath) {
  const fullStaticPath = getStaticPath(relativePath);
  const response = await fetch(fullStaticPath);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load data from ${fullStaticPath} (${response.status})`);
  }
  return response.json();
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
  return {
    position: Number(track.position ?? index + 1),
    song: track.song ?? songTitle,
    songTitle,
    artist: track.artist || '',
    album: track.album || '',
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
