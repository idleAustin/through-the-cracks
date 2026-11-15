// Ordered episode playlist pane with Episode DNA strip, filter key, archive history, and inline Audition Deck.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getBroadcastDayOfWeek } from '../../server/episodeDetailBuilder.js';
import { formatAirDate, formatDuration, formatInt, useMediaQuery } from '../utils/format';
import { buildYouTubeQueueUrl, copyTextToClipboard, formatPlaylistText, isValidVideoId } from '../utils/playlist-helpers';
import { ArchiveErrorState, EmptyArchiveState, SkeletonRows } from './DataState';
import EpisodeAuditionDeck from './EpisodeAuditionDeck';
import EpisodeDnaStrip from './EpisodeDnaStrip';
import Icon from './Icon';
import Tooltip from './Tooltip';

const RELEASE_KIND_LABELS = { single: 'Single', interlude: 'Interlude', ep: 'EP' };

function getReleaseKindLabel(track) {
  if (track.album) return '';
  return Object.hasOwn(RELEASE_KIND_LABELS, track.releaseKind) ? RELEASE_KIND_LABELS[track.releaseKind] : '';
}

function buildAiringTitle(track) {
  if (!track.firstPlayed || !track.lastPlayed) return undefined;
  return track.firstPlayed === track.lastPlayed
    ? `Aired ${formatAirDate(track.firstPlayed)}`
    : `First ${formatAirDate(track.firstPlayed)} · Last ${formatAirDate(track.lastPlayed)}`;
}

function renderHistoryInline(track) {
  const plays = Number(track.totalPlays ?? 1);
  return (
    <div className="history-inline">
      <span className="history-plays font-mono num" title={buildAiringTitle(track)}>{formatInt(plays)}x</span>
      <span className="history-dots">
        {track.isSongDebut ? <span className="dot-badge dot-badge--d" role="img" title="Song debut" aria-label="Song debut">D</span> : null}
        {track.isArtistDebut ? <span className="dot-badge dot-badge--a" role="img" title="Artist debut" aria-label="Artist debut">A</span> : null}
        {track.isOnlySpin ? <span className="dot-badge dot-badge--o" role="img" title="Only spin" aria-label="Only spin">O</span> : null}
        {track.isStaple ? <span className="dot-badge dot-badge--s" role="img" title="5+ staple" aria-label="5+ staple">S</span> : null}
      </span>
    </div>
  );
}

function renderArtistCredit(track, onSelectArtist) {
  return (
    <>
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
      {track.featuredArtist && <span className="playlist-featured"> w/ {track.featuredArtist}</span>}
    </>
  );
}

export default function BroadcastPlaylist({
  episode,
  loading = false,
  error = '',
  onRetry,
  activeSong = '',
  activeArtist = '',
  onSelectSong,
  onSelectArtist,
  onStepEpisode,
  onPauseBackgroundPlaylist,
}) {
  const isCompact = useMediaQuery('(max-width: 768px)');
  const [activeFilter, setActiveFilter] = useState('all');
  const [deckOpen, setDeckOpen] = useState(false);
  const [activeVideoIndex, setActiveVideoIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [copyState, setCopyState] = useState('idle');
  const copyTimerRef = useRef(null);

  useEffect(() => {
    setActiveFilter('all');
    setDeckOpen(false);
    setActiveVideoIndex(0);
    setAutoplay(false);
    setCopyState('idle');
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [episode?.id]);

  useEffect(() => () => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
  }, []);

  const tracks = useMemo(() => episode?.playlist || episode?.songs || [], [episode]);
  const playableTracks = useMemo(() => tracks.filter((t) => isValidVideoId(t.videoId)), [tracks]);
  const youtubeQueueUrl = useMemo(() => {
    const seen = new Set();
    const unique = [];
    for (const t of playableTracks) {
      const vid = String(t.videoId || '').trim();
      if (!vid || seen.has(vid)) continue;
      seen.add(vid);
      unique.push({ ...t, videoId: vid });
      if (unique.length >= 50) break;
    }
    return buildYouTubeQueueUrl(unique);
  }, [playableTracks]);

  const visibleTracks = useMemo(() => {
    if (activeFilter === 'debutSong') return tracks.filter((t) => t.isSongDebut);
    if (activeFilter === 'debutArtist') return tracks.filter((t) => t.isArtistDebut);
    if (activeFilter === 'onlySpin') return tracks.filter((t) => t.isOnlySpin);
    if (activeFilter === 'staple') return tracks.filter((t) => t.isStaple);
    if (activeFilter === 'playable') return tracks.filter((t) => isValidVideoId(t.videoId));
    return tracks;
  }, [tracks, activeFilter]);

  if (loading) {
    return (
      <section className="surface-region playlist-pane" aria-label="Episode playlist">
        <div className="playlist-state"><SkeletonRows label="Loading episode playlist" /></div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="surface-region playlist-pane" aria-label="Episode playlist">
        <div className="playlist-state"><ArchiveErrorState message={error} onRetry={onRetry} /></div>
      </section>
    );
  }
  if (!episode) return null;

  const airDate = episode.airDate || episode.air_date || '';
  const weekday = getBroadcastDayOfWeek(airDate);
  const spinCount = Number(episode.songCount ?? episode.song_count ?? tracks.length);
  const rawSourceUrl = typeof episode.url === 'string' ? episode.url.trim() : '';
  let safeSourceUrl = '';
  if (rawSourceUrl) {
    try {
      const parsed = new URL(rawSourceUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        safeSourceUrl = parsed.href;
      }
    } catch {
      safeSourceUrl = '';
    }
  }
  const normalizedSong = String(activeSong || '').trim().toLowerCase();
  const normalizedArtist = String(activeArtist || '').trim().toLowerCase();
  const dna = episode.dna || null;
  const activeAuditionTrack = deckOpen && playableTracks.length > 0 ? playableTracks[activeVideoIndex] : null;

  const isTrackMatch = (track) => {
    if (!normalizedSong) return false;
    const title = String(track.songTitle ?? track.song ?? '').trim().toLowerCase();
    if (title !== normalizedSong) return false;
    return !normalizedArtist || String(track.artist || '').trim().toLowerCase() === normalizedArtist;
  };

  const handleCopy = async () => {
    const text = formatPlaylistText(tracks.map((t) => ({ artist: t.artist, songTitle: t.songTitle || t.song || '' })));
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    setCopyState(ok ? 'copied' : 'failed');
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopyState('idle');
      copyTimerRef.current = null;
    }, ok ? 1800 : 2200);
  };

  const cuePlayableTrack = (track) => {
    const idx = playableTracks.indexOf(track);
    setActiveVideoIndex(idx >= 0 ? idx : 0);
    setAutoplay(true);
    setDeckOpen(true);
    onPauseBackgroundPlaylist?.();
  };

  const keyPills = dna ? [
    { key: 'all', label: 'All', count: tracks.length, variant: 'all' },
    { key: 'debutSong', badge: 'D', label: 'Song Debut', count: dna.debutSongCount, variant: 'd' },
    { key: 'debutArtist', badge: 'A', label: 'Artist Debut', count: dna.artistDebutSpinCount, variant: 'a' },
    { key: 'onlySpin', badge: 'O', label: 'Only Spin', count: dna.onlySpinCount, variant: 'o' },
    { key: 'staple', badge: 'S', label: '5+ Staple', count: dna.stapleCount, variant: 's' },
    { key: 'playable', label: 'Playable', count: dna.playableCount, variant: 'playable' },
  ] : [];

  return (
    <section className="surface-region playlist-pane" aria-label="Episode playlist">
      <div className="region-toolbar playlist-toolbar">
        <div className="playlist-head-meta">
          <h2>{formatAirDate(airDate)}</h2>
          <p className="playlist-subtitle">
            {weekday ? `${weekday} · ` : ''}
            <span className="spin-count font-mono num">{formatInt(spinCount)} {spinCount === 1 ? 'spin' : 'spins'}</span>
            {' · Episode airplay order · Click any song for its air dates'}
          </p>
        </div>

        <div className="playlist-actions">
          <div className="playlist-step-group" role="group" aria-label="Episode navigation">
            <Tooltip label="Newer episode" position="down">
              <button type="button" className="icon-action-btn sm" aria-label="Newer episode" disabled={!episode.prevEpisodeId} onClick={() => onStepEpisode?.(episode.prevEpisodeId)}>
                <Icon name="chevron-left" size="sm" />
                <span className="step-btn-label" aria-hidden="true">Newer</span>
              </button>
            </Tooltip>
            <Tooltip label="Older episode" position="down">
              <button type="button" className="icon-action-btn sm" aria-label="Older episode" disabled={!episode.nextEpisodeId} onClick={() => onStepEpisode?.(episode.nextEpisodeId)}>
                <Icon name="chevron-right" size="sm" />
                <span className="step-btn-label" aria-hidden="true">Older</span>
              </button>
            </Tooltip>
          </div>

          <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopy} aria-live="polite">
            <Icon name={copyState === 'copied' ? 'check' : copyState === 'failed' ? 'alert' : 'copy'} size="sm" />
            <span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}</span>
          </button>

          {playableTracks.length > 0 && youtubeQueueUrl ? (
            <a className="btn btn-secondary btn-sm" href={youtubeQueueUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size="sm" />
              <span>Open on YouTube</span>
            </a>
          ) : null}

          {safeSourceUrl ? (
            <a className="source-post-link" href={safeSourceUrl} target="_blank" rel="noopener noreferrer">
              Source post
              <Icon name="external" size="sm" />
            </a>
          ) : null}

          {deckOpen && playableTracks.length > 0 ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDeckOpen(false); setAutoplay(false); }}>
              <Icon name="close" size="sm" />
              <span>Close Deck</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={playableTracks.length === 0}
              onClick={() => { setActiveVideoIndex(0); setAutoplay(true); setDeckOpen(true); onPauseBackgroundPlaylist?.(); }}
            >
              <Icon name="play" size="sm" />
              <span>Play Matched ({formatInt(playableTracks.length)})</span>
            </button>
          )}
        </div>
      </div>

      <EpisodeDnaStrip episode={episode} spinCount={spinCount} weekday={weekday} />

      {deckOpen && playableTracks.length > 0 ? (
        <EpisodeAuditionDeck
          playableTracks={playableTracks}
          activeVideoIndex={activeVideoIndex}
          autoplay={autoplay}
          onSelectVideoIndex={(idx, play = true) => { setActiveVideoIndex(idx); setAutoplay(Boolean(play)); }}
          onClose={() => { setDeckOpen(false); setAutoplay(false); }}
          onPauseBackgroundPlaylist={onPauseBackgroundPlaylist}
        />
      ) : null}

      {dna ? (
        <div
          className={`episode-key-bar${activeFilter !== 'all' ? ' has-active-filter' : ''}`}
          role="group"
          aria-label="Filter playlist by archive key"
        >
          <span className="episode-key-label">Key &amp; Filter</span>
          {keyPills.map((pill) => (
            <button
              key={pill.key}
              type="button"
              className={`key-pill key-pill--${pill.variant}`}
              aria-pressed={String(activeFilter === pill.key)}
              disabled={pill.key !== 'all' && pill.count === 0}
              onClick={() => setActiveFilter((prev) => (prev === pill.key ? 'all' : pill.key))}
            >
              {pill.badge ? <span className={`dot-badge dot-badge--${pill.variant}`} aria-hidden="true">{pill.badge}</span> : null}
              <span>{pill.label}</span>
              <span className="key-pill-count font-mono num">{formatInt(pill.count)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {tracks.length === 0 ? (
        <div className="playlist-state"><EmptyArchiveState items="playlist spins" onRetry={onRetry} /></div>
      ) : isCompact ? (
        <ol className="playlist-mobile-list">
          {visibleTracks.map((track, idx) => {
            const posLabel = String(track.position || idx + 1).padStart(2, '0');
            const songTitle = track.songTitle || track.song || '';
            const matched = isTrackMatch(track);
            const isAuditioning = activeAuditionTrack === track;
            const releaseLabel = getReleaseKindLabel(track);
            const playable = dna && isValidVideoId(track.videoId);
            const dur = formatDuration(track.durationSeconds);
            return (
              <li key={`${episode.id}-${posLabel}-${idx}`} className={`playlist-mobile-row${matched ? ' is-song-match' : ''}${isAuditioning ? ' is-auditioning' : ''}${playable ? ' has-play-col' : ''}`}>
                <span className="playlist-pos font-mono num">{posLabel}</span>
                <div className="playlist-mobile-main">
                  <button type="button" className="cell-link-btn playlist-song-btn" onClick={() => onSelectSong?.(songTitle, track.artist)}>{songTitle}</button>
                  <div className="playlist-mobile-meta">
                    <span className="playlist-artist-wrap">{renderArtistCredit(track, onSelectArtist)}</span>
                    {track.album ? <span className="playlist-album"> · {track.album}</span> : releaseLabel ? <span className="playlist-album"> · <span className="playlist-release-kind">{releaseLabel}</span></span> : null}
                    {dur !== '—' ? <span className="track-dur font-mono num">{dur}</span> : null}
                    {dna ? renderHistoryInline(track) : null}
                  </div>
                </div>
                {playable ? (
                  <button type="button" className={`icon-action-btn audition-play-btn${isAuditioning ? ' is-playing' : ''}`} aria-label={`Play spin ${posLabel}`} onClick={() => cuePlayableTrack(track)}>
                    <Icon name="play" size="sm" />
                    <span className="audition-play-label" aria-hidden="true">Play</span>
                  </button>
                ) : null}
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
                {dna ? <th scope="col" className="col-play">Play</th> : null}
                <th scope="col">Song</th>
                <th scope="col">Artist</th>
                <th scope="col">Album</th>
                {dna ? <th scope="col" className="col-history">Archive History</th> : null}
              </tr>
            </thead>
            <tbody>
              {visibleTracks.map((track, idx) => {
                const posLabel = String(track.position || idx + 1).padStart(2, '0');
                const songTitle = track.songTitle || track.song || '';
                const matched = isTrackMatch(track);
                const isAuditioning = activeAuditionTrack === track;
                const releaseLabel = getReleaseKindLabel(track);
                const playable = isValidVideoId(track.videoId);
                const dur = formatDuration(track.durationSeconds);
                return (
                  <tr
                    key={`${episode.id}-${posLabel}-${idx}`}
                    className={`is-interactive${matched ? ' is-song-match' : ''}${isAuditioning ? ' is-auditioning' : ''}`}
                    onClick={() => onSelectSong?.(songTitle, track.artist)}
                  >
                    <td className="col-num cell-mono">{posLabel}</td>
                    {dna ? (
                      <td className="col-play" onClick={(e) => e.stopPropagation()}>
                        {playable ? (
                          <Tooltip label={`Play spin ${posLabel}`} position="top">
                            <button type="button" className={`icon-action-btn sm audition-play-btn${isAuditioning ? ' is-playing' : ''}`} aria-label={`Play spin ${posLabel}`} onClick={() => cuePlayableTrack(track)}>
                              <Icon name="play" size={14} />
                            </button>
                          </Tooltip>
                        ) : <span className="audition-no-video font-mono" aria-hidden="true">—</span>}
                      </td>
                    ) : null}
                    <td className="col-primary">
                      <div className="playlist-song-cell">
                        <button type="button" className="cell-link-btn playlist-song-btn" onClick={(e) => { e.stopPropagation(); onSelectSong?.(songTitle, track.artist); }}>{songTitle}</button>
                        {dur !== '—' ? <span className="track-dur font-mono num">{dur}</span> : null}
                      </div>
                    </td>
                    <td>{renderArtistCredit(track, onSelectArtist)}</td>
                    <td className="cell-dim">{track.album || (releaseLabel ? <span className="playlist-release-kind">{releaseLabel}</span> : '—')}</td>
                    {dna ? <td className="col-history">{renderHistoryInline(track)}</td> : null}
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
