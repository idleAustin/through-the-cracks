// Global Catalog Search workspace: debounced URL-synced query, search results grid, auto-open, and ArtistDashboard.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { searchAll } from '../api';
import ArtistDashboard from '../components/ArtistDashboard';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import SearchResultsGrid from '../components/SearchResultsGrid';
import { formatInt, useMediaQuery } from '../utils/format';

const EMPTY_RESULTS = { artists: [], songs: [], albums: [] };

export default function SearchView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isCompact = useMediaQuery('(max-width: 768px)');

  const q = searchParams.get('q') || '';
  const selectedArtist = searchParams.get('artist') || '';
  const trimmedQ = q.trim();

  const [searchInput, setSearchInput] = useState(q);
  const [searchState, setSearchState] = useState({ query: '', results: EMPTY_RESULTS });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  const selectedArtistRef = useRef(selectedArtist);
  selectedArtistRef.current = selectedArtist;
  const trimmedQRef = useRef(trimmedQ);
  trimmedQRef.current = trimmedQ;
  const prevQRef = useRef(q);
  const dismissedAutoOpenQueryRef = useRef(null);
  const searchInputRef = useRef(null);
  const restoreSearchFocusRef = useRef(false);

  useEffect(() => {
    if (q !== prevQRef.current) {
      prevQRef.current = q;
      setSearchInput(q);
      if (q.trim() !== dismissedAutoOpenQueryRef.current) {
        dismissedAutoOpenQueryRef.current = null;
      }
    }
  }, [q]);

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === q.trim()) return undefined;

    const timer = window.setTimeout(() => {
      prevQRef.current = trimmed;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set('q', trimmed);
          else next.delete('q');
          next.delete('artist');
          next.delete('album');
          return next;
        },
        { replace: true },
      );
    }, 200);

    return () => window.clearTimeout(timer);
  }, [searchInput, q, setSearchParams]);

  useEffect(() => {
    if (trimmedQ.length < 2) {
      setSearchState({ query: '', results: EMPTY_RESULTS });
      setLoading(false);
      setError('');
      return undefined;
    }

    let active = true;
    setLoading(true);
    setError('');

    searchAll(trimmedQ)
      .then((res) => {
        if (!active) return;
        const payload = res.data || {};
        setSearchState({
          query: trimmedQ,
          results: {
            artists: payload.artists || [],
            songs: payload.songs || [],
            albums: payload.albums || [],
          },
        });
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setSearchState({ query: trimmedQ, results: EMPTY_RESULTS });
        setError(err?.message || 'Could not search catalog.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [trimmedQ, retryKey]);

  useEffect(() => {
    if (trimmedQ.length < 2) return;
    if (loading || error || selectedArtist) return;
    if (searchState.query !== trimmedQ) return;
    if (searchState.results.artists.length !== 1) return;
    if (dismissedAutoOpenQueryRef.current === trimmedQ) return;

    const onlyArtist = searchState.results.artists[0];
    if (!onlyArtist?.name) return;

    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('artist', onlyArtist.name);
        next.delete('album');
        return next;
      },
      { replace: true },
    );
  }, [trimmedQ, loading, error, selectedArtist, searchState, setSearchParams]);

  const handleClearSearch = useCallback(() => {
    prevQRef.current = '';
    dismissedAutoOpenQueryRef.current = null;
    setSearchInput('');
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('q');
        next.delete('artist');
        next.delete('album');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const handleSelectArtist = useCallback(
    (artistName) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('artist', artistName);
        next.delete('album');
        return next;
      });
    },
    [setSearchParams],
  );

  const handleCloseDashboard = useCallback(() => {
    dismissedAutoOpenQueryRef.current = trimmedQRef.current || null;
    restoreSearchFocusRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('artist');
      next.delete('album');
      return next;
    });
  }, [setSearchParams]);

  useEffect(() => {
    if (!selectedArtist && restoreSearchFocusRef.current) {
      restoreSearchFocusRef.current = false;
      searchInputRef.current?.focus();
    }
  }, [selectedArtist]);

  const handleSelectSong = useCallback(
    (songTitle, artistName) => {
      navigate(
        `/episodes?song=${encodeURIComponent(songTitle)}&artist=${encodeURIComponent(artistName)}`,
      );
    },
    [navigate],
  );

  const handleSelectAlbum = useCallback(
    (artistName, albumName) => {
      navigate(
        `/artists?artist=${encodeURIComponent(artistName)}&album=${encodeURIComponent(albumName)}`,
      );
    },
    [navigate],
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (!selectedArtistRef.current) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      handleCloseDashboard();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCloseDashboard]);

  const { artists, songs, albums } = searchState.results;
  const totalMatches = artists.length + songs.length + albums.length;

  return (
    <section className="search-workspace" aria-label="Catalog search">
      <div className="surface-region search-hero-card">
        {!selectedArtist ? (
          <div className="search-hero-head">
            <div>
              <h1>Catalog Search</h1>
              <p className="search-hero-sub">
                Search artists, songs, and albums across every archived episode.
              </p>
            </div>
            {trimmedQ.length >= 2 && !loading && !error ? (
              <span className="search-match-badge" aria-live="polite">
                <span className="mono">{formatInt(totalMatches)}</span>{' '}
                {totalMatches === 1 ? 'match' : 'matches'}
              </span>
            ) : null}
          </div>
        ) : null}

        <form
          className="search-hero-form"
          role="search"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="search-input-wrap">
            <span className="search-input-icon" aria-hidden="true">
              <Icon name="search" size="md" />
            </span>
            <input
              ref={searchInputRef}
              id="global-search-input"
              type="search"
              enterKeyHint="search"
              className="search-input--hero"
              aria-label="Search the catalog"
              placeholder="e.g. Townes Van Zandt, Pancho & Lefty"
              value={searchInput}
              onChange={(event) => {
                dismissedAutoOpenQueryRef.current = null;
                setSearchInput(event.target.value);
              }}
            />
          </div>
          {searchInput || q ? (
            <button
              type="button"
              className="btn btn-secondary search-clear-btn"
              aria-label="Clear search"
              onClick={handleClearSearch}
            >
              Clear
            </button>
          ) : null}
        </form>
      </div>

      {selectedArtist ? (
        <ArtistDashboard
          artistName={selectedArtist}
          onBack={handleCloseDashboard}
          onSelectArtist={handleSelectArtist}
        />
      ) : trimmedQ.length < 2 ? (
        <div className="surface-region search-guidance">
          <p className="search-guidance-title">Ready to search</p>
          <p className="search-guidance-copy">
            Enter at least 2 characters to inspect artist catalogs, episode air dates, and album rotations.
          </p>
        </div>
      ) : loading ? (
        <SkeletonRows count={6} label="Searching catalog" />
      ) : error ? (
        <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : totalMatches === 0 ? (
        <EmptyFilterState items="archive entries" onClear={handleClearSearch} />
      ) : (
        <SearchResultsGrid
          query={q}
          artists={artists}
          songs={songs}
          albums={albums}
          selectedArtist={selectedArtist}
          isCompact={isCompact}
          onSelectArtist={handleSelectArtist}
          onSelectSong={handleSelectSong}
          onSelectAlbum={handleSelectAlbum}
        />
      )}
    </section>
  );
}
