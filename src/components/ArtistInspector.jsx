// Shared inline (desktop >1024px) and Full-Screen Push (<=1024px) Artist catalog inspector.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getArtistSongs } from '../api';
import { formatAirDate, formatInt, useMediaQuery } from '../utils/format';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from './DataState';
import Icon from './Icon';

export default function ArtistInspector({
  artistName,
  album = '',
  isNarrow = false,
  onClose,
  onAlbumChange,
  onSelectSong,
}) {
  const isCompact = useMediaQuery('(max-width: 768px)');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const inFlightRef = useRef({ key: null, promise: null });

  useEffect(() => {
    if (!artistName) return undefined;
    let active = true;
    const requestKey = `${artistName}:${retryKey}`;
    if (inFlightRef.current.key !== requestKey) {
      inFlightRef.current = { key: requestKey, promise: getArtistSongs(artistName) };
    }
    setLoading(true);
    setError('');
    inFlightRef.current.promise
      .then((res) => {
        if (active) {
          setData(res.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err?.message || `Could not load catalog for ${artistName}.`);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [artistName, retryKey]);

  useEffect(() => {
    if (!artistName) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [artistName, onClose]);

  const summary = data?.summary || {};
  const albums = useMemo(() => {
    if (Array.isArray(data?.albums) && data.albums.length > 0) return data.albums;
    const derived = new Set();
    for (const s of data?.songs || []) {
      const list = Array.isArray(s.albums) && s.albums.length > 0 ? s.albums : (s.album ? [s.album] : []);
      for (const alb of list) {
        if (alb) derived.add(alb);
      }
    }
    return [...derived];
  }, [data]);

  const filteredSongs = useMemo(() => {
    const songs = data?.songs || [];
    if (!album) return songs;
    return songs.filter((s) => {
      const list = Array.isArray(s.albums) && s.albums.length > 0 ? s.albums : (s.album ? [s.album] : []);
      return list.includes(album);
    });
  }, [data, album]);

  if (!artistName) return null;

  const containerClass = isNarrow ? 'surface-region push-view' : 'surface-region inline-inspector';

  return (
    <aside className={containerClass} aria-label={`${artistName} catalog inspector`}>
      {isNarrow && (
        <div className="push-detail-bar push-inspector-bar">
          <button
            type="button"
            className="btn btn-secondary push-back-btn"
            onClick={onClose}
          >
            <Icon name="arrow-left" size="sm" />
            Back
          </button>
        </div>
      )}

      <div className="inspector-head">
        <div className="inspector-head-title">
          <h2>{artistName}</h2>
          <p className="inspector-sub">Click any song to view its episode air dates</p>
        </div>
        {!isNarrow && (
          <button
            type="button"
            className="icon-action-btn sm"
            onClick={onClose}
            aria-label={`Close ${artistName} inspector`}
          >
            <Icon name="close" size="sm" />
          </button>
        )}
      </div>

      {loading ? (
        <div className="inspector-state">
          <SkeletonRows label={`Loading ${artistName} catalog`} />
        </div>
      ) : error ? (
        <div className="inspector-state">
          <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
        </div>
      ) : (
        <>
          <dl className="inspector-stats">
            <div className="inspector-stat-cell">
              <dt>Spins</dt>
              <dd className="font-mono num">{formatInt(summary.totalPlays)}</dd>
            </div>
            <div className="inspector-stat-cell">
              <dt>Songs</dt>
              <dd className="font-mono num">{formatInt(summary.uniqueSongs)}</dd>
            </div>
            <div className="inspector-stat-cell">
              <dt>Albums</dt>
              <dd className="font-mono num">{formatInt(summary.uniqueAlbums)}</dd>
            </div>
            <div className="inspector-stat-cell">
              <dt>First Spin</dt>
              <dd className="font-mono num">{formatAirDate(summary.firstAppearance)}</dd>
            </div>
            <div className="inspector-stat-cell">
              <dt>Last Spin</dt>
              <dd className="font-mono num">{formatAirDate(summary.lastAppearance)}</dd>
            </div>
          </dl>

          <div className="inspector-filter-bar">
            <select
              className="album-select"
              aria-label="Filter by album"
              value={album}
              onChange={(e) => onAlbumChange?.(e.target.value)}
            >
              <option value="">All Albums</option>
              {albums.map((alb) => (
                <option key={alb} value={alb}>{alb}</option>
              ))}
            </select>
          </div>

          <div className="inspector-body">
            {filteredSongs.length === 0 ? (
              <div className="inspector-state">
                <EmptyFilterState
                  items="songs"
                  onClear={album ? () => onAlbumChange?.('') : undefined}
                />
              </div>
            ) : isCompact ? (
              <div className="inspector-mobile-list">
                {filteredSongs.map((song, idx) => (
                  <Link
                    key={`${song.songTitle}-${idx}`}
                    to={`/episodes?song=${encodeURIComponent(song.songTitle)}&artist=${encodeURIComponent(artistName)}`}
                    className="m-card m-card--interactive inspector-song-link"
                    onClick={(e) => {
                      if (!onSelectSong || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      onSelectSong(song.songTitle, artistName);
                    }}
                  >
                    <div className="m-card-top">
                      <span className="m-card-title">#{idx + 1} · {song.songTitle}</span>
                      <span className="spin-count font-mono num">
                        {formatInt(song.totalPlays)} {song.totalPlays === 1 ? 'spin' : 'spins'} →
                      </span>
                    </div>
                    {song.album && (
                      <div className="m-card-meta">
                        <span>{song.album}</span>
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              <table className="data-table inspector-table">
                <thead>
                  <tr>
                    <th scope="col">Song</th>
                    <th scope="col">Album</th>
                    <th scope="col" className="col-num">Spins</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSongs.map((song, idx) => (
                    <tr
                      key={`${song.songTitle}-${idx}`}
                      className="is-interactive"
                      onClick={() => onSelectSong?.(song.songTitle, artistName)}
                    >
                      <td className="col-primary">{song.songTitle}</td>
                      <td className="cell-dim">{song.album || '—'}</td>
                      <td className="col-num cell-mono">{formatInt(song.totalPlays)} →</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
