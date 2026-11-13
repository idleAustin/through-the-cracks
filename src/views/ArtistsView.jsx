// Paginated Artists catalog with sort lens, scope cap, search filter, and inline/push ArtistInspector.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getArtists } from '../api';
import ArtistInspector from '../components/ArtistInspector';
import { ScopeCapSelect, SortLensToggle } from '../components/CatalogControls';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';
import { formatAirDate, formatInt, useMediaQuery } from '../utils/format';

const VALID_CAPS = new Set(['10', '25', '50', '100', 'all']);

export default function ArtistsView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNarrow = useMediaQuery('(max-width: 1024px)');
  const isCompact = useMediaQuery('(max-width: 768px)');

  const q = searchParams.get('q') || '';
  const sort = searchParams.get('sort') === 'obscure' ? 'obscure' : 'top';
  const rawCap = searchParams.get('cap') || 'all';
  const cap = VALID_CAPS.has(rawCap) ? rawCap : 'all';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = cap === '10' ? 10 : 25;
  const selectedArtist = searchParams.get('artist') || '';
  const selectedAlbum = searchParams.get('album') || '';

  const [searchInput, setSearchInput] = useState(q);
  const [result, setResult] = useState({ items: [], pagination: null, unboundedTotal: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  useEffect(() => {
    if (searchInput.trim() === q) return undefined;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const trimmed = searchInput.trim();
          if (trimmed) next.set('q', trimmed);
          else next.delete('q');
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput, q, setSearchParams]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getArtists({ search: q, sort, cap, page, limit })
      .then((res) => {
        if (!active) return;
        const payload = res.data || {};
        setResult({
          items: payload.items || payload.artists || [],
          pagination: payload.pagination || {
            page,
            limit,
            total: payload.total ?? 0,
            totalPages: Math.max(1, Math.ceil((payload.total ?? 0) / limit)),
          },
          unboundedTotal: payload.unboundedTotal ?? payload.total ?? 0,
        });
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err?.message || 'Could not load artists catalog.');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [q, sort, cap, page, limit, retryKey]);

  const handleSortChange = useCallback(
    (nextSort) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextSort === 'obscure') next.set('sort', 'obscure');
        else next.delete('sort');
        next.delete('page');
        return next;
      });
    },
    [setSearchParams],
  );

  const handleCapChange = useCallback(
    (nextCap) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextCap && nextCap !== 'all') next.set('cap', nextCap);
        else next.delete('cap');
        next.delete('page');
        return next;
      });
    },
    [setSearchParams],
  );

  const handlePageChange = useCallback(
    (nextPage) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextPage > 1) next.set('page', String(nextPage));
        else next.delete('page');
        return next;
      });
    },
    [setSearchParams],
  );

  const handleClearFilter = useCallback(() => {
    setSearchInput('');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('q');
      next.delete('page');
      return next;
    });
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

  const selectedArtistRef = useRef(selectedArtist);
  selectedArtistRef.current = selectedArtist;
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

  if (isNarrow && selectedArtist) {
    return (
      <section className="catalog-page" aria-label="Artists catalog">
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

  const pagination = result.pagination || { page, limit, total: 0, totalPages: 1 };
  const startRank = (pagination.page - 1) * pagination.limit;
  const showDesktopInspector = !isNarrow && Boolean(selectedArtist);

  return (
    <section className="catalog-page" aria-label="Artists catalog">
      <header className="catalog-head">
        <div>
          <h1>Artists</h1>
          <p className="catalog-subtitle">
            {result.unboundedTotal > 0
              ? `${formatInt(result.unboundedTotal)} artists across the archive`
              : 'Browse catalog spin rankings'}
          </p>
        </div>
      </header>

      <div className="catalog-toolbar">
        <div className="search-wrapper">
          <Icon name="search" size="sm" className="search-icon" />
          <input
            id="artist-search-input"
            type="search"
            className="search-input"
            placeholder="Filter artists..."
            aria-label="Search artists"
            enterKeyHint="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        <div className="catalog-controls-row">
          <SortLensToggle sort={sort} onChange={handleSortChange} />
          <ScopeCapSelect cap={cap} onChange={handleCapChange} />
        </div>
      </div>

      <div className={showDesktopInspector ? 'split-workspace has-detail' : 'split-workspace'}>
        <div className="catalog-main">
          {loading ? (
            <div className="surface-region catalog-state">
              <SkeletonRows label="Loading artists" />
            </div>
          ) : error ? (
            <div className="surface-region catalog-state">
              <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
            </div>
          ) : result.items.length === 0 ? (
            <div className="surface-region catalog-state">
              <EmptyFilterState items="artists" onClear={q ? handleClearFilter : undefined} />
            </div>
          ) : isCompact ? (
            <div className="m-card-stack">
              {result.items.map((item, idx) => {
                const rank = startRank + idx + 1;
                const artistName = item.name || item.artist || '';
                const lastSpin = item.lastAppearance || item.lastPlayed || '';
                const isSelected = selectedArtist === artistName;
                return (
                  <button
                    key={artistName || rank}
                    type="button"
                    className={`m-card m-card--interactive${isSelected ? ' is-selected' : ''}`}
                    onClick={() => handleSelectArtist(artistName)}
                  >
                    <div className="m-card-top">
                      <span className="m-card-title">
                        {rank}. {artistName}
                      </span>
                      <span className="spin-count font-mono num">
                        {formatInt(item.totalPlays)} {item.totalPlays === 1 ? 'spin' : 'spins'}
                      </span>
                    </div>
                    <div className="m-card-meta">
                      <span>{formatInt(item.uniqueSongs)} songs</span>
                      <span>·</span>
                      <span>{formatInt(item.uniqueAlbums)} albums</span>
                      <span>·</span>
                      <span>Last {formatAirDate(lastSpin)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="surface-region">
              <div className="table-container">
                <table id="artists-table" className="data-table catalog-table">
                  <thead>
                    <tr>
                      <th scope="col" className="col-rank">Rank</th>
                      <th scope="col">Artist</th>
                      <th scope="col" className="col-num">Spins</th>
                      <th scope="col" className="col-num">Songs</th>
                      <th scope="col" className="col-num">Albums</th>
                      <th scope="col" className="col-num">Last Spin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((item, idx) => {
                      const rank = startRank + idx + 1;
                      const artistName = item.name || item.artist || '';
                      const lastSpin = item.lastAppearance || item.lastPlayed || '';
                      const isSelected = selectedArtist === artistName;
                      return (
                        <tr
                          key={artistName || rank}
                          className={`row-clickable${isSelected ? ' is-selected' : ''}`}
                          tabIndex={0}
                          onClick={() => handleSelectArtist(artistName)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleSelectArtist(artistName);
                            }
                          }}
                        >
                          <td className="col-rank cell-mono">{rank} </td>
                          <td className="cell-primary">{artistName} </td>
                          <td className="col-num cell-mono">{formatInt(item.totalPlays)} </td>
                          <td className="col-num cell-mono">{formatInt(item.uniqueSongs)} </td>
                          <td className="col-num cell-mono">{formatInt(item.uniqueAlbums)} </td>
                          <td className="col-num cell-mono cell-dim">
                            {formatAirDate(lastSpin)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && !error && result.items.length > 0 && (
            <Pagination
              pagination={pagination}
              page={page}
              onPageChange={handlePageChange}
              noun="artists"
              idPrefix="artists"
            />
          )}
        </div>

        {showDesktopInspector && (
          <ArtistInspector
            artistName={selectedArtist}
            album={selectedAlbum}
            isNarrow={false}
            onClose={handleCloseInspector}
            onAlbumChange={handleAlbumChange}
            onSelectSong={handleSelectSong}
          />
        )}
      </div>
    </section>
  );
}
