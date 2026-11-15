// Header, Spin-depth segmented lens, confidence selector, 1-per-artist toggle, pool counter, and Roll 10 action.
import React from 'react';
import Icon from '../components/Icon';
import { formatInt } from '../utils/format';
import { PLAYLIST_MODE_OPTIONS, PLAYLIST_SCORE_OPTIONS } from '../utils/playlist-helpers';

export default function PlaylistFilterBar({
  filters,
  poolSize,
  loading,
  rolling,
  error,
  onModeChange,
  onMinScoreChange,
  onToggleOnePerArtist,
  onRoll,
}) {
  return (
    <header className="booth-head">
      <div className="booth-head-top">
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
      </div>

      <div className="booth-filter-bar" role="region" aria-label="Playlist filters">
        <div className="seg-group booth-mode-group" role="group" aria-label="Spin depth filter">
          {PLAYLIST_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="seg-btn"
              aria-pressed={String(filters.mode === opt.value)}
              onClick={() => onModeChange(opt.value)}
            >
              <span className="seg-btn-text">{opt.label}</span>
            </button>
          ))}
        </div>

        <div className="booth-filter-controls">
          <select
            id="playlist-min-score"
            className="album-select booth-score-select"
            aria-label="Confidence threshold"
            value={String(filters.minScore)}
            onChange={(e) => onMinScoreChange(Number(e.target.value))}
          >
            {PLAYLIST_SCORE_OPTIONS.map((opt) => (
              <option key={opt.value} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="seg-btn booth-artist-toggle"
            aria-pressed={String(filters.onePerArtist)}
            onClick={onToggleOnePerArtist}
          >
            <span className="seg-btn-text">1 per artist</span>
          </button>
        </div>
      </div>
    </header>
  );
}
