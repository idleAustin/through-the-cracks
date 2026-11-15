// Playlist queue card rendering the desktop data table and mobile stacked hairline cards with per-slot Swap buttons.
import React from 'react';
import Icon from '../components/Icon';
import Tooltip from '../components/Tooltip';
import { formatDuration, formatInt, formatPlaylistRuntime } from '../utils/format';

export default function PlaylistQueueCard({
  queue,
  activeIndex,
  isMobile,
  canSwap,
  swappingSlots,
  onSelectIndex,
  onSwapIndex,
  onInspectArtist,
}) {
  const totalRuntimeLabel = formatPlaylistRuntime(queue);
  const runtimeMatch = totalRuntimeLabel.match(/^(\d+:\d{2})\s+runtime$/);

  return (
    <section className="surface-region booth-playlist" aria-label="Playlist queue">
      <div className="region-toolbar">
        <span className="booth-region-title">
          Playlist · <span className="font-mono num">{queue.length}</span> {queue.length === 1 ? 'Song' : 'Songs'}
        </span>
        <span className="booth-pool-meta">
          {runtimeMatch ? (
            <>
              <span className="font-mono num">{runtimeMatch[1]}</span> runtime
            </>
          ) : (
            totalRuntimeLabel
          )}
        </span>
      </div>

      {isMobile ? (
        <ol className="booth-mobile-list">
          {queue.map((item, idx) => {
            const isActive = idx === activeIndex;
            const isSwapping = swappingSlots.has(idx);
            const slot = String(idx + 1).padStart(2, '0');
            return (
              <li key={`${item.songKey || item.videoId}-${idx}`} className={`booth-mobile-row${isActive ? ' is-active' : ''}`}>
                <span className="booth-mobile-slot font-mono num">{slot}</span>
                <div className="booth-mobile-main">
                  <button
                    type="button"
                    className="cell-link-btn booth-mobile-song"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => onSelectIndex(idx)}
                  >
                    {item.songTitle}
                  </button>
                  <div className="booth-mobile-sub">
                    {item.artist ? (
                      <button
                        type="button"
                        className="cell-link-btn cell-link booth-row-artist-btn"
                        onClick={() => onInspectArtist?.(item.artist)}
                      >
                        <span className="booth-cell-link-text">{item.artist}</span>
                      </button>
                    ) : null}
                    {item.album ? (
                      <>
                        <span className="booth-sep" aria-hidden="true"> · </span>
                        <span>{item.album}</span>
                      </>
                    ) : null}
                  </div>
                  <div className="booth-mobile-foot">
                    <span className="booth-provenance">
                      <span className="font-mono num">{formatInt(item.totalPlays)}</span>{' '}
                      {item.totalPlays === 1 ? 'spin' : 'spins'}
                      {' · '}
                      <span className="font-mono num">{item.confidenceScore}/100</span>
                      {' · '}
                      <span className="font-mono num">{formatDuration(item.durationSeconds)}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm booth-mobile-swap-btn"
                      aria-label={`Swap ${item.songTitle}`}
                      disabled={!canSwap || isSwapping}
                      onClick={() => onSwapIndex(idx)}
                    >
                      <Icon name="shuffle" size="sm" />
                      <span>{isSwapping ? 'Swapping...' : 'Swap'}</span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="table-container">
          <table className="data-table booth-table">
            <thead>
              <tr>
                <th scope="col" className="col-slot">#</th>
                <th scope="col" className="col-song">Song</th>
                <th scope="col" className="col-artist">Artist</th>
                <th scope="col" className="col-album">Album</th>
                <th scope="col" className="col-num">Spins</th>
                <th scope="col" className="col-num">Match</th>
                <th scope="col" className="booth-col-action">Swap</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item, idx) => {
                const isActive = idx === activeIndex;
                const isSwapping = swappingSlots.has(idx);
                return (
                  <tr
                    key={`${item.songKey || item.videoId}-${idx}`}
                    className={`row-clickable${isActive ? ' is-active' : ''}`}
                    onClick={() => onSelectIndex(idx)}
                  >
                    <td className="col-slot cell-mono">{String(idx + 1).padStart(2, '0')}</td>
                    <td className="cell-primary cell-truncate" title={item.songTitle}>
                      <button
                        type="button"
                        className="cell-link-btn booth-song-btn"
                        aria-current={isActive ? 'true' : undefined}
                        onClick={(e) => { e.stopPropagation(); onSelectIndex(idx); }}
                      >
                        <span className="booth-cell-link-text">{item.songTitle}</span>
                      </button>
                    </td>
                    <td className="cell-truncate" title={item.artist || undefined}>
                      {item.artist ? (
                        <button
                          type="button"
                          className="cell-link-btn cell-link booth-row-artist-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onInspectArtist?.(item.artist);
                          }}
                        >
                          <span className="booth-cell-link-text">{item.artist}</span>
                        </button>
                      ) : '—'}
                    </td>
                    <td className="col-album cell-dim cell-truncate" title={item.album || undefined}>
                      {item.album || '—'}
                    </td>
                    <td className="col-num cell-mono">{formatInt(item.totalPlays)}</td>
                    <td className="col-num cell-mono">{item.confidenceScore}</td>
                    <td className="booth-col-action">
                      <Tooltip label={`Swap ${item.songTitle}`} position="left">
                        <button
                          type="button"
                          className="icon-action-btn sm booth-table-swap-btn"
                          aria-label={`Swap ${item.songTitle}`}
                          aria-busy={isSwapping ? 'true' : undefined}
                          disabled={!canSwap || isSwapping}
                          onClick={(e) => { e.stopPropagation(); onSwapIndex(idx); }}
                        >
                          <Icon name="shuffle" size="sm" />
                          <span className="booth-dock-label">Swap</span>
                        </button>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
