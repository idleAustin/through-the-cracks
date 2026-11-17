// Production Metadata Atlas view: cross-filtered 8-decade treemap, US 50-state choropleth, Spotlight, and Curiosities.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { computeFilteredAtlas, getMetadataAtlas } from '../api';
import { decadeForYear } from '../api-atlas';
import AtlasCuriositiesSection from '../components/AtlasCuriositiesSection';
import AtlasEraFocus from '../components/AtlasEraFocus';
import AtlasSpotlightSection from '../components/AtlasSpotlightSection';
import AtlasUsMap from '../components/AtlasUsMap';
import { ArchiveErrorState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import { formatInt } from '../utils/format';

const VALID_LENSES = new Set(['recorded', 'artist', 'magnet']);
const VALID_TABS = new Set(['producers', 'writers', 'labels', 'timeCapsules']);
const EMPTY_ARRAY = [];
const EMPTY_OBJECT = {};
const EMPTY_INTL = { recorded: [], artistOrigin: [] };

function resolveValidatedFilters(params, { validDecades, validYears, states }) {
  const rawEra = params.get('era') || '';
  const rawYear = params.get('year') || '';
  const parsedYear = /^\d{4}$/.test(rawYear) ? Number(rawYear) : null;
  const year = parsedYear !== null && validYears.has(parsedYear) ? parsedYear : null;
  const decade = year !== null ? decadeForYear(year).id : (validDecades.has(rawEra) ? rawEra : '');
  const rawState = (params.get('state') || '').trim().toUpperCase();
  const state = /^[A-Z]{2}$/.test(rawState) && states && Object.prototype.hasOwnProperty.call(states, rawState) ? rawState : '';
  return { year, decade, state };
}

export default function AtlasView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [atlasData, setAtlasData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    getMetadataAtlas({ signal: controller.signal, forceRefresh: retryKey > 0 })
      .then((res) => { if (active) { setAtlasData(res.data); setLoading(false); } })
      .catch((err) => {
        if (active && err?.name !== 'AbortError') { setError(err?.message || 'Could not load metadata atlas.'); setLoading(false); }
      });
    return () => { active = false; controller.abort(); };
  }, [retryKey]);

  const { validDecades, validYears } = useMemo(() => {
    const decSet = new Set();
    const yrSet = new Set();
    for (const dec of atlasData?.decades || []) {
      decSet.add(dec.id);
      for (const yr of dec.years || []) yrSet.add(yr.year);
    }
    return { validDecades: decSet, validYears: yrSet };
  }, [atlasData]);

  const validation = { validDecades, validYears, states: atlasData?.states };
  const { year: selectedYear, decade: selectedDecade, state: selectedState } = resolveValidatedFilters(searchParams, validation);
  const rawLens = searchParams.get('lens') || '';
  const mapMode = VALID_LENSES.has(rawLens) ? rawLens : 'recorded';
  const includeMastering = searchParams.get('mastering') === '1';
  const metric = searchParams.get('metric') === 'spins' ? 'spins' : 'songs';
  const rawTab = searchParams.get('tab') || '';
  const curioTab = VALID_TABS.has(rawTab) ? rawTab : 'producers';

  const latestParamsRef = useRef(searchParams);
  latestParamsRef.current = searchParams;
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;
  const validationRef = useRef(validation);
  validationRef.current = validation;

  const updateParams = useCallback((mutate) => {
    const next = new URLSearchParams(latestParamsRef.current);
    mutate(next);
    latestParamsRef.current = next;
    setSearchParamsRef.current(next, { replace: true });
  }, []);

  const handleSelectDecade = useCallback((decadeId) => updateParams((n) => {
    const { decade: curEra } = resolveValidatedFilters(n, validationRef.current);
    const nextEra = !decadeId || curEra === decadeId ? '' : decadeId;
    n.delete('year');
    if (nextEra) n.set('era', nextEra); else n.delete('era');
  }), [updateParams]);

  const handleSelectYear = useCallback((decadeId, year) => updateParams((n) => {
    const { year: curYear } = resolveValidatedFilters(n, validationRef.current);
    if (decadeId) n.set('era', decadeId);
    if (curYear === year) n.delete('year'); else n.set('year', String(year));
  }), [updateParams]);

  const handleSelectState = useCallback((code) => updateParams((n) => { if (code) n.set('state', code); else n.delete('state'); }), [updateParams]);
  const handleChangeMapMode = useCallback((lens) => updateParams((n) => { if (lens === 'artist' || lens === 'magnet') n.set('lens', lens); else n.delete('lens'); }), [updateParams]);
  const handleToggleMastering = useCallback((on) => updateParams((n) => { if (on) n.set('mastering', '1'); else n.delete('mastering'); }), [updateParams]);
  const handleChangeMetric = useCallback((m) => updateParams((n) => { if (m === 'spins') n.set('metric', 'spins'); else n.delete('metric'); }), [updateParams]);
  const handleChangeTab = useCallback((t) => updateParams((n) => { if (t === 'writers' || t === 'labels' || t === 'timeCapsules') n.set('tab', t); else n.delete('tab'); }), [updateParams]);
  const handleResetAll = useCallback(() => updateParams((n) => { n.delete('era'); n.delete('year'); n.delete('state'); }), [updateParams]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      const cur = resolveValidatedFilters(latestParamsRef.current, validationRef.current);
      if (!cur.year && !cur.decade && !cur.state) return;
      event.preventDefault();
      updateParams((n) => {
        const { year, decade, state } = resolveValidatedFilters(n, validationRef.current);
        if (year) n.delete('year');
        else if (decade) n.delete('era');
        else if (state) n.delete('state');
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [updateParams]);

  const filteredData = useMemo(
    () => computeFilteredAtlas(atlasData, { selectedDecade, selectedYear, selectedState, mapMode, includeMastering }),
    [atlasData, selectedDecade, selectedYear, selectedState, mapMode, includeMastering],
  );

  const summary = filteredData?.summary ?? EMPTY_OBJECT;
  const decades = filteredData?.decades ?? EMPTY_ARRAY;
  const states = filteredData?.states ?? EMPTY_OBJECT;
  const international = filteredData?.international ?? EMPTY_INTL;
  const curiosities = filteredData?.curiosities ?? EMPTY_OBJECT;
  const crateSample = filteredData?.crateSample ?? EMPTY_ARRAY;
  const archiveTotal = summary.totalSongs || 1;
  const inspectedState = states[selectedState] || states.TN || Object.values(states)[0] || null;

  const activeStatesCount = useMemo(
    () => Object.values(states).filter((s) => ((includeMastering ? s.allStudios?.songs : s.recorded?.songs) || 0) > 0 || (s.artistOrigin?.songs || 0) > 0).length,
    [states, includeMastering],
  );
  const scopeDatedSongs = useMemo(
    () => decades.reduce((acc, d) => acc + Number(metric === 'spins' ? d.spinCount : d.songCount), 0),
    [decades, metric],
  );
  const matchingSongs = useMemo(() => {
    const targetState = inspectedState?.code || selectedState || 'TN';
    const filterFn = (matchBoth) => crateSample.filter((song) => {
      if (matchBoth && selectedYear && song.year !== selectedYear) return false;
      if (matchBoth && !selectedYear && selectedDecade && song.decadeId !== selectedDecade) return false;
      if (mapMode === 'artist') return song.origState === targetState;
      if (mapMode === 'recorded') return song.recState === targetState;
      return song.recState === targetState || song.origState === targetState;
    });
    const exact = filterFn(true);
    const items = (exact.length > 0 ? exact : filterFn(false)).slice().sort((a, b) => b.spins - a.spins || b.year - a.year).slice(0, 6);
    return { items, isFallbackToState: exact.length === 0 && Boolean(selectedDecade || selectedYear) };
  }, [crateSample, inspectedState?.code, selectedState, selectedDecade, selectedYear, mapMode]);

  if (loading) {
    return (
      <section className="atlas-page" aria-label="Metadata Atlas">
        <header className="catalog-head">
          <div><h1>Metadata Atlas</h1><p className="catalog-subtitle">Loading release eras, studio origins, and archive credits.</p></div>
        </header>
        <div className="surface-region atlas-state"><SkeletonRows count={8} label="Loading metadata atlas" /></div>
      </section>
    );
  }

  if (error || !atlasData || !filteredData) {
    return (
      <section className="atlas-page" aria-label="Metadata Atlas">
        <header className="catalog-head"><div><h1>Metadata Atlas</h1></div></header>
        <ArchiveErrorState headingLevel="h2" title="Could not load metadata atlas." message={error || 'Metadata atlas payload was empty.'} onRetry={() => setRetryKey((k) => k + 1)} />
      </section>
    );
  }

  const timeCapsules = curiosities.timeCapsules || {};
  const producedLabelCount = inspectedState ? (includeMastering ? inspectedState.allStudios?.songs : inspectedState.recorded?.songs) : 0;
  const activeEraLabel = atlasData.decades.find((d) => d.id === selectedDecade)?.label || selectedDecade;
  const activeEraText = selectedYear ? String(selectedYear) : (selectedDecade ? activeEraLabel : '');
  const emptyTreemapMsg = selectedState && inspectedState ? `No dated Songs match ${inspectedState.name} in ${mapMode} view.` : '';

  return (
    <section className="atlas-page" aria-label="Metadata Atlas">
      <header className="catalog-head">
        <div>
          <h1>Metadata Atlas</h1>
          <p className="catalog-subtitle">
            <span className="font-mono num">{formatInt(summary.songsWithYear)}</span> dated Songs (<span className="font-mono num">{summary.earliestYear}–{summary.latestYear}</span>) cross-indexed with <span className="font-mono num">{formatInt(summary.distinctStudios)}</span> studios and <span className="font-mono num">{formatInt(summary.distinctWriters)}</span> writers.
          </p>
        </div>
        <div className="seg-group" role="group" aria-label="Treemap count metric">
          <button type="button" className="seg-btn" aria-pressed={metric === 'songs'} onClick={() => handleChangeMetric('songs')}>Distinct Songs</button>
          <button type="button" className="seg-btn" aria-pressed={metric === 'spins'} onClick={() => handleChangeMetric('spins')}>Total Spins</button>
        </div>
      </header>

      {selectedState || selectedDecade || selectedYear ? (
        <div className="atlas-scope-bar" role="region" aria-label="Active atlas filters">
          <div className="atlas-filter-chips">
            {selectedState ? <button type="button" className="atlas-chip-btn is-active" aria-label={`Remove state filter ${atlasData.states[selectedState]?.name || selectedState}`} onClick={() => handleSelectState('')}><span>State: {atlasData.states[selectedState]?.name || selectedState}</span><Icon name="close" size={14} /></button> : null}
            {selectedDecade ? <button type="button" className="atlas-chip-btn is-active" aria-label={`Remove era filter ${activeEraLabel}`} onClick={() => handleSelectDecade(selectedDecade)}><span>Era: {activeEraLabel}</span><Icon name="close" size={14} /></button> : null}
            {selectedYear ? <button type="button" className="atlas-chip-btn is-active" aria-label={`Remove year filter ${selectedYear}`} onClick={() => handleSelectYear(selectedDecade, selectedYear)}><span>Year: <span className="font-mono num">{selectedYear}</span></span><Icon name="close" size={14} /></button> : null}
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleResetAll}>Clear All</button>
          </div>
        </div>
      ) : null}

      <dl className="readout-strip">
        <div className="readout-cell">
          <dt>{selectedState && inspectedState ? `${inspectedState.code} ${metric === 'spins' ? 'Spins' : 'Dated Songs'}` : (metric === 'spins' ? 'Dated Spins' : 'Dated Songs')}</dt>
          <dd><span className="readout-num">{formatInt(scopeDatedSongs)}</span><span className="readout-unit">{metric === 'spins' ? 'spins' : 'songs'}</span></dd>
          <p className="readout-context">{selectedState ? 'Filtered to active state' : <><span className="font-mono num">{Math.round((summary.songsWithYear / archiveTotal) * 100)}%</span> of <span className="font-mono num">{formatInt(archiveTotal)}</span> archive Songs</>}</p>
        </div>
        <div className="readout-cell">
          <dt>Active US States</dt>
          <dd><span className="readout-num">{activeStatesCount}</span><span className="readout-unit">of <span className="font-mono num">51</span></span></dd>
          <p className="readout-context"><span className="font-mono num">{formatInt(summary.mappedRecordingSongs)}</span> produced · <span className="font-mono num">{formatInt(summary.mappedArtistOriginArtists)}</span> native Artists</p>
        </div>
        <div className="readout-cell">
          <dt>{selectedState && inspectedState ? `${inspectedState.code} Net Pull` : 'Credits Indexed'}</dt>
          <dd>
            <span className="readout-num">{selectedState && inspectedState ? (inspectedState.magnetDelta >= 0 ? `+${inspectedState.magnetDelta}` : inspectedState.magnetDelta) : formatInt(summary.distinctWriters)}</span>
            <span className="readout-unit">{selectedState ? 'songs delta' : 'writers'}</span>
          </dd>
          <p className="readout-context">
            {selectedState && inspectedState
              ? <><span className="font-mono num">{formatInt(inspectedState.recorded?.songs)}</span> recorded vs <span className="font-mono num">{formatInt(inspectedState.artistOrigin?.songs)}</span> native</>
              : <><span className="font-mono num">{formatInt(summary.distinctProducers)}</span> producers · <span className="font-mono num">{formatInt(summary.distinctLabels)}</span> labels</>}
          </p>
        </div>
        <div className="readout-cell">
          <dt>Vintage &amp; Covers</dt>
          <dd><span className="readout-num">{timeCapsules.avgSongAgeAtFirstSpin ?? 0}y</span><span className="readout-unit">avg age</span></dd>
          <p className="readout-context">At first spin · <span className="font-mono num">{formatInt(summary.coversCount)}</span> pre-SHS covers</p>
        </div>
      </dl>

      <div className="atlas-workbench">
        <section className="surface-region atlas-panel" aria-label="Decade and release year treemap">
          <div className="region-toolbar">
            <div><h2>Songs by Decade &amp; Year</h2><p className="chart-header-sub">{selectedState && inspectedState ? `Narrowed to ${inspectedState.name}` : 'All dated catalog entries'}</p></div>
            {selectedDecade || selectedYear ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleSelectDecade('')}>Reset Era</button> : null}
          </div>
          <div className="atlas-panel-body">
            <AtlasEraFocus decades={decades} metric={metric} selectedDecade={selectedDecade} selectedYear={selectedYear} totalCatalogSongs={archiveTotal} datedCatalogSongs={summary.songsWithYear} emptyMessage={emptyTreemapMsg} onSelectDecade={handleSelectDecade} onSelectYear={handleSelectYear} onResetAll={handleResetAll} height={490} />
          </div>
        </section>
        <section className="surface-region atlas-panel" aria-label="US studio and artist map">
          <div className="region-toolbar">
            <div><h2>US Production &amp; Hometown Heatmap</h2><p className="chart-header-sub">{activeEraText ? `Narrowed to ${activeEraText}` : 'Full archive across 50 states + DC'}</p></div>
          </div>
          <div className="atlas-panel-body">
            <AtlasUsMap states={states} international={international} mapMode={mapMode} includeMastering={includeMastering} selectedState={selectedState} eraLabel={activeEraText} onChangeMapMode={handleChangeMapMode} onToggleMastering={handleToggleMastering} onSelectState={handleSelectState} />
          </div>
        </section>
      </div>

      <AtlasSpotlightSection inspectedState={inspectedState} producedLabelCount={producedLabelCount} activeEraText={activeEraText} selectedState={selectedState} includeMastering={includeMastering} matchingSongs={matchingSongs} />
      <AtlasCuriositiesSection curiosities={curiosities} activeTab={curioTab} onChangeTab={handleChangeTab} />
    </section>
  );
}
