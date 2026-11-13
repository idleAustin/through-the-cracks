// React context provider for theme preference, OS color-scheme tracking, and single-frame theme toggles.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ThemeContext,
  applyThemeToDom,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
} from '../theme';

export default function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(() => readThemePreference());
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(readThemePreference()));

  useEffect(() => {
    const resolved = applyThemeToDom(preference, { animate: false });
    setResolvedTheme(resolved);
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => {
      if (readThemePreference() !== 'system') return;
      const nextResolved = applyThemeToDom('system', { animate: true });
      setResolvedTheme(nextResolved);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [preference]);

  const setThemePreference = useCallback((nextPref) => {
    const normalized = writeThemePreference(nextPref);
    const nextResolved = applyThemeToDom(normalized, { animate: true });
    setPreference(normalized);
    setResolvedTheme(nextResolved);
  }, []);

  const toggleTheme = useCallback(() => {
    const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    setThemePreference(nextTheme);
  }, [resolvedTheme, setThemePreference]);

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      setThemePreference,
      toggleTheme,
    }),
    [preference, resolvedTheme, setThemePreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

