// Variant A (Broadcast Booth): equal-height cockpit pairing a 16:9 Broadcast Deck with a 10-Song Playlist queue.
import React from 'react';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import Tooltip from '../components/Tooltip';
import YouTubeDeckPlayer from '../components/YouTubeDeckPlayer';
import { formatDuration, formatInt, formatPlaylistRuntime, useMediaQuery } from '../utils/format';

const STATUS_LABELS = {
  cued: 'Cued',
  playing: 'Playing',
  paused: 'Paused',
  buffering: 'Buffering',
  ended: 'Ended',
  blocked: 'Blocked',
};

function buildYtMusicUrl(videoId) {
  return videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : '';
}

export default function PlaylistBooth({
  queue, activeIndex, activeSong, autoplay, playerStatus, poolSize, loading, rolling, swappingIndex, error,
  onRetry, onRoll, onSelectIndex, onStep, onSwapIndex, onPlayerEnded, onPlayerStatusChange,
  onInspectArtist, onInspectSongAirings,
}) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const statusLabel = STATUS_LABELS[playerStatus] || STATUS_LABELS.cued;
  const canSwap = poolSize > queue.length;
  const activeSlot = queue.length > 0 ? String(activeIndex + 1).padStart(2, '0') : '00';
  const totalSlots = String(queue.length).padStart(2, '0');
  const totalRuntimeLabel = formatPlaylistRuntime(queue);

  const deckButtons = activeSong ? [
    { key: 'prev', label: 'Previous song', short: 'Prev', icon: 'skip-back', disabled: queue.length <= 1, onClick: () => onStep(-1) },
    { key: 'next', label: 'Next song', short: 'Next', icon: 'skip-forward', disabled: queue.length <= 1, onClick: () => onStep(1) },
    { key: 'swap', label: 'Swap song', short: 'Swap', icon: 'shuffle', disabled: !canSwap || swappingIndex !== null, onClick: () => onSwapIndex(activeIndex) },
    { key: 'ytm', label: 'Open in YT Music', short: 'YT Music', icon: 'external', href: buildYtMusicUrl(activeSong.videoId) },
    { key: 'airings', label: 'Episode airings', short: 'Airings', icon: 'calendar', pos: 'left', onClick: () => onInspectSongAirings(activeSong.songTitle, activeSong.artist) },
  ] : [];

  return (
    <div className="booth-page">
      <header className="booth-head">
        <div className="booth-head-copy">
          <h1>Broadcast Booth</h1>
          <p className="booth-subtitle">
            Draw 10 verified Songs from the archive and cue them in the deck.
          </p>
        </div>

        <div className="booth-head-actions">
          <span className="booth-pool-pill" aria-live="polite">
            <span className="font-mono num">{loading && poolSize === 0 ? '—' : formatInt(poolSize)}</span>
            <span>eligible</span>
          </span>

          <button
            type="button"
            className="btn btn-primary"
            disabled={loading || rolling || (!error && poolSize === 0)}
            onClick={onRoll}
          >
            <Icon name="shuffle" size="sm" />
            <span>{rolling ? 'Rolling...' : 'Roll 10'}</span>
          </button>
        </div>
      </header>

      {loading && queue.length === 0 ? (
        <SkeletonRows count={6} label="Loading random playlist" />
      ) : error ? (
        <ArchiveErrorState
          message={error}
          onRetry={onRetry}
          headingLevel="h2"
          title="Playlist draw failed."
        />
      ) : poolSize === 0 || queue.length === 0 || !activeSong ? (
        <EmptyFilterState
          items="Songs"
          headingLevel="h2"
          title="No verified Songs available."
          description="No verified embeddable Songs matched the current playlist pool."
          clearLabel="Retry Draw"
          clearIcon="shuffle"
          onClear={onRetry}
        />
      ) : (
        <div className="booth-cockpit">
          <section className="surface-region booth-deck" aria-label="Broadcast Deck">
            <div className="region-toolbar">
              <span className="booth-region-title">
                Broadcast Deck · <span className="font-mono num">{activeSlot}/{totalSlots}</span>
              </span>
              <span className={`booth-status-chip is-${playerStatus}`} aria-live="polite">
                {playerStatus === 'playing' ? <span className="status-dot is-live" aria-hidden="true" /> : null}
                <span>{statusLabel}</span>
              </span>
            </div>

            <YouTubeDeckPlayer
              videoId={activeSong.videoId}
              autoplay={autoplay}
              onEnded={onPlayerEnded}
              onStatusChange={onPlayerStatusChange}
              title={`${activeSong.artist} — ${activeSong.songTitle}`}
            />

            <div className="booth-meta">
              <h2 className="booth-song-title">{activeSong.songTitle}</h2>
              <p className="booth-credit-line">
                <button type="button" className="cell-link-btn booth-artist-link" onClick={() => onInspectArtist(activeSong.artist)}>
                  {activeSong.artist}
                </button>
                {activeSong.album ? (
                  <>
                    <span className="booth-sep" aria-hidden="true"> · </span>
                    <span>{activeSong.album}</span>
                  </>
                ) : null}
              </p>
              <p className="booth-provenance">
                <span className="font-mono num">{formatInt(activeSong.totalPlays)}</span>{' '}
                {activeSong.totalPlays === 1 ? 'spin' : 'spins'}
                {' · '}
                <span className="font-mono num">{activeSong.confidenceScore}/100</span>
                {' · '}
                <span className="font-mono num">{formatDuration(activeSong.durationSeconds)}</span>
              </p>
            </div>

            <div className="booth-upnext">
              {queue.length > 1 ? (() => {
                const nextIndex = (activeIndex + 1) % queue.length;
                const nextSong = queue[nextIndex];
                return (
                  <>
                    <div className="booth-meta-row">
                      <span className="booth-pool-meta">
                        Up next · <span className="font-mono num">{String(nextIndex + 1).padStart(2, '0')}</span>
                      </span>
                      <span className="booth-pool-meta font-mono num">{formatDuration(nextSong.durationSeconds)}</span>
                    </div>
                    <p className="booth-credit-line">
                      <button type="button" className="cell-link-btn booth-artist-link" onClick={() => onSelectIndex(nextIndex)}>
                        {nextSong.songTitle}
                      </button>
                      <span className="booth-sep" aria-hidden="true"> · </span>
                      <span>{nextSong.artist}</span>
                    </p>
                  </>
                );
              })() : (
                <span className="booth-pool-meta">Single-song queue</span>
              )}
            </div>

            <div className="booth-controls">
              <div className="icon-dock booth-dock" role="toolbar" aria-label="Deck controls">
                {deckButtons.map((btn) => (
                  <Tooltip key={btn.key} label={btn.label} position={btn.pos || 'top'}>
                    {btn.href ? (
                      <a className="icon-action-btn booth-dock-btn" href={btn.href} target="_blank" rel="noreferrer" aria-label={btn.label}>
                        <Icon name={btn.icon} size="sm" />
                        <span className="booth-dock-label">{btn.short}</span>
                      </a>
                    ) : (
                      <button type="button" className="icon-action-btn booth-dock-btn" aria-label={btn.label} disabled={btn.disabled} onClick={btn.onClick}>
                        <Icon name={btn.icon} size="sm" />
                        <span className="booth-dock-label">{btn.short}</span>
                      </button>
                    )}
                  </Tooltip>
                ))}
              </div>
            </div>
          </section>

          <section className="surface-region booth-playlist" aria-label="Playlist queue">
            <div className="region-toolbar">
              <span className="booth-region-title">
                Playlist · <span className="font-mono num">{queue.length}</span> {queue.length === 1 ? 'Song' : 'Songs'}
              </span>
              <span className="booth-pool-meta font-mono num">{totalRuntimeLabel}</span>
            </div>

            {isMobile ? (
              <ol className="booth-mobile-list">
                {queue.map((item, idx) => {
                  const isActive = idx === activeIndex;
                  const slot = String(idx + 1).padStart(2, '0');
                  return (
                    <li key={`${item.songKey || item.videoId}-${idx}`} className={`booth-mobile-row${isActive ? ' is-active' : ''}`}>
                      <span className="booth-mobile-slot font-mono num">{slot}</span>
                      <div className="booth-mobile-main">
                        <button type="button" className="cell-link-btn booth-mobile-song" aria-current={isActive ? 'true' : undefined} onClick={() => onSelectIndex(idx)}>
                          {item.songTitle}
                        </button>
                        <div className="booth-mobile-sub">
                          <span>{item.artist}</span>
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
                            className="btn btn-secondary btn-sm"
                            aria-label={`Swap ${item.songTitle}`}
                            disabled={!canSwap || swappingIndex !== null}
                            onClick={() => onSwapIndex(idx)}
                          >
                            <Icon name="shuffle" size="sm" />
                            <span>Swap</span>
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
                              {item.songTitle}
                            </button>
                          </td>
                          <td className="cell-truncate" title={item.artist}>
                            {item.artist}
                          </td>
                          <td className="cell-dim cell-truncate" title={item.album || undefined}>
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
                                disabled={!canSwap || swappingIndex !== null}
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
        </div>
      )}
    </div>
  );
}
