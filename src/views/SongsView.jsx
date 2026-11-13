// Song library view with search filter, loading skeletons, empty/error states, and pagination.
import React, { useEffect, useRef, useState } from 'react';
import { getSongs } from '../api';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';

export default function SongsView({ onSelectArtist }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [songsData, setSongsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const inFlightRef = useRef({ key: null, promise: null });

  useEffect(() => {
    let isMounted = true;
    const requestKey = `${search}:${page}:${retryKey}`;
    if (inFlightRef.current.key !== requestKey) {
      inFlightRef.current = { key: requestKey, promise: getSongs(search, page, 20) };
    }
    setLoading(true);
    setError('');
    inFlightRef.current.promise
      .then((res) => {
        if (isMounted) {
          setSongsData(res.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err?.message || 'Could not load songs.');
          setLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [search, page, retryKey]);

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setPage(1);
  };

  const handleClearFilter = () => {
    setSearch('');
    setPage(1);
  };

  return (
    <section className="ink-panel panel-pad">
      <div className="controls-bar">
        <div>
          <h2 className="panel-title">
            <Icon name="music_note" />
            Song Library
          </h2>
          <div className="panel-subtitle">
            All {songsData?.pagination?.total?.toLocaleString() || '—'} unique songs
            played on Through the Cracks, ranked by total spins
          </div>
        </div>

        <div className="search-wrapper">
          <Icon name="search" className="search-icon" />
          <input
            id="song-search-input"
            type="search"
            enterKeyHint="search"
            className="search-input"
            placeholder="Search songs or artists…"
            aria-label="Search songs"
            value={search}
            onChange={handleSearchChange}
          />
        </div>
      </div>

      {loading ? (
        <SkeletonRows label="Loading songs" />
      ) : error ? (
        <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : !songsData?.songs?.length ? (
        <EmptyFilterState items="songs" onClear={handleClearFilter} />
      ) : (
        <>
          <div className="table-container">
            <table className="data-table" id="songs-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Song</th>
                  <th>Artist</th>
                  <th>Album</th>
                  <th>First Spun</th>
                  <th>Last Spun</th>
                  <th>Spins</th>
                </tr>
              </thead>
              <tbody>
                {songsData.songs.map((song, idx) => {
                  const rank = ((page - 1) * 20) + idx + 1;
                  return (
                    <tr
                      key={idx}
                      id={`song-row-${rank}`}
                      className="row-clickable"
                      tabIndex={0}
                      onClick={() => onSelectArtist?.(song.artist)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectArtist?.(song.artist);
                        }
                      }}
                    >
                      <td className="cell-mono cell-dim">{rank}</td>
                      <td className="cell-primary">{song.songTitle}</td>
                      <td>{song.artist}</td>
                      <td className="cell-dim">{song.album || '—'}</td>
                      <td className="cell-dim">{song.firstPlayed || '—'}</td>
                      <td className="cell-dim">{song.lastPlayed || '—'}</td>
                      <td><span className="badge badge-accent">{song.totalPlays} spins</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            pagination={songsData?.pagination}
            page={page}
            onPageChange={setPage}
            noun="songs"
            idPrefix="song"
          />
        </>
      )}
    </section>
  );
}
