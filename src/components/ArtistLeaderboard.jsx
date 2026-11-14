// Reusable ranked top-10 leaderboard card for Top songs, Top albums, and Played alongside.
import React, { useEffect, useRef } from 'react';
import { formatInt } from '../utils/format';
import ArtistAiringChips from './ArtistAiringChips';

export default function ArtistLeaderboard({
  id,
  title,
  unit,
  items = [],
  expandedKey = null,
  onToggleItem,
  onSelectItem,
  getAiringsForItem,
}) {
  const listRef = useRef(null);
  const maxCount = Math.max(1, Number(items[0]?.count ?? 1));
  const isScrollable = items.length > 5;

  useEffect(() => {
    if (!expandedKey || !listRef.current) return;
    const target = listRef.current.querySelector('[data-expanded="true"]');
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [expandedKey]);

  return (
    <section
      id={id}
      className={`surface-region ad-panel ad-board${isScrollable ? ' is-scrollable' : ''}`}
      aria-label={title}
    >
      <header className="ad-panel-head">
        <h2>{title}</h2>
        <span className="ad-board-unit">
          {unit} · top <span className="mono">{items.length}</span>
        </span>
      </header>

      {items.length === 0 ? (
        <p className="ad-board-empty">No entries recorded.</p>
      ) : (
        <ol ref={listRef} className="ad-rank-list">
          {items.map((item, idx) => {
            const rankNum = String(idx + 1).padStart(2, '0');
            const barWidth = Math.max(3, (Number(item.count || 0) / maxCount) * 100);
            const isExpandable = Boolean(onToggleItem);
            const isNavigable = Boolean(onSelectItem);
            const isOpen = isExpandable && expandedKey === item.key;
            const airings = isOpen && getAiringsForItem ? getAiringsForItem(item.key) : [];

            const rowBody = (
              <>
                <span className="ad-rank-i mono">{rankNum}</span>
                <span className="ad-rank-main">
                  <span className="ad-rank-name">{item.label}</span>
                  <span className="ad-rank-sub">{item.sub}</span>
                  <span className="ad-meter" aria-hidden="true">
                    <span className="ad-meter-fill" style={{ width: `${barWidth}%` }} />
                  </span>
                </span>
                <span className="ad-rank-n mono">{formatInt(item.count)}</span>
              </>
            );

            return (
              <li
                key={item.key}
                className={`ad-rank-item${isOpen ? ' is-open' : ''}`}
                data-expanded={isOpen ? 'true' : undefined}
              >
                {isExpandable ? (
                  <button
                    type="button"
                    className="ad-rank-row"
                    aria-expanded={isOpen}
                    onClick={() => onToggleItem(item.key)}
                  >
                    {rowBody}
                  </button>
                ) : isNavigable ? (
                  <button
                    type="button"
                    className="ad-rank-row"
                    onClick={() => onSelectItem(item.key)}
                  >
                    {rowBody}
                  </button>
                ) : (
                  <div className="ad-rank-row ad-rank-row--static">{rowBody}</div>
                )}

                {isOpen ? (
                  <ArtistAiringChips
                    airings={airings}
                    label={`Air dates for ${item.label}`}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
