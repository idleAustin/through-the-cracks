// Pure Web-API-only canonical Song key builder, query parser, and random Playlist drawer.
import { nameKey } from '../scripts/archive-normalizer.js';
import { resolveCanonicalArtist } from '../scripts/artist-aliases.js';

export const SONG_KEY_SEPARATOR = '|||';
export const VALID_PLAYLIST_MODES = ['all', 'favorites', 'deep_cuts'];
export const DEFAULT_PLAYLIST_COUNT = 10;
export const MAX_PLAYLIST_COUNT = 25;
export const DEFAULT_MIN_SCORE = 85;

const MAX_EXCLUDE_ITEMS = 25;
const MAX_ARTIST_LENGTH = 160;
const VALID_MODE_SET = new Set(VALID_PLAYLIST_MODES);

export function buildSongKey(artist, songTitle) {
  return `${nameKey(resolveCanonicalArtist(artist))}${SONG_KEY_SEPARATOR}${nameKey(songTitle)}`;
}

export function normalizeArtistCompareKey(artist) {
  return String(artist ?? '').trim().toLowerCase();
}

export function toPlaylistSongItem(row = {}) {
  const artist = String(row.artist ?? '');
  const songTitle = String(row.songTitle ?? row.song_title ?? row.song ?? '');
  const rawKey = String(row.songKey ?? row.song_key ?? '').trim();
  const rawPlays = Number(row.totalPlays ?? row.total_plays ?? 0);
  const rawDuration = row.durationSeconds ?? row.duration_seconds;
  const parsedDuration =
    rawDuration === null || rawDuration === undefined || rawDuration === ''
      ? null
      : Number(rawDuration);
  const rawScore = Number(row.confidenceScore ?? row.confidence_score ?? 0);

  return {
    songKey: rawKey || buildSongKey(artist, songTitle),
    artist,
    songTitle,
    album: String(row.album ?? ''),
    totalPlays: Number.isFinite(rawPlays) ? rawPlays : 0,
    videoId: String(row.videoId ?? row.video_id ?? '').trim(),
    ytTitle: String(row.ytTitle ?? row.yt_title ?? ''),
    ytArtist: String(row.ytArtist ?? row.yt_artist ?? ''),
    durationSeconds: Number.isFinite(parsedDuration) ? parsedDuration : null,
    confidenceScore: Number.isFinite(rawScore) ? rawScore : 0,
    matchTier: String(row.matchTier ?? row.match_tier ?? 'unmatched'),
  };
}

function parseClampedInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || typeof raw === 'boolean') return fallback;
  const trimmed = String(raw).trim();
  if (!trimmed) return fallback;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(max, Math.max(min, Math.trunc(num)));
  return clamped === 0 ? 0 : clamped;
}

function toSearchParams(input) {
  if (!input) return null;
  if (input instanceof URL) return input.searchParams;
  if (typeof input === 'string') {
    return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
  }
  if (typeof input.get === 'function' && typeof input.getAll === 'function') {
    return input;
  }
  return null;
}

export function parsePlaylistQuery(input) {
  const params = toSearchParams(input);
  const obj = !params && input && typeof input === 'object' ? input : {};

  const getScalar = (key) => {
    if (params) return params.get(key);
    const val = obj[key];
    return Array.isArray(val) ? val[0] : val;
  };
  const getList = (key) => {
    if (params) return params.getAll(key);
    const val = obj[key];
    if (Array.isArray(val)) return val;
    return val === undefined || val === null ? [] : [val];
  };

  const rawMode = getScalar('mode');
  let mode = 'all';
  if (rawMode !== undefined && rawMode !== null) {
    const trimmedMode = String(rawMode).trim();
    if (trimmedMode !== '') {
      if (!VALID_MODE_SET.has(trimmedMode)) {
        return { error: 'Invalid playlist mode', status: 400 };
      }
      mode = trimmedMode;
    }
  }

  const count = parseClampedInt(getScalar('count'), DEFAULT_PLAYLIST_COUNT, 1, MAX_PLAYLIST_COUNT);
  const minScore = parseClampedInt(getScalar('minScore'), DEFAULT_MIN_SCORE, 0, 100);

  const rawOnePerArtist = getScalar('onePerArtist');
  let onePerArtist = true;
  if (rawOnePerArtist === false) {
    onePerArtist = false;
  } else if (rawOnePerArtist !== undefined && rawOnePerArtist !== null) {
    const normalized = String(rawOnePerArtist).trim().toLowerCase();
    if (normalized === 'false' || normalized === '0') {
      onePerArtist = false;
    }
  }

  const exclude = [];
  const excludeSeen = new Set();
  for (const chunk of getList('exclude')) {
    if (chunk === undefined || chunk === null) continue;
    for (const part of String(chunk).split(',')) {
      const id = part.trim();
      if (!id || excludeSeen.has(id)) continue;
      excludeSeen.add(id);
      exclude.push(id);
      if (exclude.length >= MAX_EXCLUDE_ITEMS) break;
    }
    if (exclude.length >= MAX_EXCLUDE_ITEMS) break;
  }

  const excludeArtist = [];
  const excludeArtistSeen = new Set();
  for (const rawArtist of getList('excludeArtist')) {
    if (rawArtist === undefined || rawArtist === null) continue;
    const trimmed = String(rawArtist).trim().slice(0, MAX_ARTIST_LENGTH);
    const compareKey = normalizeArtistCompareKey(trimmed);
    if (!compareKey || excludeArtistSeen.has(compareKey)) continue;
    excludeArtistSeen.add(compareKey);
    excludeArtist.push(trimmed);
    if (excludeArtist.length >= MAX_EXCLUDE_ITEMS) break;
  }

  return { count, minScore, mode, onePerArtist, exclude, excludeArtist };
}

function isTruthyFlag(val) {
  return val === 1 || val === true || val === '1';
}

function isFalsyFlag(val) {
  return val === 0 || val === false || val === '0';
}

function isRowPlayable(row, assumedPlayable) {
  const rawEmbed = row?.is_embeddable ?? row?.isEmbeddable;
  const rawUs = row?.us_playable ?? row?.usPlayable;
  if (assumedPlayable) {
    return !isFalsyFlag(rawEmbed) && !isFalsyFlag(rawUs);
  }
  return isTruthyFlag(rawEmbed) && isTruthyFlag(rawUs);
}

function shuffleCopy(items, rng = Math.random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function drawRandomPlaylist(poolOrSnapshot, queryInput = {}, options = {}) {
  const parsed = parsePlaylistQuery(queryInput);
  if (parsed.error) return parsed;

  const { count, minScore, mode, onePerArtist, exclude, excludeArtist } = parsed;
  const assumedPlayable = options?.assumedPlayable === true;
  const rng = typeof options?.rng === 'function' ? options.rng : Math.random;

  const rawList = Array.isArray(poolOrSnapshot)
    ? poolOrSnapshot
    : Array.isArray(poolOrSnapshot?.songs)
      ? poolOrSnapshot.songs
      : [];

  const eligiblePool = [];
  for (const row of rawList) {
    if (!row || !isRowPlayable(row, assumedPlayable)) continue;
    const item = toPlaylistSongItem(row);
    if (!item.videoId) continue;
    if (item.confidenceScore < minScore) continue;
    if (mode === 'favorites' && item.totalPlays < 3) continue;
    if (mode === 'deep_cuts' && (item.totalPlays < 1 || item.totalPlays > 2)) continue;
    eligiblePool.push(item);
  }

  const poolSize = eligiblePool.length;
  const excludeVideoSet = new Set(exclude);
  const available = excludeVideoSet.size
    ? eligiblePool.filter((item) => !excludeVideoSet.has(item.videoId))
    : eligiblePool;

  const shuffled = shuffleCopy(available, rng);
  const excludeArtistKeys = new Set(excludeArtist.map(normalizeArtistCompareKey).filter(Boolean));
  const seenArtists = new Set(excludeArtistKeys);
  const usedVideoIds = new Set();
  const songs = [];

  for (const item of shuffled) {
    if (songs.length >= count) break;
    if (usedVideoIds.has(item.videoId)) continue;
    const artistKey = normalizeArtistCompareKey(item.artist);
    if (artistKey && (excludeArtistKeys.has(artistKey) || (onePerArtist && seenArtists.has(artistKey)))) {
      continue;
    }
    songs.push(item);
    usedVideoIds.add(item.videoId);
    if (onePerArtist && artistKey) seenArtists.add(artistKey);
  }

  if (songs.length < count) {
    for (const item of shuffled) {
      if (songs.length >= count) break;
      if (usedVideoIds.has(item.videoId)) continue;
      songs.push(item);
      usedVideoIds.add(item.videoId);
    }
  }

  return {
    count: songs.length,
    poolSize,
    minScore,
    mode,
    onePerArtist,
    songs,
  };
}
