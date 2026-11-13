// Global Command Palette dialog: routes, Latest Broadcast jump, theme switcher, and grouped catalog search.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchAll } from '../api';
import { useTheme } from '../theme';
import { formatInt } from '../utils/format';
import Icon from './Icon';

const EMPTY_RESULTS = { artists: [], songs: [], albums: [] };
const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export default function CommandPalette({ isOpen, onClose, latestEpisodeId = null }) {
  const navigate = useNavigate();
  const { preference, setThemePreference } = useTheme();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const rowRefs = useRef([]);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length >= 2;

  useEffect(() => {
    if (!isOpen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setQuery('');
    setResults(EMPTY_RESULTS);
    setLoading(false);
    setError('');
    setActiveIndex(0);
    const frameId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => {
      document.body.style.overflow = prevOverflow;
      window.cancelAnimationFrame(frameId);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onCaptureKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onCaptureKeyDown, true);
    return () => window.removeEventListener('keydown', onCaptureKeyDown, true);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    if (trimmedQuery.length < 2) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      setError('');
      setActiveIndex(0);
      return undefined;
    }

    let active = true;
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => {
      searchAll(trimmedQuery)
        .then((res) => {
          if (!active) return;
          const payload = res.data || {};
          setResults({
            artists: (payload.artists || []).slice(0, 6),
            songs: (payload.songs || []).slice(0, 6),
            albums: (payload.albums || []).slice(0, 6),
          });
          setActiveIndex(0);
          setLoading(false);
        })
        .catch((err) => {
          if (!active) return;
          setResults(EMPTY_RESULTS);
          setError(err?.message || 'Search request failed.');
          setActiveIndex(0);
          setLoading(false);
        });
    }, 150);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isOpen, trimmedQuery]);

  const sections = useMemo(() => {
    if (!isSearching) {
      const latestUrl = latestEpisodeId
        ? `/episodes?episode=${encodeURIComponent(latestEpisodeId)}`
        : '/episodes';
      return [
        {
          heading: 'Navigation',
          items: [
            { key: 'nav-overview', label: 'Overview', meta: 'Route', icon: 'overview', to: '/' },
            { key: 'nav-artists', label: 'Artists', meta: 'Route', icon: 'artists', to: '/artists' },
            { key: 'nav-songs', label: 'Songs', meta: 'Route', icon: 'songs', to: '/songs' },
            { key: 'nav-episodes', label: 'Episodes', meta: 'Route', icon: 'episodes', to: '/episodes' },
            { key: 'nav-search', label: 'Search', meta: 'Route', icon: 'search', to: '/search' },
            { key: 'nav-latest', label: 'Latest Broadcast', meta: 'Episode', icon: 'playlist', to: latestUrl },
          ],
        },
        {
          heading: 'Appearance',
          items: [
            {
              key: 'theme-system',
              label: 'Theme: System',
              meta: preference === 'system' ? 'Active' : 'Theme',
              icon: 'compass',
              action: () => setThemePreference('system'),
            },
            {
              key: 'theme-dark',
              label: 'Theme: Dark',
              meta: preference === 'dark' ? 'Active' : 'Theme',
              icon: 'moon',
              action: () => setThemePreference('dark'),
            },
            {
              key: 'theme-light',
              label: 'Theme: Light',
              meta: preference === 'light' ? 'Active' : 'Theme',
              icon: 'sun',
              action: () => setThemePreference('light'),
            },
          ],
        },
      ];
    }

    const nextSections = [];
    if (results.artists.length > 0) {
      nextSections.push({
        heading: 'Artists',
        items: results.artists.map((artist) => ({
          key: `artist-${artist.name}`,
          label: artist.name,
          meta: `${formatInt(artist.plays)} spins`,
          monoMeta: true,
          icon: 'artists',
          to: `/artists?artist=${encodeURIComponent(artist.name)}`,
        })),
      });
    }
    if (results.songs.length > 0) {
      nextSections.push({
        heading: 'Songs',
        items: results.songs.map((song) => ({
          key: `song-${song.artist}-${song.songTitle}`,
          label: song.songTitle,
          meta: song.artist,
          icon: 'songs',
          to: `/episodes?song=${encodeURIComponent(song.songTitle)}&artist=${encodeURIComponent(song.artist)}`,
        })),
      });
    }
    if (results.albums.length > 0) {
      nextSections.push({
        heading: 'Albums',
        items: results.albums.map((item) => ({
          key: `album-${item.artist}-${item.album}`,
          label: item.album,
          meta: item.artist,
          icon: 'album',
          to: `/artists?artist=${encodeURIComponent(item.artist)}&album=${encodeURIComponent(item.album)}`,
        })),
      });
    }
    return nextSections;
  }, [isSearching, latestEpisodeId, preference, results, setThemePreference]);

  const flatItems = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  useEffect(() => {
    if (activeIndex >= flatItems.length && flatItems.length > 0) {
      setActiveIndex(0);
    }
  }, [activeIndex, flatItems.length]);

  const runItem = useCallback(
    (item) => {
      if (!item) return;
      onClose();
      if (item.action) {
        item.action();
        return;
      }
      if (item.to) {
        navigate(item.to);
      }
    },
    [navigate, onClose],
  );

  const handleDialogKeyDown = useCallback(
    (event) => {
      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
          (el) => el.getClientRects().length > 0,
        );
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!dialogRef.current.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
          return;
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (event.key === 'ArrowDown' && flatItems.length > 0) {
        event.preventDefault();
        setActiveIndex((prev) => {
          const next = (prev + 1) % flatItems.length;
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }

      if (event.key === 'ArrowUp' && flatItems.length > 0) {
        event.preventDefault();
        setActiveIndex((prev) => {
          const next = (prev - 1 + flatItems.length) % flatItems.length;
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }

      if (event.key === 'Enter' && document.activeElement === inputRef.current && flatItems[activeIndex]) {
        event.preventDefault();
        runItem(flatItems[activeIndex]);
      }
    },
    [activeIndex, flatItems, runItem],
  );

  if (!isOpen) return null;

  let runningIndex = 0;

  return (
    <div
      className="cmd-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="cmd-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleDialogKeyDown}
      >
        <div className="cmd-bar">
          <Icon name="search" size="md" />
          <input
            ref={inputRef}
            type="search"
            className="cmd-input"
            enterKeyHint="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Jump to view, artist, song, album, or theme..."
            aria-label="Quick jump search"
          />
          <button type="button" className="cmd-close-btn" onClick={onClose} aria-label="Close command palette">
            Esc
          </button>
        </div>

        <div className="cmd-results">
          {loading ? (
            <div className="cmd-empty" role="status" aria-live="polite">
              Searching catalog...
            </div>
          ) : error ? (
            <div className="cmd-empty" role="alert">
              {error}
            </div>
          ) : isSearching && flatItems.length === 0 ? (
            <div className="cmd-empty">No matching artists, songs, or albums.</div>
          ) : (
            sections.map((section) => (
              <React.Fragment key={section.heading}>
                <div className="cmd-group-lbl">{section.heading}</div>
                {section.items.map((item) => {
                  const itemIndex = runningIndex;
                  runningIndex += 1;
                  const isActive = itemIndex === activeIndex;
                  return (
                    <button
                      key={item.key}
                      ref={(node) => {
                        rowRefs.current[itemIndex] = node;
                      }}
                      type="button"
                      className={`cmd-row${isActive ? ' is-active' : ''}`}
                      onMouseEnter={() => setActiveIndex(itemIndex)}
                      onClick={() => runItem(item)}
                    >
                      <span className="cmd-row-main">
                        <span className="cmd-row-icon">
                          <Icon name={item.icon} size="sm" />
                        </span>
                        <span className="cmd-row-label">{item.label}</span>
                      </span>
                      <span className={item.monoMeta ? 'cmd-row-meta font-mono num' : 'cmd-row-meta'}>
                        {item.meta}
                      </span>
                    </button>
                  );
                })}
              </React.Fragment>
            ))
          )}
        </div>

        <div className="cmd-footer">
          <span className="cmd-footer-hints">
            <span>
              <kbd className="kbd">Up</kbd> <kbd className="kbd">Down</kbd> move
            </span>
            <span>
              <kbd className="kbd">Enter</kbd> open
            </span>
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
