// Global catalog search view with debounced queries, loading skeletons, and empty/error states.
import React, { useEffect, useState } from 'react';
import { searchAll } from '../api';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';

function ResultPanel({ icon, title, count, empty, children }) {
  return (
    <section className="ink-panel panel-pad">
      <div className="panel-header">
        <h3 className="panel-title">
          <Icon name={icon} />
          {title}
        </h3>
        <span className="badge">{count}</span>
      </div>
      {count > 0 ? <div className="list-stack">{children}</div> : <p className="state-empty">{empty}</p>}
    </section>
  );
}

export default function SearchView({ onSelectArtist }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!query || query.trim().length < 2) {
      setResults(null);
      setError('');
      setLoading(false);
      return undefined;
    }

    let isMounted = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError('');
      searchAll(query)
        .then((res) => {
          if (isMounted) {
            setResults(res.data);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (isMounted) {
            setError(err?.message || 'Could not search archive catalog.');
            setLoading(false);
          }
        });
    }, 250);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [query, retryKey]);

  const totalMatches = results
    ? (results.artists?.length || 0) + (results.songs?.length || 0) + (results.albums?.length || 0)
    : 0;

  return (
    <div className="ink-panel panel-pad-lg">
      <div className="search-hero">
        <h2>Global Catalog Search</h2>
        <p>Search instantly across 36,000+ spins, 1,600+ artists, and 6,000+ albums</p>

        <div className="search-wrapper search-wrapper--hero">
          <Icon name="search" className="search-icon" size="lg" />
          <input
            id="global-search-input"
            type="search"
            enterKeyHint="search"
            className="search-input search-input--hero"
            placeholder="Artist, song, or album…"
            aria-label="Search the catalog"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
      </div>

      {loading ? (
        <SkeletonRows count={4} label="Searching catalog" />
      ) : error ? (
        <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : results && totalMatches === 0 ? (
        <EmptyFilterState items="catalog entries" onClear={() => setQuery('')} />
      ) : results ? (
        <div className="grid-auto">
          <ResultPanel
            icon="mic"
            title="Artists"
            count={results.artists?.length || 0}
            empty="No matching artists found."
          >
            {results.artists?.map((artist, idx) => (
              <button
                key={idx}
                type="button"
                className="list-row list-row--clickable"
                onClick={() => onSelectArtist?.(artist.name)}
              >
                <span className="list-row-main">
                  <span className="list-row-text">
                    <span className="list-row-title">{artist.name}</span>
                  </span>
                </span>
                <span className="metric-value">{artist.plays} spins</span>
              </button>
            ))}
          </ResultPanel>

          <ResultPanel
            icon="music_note"
            title="Songs"
            count={results.songs?.length || 0}
            empty="No matching songs found."
          >
            {results.songs?.map((song, idx) => (
              <div key={idx} className="list-row">
                <span className="list-row-main">
                  <span className="list-row-text">
                    <span className="list-row-title">"{song.songTitle}"</span>
                    <span className="list-row-sub">{song.artist}</span>
                  </span>
                </span>
                <span className="metric-value">{song.plays} spins</span>
              </div>
            ))}
          </ResultPanel>

          <ResultPanel
            icon="album"
            title="Albums"
            count={results.albums?.length || 0}
            empty="No matching albums found."
          >
            {results.albums?.map((album, idx) => (
              <div key={idx} className="list-row">
                <span className="list-row-main">
                  <span className="list-row-text">
                    <span className="list-row-title">{album.album}</span>
                    <span className="list-row-sub">{album.artist}</span>
                  </span>
                </span>
                <span className="metric-value">{album.plays} spins</span>
              </div>
            ))}
          </ResultPanel>
        </div>
      ) : null}
    </div>
  );
}
