// Inline collapsible YouTube Audition Deck for playing matched spins inside BroadcastPlaylist.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../utils/format';
import { isValidVideoId } from '../utils/playlist-helpers';
import Icon from './Icon';
import Tooltip from './Tooltip';
import YouTubeDeckPlayer from './YouTubeDeckPlayer';

const STATUS_LABELS = {
  cued: 'Cued',
  playing: 'Playing',
  paused: 'Paused',
  buffering: 'Buffering',
  ended: 'Ended',
  blocked: 'Blocked',
};

function buildWatchUrl(videoId) {
  const clean = typeof videoId === 'string' ? videoId.trim() : '';
  return isValidVideoId(clean) ? `https://www.youtube.com/watch?v=${encodeURIComponent(clean)}` : '';
}

export default function EpisodeAuditionDeck({
  playableTracks = [],
  activeVideoIndex = 0,
  autoplay = false,
  onSelectVideoIndex,
  onClose,
  onPauseBackgroundPlaylist,
}) {
  const controlRef = useRef(null);
  const [playerStatus, setPlayerStatus] = useState(autoplay ? 'buffering' : 'cued');

  useEffect(() => {
    onPauseBackgroundPlaylist?.();
  }, [onPauseBackgroundPlaylist]);

  const count = playableTracks.length;
  const safeIndex = count > 0 ? ((activeVideoIndex % count) + count) % count : 0;
  const activeTrack = count > 0 ? playableTracks[safeIndex] : null;
  const nextIndex = count > 1 ? (safeIndex + 1) % count : -1;
  const nextTrack = nextIndex >= 0 ? playableTracks[nextIndex] : null;

  const handleStatusChange = useCallback((nextStatus) => {
    setPlayerStatus(nextStatus);
    if (nextStatus === 'playing' || nextStatus === 'buffering') {
      onPauseBackgroundPlaylist?.();
    }
  }, [onPauseBackgroundPlaylist]);

  const handleEnded = useCallback(() => {
    if (count <= 1) {
      setPlayerStatus('ended');
      return;
    }
    onSelectVideoIndex?.((safeIndex + 1) % count, true);
  }, [count, onSelectVideoIndex, safeIndex]);

  if (!activeTrack) return null;

  const posLabel = String(activeTrack.position || safeIndex + 1).padStart(2, '0');
  const songTitle = activeTrack.songTitle || activeTrack.song || '';
  const watchUrl = buildWatchUrl(activeTrack.videoId);
  const statusLabel = STATUS_LABELS[playerStatus] || STATUS_LABELS.cued;
  const durationLabel = formatDuration(activeTrack.durationSeconds);

  const stepTrack = (delta) => {
    if (count <= 1) return;
    onSelectVideoIndex?.((safeIndex + delta + count) % count, true);
  };

  return (
    <section className="audition-deck" aria-label="Episode Audition Deck">
      <div className="audition-player-col">
        <YouTubeDeckPlayer
          videoId={activeTrack.videoId}
          autoplay={autoplay}
          controlRef={controlRef}
          onEnded={handleEnded}
          onStatusChange={handleStatusChange}
          title={`${activeTrack.artist} — ${songTitle}`}
        />
      </div>

      <div className="audition-info-col">
        <div className="audition-head">
          <div className="audition-head-top">
            <h3 className="audition-track-title">
              <span className="font-mono num">{posLabel}</span>
              <span aria-hidden="true"> · </span>
              <span>{songTitle}</span>
            </h3>
            <span className={`booth-status-chip is-${playerStatus}`} aria-live="polite">
              {playerStatus === 'playing' ? <span className="status-dot is-live" aria-hidden="true" /> : null}
              <span>{statusLabel}</span>
            </span>
          </div>

          <p className="audition-track-meta">
            <span>{activeTrack.artist}</span>
            <span aria-hidden="true"> · </span>
            <span><span className="font-mono num">{safeIndex + 1}/{count}</span> playable</span>
            {durationLabel !== '—' ? (
              <>
                <span aria-hidden="true"> · </span>
                <span className="font-mono num">{durationLabel}</span>
              </>
            ) : null}
          </p>
        </div>

        <div className="audition-controls-row">
          <div className="icon-dock audition-dock" role="toolbar" aria-label="Audition deck controls">
            <Tooltip label="Previous spin" position="top">
              <button
                type="button"
                className="icon-action-btn audition-dock-btn"
                aria-label="Previous spin"
                disabled={count <= 1}
                onClick={() => stepTrack(-1)}
              >
                <Icon name="skip-back" size="sm" />
                <span className="audition-dock-label">Prev</span>
              </button>
            </Tooltip>

            <Tooltip label="Skip spin" position="top">
              <button
                type="button"
                className="icon-action-btn audition-dock-btn"
                aria-label="Skip spin"
                disabled={count <= 1}
                onClick={() => stepTrack(1)}
              >
                <Icon name="skip-forward" size="sm" />
                <span className="audition-dock-label">Skip</span>
              </button>
            </Tooltip>

            {watchUrl ? (
              <Tooltip label="Open on YouTube" position="top">
                <a
                  className="icon-action-btn audition-dock-btn"
                  href={watchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open on YouTube"
                >
                  <Icon name="external" size="sm" />
                  <span className="audition-dock-label">YouTube</span>
                </a>
              </Tooltip>
            ) : null}

            <Tooltip label="Close deck" position="top">
              <button
                type="button"
                className="icon-action-btn audition-dock-btn"
                aria-label="Close deck"
                onClick={onClose}
              >
                <Icon name="close" size="sm" />
                <span className="audition-dock-label">Close</span>
              </button>
            </Tooltip>
          </div>
        </div>

        <div className="audition-upnext">
          {nextTrack ? (
            <>
              <span className="audition-upnext-label">Up next:</span>{' '}
              <span className="font-mono num">
                {String(nextTrack.position || nextIndex + 1).padStart(2, '0')}
              </span>
              {' · '}
              <span className="audition-upnext-song">{nextTrack.songTitle || nextTrack.song}</span>
              {' — '}
              <span>{nextTrack.artist}</span>
            </>
          ) : (
            <span className="audition-upnext-label">Single playable spin in this episode</span>
          )}
        </div>
      </div>
    </section>
  );
}
