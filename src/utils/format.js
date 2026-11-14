// Date, song-key, integer, compact spin formatting utilities and responsive media-query hook.
import { useEffect, useState } from 'react';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function normalizeSongKey(title) {
  return String(title || '').trim().toLowerCase();
}

export function formatAirDate(iso) {
  if (!iso) return '—';
  const raw = String(iso).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const [, year, monthStr, dayStr] = match;
  const monthIdx = parseInt(monthStr, 10) - 1;
  const day = parseInt(dayStr, 10);
  const month = SHORT_MONTHS[monthIdx] || monthStr;
  return `${month} ${day}, ${year}`;
}

export function formatShortMonthYear(iso, optionsOrApostrophe = '’') {
  if (!iso) return '—';
  const apostrophe = typeof optionsOrApostrophe === 'string'
    ? optionsOrApostrophe
    : (optionsOrApostrophe?.apostrophe ?? '’');
  const match = String(iso).trim().match(/^(\d{4})-(\d{2})/);
  if (!match) return formatAirDate(iso);
  const year = match[1].slice(2);
  const monthIdx = parseInt(match[2], 10) - 1;
  return `${SHORT_MONTHS[monthIdx] || match[2]} ${apostrophe}${year}`;
}

export function formatInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function formatCompactSpins(n, isCompact = false) {
  const value = Number(n || 0);
  if (isCompact && value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return formatInt(value);
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '—';
  const num = Number(seconds);
  if (!Number.isFinite(num) || num < 0) return '—';
  const total = Math.round(num);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatPlaylistRuntime(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return 'Broadcast Queue';
  let total = 0;
  let counted = 0;
  for (const item of queue) {
    const secs = Number(item?.durationSeconds);
    if (Number.isFinite(secs) && secs > 0) {
      total += secs;
      counted += 1;
    }
  }
  if (counted === 0) return 'Broadcast Queue';
  const mins = Math.floor(total / 60);
  const secs = Math.round(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')} runtime`;
}

export function useMediaQuery(query) {
  const getMatch = () => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  );

  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
