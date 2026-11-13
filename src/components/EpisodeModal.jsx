// Legacy episode playlist dialog safeguarded for stripped episode metadata until Ticket 07 removal.
import React, { useEffect, useRef } from 'react';
import { formatAirDate } from '../utils/format';
import Icon from './Icon';

export default function EpisodeModal({ episode, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!episode) return undefined;

    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus();

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [episode, onClose]);

  if (!episode) return null;

  const tracks = episode.songs || episode.playlist || [];
  const trackCount = Number(episode.songCount ?? episode.song_count ?? tracks.length);
  const airDate = episode.airDate || episode.air_date || '';
  const headingText = episode.title || formatAirDate(airDate);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        id="episode-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="episode-modal-title"
      >
        <div className="modal-header">
          <div>
            {(episode.episodeNumber || episode.dayOfWeek || airDate) && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {episode.episodeNumber && (
                  <span className="badge badge-accent">#{episode.episodeNumber}</span>
                )}
                {(episode.dayOfWeek || airDate) && (
                  <span className="badge">
                    {[episode.dayOfWeek, formatAirDate(airDate)].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            )}
            <h2 className="modal-title" id="episode-modal-title">{headingText}</h2>
          </div>

          <button
            ref={closeRef}
            type="button"
            className="close-btn"
            onClick={onClose}
            id="modal-close-btn"
            aria-label="Close episode details"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-meta">
            <span>
              <Icon name="playlist_play" size="sm" />{' '}
              Total spins <strong className="font-mono text-accent">{trackCount}</strong>
            </span>
            {episode.url && (
              <a
                className="modal-link"
                href={episode.url}
                target="_blank"
                rel="noreferrer"
              >
                Source post
                <Icon name="open_in_new" size="sm" />
              </a>
            )}
          </div>

          <div className="track-list">
            {tracks.length > 0 ? (
              tracks.map((song, idx) => (
                <div key={idx} className="track-item" id={`track-item-${idx + 1}`}>
                  <div className="track-num">
                    {String(song.position || idx + 1).padStart(2, '0')}
                  </div>
                  <div className="track-info">
                    <div className="track-title">{song.songTitle || song.song}</div>
                    <div className="track-artist-album">
                      <span className="track-artist">{song.artist}</span>
                      {song.album && <span> — {song.album}</span>}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="state-block state-block--loading">
                <Icon name="graphic_eq" />
                Loading playlist…
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
