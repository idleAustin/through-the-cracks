// Broadcast Deck card pairing the singleton 16:9 YouTube player, metadata, Up next cue strip, icon dock, and exports.
import React from 'react';
import Icon from '../components/Icon';
import Tooltip from '../components/Tooltip';
import YouTubeDeckPlayer from '../components/YouTubeDeckPlayer';
import { formatDuration, formatInt } from '../utils/format';

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

export default function PlaylistDeckCard({
  queue,
  activeIndex,
  activeSong,
  autoplay,
  playerStatus,
  canSwap,
  isActiveSwapping,
  youtubeQueueUrl,
  copyState,
  onSelectIndex,
  onStep,
  onSwapIndex,
  onCopyPlaylist,
  onPlayerEnded,
  onPlayerStatusChange,
  onInspectArtist,
  onInspectSongAirings,
}) {
  const statusLabel = STATUS_LABELS[playerStatus] || STATUS_LABELS.cued;
  const activeSlot = queue.length > 0 ? String(activeIndex + 1).padStart(2, '0') : '00';
  const totalSlots = String(queue.length).padStart(2, '0');
  const nextIndex = queue.length > 1 ? (activeIndex + 1) % queue.length : 0;
  const nextSong = queue.length > 1 ? queue[nextIndex] : null;

  const deckButtons = [
    { key: 'prev', label: 'Previous song', short: 'Prev', icon: 'skip-back', disabled: queue.length <= 1, onClick: () => onStep(-1) },
    { key: 'next', label: 'Next song', short: 'Next', icon: 'skip-forward', disabled: queue.length <= 1, onClick: () => onStep(1) },
    { key: 'swap', label: 'Swap song', short: 'Swap', icon: 'shuffle', disabled: !canSwap || isActiveSwapping, onClick: () => onSwapIndex(activeIndex) },
    { key: 'ytm', label: 'Open in YT Music', short: 'YT Music', icon: 'external', href: buildYtMusicUrl(activeSong.videoId) },
    { key: 'airings', label: 'Episode airings', short: 'Airings', icon: 'calendar', pos: 'left', onClick: () => onInspectSongAirings(activeSong.songTitle, activeSong.artist) },
  ];

  const copyIcon = copyState === 'copied' ? 'check' : copyState === 'failed' ? 'alert' : 'copy';
  const copyLabel = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy unavailable' : 'Copy Playlist';

  return (
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
          <button
            type="button"
            className="cell-link-btn booth-artist-link"
            onClick={() => onInspectArtist(activeSong.artist)}
          >
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

      {nextSong ? (
        <button
          type="button"
          className="booth-upnext"
          onClick={() => onSelectIndex(nextIndex)}
          aria-label={`Up next ${String(nextIndex + 1).padStart(2, '0')}: ${nextSong.songTitle} by ${nextSong.artist}`}
        >
          <span className="booth-meta-row">
            <span className="booth-pool-meta">
              Up next · <span className="font-mono num">{String(nextIndex + 1).padStart(2, '0')}</span>
            </span>
            <span className="booth-pool-meta font-mono num">{formatDuration(nextSong.durationSeconds)}</span>
          </span>
          <span className="booth-upnext-credit">
            <span className="booth-upnext-song">{nextSong.songTitle}</span>
            <span className="booth-sep" aria-hidden="true"> · </span>
            <span className="booth-upnext-artist">{nextSong.artist}</span>
          </span>
        </button>
      ) : (
        <div className="booth-upnext is-single">
          <span className="booth-pool-meta">Single-song queue</span>
        </div>
      )}

      <div className="booth-controls">
        <div className="icon-dock booth-dock" role="toolbar" aria-label="Deck controls">
          {deckButtons.map((btn) => (
            <Tooltip key={btn.key} label={btn.label} position={btn.pos || 'top'}>
              {btn.href ? (
                <a
                  className="icon-action-btn booth-dock-btn"
                  href={btn.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={btn.label}
                >
                  <Icon name={btn.icon} size="sm" />
                  <span className="booth-dock-label">{btn.short}</span>
                </a>
              ) : (
                <button
                  type="button"
                  className="icon-action-btn booth-dock-btn"
                  aria-label={btn.label}
                  disabled={btn.disabled}
                  onClick={btn.onClick}
                >
                  <Icon name={btn.icon} size="sm" />
                  <span className="booth-dock-label">{btn.short}</span>
                </button>
              )}
            </Tooltip>
          ))}
        </div>

        <div className="booth-export-row">
          {youtubeQueueUrl ? (
            <a
              className="btn btn-secondary btn-sm"
              href={youtubeQueueUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="external" size="sm" />
              <span>Open {queue.length} on YouTube</span>
            </a>
          ) : null}

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCopyPlaylist}
            aria-live="polite"
          >
            <Icon name={copyIcon} size="sm" />
            <span>{copyLabel}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
