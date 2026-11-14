// Artist monthly heatmap matrix, mobile month selector, intensity legend, and active month airing drawer.
import React, { useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { formatAirDate, formatInt } from '../utils/format';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ROW_LABELS = ['Jan / Jul', '', 'Mar / Sep', '', 'May / Nov', ''];

export const ROW_LABEL_COL_PX = 56;

function formatShortMonth(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return '—';
  const [yr, mo] = monthKey.split('-').map(Number);
  return `${SHORT_MONTHS[mo - 1] || mo} ’${String(yr).slice(2)}`;
}

function formatFullMonth(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return '—';
  const [yr, mo] = monthKey.split('-').map(Number);
  return `${FULL_MONTHS[mo - 1] || mo} ${yr}`;
}

function countArchiveMonths(earliest, latest) {
  if (!earliest || !latest) return 0;
  const [y0, m0] = String(earliest).slice(0, 7).split('-').map(Number);
  const [y1, m1] = String(latest).slice(0, 7).split('-').map(Number);
  if (![y0, m0, y1, m1].every(Number.isFinite)) return 0;
  return Math.max(0, (y1 - y0) * 12 + (m1 - m0) + 1);
}

function normalizeSongKey(title) {
  return String(title || '').trim().toLowerCase();
}

function formatAiringSlot(airing) {
  return airing.episodeSongCount > 0 ? `#${airing.position}/${airing.episodeSongCount}` : `#${airing.position}`;
}

export default function ArtistHeatmapView({
  years = [],
  visibleYears = [],
  months = [],
  airings = [],
  archiveDateRange = {},
  selectedMonth,
  expandedSong = null,
  onSelectMonth,
  onSelectSong,
  getAiringsForSong,
}) {
  const lastMonthTriggerRef = useRef(null);

  const monthMap = useMemo(() => {
    const map = new Map();
    for (const entry of months) {
      if (entry?.month) map.set(entry.month, Number(entry.spins || 0));
    }
    return map;
  }, [months]);

  const activeMonths = useMemo(
    () =>
      months
        .filter((entry) => Number(entry?.spins || 0) > 0 && /^\d{4}-\d{2}$/.test(String(entry?.month || '')))
        .slice()
        .sort((a, b) => b.month.localeCompare(a.month)),
    [months],
  );

  const maxMonthSpins = useMemo(() => Math.max(1, ...months.map((m) => Number(m.spins || 0))), [months]);

  const busiestMonth = useMemo(() => {
    let best = null;
    for (const m of months) {
      if (!best || Number(m.spins || 0) > Number(best.spins || 0)) best = m;
    }
    return best;
  }, [months]);

  const selectedHits = useMemo(
    () => (selectedMonth ? airings.filter((a) => String(a.airDate || '').startsWith(selectedMonth)) : []),
    [airings, selectedMonth],
  );

  const normalizedExpanded = normalizeSongKey(expandedSong);
  const firstArchiveMonth = archiveDateRange?.earliest ? String(archiveDateRange.earliest).slice(0, 7) : '';
  const lastArchiveMonth = archiveDateRange?.latest ? String(archiveDateRange.latest).slice(0, 7) : '';
  const totalArchiveMonths = countArchiveMonths(archiveDateRange?.earliest, archiveDateRange?.latest);
  const trimmedYears = visibleYears.length < years.length;

  const handleCloseDrawer = () => {
    const trigger = lastMonthTriggerRef.current;
    onSelectMonth(null);
    if (trigger && trigger.isConnected && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => trigger.focus());
    }
  };

  return (
    <>
      <div
        className="ah-grid"
        style={{ gridTemplateColumns: `${ROW_LABEL_COL_PX}px repeat(${Math.max(1, visibleYears.length * 2)}, minmax(8px, 1fr))` }}
      >
        {ROW_LABELS.map((label, r) => (
          <span key={`rl-${r}`} className="ah-rl" style={{ gridRow: r + 2 }}>{label}</span>
        ))}

        {visibleYears.map((yObj, yi) => (
          <React.Fragment key={yObj.year}>
            <span className="ah-yl mono" style={{ gridColumn: `${yi * 2 + 2} / span 2`, gridRow: 1 }}>
              {`’${String(yObj.year).slice(2)}`}
            </span>

            {[0, 1].map((half) =>
              [0, 1, 2, 3, 4, 5].map((r) => {
                const monthIndex = half * 6 + r;
                const monthKey = `${yObj.year}-${String(monthIndex + 1).padStart(2, '0')}`;
                const spins = monthMap.get(monthKey) || 0;
                const isOut = Boolean(
                  (firstArchiveMonth && monthKey < firstArchiveMonth) ||
                  (lastArchiveMonth && monthKey > lastArchiveMonth),
                );
                const lvl = spins > 0 ? Math.min(4, Math.ceil((spins / maxMonthSpins) * 4)) : 0;
                const isSelected = selectedMonth === monthKey;
                const posStyle = { gridColumn: yi * 2 + half + 2, gridRow: r + 2 };
                const cellLabel = `${FULL_MONTHS[monthIndex]} ${yObj.year}: ${formatInt(spins)} ${spins === 1 ? 'spin' : 'spins'}`;

                const cls = `ah-cell l${spins > 0 ? lvl : 0}${isOut ? ' is-out' : ''}${isSelected ? ' is-sel' : ''}`;
                if (spins > 0) {
                  return (
                    <button
                      key={monthKey}
                      type="button"
                      data-month={monthKey}
                      className={cls}
                      style={posStyle}
                      aria-label={cellLabel}
                      aria-pressed={isSelected}
                      title={cellLabel}
                      onClick={(event) => {
                        lastMonthTriggerRef.current = event.currentTarget;
                        onSelectMonth((prev) => (prev === monthKey ? null : monthKey));
                      }}
                    />
                  );
                }
                const zeroTitle = isOut ? 'Outside archive range' : `${FULL_MONTHS[monthIndex]} ${yObj.year}: 0 spins`;
                return <span key={monthKey} className={cls} style={posStyle} title={zeroTitle} />;
              }),
            )}
          </React.Fragment>
        ))}
      </div>

      {activeMonths.length > 0 ? (
        <div className="ad-month-select-wrap">
          <select
            className="ad-month-select"
            aria-label="Select month"
            value={selectedMonth || ''}
            onChange={(event) => {
              const nextMonth = event.target.value || null;
              lastMonthTriggerRef.current = event.currentTarget;
              onSelectMonth(nextMonth);
            }}
          >
            <option value="">Select a month ({formatInt(activeMonths.length)} active)</option>
            {activeMonths.map((entry) => (
              <option key={entry.month} value={entry.month}>
                {formatFullMonth(entry.month)} — {formatInt(entry.spins)} {entry.spins === 1 ? 'spin' : 'spins'}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="ah-cap">
        <span className="ah-cap-summary">
          Busiest month: <strong className="mono">{busiestMonth ? formatShortMonth(busiestMonth.month) : '—'}</strong>{' '}
          (<span className="mono">{formatInt(busiestMonth?.spins || 0)}</span>). On the air in{' '}
          <span className="mono">{formatInt(months.length)}</span> of{' '}
          <span className="mono">{formatInt(totalArchiveMonths)}</span> months.
          {trimmedYears ? ` Showing last ${visibleYears.length} years.` : ''}
        </span>

        <span className="ah-legend" aria-label="Heatmap intensity scale from less to more">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((lvl) => <span key={lvl} className={`ah-cell l${lvl}`} aria-hidden="true" />)}
          <span>More</span>
        </span>
      </div>

      {selectedMonth ? (
        <div className="ad-month-drawer" aria-label={`${formatFullMonth(selectedMonth)} airings`}>
          <div className="ad-month-drawer-head">
            <span>
              <strong className="mono">{formatFullMonth(selectedMonth)}</strong> ·{' '}
              <span className="mono">{formatInt(selectedHits.length)}</span> {selectedHits.length === 1 ? 'spin' : 'spins'}
            </span>
            <button type="button" className="btn btn-secondary btn-sm ad-drawer-close" onClick={handleCloseDrawer}>
              Close
            </button>
          </div>

          <ul className="ad-month-list">
            {selectedHits.map((hit, idx) => {
              const hitKey = normalizeSongKey(hit.songTitle);
              const isSongExpanded = Boolean(normalizedExpanded) && normalizedExpanded === hitKey;
              const songAirings = isSongExpanded
                ? (getAiringsForSong
                    ? getAiringsForSong(hit.songTitle)
                    : airings.filter((a) => normalizeSongKey(a.songTitle) === hitKey))
                : [];
              return (
                <li
                  key={`${hit.episodeId}-${hit.position}-${idx}`}
                  className={`ad-month-item${isSongExpanded ? ' is-open' : ''}`}
                >
                  <div className="ad-month-item-row">
                    <span className="ad-month-song">
                      <button
                        type="button"
                        className="ad-drawer-song-btn"
                        aria-expanded={isSongExpanded}
                        onClick={() => onSelectSong?.(hit.songTitle)}
                      >
                        {hit.songTitle}
                      </button>
                      {hit.album ? <span className="ad-month-album">{hit.album}</span> : null}
                    </span>
                    <Link to={`/episodes?episode=${encodeURIComponent(hit.episodeId)}`} className="ad-chip mono">
                      {formatAirDate(hit.airDate)} · {formatAiringSlot(hit)}
                    </Link>
                  </div>

                  {isSongExpanded ? (
                    <div className="ad-airing-chips" aria-label={`Air dates for ${hit.songTitle}`}>
                      {songAirings.map((airing, chipIdx) => (
                        <Link
                          key={`${airing.episodeId}-${airing.position}-${chipIdx}`}
                          to={`/episodes?episode=${encodeURIComponent(airing.episodeId)}`}
                          className="ad-chip mono"
                        >
                          {formatAirDate(airing.airDate)} · {formatAiringSlot(airing)}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}
