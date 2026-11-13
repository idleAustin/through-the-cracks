// Artist directory view with search filter, loading skeletons, empty/error states, and pagination.
import React, { useEffect, useRef, useState } from 'react';
import { getArtists } from '../api';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';

export default function ArtistsView({ initialSearch = '', onSelectArtist }) {
  const [search, setSearch] = useState(initialSearch);
  const [page, setPage] = useState(1);
  const [artistsData, setArtistsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const inFlightRef = useRef({ key: null, promise: null });

  useEffect(() => {
    let isMounted = true;
    const requestKey = `${search}:${page}:${retryKey}`;
    if (inFlightRef.current.key !== requestKey) {
      inFlightRef.current = { key: requestKey, promise: getArtists(search, page, 20) };
    }
    setLoading(true);
    setError('');
    inFlightRef.current.promise
      .then((res) => {
        if (isMounted) {
          setArtistsData(res.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err?.message || 'Could not load artists.');
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
            <Icon name="mic" />
            Artist Directory
          </h2>
          <div className="panel-subtitle">
            Ranking of all {artistsData?.pagination?.total?.toLocaleString() || '1,648'} artists
            played on Through the Cracks
          </div>
        </div>

        <div className="search-wrapper">
          <Icon name="search" className="search-icon" />
          <input
            id="artist-search-input"
            type="search"
            enterKeyHint="search"
            className="search-input"
            placeholder="Search artists (e.g. Dylan, Lucinda, Prine)…"
            aria-label="Search artists"
            value={search}
            onChange={handleSearchChange}
          />
        </div>
      </div>

      {loading ? (
        <SkeletonRows label="Loading artists" />
      ) : error ? (
        <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : !artistsData?.artists?.length ? (
        <EmptyFilterState items="artists" onClear={handleClearFilter} />
      ) : (
        <>
          <div className="table-container">
            <table className="data-table" id="artists-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Artist</th>
                  <th>Spins</th>
                  <th>Songs</th>
                  <th>Albums</th>
                  <th>First Spun</th>
                  <th>Last Spun</th>
                </tr>
              </thead>
              <tbody>
                {artistsData.artists.map((artist, idx) => {
                  const rank = ((page - 1) * 20) + idx + 1;
                  return (
                    <tr
                      key={idx}
                      id={`artist-row-${rank}`}
                      className="row-clickable"
                      tabIndex={0}
                      onClick={() => onSelectArtist?.(artist.name)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectArtist?.(artist.name);
                        }
                      }}
                    >
                      <td className="cell-mono cell-dim">{rank}</td>
                      <td className="cell-primary">{artist.name}</td>
                      <td><span className="badge badge-accent">{artist.totalPlays} spins</span></td>
                      <td className="cell-mono">{artist.uniqueSongs}</td>
                      <td className="cell-mono">{artist.uniqueAlbums}</td>
                      <td className="cell-dim">{artist.firstAppearance || '—'}</td>
                      <td className="cell-dim">{artist.lastAppearance || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            pagination={artistsData?.pagination}
            page={page}
            onPageChange={setPage}
            noun="artists"
            idPrefix="artist"
          />
        </>
      )}
    </section>
  );
}
