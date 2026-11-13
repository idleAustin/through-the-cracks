// Theme preference controller, legacy storage migration, and DOM synchronization for idleAustin themes.
import { createContext, useContext } from 'react';

export const THEME_STORAGE_KEY = 'as-theme';
export const LEGACY_THEME_STORAGE_KEY = 'ttc-theme';
const VALID_PREFERENCES = new Set(['system', 'light', 'dark']);

export const ThemeContext = createContext(null);

export function readThemePreference() {
  if (typeof window === 'undefined') return 'system';

  let preference = 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && VALID_PREFERENCES.has(stored)) {
      preference = stored;
    } else {
      const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      if (legacy === 'light' || legacy === 'dark') {
        preference = legacy;
        window.localStorage.setItem(THEME_STORAGE_KEY, legacy);
      }
    }

    if (window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY) !== null) {
      window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    }
  } catch {
    // Storage access can throw in restricted browser contexts.
  }

  return preference;
}

export function writeThemePreference(pref) {
  const next = VALID_PREFERENCES.has(pref) ? pref : 'system';
  if (typeof window === 'undefined') return next;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    if (window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY) !== null) {
      window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    }
  } catch {
    // Storage access can throw in restricted browser contexts.
  }

  return next;
}

export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

export function applyThemeToDom(pref, { animate = false } = {}) {
  const resolved = resolveTheme(pref);
  if (typeof document === 'undefined') return resolved;

  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-switching');
  }

  root.dataset.theme = resolved;

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const bgBase = window.getComputedStyle(root).getPropertyValue('--as-bg-base').trim();
    if (bgBase) {
      const metas = document.querySelectorAll('meta[name="theme-color"]');
      metas.forEach((meta) => {
        meta.setAttribute('content', bgBase);
      });
    }
  }

  if (animate && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        root.classList.remove('theme-switching');
      });
    });
  } else if (animate) {
    root.classList.remove('theme-switching');
  }

  return resolved;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

