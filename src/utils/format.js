// Date, integer, compact spin formatting utilities and responsive media-query hook.
import { useEffect, useState } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatAirDate(iso) {
  if (!iso) return '—';
  const raw = String(iso).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const [, year, monthStr, dayStr] = match;
  const monthIdx = parseInt(monthStr, 10) - 1;
  const day = parseInt(dayStr, 10);
  const month = MONTHS[monthIdx] || monthStr;
  return `${month} ${day}, ${year}`;
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
