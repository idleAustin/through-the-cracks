// Global Catalog Search workspace: debounced URL-synced query, search results grid, and ArtistInspector.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { searchAll } from '../api';
import ArtistInspector from '../components/ArtistInspector';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import SearchResultsGrid from '../components/SearchResultsGrid';
import { formatInt, useMediaQuery } from '../utils/format';

const EMPTY_RESULTS = { artists: [], songs: [], albums: [] };

export default function SearchView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNarrow = useMediaQuery('(max-width: 1024px)');
  const isCompact = useMediaQuery('(max-width: 768px)');

  const q = searchParams.get('q') || '';
  const selectedArtist = searchParams.get('artist') || '';
  const selectedAlbum = searchParams.get('album') || '';

  const [searchInput, setSearchInput] = useState(q);
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  const selectedArtistRef = useRef(selectedArtist);
  selectedArtistRef.current = selectedArtist;
  const prevQRef = useRef(q);

  useEffect(() => {
    if (q !== prevQRef.current) {
      prevQRef.current = q;
      setSearchInput(q);
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
          return next;
        },
        { replace: true },
      );
    }, 200);

    return () => window.clearTimeout(timer);
  }, [searchInput, q, setSearchParams]);

  const trimmedQ = q.trim();

  useEffect(() => {
    if (trimmedQ.length < 2) {
      setResults(EMPTY_RESULTS);
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
        setResults({
          artists: payload.artists || [],
          songs: payload.songs || [],
          albums: payload.albums || [],
        });
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setResults(EMPTY_RESULTS);
        setError(err?.message || 'Could not search catalog.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [trimmedQ, retryKey]);

  const handleClearSearch = useCallback(() => {
    prevQRef.current = '';
    setSearchInput('');
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('q');
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

  const handleCloseInspector = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    next.delete('artist');
    next.delete('album');
    setSearchParams(next);
  }, [setSearchParams]);

  const handleAlbumChange = useCallback(
    (nextAlbum) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextAlbum) next.set('album', nextAlbum);
        else next.delete('album');
        return next;
      });
    },
    [setSearchParams],
  );

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
      const hasArtist =
        Boolean(selectedArtistRef.current) ||
        new URLSearchParams(window.location.search).has('artist');
      if (!hasArtist) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      handleCloseInspector();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCloseInspector]);

  if (isNarrow && selectedArtist) {
    return (
      <section className="search-workspace" aria-label="Catalog search">
        <ArtistInspector
          artistName={selectedArtist}
          album={selectedAlbum}
          isNarrow
          onClose={handleCloseInspector}
          onAlbumChange={handleAlbumChange}
          onSelectSong={handleSelectSong}
        />
      </section>
    );
  }

  const { artists, songs, albums } = results;
  const totalMatches = artists.length + songs.length + albums.length;

  return (
    <section className="search-workspace" aria-label="Catalog search">
      <div className="surface-region search-hero-card">
        <div className="search-hero-head">
          <div>
            <h1>Catalog Search</h1>
            <p className="search-hero-sub">
              Search artists, songs, and albums across every archived broadcast.
            </p>
          </div>
          {trimmedQ.length >= 2 && !loading && !error ? (
            <span className="mono">{formatInt(totalMatches)} matches</span>
          ) : null}
        </div>

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
              id="global-search-input"
              type="search"
              enterKeyHint="search"
              className="search-input--hero"
              aria-label="Search the catalog"
              placeholder="Search artists, songs, or albums..."
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
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

      {trimmedQ.length < 2 ? (
        <div className="surface-region search-guidance">
          <p className="search-guidance-title">Search across artists, songs, and albums</p>
          <p className="search-guidance-copy">
            Enter at least 2 characters to inspect artist catalogs, broadcast air dates, and album rotations.
          </p>
        </div>
      ) : loading ? (
        <SkeletonRows count={6} label="Searching catalog" />
      ) : error ? (
        <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : totalMatches === 0 ? (
        <EmptyFilterState items="archive entries" onClear={handleClearSearch} />
      ) : (
        <div className={`catalog-cockpit${selectedArtist && !isNarrow ? ' has-inspector' : ''}`}>
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

          {selectedArtist && !isNarrow ? (
            <ArtistInspector
              artistName={selectedArtist}
              album={selectedAlbum}
              isNarrow={false}
              onClose={handleCloseInspector}
              onAlbumChange={handleAlbumChange}
              onSelectSong={handleSelectSong}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
