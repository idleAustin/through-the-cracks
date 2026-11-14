// Artist yearly trajectory panel with Bars (plus archive trend line) and clickable Month Heatmap views.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatInt, useMediaQuery } from '../utils/format';
import ArtistHeatmapView, { ROW_LABEL_COL_PX } from './ArtistHeatmapView';

const YEAR_PAIR_MIN_PX = 25;

function canHover() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover)').matches
  );
}

function isFocusVisibleTarget(target) {
  try {
    return Boolean(target?.matches?.(':focus-visible'));
  } catch {
    return true;
  }
}

export default function ArtistYearPanel({
  artistName,
  years = [],
  peakYear = null,
  months = [],
  airings = [],
  archiveDateRange = {},
  expandedSong = null,
  onSelectSong,
  getAiringsForSong,
}) {
  const isMobile = useMediaQuery('(max-width: 640px)');
  const isTiny = useMediaQuery('(max-width: 400px)');

  const [view, setView] = useState('bars');
  const [activeYear, setActiveYear] = useState(null);
  const [hoveredYear, setHoveredYear] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const bodyRef = useRef(null);

  useEffect(() => {
    setActiveYear(null);
    setHoveredYear(null);
    setSelectedMonth(null);
  }, [artistName]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    setContainerWidth(el.clientWidth || 0);
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(Math.round(entries[0]?.contentRect?.width || el.clientWidth || 0));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleYears = useMemo(() => {
    if (!years.length) return [];
    let fitCount = years.length;
    if (containerWidth > 0) fitCount = Math.floor((containerWidth - ROW_LABEL_COL_PX) / YEAR_PAIR_MIN_PX);
    else if (isTiny) fitCount = 8;
    else if (isMobile) fitCount = 10;
    const clamped = Math.max(4, Math.min(years.length, fitCount));
    return clamped < years.length ? years.slice(-clamped) : years;
  }, [years, containerWidth, isMobile, isTiny]);

  const maxArtistSpins = useMemo(() => Math.max(1, ...years.map((y) => Number(y.spins || 0))), [years]);
  const maxArchiveSpins = useMemo(() => Math.max(1, ...years.map((y) => Number(y.archiveSpins || 0))), [years]);

  const trendPoints = useMemo(
    () =>
      years
        .map((y, i) => {
          const x = (((i + 0.5) / years.length) * 100).toFixed(2);
          const yPos = (100 - (Number(y.archiveSpins || 0) / maxArchiveSpins) * 90).toFixed(2);
          return `${x},${yPos}`;
        })
        .join(' '),
    [years, maxArchiveSpins],
  );

  const displayYearNum = hoveredYear ?? activeYear;
  const displayYearObj = displayYearNum != null ? years.find((y) => y.year === displayYearNum) || null : null;

  const handleViewChange = (nextView) => {
    setView(nextView);
    if (nextView === 'bars') setSelectedMonth(null);
  };

  const handleBarClick = (yearNum) => {
    if (activeYear === yearNum) {
      setActiveYear(null);
      setHoveredYear(null);
    } else {
      setActiveYear(yearNum);
    }
  };

  return (
    <section className="surface-region ad-panel" aria-label="Spins by year">
      <header className="ad-panel-head">
        <h2>{view === 'bars' ? 'Spins by year' : 'When it aired'}</h2>
        <div className="ad-year-controls">
          <span className="ad-year-note">
            {view === 'bars' ? `bars: ${artistName} · line: whole archive` : 'One square per month · select a month'}
          </span>
          <div className="seg-group" role="group" aria-label="Year view">
            {[['bars', 'Bars'], ['heatmap', 'Heatmap']].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="seg-btn ad-seg-btn"
                aria-pressed={view === id}
                onClick={() => handleViewChange(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div ref={bodyRef} className="ad-year-body">
        {view === 'bars' ? (
          <>
            <div className="ad-bars-stage">
              <div className="ad-bars-cols" style={{ gridTemplateColumns: `repeat(${Math.max(1, years.length)}, minmax(0, 1fr))` }}>
                {years.map((item, idx) => {
                  const isPeak = Boolean(peakYear && peakYear.spins > 0 && item.year === peakYear.year);
                  const isActive = activeYear === item.year;
                  const pctHeight = item.spins > 0 ? Math.max(4, Math.round((item.spins / maxArtistSpins) * 100)) : 0;
                  const label = `${item.year}: ${formatInt(item.spins)} ${item.spins === 1 ? 'spin' : 'spins'}`;

                  return (
                    <button
                      key={item.year}
                      type="button"
                      className={`ad-bar-col${isPeak ? ' is-peak' : ''}${isActive ? ' is-active' : ''}${item.spins === 0 ? ' is-zero' : ''}`}
                      aria-pressed={isActive}
                      aria-label={`${label}, archive ${formatInt(item.archiveSpins)}`}
                      title={label}
                      onClick={() => handleBarClick(item.year)}
                      onMouseEnter={() => {
                        if (canHover()) setHoveredYear(item.year);
                      }}
                      onMouseLeave={() => setHoveredYear(null)}
                      onFocus={(event) => {
                        if (isFocusVisibleTarget(event.currentTarget)) setHoveredYear(item.year);
                      }}
                      onBlur={() => setHoveredYear(null)}
                    >
                      <span className="ad-bar-track">
                        <span className="ad-bar-fill" style={{ height: item.spins > 0 ? `${pctHeight}%` : '2px' }} />
                      </span>
                      <span className={`ad-bar-label mono${idx % 2 === 1 ? ' is-alt' : ''}`}>{`’${String(item.year).slice(2)}`}</span>
                    </button>
                  );
                })}
              </div>

              {years.length > 1 ? (
                <div className="ad-bars-trend-wrap" aria-hidden="true">
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="ad-bars-trend-svg">
                    <polyline className="ad-bars-trend-line" points={trendPoints} />
                  </svg>
                </div>
              ) : null}
            </div>

            {years.length > 0 ? (
              <div className="ad-year-select-wrap">
                <select
                  className="ad-month-select ad-year-select"
                  aria-label="Select year"
                  value={activeYear != null ? String(activeYear) : ''}
                  onChange={(event) => {
                    const nextYear = event.target.value ? Number(event.target.value) : null;
                    setActiveYear(Number.isFinite(nextYear) ? nextYear : null);
                    setHoveredYear(null);
                  }}
                >
                  <option value="">
                    Select a year ({formatInt(years.length)} {years.length === 1 ? 'year' : 'years'})
                  </option>
                  {years.map((item) => (
                    <option key={item.year} value={String(item.year)}>
                      {item.year} — {formatInt(item.spins)} {item.spins === 1 ? 'spin' : 'spins'}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="ad-year-cap" aria-live="polite">
              {displayYearObj ? (
                <span>
                  <span className="mono">{displayYearObj.year}</span>: <strong className="mono">{formatInt(displayYearObj.spins)}</strong>{' '}
                  {displayYearObj.spins === 1 ? 'spin' : 'spins'} · archive <span className="mono">{formatInt(displayYearObj.archiveSpins)}</span>
                  {peakYear?.spins > 0 && displayYearObj.year === peakYear.year ? ' · peak year' : ''}
                </span>
              ) : peakYear && peakYear.spins > 0 ? (
                <span>
                  Peak year: <span className="mono">{peakYear.year}</span> (<span className="mono">{formatInt(peakYear.spins)}</span>{' '}
                  {peakYear.spins === 1 ? 'spin' : 'spins'}). Select a bar for exact counts.
                </span>
              ) : (
                <span>Zero recorded spins across archived years.</span>
              )}
            </div>
          </>
        ) : (
          <ArtistHeatmapView
            years={years}
            visibleYears={visibleYears}
            months={months}
            airings={airings}
            archiveDateRange={archiveDateRange}
            selectedMonth={selectedMonth}
            expandedSong={expandedSong}
            onSelectMonth={setSelectedMonth}
            onSelectSong={onSelectSong}
            getAiringsForSong={getAiringsForSong}
          />
        )}
      </div>
    </section>
  );
}
