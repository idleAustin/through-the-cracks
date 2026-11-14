// Pure URL filter parsing, swap exclusion builders, and queue export helpers for Broadcast Booth.

export const DEFAULT_PLAYLIST_FILTERS = Object.freeze({
  count: 10,
  mode: 'all',
  minScore: 85,
  onePerArtist: true,
});

export const PLAYLIST_MODE_OPTIONS = Object.freeze([
  { value: 'all', label: 'All Spins' },
  { value: 'favorites', label: '3+ Spins' },
  { value: 'deep_cuts', label: '1–2 Spins' },
]);

export const PLAYLIST_SCORE_OPTIONS = Object.freeze([
  { value: 85, label: 'High confidence (85+)' },
  { value: 65, label: 'Include medium (65+)' },
]);

const VALID_MODES = new Set(PLAYLIST_MODE_OPTIONS.map((opt) => opt.value));
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value.trim());
}

export function parsePlaylistFilters(searchParams) {
  const params = searchParams instanceof URLSearchParams
    ? searchParams
    : new URLSearchParams(searchParams || '');

  const rawMode = String(params.get('mode') || '').trim();
  const mode = VALID_MODES.has(rawMode) ? rawMode : DEFAULT_PLAYLIST_FILTERS.mode;

  const rawScore = String(params.get('minScore') || '').trim();
  const minScore = rawScore === '65' ? 65 : DEFAULT_PLAYLIST_FILTERS.minScore;

  const rawOne = String(params.get('onePerArtist') ?? '').trim().toLowerCase();
  const onePerArtist = rawOne !== 'false' && rawOne !== '0';

  return { mode, minScore, onePerArtist };
}

export function applyPlaylistFiltersToSearchParams(prevParams, nextFilters = {}) {
  const next = new URLSearchParams(prevParams);
  const mode = VALID_MODES.has(nextFilters.mode) ? nextFilters.mode : DEFAULT_PLAYLIST_FILTERS.mode;
  const minScore = Number(nextFilters.minScore) === 65 ? 65 : DEFAULT_PLAYLIST_FILTERS.minScore;
  const onePerArtist = nextFilters.onePerArtist !== false;

  if (mode !== DEFAULT_PLAYLIST_FILTERS.mode) next.set('mode', mode);
  else next.delete('mode');

  if (minScore !== DEFAULT_PLAYLIST_FILTERS.minScore) next.set('minScore', String(minScore));
  else next.delete('minScore');

  if (!onePerArtist) next.set('onePerArtist', 'false');
  else next.delete('onePerArtist');

  return next;
}

export function areDefaultPlaylistFilters(filters) {
  return (
    filters.mode === DEFAULT_PLAYLIST_FILTERS.mode
    && filters.minScore === DEFAULT_PLAYLIST_FILTERS.minScore
    && filters.onePerArtist === DEFAULT_PLAYLIST_FILTERS.onePerArtist
  );
}

export function buildSwapExcludeIds(queue, targetIndex, extraIds = []) {
  const seen = new Set();
  const ids = [];
  const push = (id) => {
    const clean = String(id || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    ids.push(clean);
  };

  if (Array.isArray(queue)) {
    if (queue[targetIndex]?.videoId) push(queue[targetIndex].videoId);
    for (const song of queue) {
      if (song?.videoId) push(song.videoId);
    }
  }
  for (const extra of extraIds) {
    push(extra);
  }
  return ids.slice(0, 25);
}

export function buildSwapExcludeArtists(queue, targetIndex, onePerArtist = true) {
  if (!onePerArtist || !Array.isArray(queue)) return [];
  const seen = new Set();
  const artists = [];
  const push = (name) => {
    const clean = String(name || '').trim();
    const key = clean.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    artists.push(clean);
  };

  queue.forEach((song, idx) => {
    if (idx !== targetIndex && song?.artist) push(song.artist);
  });
  if (queue[targetIndex]?.artist) {
    push(queue[targetIndex].artist);
  }
  return artists.slice(0, 25);
}

export function buildYouTubeQueueUrl(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return '';
  const ids = queue
    .map((item) => (typeof item?.videoId === 'string' ? item.videoId.trim() : ''))
    .filter((id) => isValidVideoId(id))
    .map((id) => encodeURIComponent(id));
  if (ids.length === 0) return '';
  return `https://www.youtube.com/watch_videos?video_ids=${ids.join(',')}`;
}

export function formatPlaylistText(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return '';
  return queue
    .map((item, idx) => `${idx + 1}. ${item.artist} — ${item.songTitle}`)
    .join('\n');
}

function copyTextFallback(text) {
  if (typeof document === 'undefined' || !document.body) return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = Boolean(document.execCommand?.('copy'));
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

export async function copyTextToClipboard(text) {
  if (!text) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyTextFallback(text);
    }
  }
  return copyTextFallback(text);
}
