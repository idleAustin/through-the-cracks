// Episodes archive view with two-pane desktop Broadcast Log, mobile Push Playlist, and year/song filtering.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getEpisodeById, getEpisodes } from '../api';
import BroadcastPlaylist from '../components/BroadcastPlaylist';
import { ArchiveErrorState, EmptyArchiveState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';
import { formatAirDate, formatInt, useMediaQuery } from '../utils/format';

const DEFAULT_ARCHIVE_YEARS = [
  '2026', '2025', '2024', '2023', '2022', '2021', '2020',
  '2019', '2018', '2017', '2016', '2015', '2014', '2013',
];

export default function EpisodesView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNarrow = useMediaQuery('(max-width: 1024px)');

  const year = searchParams.get('year') || '';
  const song = searchParams.get('song') || '';
  const artist = searchParams.get('artist') || '';
  const selectedEpisodeId = searchParams.get('episode') || '';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);

  const [episodesData, setEpisodesData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const listInFlightRef = useRef({ key: null, promise: null });

  const [detailEpisode, setDetailEpisode] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const detailInFlightRef = useRef({ key: null, promise: null });

  useEffect(() => {
    let isMounted = true;
    const requestKey = `${year}:${song}:${artist}:${page}:${retryKey}`;
    if (listInFlightRef.current.key !== requestKey) {
      listInFlightRef.current = {
        key: requestKey,
        promise: getEpisodes({ year, song, artist, page, limit: 20 }),
      };
    }
    setLoading(true);
    setError('');
    listInFlightRef.current.promise
      .then((res) => {
        if (isMounted) {
          setEpisodesData(res.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err?.message || 'Could not load episodes.');
          setLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [year, song, artist, page, retryKey]);

  const episodes = useMemo(
    () => episodesData?.episodes || episodesData?.items || [],
    [episodesData],
  );
  const total = Number(episodesData?.pagination?.total ?? episodesData?.total ?? episodes.length);
  const yearOptions = episodesData?.years?.length ? episodesData.years : DEFAULT_ARCHIVE_YEARS;

  const effectiveEpisodeId = isNarrow
    ? selectedEpisodeId
    : (episodes.some((ep) => ep.id === selectedEpisodeId) ? selectedEpisodeId : (episodes[0]?.id || ''));

  // Keep desktop URL ?episode= synced to the active rail selection.
  useEffect(() => {
    if (isNarrow || loading || error || episodes.length === 0) return;
    const exists = selectedEpisodeId && episodes.some((ep) => ep.id === selectedEpisodeId);
    if (!exists) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('episode', episodes[0].id);
        return next;
      }, { replace: true });
    }
  }, [isNarrow, loading, error, episodes, selectedEpisodeId, setSearchParams]);

  // Fetch active episode playlist when selection changes.
  useEffect(() => {
    if (!effectiveEpisodeId) {
      setDetailEpisode(null);
      setDetailLoading(false);
      setDetailError('');
      return undefined;
    }

    let isMounted = true;
    const requestKey = `${effectiveEpisodeId}:${detailRetryKey}`;
    if (detailInFlightRef.current.key !== requestKey) {
      detailInFlightRef.current = {
        key: requestKey,
        promise: getEpisodeById(effectiveEpisodeId),
      };
    }
    setDetailLoading(true);
    setDetailError('');
    detailInFlightRef.current.promise
      .then((res) => {
        if (isMounted) {
          setDetailEpisode(res.data);
          setDetailLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setDetailError(err?.message || 'Could not load episode playlist.');
          setDetailLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [effectiveEpisodeId, detailRetryKey]);

  // Escape closes mobile/narrow push detail without interfering with open dialogs.
  useEffect(() => {
    if (!isNarrow || !selectedEpisodeId) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('episode');
        return next;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isNarrow, selectedEpisodeId, setSearchParams]);

  const handleYearChange = (event) => {
    const nextYear = event.target.value;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (nextYear) next.set('year', nextYear);
      else next.delete('year');
      next.delete('page');
      next.delete('episode');
      return next;
    });
  };

  const handlePageChange = (nextPageOrFn) => {
    const target = typeof nextPageOrFn === 'function' ? nextPageOrFn(page) : nextPageOrFn;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (target > 1) next.set('page', String(target));
      else next.delete('page');
      next.delete('episode');
      return next;
    });
  };

  const handleSelectEpisode = (episodeId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('episode', episodeId);
      return next;
    });
  };

  const handleBackToList = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('episode');
      return next;
    });
  };

  const handleSelectSong = (songTitle, songArtist) => {
    const next = new URLSearchParams();
    next.set('song', songTitle);
    if (songArtist) next.set('artist', songArtist);
    navigate(`/episodes?${next.toString()}`);
  };

  const handleClearSongFilter = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('song');
      next.delete('artist');
      next.delete('page');
      next.delete('episode');
      return next;
    });
  };

  const handleClearAllFilters = () => {
    setSearchParams(new URLSearchParams());
  };

  const handleSelectArtist = (artistName) => {
    navigate(`/artists?artist=${encodeURIComponent(artistName)}`);
  };

  if (isNarrow && selectedEpisodeId) {
    return (
      <div className="episodes-view">
        <div className="push-detail-bar">
          <button
            type="button"
            className="btn btn-secondary push-back-btn"
            onClick={handleBackToList}
          >
            <Icon name="arrow-left" size="sm" />
            Back
          </button>
        </div>

        <BroadcastPlaylist
          episode={detailEpisode}
          loading={detailLoading}
          error={detailError}
          onRetry={() => setDetailRetryKey((k) => k + 1)}
          activeSong={song}
          activeArtist={artist}
          onSelectSong={handleSelectSong}
          onSelectArtist={handleSelectArtist}
        />
      </div>
    );
  }

  const yearSelect = (
    <select
      className="year-select"
      aria-label="Filter air dates by year"
      value={year}
      onChange={handleYearChange}
    >
      <option value="">All Years</option>
      {yearOptions.map((yr) => (
        <option key={yr} value={yr}>{yr}</option>
      ))}
    </select>
  );

  const showHeaderYearSelect = isNarrow || loading || Boolean(error) || episodes.length === 0;

  return (
    <div className="episodes-view">
      <div className="episodes-head">
        <div>
          <h1>Episodes</h1>
          <p className="episodes-subtitle">
            {song
              ? `${formatInt(total)} matching ${total === 1 ? 'air date' : 'air dates'}`
              : 'Episode air dates and ordered playlists (newest first)'}
          </p>
        </div>

        {showHeaderYearSelect ? (
          yearSelect
        ) : (
          <span className="episodes-count font-mono num">
            {formatInt(total)} archived air dates
          </span>
        )}
      </div>

      {song && (
        <div className="filter-banner">
          <span className="filter-banner-text">
            <strong>Played Song:</strong> &ldquo;{song}&rdquo;
            {artist ? ` — ${artist}` : ''}{' '}
            <span className="font-mono num">
              ({formatInt(total)} {total === 1 ? 'air date' : 'air dates'})
            </span>
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm filter-clear-btn"
            onClick={handleClearSongFilter}
          >
            Clear Song Filter
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonRows label="Loading episodes" />
      ) : error ? (
        <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : episodes.length === 0 ? (
        year || song ? (
          <EmptyFilterState items="episodes" onClear={handleClearAllFilters} />
        ) : (
          <EmptyArchiveState items="episodes" onRetry={() => setRetryKey((k) => k + 1)} />
        )
      ) : isNarrow ? (
        <>
          <div className="m-card-stack">
            {episodes.map((ep) => (
              <button
                key={ep.id}
                type="button"
                className="m-card"
                onClick={() => handleSelectEpisode(ep.id)}
              >
                <div className="m-card-top">
                  <span className="m-card-title">{formatAirDate(ep.airDate)}</span>
                  <span className="spin-count font-mono num">
                    {formatInt(ep.songCount)} {ep.songCount === 1 ? 'spin' : 'spins'} →
                  </span>
                </div>
              </button>
            ))}
          </div>

          <Pagination
            pagination={episodesData?.pagination}
            page={page}
            onPageChange={handlePageChange}
            noun="episodes"
            idPrefix="episodes"
          />
        </>
      ) : (
        <div className="broadcast-log">
          <aside className="surface-region airdate-rail" aria-label="Episode air dates">
            <div className="region-toolbar rail-toolbar">
              <h2 className="rail-title">Air Dates</h2>
              {yearSelect}
            </div>
            <div className="airdate-scroll" role="listbox" aria-label="Air date list">
              {episodes.map((ep) => {
                const selected = ep.id === effectiveEpisodeId;
                return (
                  <button
                    key={ep.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="airdate-row airdate-item"
                    onClick={() => handleSelectEpisode(ep.id)}
                  >
                    <span className="airdate-label">
                      {selected && <span className="nav-lime-dot" aria-hidden="true" />}
                      {formatAirDate(ep.airDate)}
                    </span>
                    <span className="spin-count font-mono num">
                      {formatInt(ep.songCount)} {ep.songCount === 1 ? 'spin' : 'spins'}
                    </span>
                  </button>
                );
              })}
            </div>
            <Pagination
              pagination={episodesData?.pagination}
              page={page}
              onPageChange={handlePageChange}
              noun="episodes"
              idPrefix="episodes"
              compact
            />
          </aside>

          <BroadcastPlaylist
            episode={detailEpisode}
            loading={detailLoading}
            error={detailError}
            onRetry={() => setDetailRetryKey((k) => k + 1)}
            activeSong={song}
            activeArtist={artist}
            onSelectSong={handleSelectSong}
            onSelectArtist={handleSelectArtist}
          />
        </div>
      )}
    </div>
  );
}
