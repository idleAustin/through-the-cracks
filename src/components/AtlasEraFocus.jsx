// Interactive 8-decade proportional share strip, single-level release year treemap (desktop/tablet), and ranked list (phone).
import React, { useMemo, useState } from 'react';
import {
  ERA_SLICE_STEPS, HEAT_STEPS, SHORT_DECADE_LABELS, collectPeakYears,
  computeHeatIntensity, heatMixFill, metricValue, squarifyLayout, summarizeCoverage, truncateLabel,
} from '../utils/atlas-treemap';
import { formatInt, useMediaQuery } from '../utils/format';
import { EmptyFilterState } from './DataState';

export default function AtlasEraFocus({
  decades = [],
  metric = 'songs',
  selectedDecade = '',
  selectedYear = null,
  totalCatalogSongs = 0,
  datedCatalogSongs = 0,
  emptyMessage = '',
  onSelectDecade,
  onSelectYear,
  onResetAll,
  height = 490,
}) {
  const [hoveredYear, setHoveredYear] = useState(null);
  const isTouchOrCompact = useMediaQuery('(max-width: 768px), (pointer: coarse)');
  const isPhone = useMediaQuery('(max-width: 640px)');
  const viewW = 920;
  const viewH = height;
  const unitLabel = metric === 'spins' ? 'Spins' : 'Songs';

  const { slices, stackTotal, undatedCount } = useMemo(() => {
    const datedSum = decades.reduce((sum, d) => sum + metricValue(d, metric), 0);
    const showUndated = metric === 'songs' && totalCatalogSongs > datedCatalogSongs && datedSum === datedCatalogSongs;
    const undated = showUndated ? Math.max(0, totalCatalogSongs - datedCatalogSongs) : 0;
    const total = Math.max(1, datedSum + undated);
    const list = decades
      .map((d, idx) => {
        const val = metricValue(d, metric);
        return {
          id: d.id, label: SHORT_DECADE_LABELS[d.id] || d.label, fullLabel: d.label, value: val,
          pct: (val / total) * 100, pctText: ((val / total) * 100).toFixed(1),
          mixPct: ERA_SLICE_STEPS[d.id] ?? (16 + idx * 5),
        };
      })
      .filter((s) => s.value > 0);
    return { slices: list, stackTotal: total, undatedCount: undated };
  }, [decades, metric, totalCatalogSongs, datedCatalogSongs]);

  const activeDecadeObj = useMemo(
    () => (selectedDecade ? decades.find((d) => d.id === selectedDecade) || null : null),
    [decades, selectedDecade],
  );

  const focusYears = useMemo(
    () => (activeDecadeObj ? collectPeakYears([activeDecadeObj], metric, 100) : collectPeakYears(decades, metric, 24)),
    [decades, activeDecadeObj, metric],
  );

  const focusStats = useMemo(() => {
    let minVal = Infinity;
    let maxVal = 0;
    let peakYear = null;
    let total = 0;
    for (const item of focusYears) {
      total += item.value;
      if (item.value < minVal) minVal = item.value;
      if (item.value > maxVal) { maxVal = item.value; peakYear = item.year; }
    }
    return { minVal: minVal === Infinity ? 0 : minVal, maxVal: Math.max(1, maxVal), peakYear, total: Math.max(1, total) };
  }, [focusYears]);

  const tiles = useMemo(() => {
    const items = focusYears.map((yr) => ({
      ...yr, id: `${yr.decadeId}-${yr.year}`, value: Math.max(0.5, yr.value), rawValue: yr.value,
    }));
    return squarifyLayout(items, 2, 2, viewW - 4, viewH - 4);
  }, [focusYears, viewW, viewH]);

  const activePreview = useMemo(() => {
    if (hoveredYear) return hoveredYear;
    if (selectedYear) return focusYears.find((y) => y.year === selectedYear) || null;
    return null;
  }, [hoveredYear, selectedYear, focusYears]);

  const coverage = useMemo(
    () => summarizeCoverage(totalCatalogSongs, datedCatalogSongs),
    [totalCatalogSongs, datedCatalogSongs],
  );

  const handleKeyActivate = (event, fn) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fn?.(); }
  };

  if (!decades.length) {
    return (
      <EmptyFilterState
        items="dated Songs"
        title="No dated Songs match this slice."
        description={emptyMessage || 'Clear the active filter to browse all dated Songs.'}
        clearLabel="Reset Filters"
        onClear={onResetAll}
      />
    );
  }

  return (
    <div className="atlas-treemap-wrap">
      <div className="atlas-era-toolbar">
        <div className="seg-group" role="group" aria-label="Focus decade">
          <button type="button" className="seg-btn" aria-pressed={!selectedDecade} onClick={() => onSelectDecade?.('')}>
            All (Top 24)
          </button>
          {decades.map((d) => (
            <button key={d.id} type="button" className="seg-btn" aria-pressed={selectedDecade === d.id} onClick={() => onSelectDecade?.(d.id)}>
              {SHORT_DECADE_LABELS[d.id] || d.label}
            </button>
          ))}
        </div>

        <span className="atlas-scope-badge font-mono num">
          {activeDecadeObj ? `${activeDecadeObj.label} · ${focusYears.length} yrs` : `Top ${focusYears.length} Peak Years`}
        </span>
      </div>

      <div
        className="era-stack-bar"
        role={isTouchOrCompact ? undefined : 'group'}
        aria-label={isTouchOrCompact ? undefined : 'Proportional decade share bar'}
        aria-hidden={isTouchOrCompact ? 'true' : undefined}
      >
        {slices.map((s) => {
          const isSelected = selectedDecade === s.id;
          const isDimmed = Boolean(selectedDecade && selectedDecade !== s.id);
          const cls = ['era-stack-seg', isSelected ? 'is-active' : '', isDimmed ? 'is-dimmed' : ''].filter(Boolean).join(' ');
          const segStyle = { width: `${Math.max(s.pct, 0.7)}%`, backgroundColor: heatMixFill(s.mixPct) };
          if (isTouchOrCompact) {
            return <span key={s.id} className={cls} style={segStyle} />;
          }
          return (
            <button
              key={s.id}
              type="button"
              className={cls}
              style={segStyle}
              aria-pressed={isSelected}
              aria-label={`${s.fullLabel}: ${formatInt(s.value)} ${unitLabel} (${s.pctText}%)`}
              title={`${s.fullLabel}: ${formatInt(s.value)} ${unitLabel} (${s.pctText}%)`}
              onClick={() => onSelectDecade?.(s.id)}
            />
          );
        })}
        {undatedCount > 0 ? (
          <span
            className="era-stack-seg is-undated"
            style={{ width: `${Math.max((undatedCount / stackTotal) * 100, 1.5)}%` }}
            title={isTouchOrCompact ? undefined : `Undated: ${formatInt(undatedCount)} Songs`}
          />
        ) : null}
      </div>

      <div className="atlas-readout" aria-live="polite">
        {activePreview ? (
          <>
            <span className="font-mono num atlas-readout-accent">{activePreview.year}</span>
            <span>({activePreview.decadeLabel})</span>
            <span className="font-mono num">{formatInt(activePreview.songCount)} Songs</span>
            <span className="font-mono num">{formatInt(activePreview.spinCount)} Spins</span>
            <span className="font-mono num">{((activePreview.value / focusStats.total) * 100).toFixed(1)}% of focus</span>
            {activePreview.topSong ? (
              <span className="atlas-readout-sample">Top: {activePreview.topSong.artist} — {activePreview.topSong.title}</span>
            ) : null}
          </>
        ) : (
          <span className="atlas-readout-muted">
            {isPhone
              ? 'Tap a decade above or any release year below to cross-filter the map.'
              : 'Select a decade strip above or click any large year tile below to cross-filter the map.'}
          </span>
        )}
      </div>

      {isPhone ? (
        <ol className="atlas-mobile-years" aria-label={activeDecadeObj ? `${activeDecadeObj.label} ranked release years` : 'Top archive release years'}>
          {focusYears.slice(0, 16).map((yr) => {
            const intensity = computeHeatIntensity(yr.value, focusStats.minVal, focusStats.maxVal);
            const widthPct = Math.max(6, Math.round((yr.value / focusStats.maxVal) * 100));
            const isSelected = selectedYear === yr.year;
            return (
              <li key={`${yr.decadeId}-${yr.year}`}>
                <button
                  type="button"
                  className={isSelected ? 'atlas-mobile-year-btn is-active' : 'atlas-mobile-year-btn'}
                  aria-pressed={isSelected}
                  onClick={() => { setHoveredYear(null); onSelectYear?.(yr.decadeId, yr.year); }}
                >
                  <span className="atlas-mobile-year-head">
                    <span className="atlas-mobile-year-left">
                      <span className="atlas-mobile-year-num font-mono num">{yr.year}</span>
                      <span className="atlas-mobile-year-era">{SHORT_DECADE_LABELS[yr.decadeId] || yr.decadeLabel}</span>
                    </span>
                    <span className="atlas-mobile-year-metric font-mono num">{formatInt(yr.value)} {unitLabel}</span>
                  </span>
                  <span className="atlas-mobile-year-track" aria-hidden="true">
                    <span className="atlas-mobile-year-fill" style={{ width: `${widthPct}%`, backgroundColor: heatMixFill(intensity) }} />
                  </span>
                  {yr.topArtist ? <span className="atlas-mobile-year-artist">{yr.topArtist}</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <svg
          viewBox={`0 0 ${viewW} ${viewH}`}
          className="atlas-treemap-svg"
          role="group"
          aria-label={activeDecadeObj ? `${activeDecadeObj.label} year breakdown treemap` : 'Top 24 archive years treemap'}
          onMouseLeave={() => setHoveredYear(null)}
        >
          {tiles.map((tile) => {
            const fill = heatMixFill(computeHeatIntensity(tile.rawValue, focusStats.minVal, focusStats.maxVal));
            const isSelected = selectedYear === tile.year;
            const isPeak = !isSelected && tile.year === focusStats.peakYear && tiles.length > 1;
            const tileClass = isSelected ? 'atlas-year-tile is-selected' : isPeak ? 'atlas-year-tile is-peak' : 'atlas-year-tile';
            const showYear = tile.w >= 44 && tile.h >= 28;
            const showMeta = tile.w >= 70 && tile.h >= 46;
            const showArtist = tile.w >= 110 && tile.h >= 66 && tile.topArtist;
            const maxChars = Math.max(8, Math.floor((tile.w - 16) / 6.8));
            return (
              <g
                key={tile.id}
                className="atlas-year-hit"
                tabIndex={0}
                role="button"
                aria-pressed={isSelected}
                aria-label={`${tile.year} (${tile.decadeLabel}): ${formatInt(tile.songCount)} Songs, ${formatInt(tile.spinCount)} Spins`}
                onClick={() => { setHoveredYear(null); onSelectYear?.(tile.decadeId, tile.year); }}
                onKeyDown={(e) => handleKeyActivate(e, () => onSelectYear?.(tile.decadeId, tile.year))}
                onPointerEnter={(e) => { if (e.pointerType !== 'touch') setHoveredYear(tile); }}
                onFocus={() => setHoveredYear(tile)}
                onBlur={() => setHoveredYear(null)}
              >
                <rect x={tile.x + 1.5} y={tile.y + 1.5} width={Math.max(0, tile.w - 3)} height={Math.max(0, tile.h - 3)} rx={4} style={{ fill }} className={tileClass} />
                {showYear ? <text x={tile.x + 10} y={tile.y + 22} className="atlas-year-label">{tile.year}</text> : null}
                {showMeta ? <text x={tile.x + 10} y={tile.y + 39} className="atlas-year-count">{formatInt(tile.rawValue)} {unitLabel}</text> : null}
                {showArtist ? <text x={tile.x + 10} y={tile.y + 56} className="atlas-year-artist">{truncateLabel(tile.topArtist, maxChars)}</text> : null}
              </g>
            );
          })}
        </svg>
      )}

      <div className="atlas-treemap-footer">
        <div className="atlas-legend-row">
          <span className="atlas-legend-label">Quiet</span>
          <div className="atlas-heat-scale" aria-hidden="true">
            {HEAT_STEPS.map((pct) => <span key={pct} className="atlas-heat-swatch" style={{ backgroundColor: heatMixFill(pct) }} />)}
          </div>
          <span className="atlas-legend-label">Peak</span>
          <span className="atlas-range-meta font-mono num">{formatInt(focusStats.minVal)}–{formatInt(focusStats.maxVal)} {unitLabel}/yr</span>
        </div>

        {coverage ? (
          <div className="atlas-coverage-row">
            <span className="atlas-legend-label">Catalog coverage</span>
            <span className="atlas-coverage-pill font-mono num">Dated {formatInt(coverage.dated)} ({coverage.datedPct}%)</span>
            <span className="atlas-coverage-pill is-muted font-mono num">Undated {formatInt(coverage.undated)} ({coverage.undatedPct}%)</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
