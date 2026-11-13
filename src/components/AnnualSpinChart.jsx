// Dynamic 2013-2026 Annual Spin Volume bar chart with Archive, Artist, and Song scope toggling.
import React from 'react';
import { Link } from 'react-router-dom';
import { formatCompactSpins, formatInt } from '../utils/format';
import { ArchiveErrorState, SkeletonRows } from './DataState';

const DEFAULT_YEARS = [
  2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
];

export default function AnnualSpinChart({
  scope,
  artistName,
  songTitle,
  songArtist,
  yearData,
  loading,
  error,
  isCompact,
  onScopeChange,
  onRetry,
}) {
  const years = Array.isArray(yearData?.years) && yearData.years.length > 0
    ? yearData.years
    : DEFAULT_YEARS;
  const spins = Array.isArray(yearData?.spins) ? yearData.spins : [];
  const series = years.map((year, idx) => ({
    year,
    count: Number(spins[idx] || 0),
  }));

  const maxCount = Math.max(0, ...series.map((s) => s.count));
  const totalInFocus = series.reduce((sum, s) => sum + s.count, 0);
  const peakEntry = series.reduce(
    (best, s) => (s.count > best.count ? s : best),
    series[0] || { year: 2013, count: 0 },
  );
  const peakYear = maxCount > 0 ? peakEntry.year : null;

  let title = 'Annual Spin Volume (2013–2026)';
  if (scope === 'song' && songTitle) {
    title = songArtist
      ? `Annual Spins · "${songTitle}" — ${songArtist}`
      : `Annual Spins · "${songTitle}"`;
  } else if (scope === 'artist' && artistName) {
    title = `Annual Spins · ${artistName}`;
  }

  const airDatesUrl = songTitle
    ? `/episodes?song=${encodeURIComponent(songTitle)}${songArtist ? `&artist=${encodeURIComponent(songArtist)}` : ''}`
    : '/episodes';

  return (
    <section className="surface-region" aria-label="Annual spin volume">
      <div className="region-toolbar chart-toolbar">
        <div className="chart-header-meta">
          <h2>{title}</h2>
          <p className="chart-header-sub">
            {totalInFocus > 0
              ? `${formatInt(totalInFocus)} spins total · Peak: ${peakEntry.year} (${formatInt(peakEntry.count)} spins)`
              : 'Zero recorded spins in 2013–2026'}
          </p>
        </div>

        <div className="chart-header-actions">
          {scope === 'song' && songTitle && (
            <Link to={airDatesUrl} className="btn btn-secondary btn-sm">
              View Air Dates →
            </Link>
          )}
          <div className="seg-group" role="group" aria-label="Annual chart scope">
            <button
              type="button"
              className="seg-btn"
              aria-pressed={scope === 'all'}
              onClick={() => onScopeChange('all')}
            >
              All Archive
            </button>
            <button
              type="button"
              className="seg-btn"
              disabled={!artistName}
              aria-pressed={scope === 'artist'}
              onClick={() => onScopeChange('artist')}
            >
              {artistName || 'Artist'}
            </button>
            {songTitle && (
              <button
                type="button"
                className="seg-btn"
                aria-pressed={scope === 'song'}
                onClick={() => onScopeChange('song')}
              >
                {songTitle}
              </button>
            )}
          </div>
        </div>
      </div>

      {error ? (
        <div className="chart-state">
          <ArchiveErrorState message={error} onRetry={onRetry} />
        </div>
      ) : loading && !yearData ? (
        <div className="chart-state">
          <SkeletonRows count={3} label="Loading annual spin volume" />
        </div>
      ) : (
        <div className="year-bars" role="img" aria-label={title}>
          {series.map((entry) => {
            const barHeight = entry.count === 0 || maxCount === 0
              ? 2
              : Math.max(8, Math.round((entry.count / maxCount) * 76));
            const isZero = entry.count === 0;
            const isPeak = peakYear !== null && entry.year === peakYear;
            const colClass = `year-col${isZero ? ' is-zero' : ''}${isPeak ? ' is-peak' : ''}`;
            const label = formatCompactSpins(entry.count, isCompact && scope === 'all');

            return (
              <div
                key={entry.year}
                className={colClass}
                title={`${entry.year}: ${formatInt(entry.count)} spins`}
              >
                <span className="year-val">{label}</span>
                <div className="year-bar-fill" style={{ height: `${barHeight}px` }} />
                <span className="year-lbl">{`'${String(entry.year).slice(2)}`}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
