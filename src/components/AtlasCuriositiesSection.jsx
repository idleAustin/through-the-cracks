// Controlled archive curiosities table (desktop) and hairline row list (mobile) with WAI-ARIA tablist for Metadata Atlas.
import React, { useRef } from 'react';
import { Link } from 'react-router-dom';
import { formatAirDate, formatInt, useMediaQuery } from '../utils/format';

const CURIO_TABS = [
  { key: 'producers', label: 'Producers' },
  { key: 'writers', label: 'Songwriters' },
  { key: 'labels', label: 'Labels' },
  { key: 'timeCapsules', label: 'Time-Capsule Gaps' },
];

export default function AtlasCuriositiesSection({
  curiosities = {},
  activeTab = 'producers',
  onChangeTab,
}) {
  const isCompact = useMediaQuery('(max-width: 768px)');
  const tabRefs = useRef({});
  const curioTab = CURIO_TABS.some((t) => t.key === activeTab) ? activeTab : 'producers';
  const timeCapsules = curiosities.timeCapsules || {};
  const list = curioTab === 'timeCapsules' ? (timeCapsules.vintageGems || []) : (curiosities[curioTab] || []);

  const handleTabKeyDown = (event, idx) => {
    let nextIdx = -1;
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % CURIO_TABS.length;
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + CURIO_TABS.length) % CURIO_TABS.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = CURIO_TABS.length - 1;
    if (nextIdx === -1) return;
    event.preventDefault();
    const nextKey = CURIO_TABS[nextIdx].key;
    onChangeTab?.(nextKey);
    tabRefs.current[nextKey]?.focus();
  };

  return (
    <section className="surface-region" aria-label="Archive curiosities">
      <div className="region-toolbar">
        <div>
          <h2>Behind the Glass &amp; Time-Capsule Gaps</h2>
          <p className="chart-header-sub">
            {curioTab === 'timeCapsules' ? (
              <>
                <span className="font-mono num">{formatInt(timeCapsules.freshSameYearSongs)}</span> fresh same/next-year Songs · avg{' '}
                <span className="font-mono num">{timeCapsules.avgSongAgeAtFirstSpin ?? 0}</span> years before first WEVL Spin
              </>
            ) : (
              'Top cross-archive connectors linking unrelated WEVL Episodes'
            )}
          </p>
        </div>

        <div className="seg-group atlas-curio-tabs" role="tablist" aria-label="Curiosity category">
          {CURIO_TABS.map((t, idx) => {
            const isSelected = curioTab === t.key;
            return (
              <button
                key={t.key}
                ref={(node) => { tabRefs.current[t.key] = node; }}
                id={`curio-tab-${t.key}`}
                type="button"
                role="tab"
                aria-controls="curio-tabpanel"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                className="seg-btn"
                onClick={() => onChangeTab?.(t.key)}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div id="curio-tabpanel" role="tabpanel" aria-labelledby={`curio-tab-${curioTab}`}>
        {isCompact ? (
          list.length === 0 ? (
            <p className="atlas-curio-empty">No entries recorded for this slice.</p>
          ) : curioTab === 'timeCapsules' ? (
            <ol className="playlist-mobile-list">
              {list.map((gem, idx) => (
                <li key={`${gem.artist}-${gem.title}`} className="playlist-mobile-row">
                  <span className="playlist-pos font-mono num">{idx + 1}</span>
                  <div className="playlist-mobile-main">
                    <Link
                      to={`/episodes?song=${encodeURIComponent(gem.title)}&artist=${encodeURIComponent(gem.artist)}`}
                      className="cell-link-btn cell-primary"
                    >
                      {gem.title}
                    </Link>
                    <div className="playlist-mobile-meta">
                      <span className="atlas-rank-name">{gem.artist}{gem.studio ? ` · ${gem.studio}` : ''}</span>
                      <span className="atlas-mobile-count">Released <span className="font-mono num">{gem.releaseYear}</span></span>
                      <span className="atlas-mobile-count">First Spin <span className="font-mono num">{formatAirDate(gem.firstSpinDate)}</span></span>
                      <span className="atlas-mobile-count font-mono num atlas-readout-accent">{gem.gapYears}y gap</span>
                      <span className="atlas-mobile-count"><span className="font-mono num">{formatInt(gem.spins)}</span> Spins</span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <ol className="playlist-mobile-list">
              {list.map((item, idx) => (
                <li key={item.name} className="playlist-mobile-row">
                  <span className="playlist-pos font-mono num">{idx + 1}</span>
                  <div className="playlist-mobile-main">
                    <span className="cell-primary atlas-rank-name">{item.name}</span>
                    <div className="playlist-mobile-meta">
                      <span className="atlas-mobile-count"><span className="font-mono num">{formatInt(item.artistCount)}</span> Artists</span>
                      <span className="atlas-mobile-count atlas-readout-accent"><span className="font-mono num">{formatInt(item.songs)}</span> Songs</span>
                      <span className="atlas-mobile-count"><span className="font-mono num">{formatInt(item.spins)}</span> Spins</span>
                    </div>
                    {item.sampleArtists?.length ? (
                      <div className="atlas-sub-cell">{item.sampleArtists.slice(0, 4).join(', ')}</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )
        ) : (
          <div className="table-container">
            <table className="data-table atlas-curio-table">
              <thead>
                {curioTab === 'timeCapsules' ? (
                  <tr>
                    <th className="col-num">#</th>
                    <th>Song &amp; Artist</th>
                    <th className="col-num">Released</th>
                    <th className="col-num">First WEVL Spin</th>
                    <th className="col-num">Gap</th>
                    <th className="col-num">Spins</th>
                  </tr>
                ) : (
                  <tr>
                    <th className="col-num">#</th>
                    <th>Name</th>
                    <th>Sample WEVL Artists</th>
                    <th className="col-num">Artists</th>
                    <th className="col-num">Songs</th>
                    <th className="col-num">Spins</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {list.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="cell-dim">No entries recorded for this slice.</td>
                  </tr>
                ) : curioTab === 'timeCapsules' ? (
                  list.map((gem, idx) => (
                    <tr key={`${gem.artist}-${gem.title}`}>
                      <td className="cell-mono col-num">{idx + 1}</td>
                      <td>
                        <Link
                          to={`/episodes?song=${encodeURIComponent(gem.title)}&artist=${encodeURIComponent(gem.artist)}`}
                          className="cell-link-btn cell-primary"
                        >
                          {gem.title}
                        </Link>
                        <div className="atlas-sub-cell">{gem.artist}{gem.studio ? ` · ${gem.studio}` : ''}</div>
                      </td>
                      <td className="cell-mono col-num">{gem.releaseYear}</td>
                      <td className="cell-mono col-num">{formatAirDate(gem.firstSpinDate)}</td>
                      <td className="cell-mono col-num atlas-readout-accent">{gem.gapYears}y</td>
                      <td className="cell-mono col-num">{formatInt(gem.spins)}</td>
                    </tr>
                  ))
                ) : (
                  list.map((item, idx) => (
                    <tr key={item.name}>
                      <td className="cell-mono col-num">{idx + 1}</td>
                      <td className="cell-primary">{item.name}</td>
                      <td className="cell-dim">{(item.sampleArtists || []).slice(0, 4).join(', ')}</td>
                      <td className="cell-mono col-num">{formatInt(item.artistCount)}</td>
                      <td className="cell-mono col-num atlas-readout-accent">{formatInt(item.songs)}</td>
                      <td className="cell-mono col-num">{formatInt(item.spins)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
