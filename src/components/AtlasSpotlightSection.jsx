// Three-column Spotlight breakdown panel for the selected (or default) state and era in Metadata Atlas.
import React from 'react';
import { Link } from 'react-router-dom';
import { formatInt } from '../utils/format';

export default function AtlasSpotlightSection({
  inspectedState,
  producedLabelCount = 0,
  activeEraText = '',
  selectedState = '',
  includeMastering = false,
  matchingSongs = { items: [], isFallbackToState: false },
}) {
  if (!inspectedState) return null;

  const studioList = includeMastering
    ? inspectedState.allStudios?.topStudios
    : inspectedState.recorded?.topStudios;
  const sampleItems = matchingSongs?.items || [];

  return (
    <section className="surface-region" aria-label="Selection spotlight">
      <div className="region-toolbar">
        <div>
          <h2>
            Spotlight: {inspectedState.name} ({inspectedState.code})
            {activeEraText ? <> · <span className="font-mono num">{activeEraText}</span></> : null}
          </h2>
          <p className="chart-header-sub">
            {selectedState
              ? 'Selected state breakdown'
              : `Defaulting spotlight to ${inspectedState.name} — click any state to switch`}
          </p>
        </div>
        <span className="chart-header-sub">
          <span className="font-mono num">{formatInt(producedLabelCount)}</span> produced ·{' '}
          <span className="font-mono num">{formatInt(inspectedState.artistOrigin?.artists)}</span> native Artists
        </span>
      </div>

      <div className="atlas-spotlight-grid">
        <div className="atlas-spotlight-col">
          <h3>Top Studios &amp; Cities</h3>
          <ul className="atlas-rank-list">
            {studioList?.length ? (
              studioList.map((s) => (
                <li key={s.name}>
                  <span className="atlas-rank-name">{s.name}</span>
                  <span className="atlas-mobile-count font-mono num">{formatInt(s.count)}</span>
                </li>
              ))
            ) : (
              <li className="atlas-readout-muted">No studio credits indexed in {inspectedState.code}.</li>
            )}
          </ul>
          {inspectedState.recorded?.topCities?.length ? (
            <p className="atlas-inline-meta">
              Cities:{' '}
              {inspectedState.recorded.topCities.map((c, idx) => (
                <React.Fragment key={c.name}>
                  {idx > 0 ? ' · ' : ''}
                  {c.name} (<span className="font-mono num">{formatInt(c.count)}</span>)
                </React.Fragment>
              ))}
            </p>
          ) : null}
        </div>

        <div className="atlas-spotlight-col">
          <h3>Native Artists ({inspectedState.code})</h3>
          <ul className="atlas-rank-list">
            {inspectedState.artistOrigin?.topArtists?.length ? (
              inspectedState.artistOrigin.topArtists.map((a) => (
                <li key={a.name}>
                  <Link to={`/artists?artist=${encodeURIComponent(a.name)}`} className="cell-link-btn atlas-rank-name">
                    {a.name}
                  </Link>
                  <span className="atlas-mobile-count font-mono num">{formatInt(a.spins)}x</span>
                </li>
              ))
            ) : (
              <li className="atlas-readout-muted">No native Artists mapped to {inspectedState.code}.</li>
            )}
          </ul>
        </div>

        <div className="atlas-spotlight-col">
          <h3>
            Sample Songs{matchingSongs?.isFallbackToState ? ` (${inspectedState.code} All Eras)` : ''}
          </h3>
          <ul className="atlas-song-list">
            {sampleItems.length ? (
              sampleItems.map((song) => (
                <li key={song.key}>
                  <div className="atlas-song-row">
                    <Link
                      to={`/episodes?song=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist)}`}
                      className="cell-link-btn cell-primary atlas-rank-name"
                    >
                      {song.title}
                    </Link>
                    <span className="atlas-mobile-count font-mono num atlas-readout-accent">{song.year} · {formatInt(song.spins)}x</span>
                  </div>
                  <div className="atlas-sub-cell">
                    {song.artist}{song.studio ? ` · ${song.studio}` : ''}
                  </div>
                </li>
              ))
            ) : (
              <li className="atlas-readout-muted">Switch map lens or clear filter to browse matching Songs.</li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
