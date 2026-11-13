// Catalog lens toggle and asymmetric linked Artists (~316px) and Songs (1fr) Overview cards.
import React from 'react';
import { Link } from 'react-router-dom';
import { formatInt } from '../utils/format';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from './DataState';
import Icon from './Icon';

function CardFooterPager({ pagination, page, onPageChange, ariaLabel, isCompact }) {
  if (!pagination) return null;
  const totalPages = Number(pagination.totalPages ?? 1);
  if (totalPages <= 1) return null;
  const currentPage = Math.min(totalPages, Math.max(1, page));
  const btnClass = `page-btn ${isCompact ? 'is-mobile' : 'btn-sm'}`;

  return (
    <nav className="overview-card-pager" aria-label={ariaLabel}>
      <button
        type="button"
        className={btnClass}
        disabled={currentPage <= 1}
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
      >
        ← Prev
      </button>
      <span className="pagination-readout font-mono num">
        {currentPage} / {totalPages}
      </span>
      <button
        type="button"
        className={btnClass}
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
      >
        Next →
      </button>
    </nav>
  );
}

export default function OverviewCards({
  overview,
  rank,
  cap,
  apage,
  spage,
  rowCap,
  selectedArtist,
  focusedSong,
  isCompact,
  artistsState,
  songsState,
  onRankChange,
  onCapChange,
  onArtistsPageChange,
  onSongsPageChange,
  onSelectArtist,
  onClearArtistScope,
  onSelectSong,
  onViewSongDates,
  onRetryArtists,
  onRetrySongs,
}) {
  const isObscure = rank === 'obscure';
  const artistHeading = isObscure ? 'Obscure Artists' : 'Top Artists';
  const songHeading = selectedArtist
    ? `Songs · ${selectedArtist}`
    : (isObscure ? 'Obscure Songs' : 'Top Songs');
  const artistOffset = ((artistsState.pagination?.page ?? apage) - 1) * rowCap;
  const songOffset = ((songsState.pagination?.page ?? spage) - 1) * rowCap;

  const capOptions = [
    { value: '10', label: isObscure ? 'First 10' : 'Top 10' },
    { value: '25', label: isObscure ? 'First 25' : 'Top 25' },
    { value: '50', label: isObscure ? 'First 50' : 'Top 50' },
    { value: '100', label: isObscure ? 'First 100' : 'Top 100' },
    { value: 'all', label: 'All' },
  ];

  return (
    <>
      <div className="catalog-lens-bar">
        <div className="lens-bar-left">
          <div className="seg-group" role="group" aria-label="Catalog ranking mode">
            <button
              type="button"
              className="seg-btn"
              aria-pressed={!isObscure}
              onClick={() => onRankChange('top')}
            >
              Most Played
            </button>
            <button
              type="button"
              className="seg-btn"
              aria-pressed={isObscure}
              onClick={() => onRankChange('obscure')}
            >
              Most Obscure
            </button>
          </div>
          <span className="lens-summary">
            {isObscure
              ? `Single-spin deep cuts · ${formatInt(overview.oneSpinArtists)} artists & ${formatInt(overview.oneSpinSongs)} songs played once`
              : `Ranked by all-time spins across ${formatInt(overview.totalEpisodes)} broadcasts`}
          </span>
        </div>
      </div>

      <div className="overview-split-grid">
        <section className="surface-region overview-artists-card" aria-label={artistHeading}>
          <div className="region-toolbar">
            <h2>{artistHeading}</h2>
            <div className="overview-toolbar-actions">
              {isCompact && selectedArtist && (
                <Link
                  to={`/artists?artist=${encodeURIComponent(selectedArtist)}`}
                  className="m-dates-link"
                >
                  Catalog ›
                </Link>
              )}
              <select
                className="overview-cap-select"
                aria-label="List cap"
                value={cap}
                onChange={(e) => onCapChange(e.target.value)}
              >
                {capOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {artistsState.loading ? (
            <div className="overview-card-state">
              <SkeletonRows count={5} label="Loading artists" />
            </div>
          ) : artistsState.error ? (
            <div className="overview-card-state">
              <ArchiveErrorState message={artistsState.error} onRetry={onRetryArtists} />
            </div>
          ) : artistsState.items.length === 0 ? (
            <div className="overview-card-state">
              <EmptyFilterState items="artists" />
            </div>
          ) : isCompact ? (
            <div className="m-card-stack overview-mobile-list">
              {artistsState.items.map((item, idx) => {
                const artistName = item.name || item.artist || '';
                const absRank = artistOffset + idx + 1;
                const isSelected = selectedArtist === artistName;
                return (
                  <button
                    key={artistName || absRank}
                    type="button"
                    className={`m-card m-card--interactive${isSelected ? ' is-selected' : ''}`}
                    onClick={() => onSelectArtist(artistName)}
                  >
                    <div className="m-card-top">
                      <span className="m-card-title">
                        #{absRank} · {artistName}
                      </span>
                      <span className="spin-count font-mono num">
                        {formatInt(item.totalPlays)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="table-container">
              <table className="data-table overview-table">
                <thead>
                  <tr>
                    <th scope="col" className="col-rank">#</th>
                    <th scope="col">Artist</th>
                    <th scope="col" className="col-num">Spins</th>
                  </tr>
                </thead>
                <tbody>
                  {artistsState.items.map((item, idx) => {
                    const artistName = item.name || item.artist || '';
                    const absRank = artistOffset + idx + 1;
                    const isSelected = selectedArtist === artistName;
                    return (
                      <tr
                        key={artistName || absRank}
                        className={`row-clickable${isSelected ? ' is-selected' : ''}`}
                        tabIndex={0}
                        onClick={() => onSelectArtist(artistName)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectArtist(artistName);
                          }
                        }}
                      >
                        <td className="col-rank cell-mono">{absRank} </td>
                        <td className="cell-primary cell-truncate" title={artistName}>
                          {artistName}{' '}
                        </td>
                        <td className="col-num cell-mono">{formatInt(item.totalPlays)} </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <CardFooterPager
            pagination={artistsState.pagination}
            page={apage}
            onPageChange={onArtistsPageChange}
            ariaLabel="Artists pagination"
            isCompact={isCompact}
          />
        </section>

        <section className="surface-region overview-songs-card" aria-label={songHeading}>
          <div className="region-toolbar">
            <h2>{songHeading}</h2>
            {selectedArtist && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onClearArtistScope}
              >
                All Artists
              </button>
            )}
          </div>

          {songsState.loading ? (
            <div className="overview-card-state">
              <SkeletonRows count={5} label="Loading songs" />
            </div>
          ) : songsState.error ? (
            <div className="overview-card-state">
              <ArchiveErrorState message={songsState.error} onRetry={onRetrySongs} />
            </div>
          ) : songsState.items.length === 0 ? (
            <div className="overview-card-state">
              <EmptyFilterState items="songs" />
            </div>
          ) : isCompact ? (
            <div className="m-card-stack overview-mobile-list">
              {songsState.items.map((item, idx) => {
                const absRank = songOffset + idx + 1;
                const songArtist = item.artist || selectedArtist || '';
                const albumText =
                  item.album || (Array.isArray(item.albums) && item.albums[0]) || '—';
                const isSelected =
                  focusedSong?.title === item.songTitle && focusedSong?.artist === songArtist;
                return (
                  <div
                    key={`${songArtist}-${item.songTitle}-${absRank}`}
                    role="button"
                    tabIndex={0}
                    className={`m-card m-card--interactive${isSelected ? ' is-selected' : ''}`}
                    onClick={() => onSelectSong(item.songTitle, songArtist)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onSelectSong(item.songTitle, songArtist);
                      }
                    }}
                  >
                    <div className="m-card-top">
                      <span className="m-card-title">
                        #{absRank} · {item.songTitle}
                      </span>
                      <span className="spin-count font-mono num">
                        {formatInt(item.totalPlays)}
                      </span>
                    </div>
                    <div className="m-card-meta" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>
                        {songArtist}
                        {albumText !== '—' ? ` · ${albumText}` : ''}
                      </span>
                      <button
                        type="button"
                        className="m-dates-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          onViewSongDates(item.songTitle, songArtist);
                        }}
                      >
                        <Icon name="calendar" size={12} />
                        Dates ›
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="table-container">
              <table className="data-table overview-table overview-songs-table">
                <thead>
                  <tr>
                    <th scope="col" className="col-rank">#</th>
                    <th scope="col" className="col-song">Song</th>
                    <th scope="col" className="col-artist">Artist</th>
                    <th scope="col" className="col-album">Album</th>
                    <th scope="col" className="col-num">Spins</th>
                    <th scope="col" className="col-act" aria-label="Air dates"></th>
                  </tr>
                </thead>
                <tbody>
                  {songsState.items.map((item, idx) => {
                    const absRank = songOffset + idx + 1;
                    const songArtist = item.artist || selectedArtist || '';
                    const albumText =
                      item.album || (Array.isArray(item.albums) && item.albums[0]) || '—';
                    const isSelected =
                      focusedSong?.title === item.songTitle && focusedSong?.artist === songArtist;
                    return (
                      <tr
                        key={`${songArtist}-${item.songTitle}-${absRank}`}
                        className={`row-clickable${isSelected ? ' is-selected' : ''}`}
                        tabIndex={0}
                        onClick={() => onSelectSong(item.songTitle, songArtist)}
                        onKeyDown={(e) => {
                          if (
                            e.target === e.currentTarget &&
                            (e.key === 'Enter' || e.key === ' ')
                          ) {
                            e.preventDefault();
                            onSelectSong(item.songTitle, songArtist);
                          }
                        }}
                      >
                        <td className="col-rank cell-mono">{absRank} </td>
                        <td className="cell-primary cell-truncate" title={item.songTitle}>
                          {item.songTitle}{' '}
                        </td>
                        <td className="cell-truncate" title={songArtist}>{songArtist} </td>
                        <td className="cell-dim cell-truncate" title={albumText}>{albumText} </td>
                        <td className="col-num cell-mono">{formatInt(item.totalPlays)} </td>
                        <td className="col-act">
                          <span className="tooltip-wrapper tip-left">
                            <button
                              type="button"
                              className="subtle-dates-btn"
                              aria-label={`Air dates for ${item.songTitle}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onViewSongDates(item.songTitle, songArtist);
                              }}
                            >
                              <Icon name="calendar" size={14} />
                            </button>
                            <span className="tooltip-bubble" role="tooltip">
                              <span>Air dates</span>
                            </span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <CardFooterPager
            pagination={songsState.pagination}
            page={spage}
            onPageChange={onSongsPageChange}
            ariaLabel="Songs pagination"
            isCompact={isCompact}
          />
        </section>
      </div>
    </>
  );
}
