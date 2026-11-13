// Ordered episode playlist pane for desktop Broadcast Log and mobile Push Detail views.
import React from 'react';
import { formatAirDate, formatInt, useMediaQuery } from '../utils/format';
import { ArchiveErrorState, EmptyArchiveState, SkeletonRows } from './DataState';
import Icon from './Icon';

export default function BroadcastPlaylist({
  episode,
  loading = false,
  error = '',
  onRetry,
  activeSong = '',
  activeArtist = '',
  onSelectSong,
  onSelectArtist,
}) {
  const isCompact = useMediaQuery('(max-width: 768px)');

  if (loading) {
    return (
      <section className="surface-region playlist-pane" aria-label="Episode playlist">
        <div className="playlist-state">
          <SkeletonRows label="Loading episode playlist" />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="surface-region playlist-pane" aria-label="Episode playlist">
        <div className="playlist-state">
          <ArchiveErrorState message={error} onRetry={onRetry} />
        </div>
      </section>
    );
  }

  if (!episode) return null;

  const tracks = episode.playlist || episode.songs || [];
  const spinCount = Number(episode.songCount ?? episode.song_count ?? tracks.length);
  const normalizedSong = String(activeSong || '').trim().toLowerCase();
  const normalizedArtist = String(activeArtist || '').trim().toLowerCase();

  const isTrackMatch = (track) => {
    if (!normalizedSong) return false;
    const title = String(track.songTitle ?? track.song ?? '').trim().toLowerCase();
    if (title !== normalizedSong) return false;
    if (!normalizedArtist) return true;
    return String(track.artist || '').trim().toLowerCase() === normalizedArtist;
  };

  return (
    <section className="surface-region playlist-pane" aria-label="Episode playlist">
      <div className="region-toolbar playlist-toolbar">
        <div className="playlist-head-meta">
          <h2>{formatAirDate(episode.airDate || episode.air_date)}</h2>
          <p className="playlist-subtitle">
            <span className="spin-count font-mono num">
              {formatInt(spinCount)} {spinCount === 1 ? 'spin' : 'spins'}
            </span>
            {' · Episode airplay order · Click any song for its air dates'}
          </p>
        </div>

        {episode.url && (
          <a
            className="source-post-link"
            href={episode.url}
            target="_blank"
            rel="noreferrer"
          >
            Source post
            <Icon name="external" size="sm" />
          </a>
        )}
      </div>

      {tracks.length === 0 ? (
        <div className="playlist-state">
          <EmptyArchiveState items="playlist spins" onRetry={onRetry} />
        </div>
      ) : isCompact ? (
        <ol className="playlist-mobile-list">
          {tracks.map((track, idx) => {
            const posLabel = String(track.position || idx + 1).padStart(2, '0');
            const songTitle = track.songTitle || track.song || '';
            const matched = isTrackMatch(track);
            return (
              <li
                key={`${episode.id}-${posLabel}-${idx}`}
                className={`playlist-mobile-row${matched ? ' is-song-match' : ''}`}
              >
                <span className="playlist-pos font-mono num">{posLabel}</span>
                <div className="playlist-mobile-main">
                  <button
                    type="button"
                    className="cell-link-btn playlist-song-btn"
                    onClick={() => onSelectSong?.(songTitle, track.artist)}
                  >
                    {songTitle}
                  </button>
                  <div className="playlist-mobile-meta">
                    <button
                      type="button"
                      className="cell-link-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectArtist?.(track.artist);
                      }}
                    >
                      {track.artist}
                    </button>
                    {track.album && <span className="playlist-album"> · {track.album}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="table-container">
          <table className="data-table playlist-table">
            <thead>
              <tr>
                <th scope="col" className="col-num">#</th>
                <th scope="col">Song</th>
                <th scope="col">Artist</th>
                <th scope="col">Album</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, idx) => {
                const posLabel = String(track.position || idx + 1).padStart(2, '0');
                const songTitle = track.songTitle || track.song || '';
                const matched = isTrackMatch(track);
                return (
                  <tr
                    key={`${episode.id}-${posLabel}-${idx}`}
                    className={`is-interactive${matched ? ' is-song-match' : ''}`}
                    onClick={() => onSelectSong?.(songTitle, track.artist)}
                  >
                    <td className="col-num cell-mono">{posLabel}</td>
                    <td className="col-primary">
                      <button
                        type="button"
                        className="cell-link-btn playlist-song-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectSong?.(songTitle, track.artist);
                        }}
                      >
                        {songTitle}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cell-link-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectArtist?.(track.artist);
                        }}
                      >
                        {track.artist}
                      </button>
                    </td>
                    <td className="cell-dim">{track.album || '—'}</td>
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
