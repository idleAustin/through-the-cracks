// Studio Log filter bar: episode search, year selector, broadcast weekday segmented control, and random jump.
import React from 'react';
import Icon from './Icon';

const DAY_OPTIONS = [
  { value: '', label: 'All Days' },
  { value: 'Saturday', label: 'Sat' },
  { value: 'Wednesday', label: 'Wed' },
];

export default function EpisodeFilterBar({
  searchInput,
  onSearchChange,
  onClearSearch,
  year,
  yearOptions,
  onYearChange,
  day,
  onDayChange,
  onRandomEpisode,
  randomBusy = false,
  total = 0,
}) {
  return (
    <div className="episodes-filter-bar" role="region" aria-label="Episode filters">
      <div className="search-wrapper episodes-search-wrapper">
        <Icon name="search" size="sm" className="search-icon" />
        <input
          id="episode-search-input"
          type="search"
          enterKeyHint="search"
          className={`search-input episodes-search-input${searchInput ? ' has-clear' : ''}`}
          aria-label="Search episodes by song, artist, album, or air date"
          placeholder="Search song, artist, album, or date..."
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchInput ? (
          <button
            type="button"
            className="search-clear-icon-btn"
            aria-label="Clear episode search"
            onClick={onClearSearch}
          >
            <Icon name="close" size="sm" />
          </button>
        ) : null}
      </div>

      <div className="episodes-filter-controls">
        <select
          className="year-select"
          aria-label="Filter air dates by year"
          value={year}
          onChange={onYearChange}
        >
          <option value="">All Years</option>
          {yearOptions.map((yr) => (
            <option key={yr} value={yr}>{yr}</option>
          ))}
        </select>

        <div className="seg-group day-segmented" role="group" aria-label="Filter by broadcast day">
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value || 'all'}
              type="button"
              className="seg-btn day-seg-btn"
              aria-pressed={String(day === opt.value)}
              onClick={() => onDayChange(opt.value)}
            >
              <span className="seg-btn-text">{opt.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm episodes-random-btn"
          disabled={randomBusy || total === 0}
          onClick={onRandomEpisode}
        >
          <Icon name="shuffle" size="sm" />
          <span>Random</span>
        </button>
      </div>
    </div>
  );
}
