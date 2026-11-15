// Static snapshot provenance enrichment, cached lookup maps, and archive query matching helpers.
import { normalizeArtistKey } from '../server/artistProfileBuilder.js';
import { buildEnrichedEpisodeDetail } from '../server/episodeDetailBuilder.js';
import { buildSongKey, buildSqliteSongKey, isValidVideoId } from '../server/playlistBuilder.js';
import { fetchStaticJsonAllow404 } from './api-runtime.js';

const toArray = (val, altKey) => (Array.isArray(val) ? val : (Array.isArray(val?.[altKey]) ? val[altKey] : []));
const isFalsyFlag = (v) => v === 0 || v === false || v === '0';

function createStaticSnapshotLoader(path) {
  let cached = null;
  let inFlight = null;
  return async () => {
    if (cached !== null) return cached;
    if (inFlight) return inFlight;
    inFlight = fetchStaticJsonAllow404(path)
      .then((json) => {
        if (json !== null) cached = json;
        return json;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export const loadStaticSongs = createStaticSnapshotLoader('/data/songs.json');
const loadStaticArtists = createStaticSnapshotLoader('/data/artists.json');
const loadStaticSongLinks = createStaticSnapshotLoader('/data/song-links.json');

export async function collectQueryEpisodeIds({ index, songsJson, qLower, loadYearShard }) {
  const matches = new Set();
  if (index.legacyEpisodes) {
    for (const ep of index.legacyEpisodes) {
      const air = String(ep.airDate || ep.air_date || '').toLowerCase();
      const tracks = ep.songs || ep.playlist || [];
      const hit = air.includes(qLower) || tracks.some((t) => (
        String(t.songTitle ?? t.song_title ?? t.song ?? '').toLowerCase().includes(qLower)
        || String(t.artist || '').toLowerCase().includes(qLower)
        || String(t.featuredArtist ?? t.featured_artist ?? '').toLowerCase().includes(qLower)
        || String(t.album || '').toLowerCase().includes(qLower)
      ));
      if (hit) matches.add(String(ep.id ?? ''));
    }
    return matches;
  }

  const songEpisodes = index.songEpisodes || {};
  for (const [key, epIds] of Object.entries(songEpisodes)) {
    if (key.toLowerCase().includes(qLower)) {
      for (const epId of epIds || []) matches.add(String(epId));
    }
  }

  const pendingByEpId = new Map();
  for (const s of toArray(songsJson, 'songs')) {
    if (!s) continue;
    const title = String(s.songTitle ?? s.song_title ?? s.song ?? '');
    const artist = String(s.artist || '');
    const sk = `${title.trim().toLowerCase()}\t${artist.trim().toLowerCase()}`;
    const epIds = songEpisodes[sk] || [];
    if (epIds.length === 0) continue;

    if (title.toLowerCase().includes(qLower) || artist.toLowerCase().includes(qLower)) {
      for (const epId of epIds) matches.add(String(epId));
      continue;
    }

    const albums = [...(Array.isArray(s.albums) ? s.albums : []), ...(s.album ? [s.album] : [])];
    const feats = [...(Array.isArray(s.featuredArtists) ? s.featuredArtists : []), ...(s.featuredArtist ? [s.featuredArtist] : [])];
    const metaHit = albums.some((alb) => String(alb || '').toLowerCase().includes(qLower))
      || feats.some((fa) => String(fa || '').toLowerCase().includes(qLower));
    if (!metaHit) continue;

    for (const rawId of epIds) {
      const epId = String(rawId);
      if (matches.has(epId)) continue;
      let keys = pendingByEpId.get(epId);
      if (!keys) {
        keys = new Set();
        pendingByEpId.set(epId, keys);
      }
      keys.add(sk);
    }
  }

  if (pendingByEpId.size > 0 && typeof loadYearShard === 'function') {
    const neededYears = new Set();
    for (const epId of pendingByEpId.keys()) {
      const yr = index.byId.get(epId)?.airDate?.slice(0, 4) || '';
      if (/^\d{4}$/.test(yr)) neededYears.add(yr);
    }
    const shardPairs = await Promise.all(
      Array.from(neededYears, async (yr) => [yr, await loadYearShard(yr)]),
    );
    const shardsByYear = new Map(shardPairs);
    for (const [epId, candidateKeys] of pendingByEpId.entries()) {
      const yr = index.byId.get(epId)?.airDate?.slice(0, 4) || '';
      const tracks = yr ? (shardsByYear.get(yr)?.[epId] || []) : [];
      const spinHit = tracks.some((t) => {
        const spinKey = `${String(t.songTitle ?? t.song_title ?? t.song ?? '').trim().toLowerCase()}\t${String(t.artist || '').trim().toLowerCase()}`;
        if (!candidateKeys.has(spinKey)) return false;
        return String(t.album || '').toLowerCase().includes(qLower)
          || String(t.featuredArtist ?? t.featured_artist ?? '').toLowerCase().includes(qLower);
      });
      if (spinHit) matches.add(epId);
    }
  }

  return matches;
}

const songStatsMemo = new WeakMap();
const artistFirstMemo = new WeakMap();
const playableLinksMemo = new WeakMap();

function getSongStatsMap(songsJson) {
  if (!songsJson || typeof songsJson !== 'object') return new Map();
  const cached = songStatsMemo.get(songsJson);
  if (cached) return cached;
  const map = new Map();
  for (const s of toArray(songsJson, 'songs')) {
    if (!s) continue;
    const artist = String(s.artist ?? '');
    const title = String(s.songTitle ?? s.song_title ?? s.song ?? '');
    const stat = {
      totalPlays: Number(s.totalPlays ?? s.total_plays ?? 1),
      firstPlayed: String(s.firstPlayed ?? s.first_played ?? s.firstAppearance ?? ''),
      lastPlayed: String(s.lastPlayed ?? s.last_played ?? s.lastAppearance ?? ''),
    };
    const sqliteKey = buildSqliteSongKey(artist, title);
    const canonKey = buildSongKey(artist, title);
    if (sqliteKey) map.set(sqliteKey, stat);
    if (canonKey && !map.has(canonKey)) map.set(canonKey, stat);
  }
  songStatsMemo.set(songsJson, map);
  return map;
}

function getArtistFirstMap(artistsJson) {
  if (!artistsJson || typeof artistsJson !== 'object') return new Map();
  const cached = artistFirstMemo.get(artistsJson);
  if (cached) return cached;
  const map = new Map();
  for (const a of toArray(artistsJson, 'artists')) {
    if (!a) continue;
    const first = String(a.firstAppearance ?? a.first_appearance ?? '');
    if (!first) continue;
    const normKey = normalizeArtistKey(a.name);
    const lowerKey = String(a.name || '').trim().toLowerCase();
    for (const k of normKey === lowerKey ? [normKey] : [normKey, lowerKey]) {
      if (!k) continue;
      const prev = map.get(k);
      if (prev === undefined || first < prev) map.set(k, first);
    }
  }
  artistFirstMemo.set(artistsJson, map);
  return map;
}

function getPlayableLinksMap(songLinksJson) {
  if (!songLinksJson || typeof songLinksJson !== 'object') return new Map();
  const cached = playableLinksMemo.get(songLinksJson);
  if (cached) return cached;
  const map = new Map();
  for (const s of toArray(songLinksJson, 'songs')) {
    if (!s || typeof s !== 'object') continue;
    if (isFalsyFlag(s.is_embeddable ?? s.isEmbeddable) || isFalsyFlag(s.us_playable ?? s.usPlayable)) continue;
    const vid = s.videoId ?? s.video_id;
    if (!isValidVideoId(vid)) continue;
    const entry = { videoId: vid.trim(), durationSeconds: s.durationSeconds ?? s.duration_seconds ?? null };
    const explicitKey = String(s.songKey ?? s.song_key ?? '').trim();
    if (explicitKey && !map.has(explicitKey)) map.set(explicitKey, entry);
    const artist = String(s.artist ?? '');
    const title = String(s.songTitle ?? s.song_title ?? s.song ?? '');
    if (artist || title) {
      const canonKey = buildSongKey(artist, title);
      const sqliteKey = buildSqliteSongKey(artist, title);
      if (canonKey && !map.has(canonKey)) map.set(canonKey, entry);
      if (sqliteKey && !map.has(sqliteKey)) map.set(sqliteKey, entry);
    }
  }
  playableLinksMemo.set(songLinksJson, map);
  return map;
}

export async function enrichStaticEpisode({ summary, rawTracks, episodes, normalizeTrack }) {
  const [songsJson, artistsJson, songLinksJson] = await Promise.all([
    loadStaticSongs(),
    loadStaticArtists(),
    loadStaticSongLinks(),
  ]);
  const idx = episodes.findIndex((ep) => ep.id === summary.id);
  const prevEpisodeId = idx > 0 ? episodes[idx - 1].id : null;
  const nextEpisodeId = idx >= 0 && idx + 1 < episodes.length ? episodes[idx + 1].id : null;

  return buildEnrichedEpisodeDetail({
    episode: summary,
    tracks: (Array.isArray(rawTracks) ? rawTracks : []).map(normalizeTrack),
    songStatsByKey: getSongStatsMap(songsJson),
    artistFirstByKey: getArtistFirstMap(artistsJson),
    playableLinksByKey: getPlayableLinksMap(songLinksJson),
    prevEpisodeId,
    nextEpisodeId,
  });
}
