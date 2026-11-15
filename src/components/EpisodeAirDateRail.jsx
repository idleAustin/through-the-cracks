// Responsive episode air-date list rendering collapsible desktop Broadcast Log rail and mobile card stack.
import React, { useRef } from 'react';
import { getBroadcastDayOfWeek } from '../../server/episodeDetailBuilder.js';
import { formatAirDate, formatInt } from '../utils/format';
import Icon from './Icon';
import Pagination from './Pagination';
import Tooltip from './Tooltip';

function getShortWeekday(airDate) {
  const dow = getBroadcastDayOfWeek(airDate);
  return dow ? dow.slice(0, 3).toUpperCase() : '';
}

export default function EpisodeAirDateRail({
  isNarrow,
  isCollapsed = false,
  onToggleCollapse,
  episodes,
  total = 0,
  effectiveEpisodeId,
  onSelectEpisode,
  pagination,
  page,
  onPageChange,
}) {
  const scrollRef = useRef(null);

  if (isNarrow) {
    return (
      <>
        <div className="m-card-stack">
          {episodes.map((ep) => {
            const dowShort = getShortWeekday(ep.airDate);
            return (
              <button
                key={ep.id}
                type="button"
                className="m-card"
                onClick={() => onSelectEpisode(ep.id)}
              >
                <div className="m-card-top">
                  <span className="m-card-title font-mono num">{formatAirDate(ep.airDate)}</span>
                  <span className="m-card-right">
                    {dowShort && <span className="airdate-dow font-mono">{dowShort}</span>}
                    <span className="spin-count font-mono num">
                      {formatInt(ep.songCount)} {ep.songCount === 1 ? 'spin' : 'spins'}
                    </span>
                    <Icon name="arrow-right" size={14} />
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <Pagination
          pagination={pagination}
          page={page}
          onPageChange={onPageChange}
          noun="episodes"
          idPrefix="episodes"
        />
      </>
    );
  }

  const toggleLabel = isCollapsed ? 'Expand air dates' : 'Collapse air dates';

  return (
    <aside
      className={`surface-region airdate-rail${isCollapsed ? ' is-collapsed' : ''}`}
      aria-label="Episode air dates"
    >
      <div className="region-toolbar rail-toolbar">
        <div className="rail-title-group">
          <span className="rail-title">{isCollapsed ? 'Dates' : 'Air Dates'}</span>
          {!isCollapsed && (
            <span className="rail-count font-mono num">{formatInt(total)}</span>
          )}
        </div>

        <Tooltip label={toggleLabel} position="down-left">
          <button
            type="button"
            className="icon-action-btn sm rail-collapse-btn"
            aria-expanded={!isCollapsed}
            aria-label={toggleLabel}
            onClick={onToggleCollapse}
          >
            <Icon name={isCollapsed ? 'panel-expand' : 'panel-collapse'} size="sm" />
          </button>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="airdate-scroll" role="listbox" aria-label="Air date list">
        {episodes.map((ep) => {
          const selected = ep.id === effectiveEpisodeId;
          const dowShort = getShortWeekday(ep.airDate);
          return (
            <button
              key={ep.id}
              type="button"
              role="option"
              aria-selected={selected}
              className="airdate-row airdate-item"
              onClick={() => onSelectEpisode(ep.id)}
            >
              <span className="airdate-label">
                {selected && <span className="nav-lime-dot" aria-hidden="true" />}
                {formatAirDate(ep.airDate)}
              </span>
              {!isCollapsed && (
                <span className="airdate-meta">
                  {dowShort && <span className="airdate-dow font-mono">{dowShort}</span>}
                  <span className="spin-count font-mono num">
                    {formatInt(ep.songCount)} {ep.songCount === 1 ? 'spin' : 'spins'}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <Pagination
        pagination={pagination}
        page={page}
        onPageChange={onPageChange}
        noun="episodes"
        idPrefix="episodes"
        compact
      />
    </aside>
  );
}
