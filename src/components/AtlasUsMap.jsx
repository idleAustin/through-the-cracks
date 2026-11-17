// 50-state + DC + Alaska/Hawaii Albers choropleth map with Producer, Artist From, Magnet Delta lenses, and mobile state picker.
import React, { useMemo, useState } from 'react';
import usMapData from '../assets/us-states-albers.json';
import { formatInt } from '../utils/format';

const HIDE_INLINE_CODES = new Set(['RI', 'DE', 'DC', 'CT', 'NJ', 'MD', 'MA', 'NH', 'VT']);

function getStateMetricValue(stData, mapMode, includeMastering) {
  if (!stData) return 0;
  if (mapMode === 'artist') return Number(stData.artistOrigin?.songs || 0);
  if (mapMode === 'magnet') return Number(stData.magnetDelta || 0);
  return Number(includeMastering ? stData.allStudios?.songs : stData.recorded?.songs) || 0;
}

function getStateAriaLabel(name, val, mapMode) {
  if (mapMode === 'magnet') return `${name}: ${val > 0 ? `+${formatInt(val)}` : formatInt(val)} net Songs delta`;
  if (mapMode === 'artist') return `${name}: ${formatInt(val)} native-Artist Songs`;
  return `${name}: ${formatInt(val)} Songs produced`;
}

export default function AtlasUsMap({
  states = {},
  international = { recorded: [], artistOrigin: [] },
  mapMode = 'recorded',
  includeMastering = false,
  selectedState = '',
  eraLabel = '',
  onChangeMapMode,
  onToggleMastering,
  onSelectState,
}) {
  const [hoveredCode, setHoveredCode] = useState('');

  const sortedStates = useMemo(
    () => usMapData.states.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  const { maxAbsVal, topStates } = useMemo(() => {
    const entries = Object.values(states);
    const maxV = Math.max(1, ...entries.map((s) => Math.abs(getStateMetricValue(s, mapMode, includeMastering))));
    const ranked = entries.slice().sort((a, b) => {
      const av = getStateMetricValue(a, mapMode, includeMastering);
      const bv = getStateMetricValue(b, mapMode, includeMastering);
      return mapMode === 'magnet' ? Math.abs(bv) - Math.abs(av) : bv - av;
    }).slice(0, 6);
    return { maxAbsVal: maxV, topStates: ranked };
  }, [states, mapMode, includeMastering]);

  const previewState = states[hoveredCode] || states[selectedState] || states.TN || Object.values(states)[0] || null;
  const intlList = mapMode === 'artist' ? international.artistOrigin : international.recorded;

  const getStateFill = (val) => {
    if (!val) return 'var(--as-bg-elevated)';
    const norm = Math.sqrt(Math.min(1, Math.abs(val) / maxAbsVal));
    const mixPct = Math.round(12 + norm * 32);
    if (mapMode === 'artist') return `color-mix(in srgb, var(--as-status-info) ${mixPct}%, var(--as-bg-elevated))`;
    if (mapMode === 'magnet') {
      const token = val > 0 ? 'var(--as-accent-fg)' : 'var(--as-status-info)';
      return `color-mix(in srgb, ${token} ${mixPct}%, var(--as-bg-elevated))`;
    }
    return `color-mix(in srgb, var(--as-accent-fg) ${mixPct}%, var(--as-bg-elevated))`;
  };

  const legendSteps = mapMode === 'magnet'
    ? [
        'color-mix(in srgb, var(--as-status-info) 44%, var(--as-bg-elevated))',
        'color-mix(in srgb, var(--as-status-info) 22%, var(--as-bg-elevated))',
        'var(--as-bg-elevated)',
        'color-mix(in srgb, var(--as-accent-fg) 22%, var(--as-bg-elevated))',
        'color-mix(in srgb, var(--as-accent-fg) 44%, var(--as-bg-elevated))',
      ]
    : [12, 20, 28, 36, 44].map((step) =>
        `color-mix(in srgb, ${mapMode === 'artist' ? 'var(--as-status-info)' : 'var(--as-accent-fg)'} ${step}%, var(--as-bg-elevated))`,
      );

  const quickCodes = ['AK', 'HI', ...topStates.map((s) => s.code).filter((c) => c !== 'AK' && c !== 'HI')].slice(0, 8);

  return (
    <div className="atlas-map-wrap">
      <div className="atlas-map-toolbar">
        <div className="seg-group" role="group" aria-label="Map layer mode">
          <button type="button" className="seg-btn" aria-pressed={mapMode === 'recorded'} onClick={() => onChangeMapMode?.('recorded')}>Song Produced</button>
          <button type="button" className="seg-btn" aria-pressed={mapMode === 'artist'} onClick={() => onChangeMapMode?.('artist')}>Artist From</button>
          <button type="button" className="seg-btn" aria-pressed={mapMode === 'magnet'} onClick={() => onChangeMapMode?.('magnet')}>Magnet Delta</button>
        </div>

        <div className="atlas-map-subcontrols">
          {mapMode === 'recorded' ? (
            <div className="seg-group" role="group" aria-label="Studio role filter">
              <button type="button" className="seg-btn" aria-pressed={!includeMastering} onClick={() => onToggleMastering?.(false)}>Sessions</button>
              <button type="button" className="seg-btn" aria-pressed={includeMastering} onClick={() => onToggleMastering?.(true)}>Incl. Mastering</button>
            </div>
          ) : null}
          {selectedState ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setHoveredCode(''); onSelectState?.(''); }}>Clear {selectedState}</button>
          ) : null}
        </div>
      </div>

      <div className="atlas-mobile-state-picker">
        <label htmlFor="atlas-state-select" className="sr-only">State filter</label>
        <select
          id="atlas-state-select"
          className="atlas-state-select"
          value={selectedState}
          onChange={(e) => { setHoveredCode(''); onSelectState?.(e.target.value); }}
        >
          <option value="">All US States</option>
          {sortedStates.map((geom) => (
            <option key={geom.code} value={geom.code}>{geom.name} ({geom.code})</option>
          ))}
        </select>
      </div>

      <div className="atlas-readout" aria-live="polite">
        {previewState ? (
          <>
            <strong className="atlas-readout-accent">{previewState.name} ({previewState.code})</strong>
            <span className="font-mono num">{formatInt(includeMastering ? previewState.allStudios?.songs : previewState.recorded?.songs)} Produced</span>
            <span className="font-mono num">{formatInt(previewState.artistOrigin?.songs)} Native-Artist Songs</span>
            <span className="font-mono num">Delta: {previewState.magnetDelta >= 0 ? `+${previewState.magnetDelta}` : previewState.magnetDelta}</span>
            {eraLabel ? <span className="atlas-readout-muted">· {eraLabel}</span> : null}
          </>
        ) : null}
      </div>

      <svg
        viewBox={usMapData.viewBox}
        className="atlas-map-svg"
        role="group"
        aria-label="US 50-state including Alaska and Hawaii heatmap"
        onMouseLeave={() => setHoveredCode('')}
      >
        <rect x="4" y="346" width="320" height="258" rx="6" className="atlas-inset-frame" />
        <text x="14" y="362" className="atlas-inset-caption">Alaska &amp; Hawaii (Albers inset)</text>

        {usMapData.states.map((geom) => {
          const val = getStateMetricValue(states[geom.code], mapMode, includeMastering);
          const isSelected = selectedState === geom.code;
          const showLabel = !HIDE_INLINE_CODES.has(geom.code) && (val !== 0 || geom.code === 'AK' || geom.code === 'HI');
          return (
            <g
              key={geom.code}
              className="atlas-state-hit"
              tabIndex={0}
              role="button"
              aria-pressed={isSelected}
              aria-label={getStateAriaLabel(geom.name, val, mapMode)}
              onClick={() => { setHoveredCode(''); onSelectState?.(geom.code === selectedState ? '' : geom.code); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setHoveredCode('');
                  onSelectState?.(geom.code === selectedState ? '' : geom.code);
                }
              }}
              onPointerEnter={(e) => { if (e.pointerType !== 'touch') setHoveredCode(geom.code); }}
              onFocus={() => setHoveredCode(geom.code)}
              onBlur={() => setHoveredCode('')}
            >
              <path d={geom.d} style={{ fill: getStateFill(val) }} className={isSelected ? 'atlas-state-path is-selected' : 'atlas-state-path'} />
              {showLabel ? <text x={geom.cx} y={geom.cy} className="atlas-state-label">{geom.code}</text> : null}
            </g>
          );
        })}
      </svg>

      <div className="atlas-legend-row">
        <span className="atlas-map-legend-title">
          {mapMode === 'magnet' ? (
            <>Net Pull (<span className="font-mono num">-{formatInt(maxAbsVal)}</span> Exporter to <span className="font-mono num">+{formatInt(maxAbsVal)}</span> Studio Magnet)</>
          ) : (
            <>Scale: <span className="font-mono num">0</span> to <span className="font-mono num">{formatInt(maxAbsVal)}</span> {mapMode === 'artist' ? 'Songs by Native Artists' : 'Songs Cut in State'}</>
          )}
        </span>
        <div className="atlas-map-legend-swatches" aria-hidden="true">
          {legendSteps.map((bg, idx) => <span key={idx} className="atlas-map-legend-box" style={{ background: bg }} />)}
        </div>
      </div>

      <div className="atlas-quick-strip" role="group" aria-label="Quick select top states and Alaska or Hawaii">
        {quickCodes.map((code) => {
          const stData = states[code];
          if (!stData) return null;
          const val = getStateMetricValue(stData, mapMode, includeMastering);
          return (
            <button
              key={code}
              type="button"
              className={selectedState === code ? 'atlas-chip-btn is-active' : 'atlas-chip-btn'}
              aria-pressed={selectedState === code}
              onClick={() => { setHoveredCode(''); onSelectState?.(code === selectedState ? '' : code); }}
            >
              <span className="font-mono">{code}</span>
              <span className="font-mono num">{val >= 0 && mapMode === 'magnet' ? `+${val}` : formatInt(val)}</span>
            </button>
          );
        })}
      </div>

      {intlList?.length ? (
        <div className="atlas-intl-strip">
          <span className="atlas-intl-label">{mapMode === 'artist' ? 'Artists abroad' : 'Sessions abroad'}</span>
          {intlList.slice(0, 6).map((item) => (
            <span key={item.country} className="atlas-intl-pill">
              {item.country} <strong className="font-mono num">{formatInt(mapMode === 'artist' ? item.artists : item.songs)}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
