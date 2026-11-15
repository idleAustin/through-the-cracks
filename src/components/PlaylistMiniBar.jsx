// Off-route Now Playing mini-bar exposing background Broadcast Booth status, return link, and transport controls.
import React from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import Tooltip from './Tooltip';

export default function PlaylistMiniBar({
  activeSong,
  activeIndex = 0,
  totalSlots = 0,
  playerStatus = 'cued',
  playlistHref = '/playlist',
  onTogglePlayPause,
  onStep,
  onStopPlayback,
}) {
  if (!activeSong) return null;

  const isLivePlaying = playerStatus === 'playing';
  const isPlaying = playerStatus === 'playing' || playerStatus === 'buffering';
  const slotLabel = totalSlots > 0 ? String(activeIndex + 1).padStart(2, '0') : '00';
  const totalLabel = String(totalSlots).padStart(2, '0');
  const playPauseLabel = isPlaying ? 'Pause playback' : 'Resume playback';
  const playPauseShort = isPlaying ? 'Pause' : 'Play';
  const playPauseIcon = isPlaying ? 'pause' : 'play';
  const canStep = totalSlots > 1;
  const returnLabel = `Return to Broadcast Booth: ${activeSong.songTitle} by ${activeSong.artist}`;

  return (
    <aside className="playlist-minibar" aria-label="Now playing">
      <Link
        to={playlistHref}
        className="playlist-minibar-link"
        aria-label={returnLabel}
      >
        <span className="playlist-minibar-lead">
          <span
            className={`status-dot ${isLivePlaying ? 'is-live' : 'is-static'}`}
            aria-hidden="true"
          />
          <span className="playlist-minibar-slot font-mono num">
            {slotLabel}/{totalLabel}
          </span>
          <span className="playlist-minibar-credit">
            <span className="playlist-minibar-song">{activeSong.songTitle}</span>
            <span className="playlist-minibar-sep" aria-hidden="true"> · </span>
            <span className="playlist-minibar-artist">{activeSong.artist}</span>
          </span>
        </span>
        <span className="playlist-minibar-booth-pill" aria-hidden="true">
          <Icon name="playlist" size="sm" />
          <span>Booth</span>
        </span>
      </Link>

      <div
        className="icon-dock playlist-minibar-dock"
        role="toolbar"
        aria-label="Background playback controls"
      >
        <Tooltip label={playPauseLabel} position="top">
          <button
            type="button"
            className={`icon-action-btn playlist-minibar-btn${isPlaying ? ' is-playing' : ''}`}
            aria-label={playPauseLabel}
            onClick={onTogglePlayPause}
          >
            <Icon name={playPauseIcon} size="sm" />
            <span className="playlist-minibar-btn-label">{playPauseShort}</span>
          </button>
        </Tooltip>

        <Tooltip label="Previous song" position="top">
          <button
            type="button"
            className="icon-action-btn playlist-minibar-btn"
            aria-label="Previous song"
            disabled={!canStep}
            onClick={() => onStep?.(-1)}
          >
            <Icon name="skip-back" size="sm" />
            <span className="playlist-minibar-btn-label">Prev</span>
          </button>
        </Tooltip>

        <Tooltip label="Next song" position="top">
          <button
            type="button"
            className="icon-action-btn playlist-minibar-btn"
            aria-label="Next song"
            disabled={!canStep}
            onClick={() => onStep?.(1)}
          >
            <Icon name="skip-forward" size="sm" />
            <span className="playlist-minibar-btn-label">Next</span>
          </button>
        </Tooltip>

        <span className="playlist-minibar-booth-item">
          <Tooltip label="Open Broadcast Booth" position="top">
            <Link
              to={playlistHref}
              className="icon-action-btn playlist-minibar-btn"
              aria-label="Open Broadcast Booth"
            >
              <Icon name="playlist" size="sm" />
              <span className="playlist-minibar-btn-label">Booth</span>
            </Link>
          </Tooltip>
        </span>

        <Tooltip label="Stop playback" position="left">
          <button
            type="button"
            className="icon-action-btn playlist-minibar-btn"
            aria-label="Stop playback"
            onClick={onStopPlayback}
          >
            <Icon name="close" size="sm" />
            <span className="playlist-minibar-btn-label">Stop</span>
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}
