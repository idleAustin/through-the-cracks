// Responsive pagination bar supporting windowed desktop page links, compact rail mode, and 44px mobile controls.
import React from 'react';
import { formatInt, useMediaQuery } from '../utils/format';

function buildPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('…');
  for (let p = start; p <= end; p += 1) pages.push(p);
  if (end < total - 1) pages.push('…');
  pages.push(total);
  return pages;
}

export default function Pagination({
  pagination,
  page,
  onPageChange,
  noun = 'items',
  idPrefix,
  compact = false,
}) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  if (!pagination) return null;

  const total = Number(pagination.total ?? 0);
  const limit = Math.max(1, Number(pagination.limit ?? 20));
  const totalPages = Math.max(1, Number(pagination.totalPages ?? Math.ceil(total / limit)) || 1);
  const currentPage = Math.min(totalPages, Math.max(1, Number(page ?? pagination.page ?? 1) || 1));

  if (compact && totalPages <= 1) return null;

  const startIdx = (currentPage - 1) * limit;
  const shownStart = total === 0 ? 0 : startIdx + 1;
  const shownEnd = Math.min(total, startIdx + limit);
  const prevId = idPrefix ? `${idPrefix}-prev-btn` : undefined;
  const nextId = idPrefix ? `${idPrefix}-next-btn` : undefined;

  if (isMobile) {
    return (
      <nav
        className={`pagination-bar is-mobile${compact ? ' is-compact' : ''}`}
        aria-label={`${noun} pagination`}
      >
        <button
          id={prevId}
          type="button"
          className="page-btn btn-sm is-mobile"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        >
          ← Prev
        </button>
        <span className="pagination-readout font-mono num">
          {compact
            ? `${currentPage} / ${totalPages}`
            : `${formatInt(shownStart)}–${formatInt(shownEnd)} of ${formatInt(total)} (${currentPage}/${totalPages})`}
        </span>
        <button
          id={nextId}
          type="button"
          className="page-btn btn-sm is-mobile"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        >
          Next →
        </button>
      </nav>
    );
  }

  return (
    <nav
      className={`pagination-bar${compact ? ' is-compact' : ''}`}
      aria-label={`${noun} pagination`}
    >
      {!compact && (
        <span className="pagination-readout font-mono num">
          Showing {formatInt(shownStart)}–{formatInt(shownEnd)} of {formatInt(total)}
        </span>
      )}

      <div className={`page-controls${compact ? ' is-compact' : ''}`}>
        <button
          id={prevId}
          type="button"
          className="page-btn btn-sm"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        >
          ← Prev
        </button>

        {compact ? (
          <span className="pagination-readout font-mono num pagination-compact-status">
            {currentPage} / {totalPages}
          </span>
        ) : (
          buildPageNumbers(currentPage, totalPages).map((entry, idx) => (
            entry === '…' ? (
              <span key={`ellipsis-${idx}`} className="page-ellipsis" aria-hidden="true">…</span>
            ) : (
              <button
                key={entry}
                type="button"
                className="page-btn"
                aria-current={entry === currentPage ? 'page' : undefined}
                onClick={() => onPageChange(entry)}
              >
                {entry}
              </button>
            )
          ))
        )}

        <button
          id={nextId}
          type="button"
          className="page-btn btn-sm"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        >
          Next →
        </button>
      </div>
    </nav>
  );
}
