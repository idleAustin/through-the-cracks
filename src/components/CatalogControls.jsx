// Shared catalog sorting toggle and depth cap selector controls for Artists and Songs views.
import React from 'react';

const CAP_OPTIONS = [
  { value: '10', label: 'Top 10' },
  { value: '25', label: 'Top 25' },
  { value: '50', label: 'Top 50' },
  { value: '100', label: 'Top 100' },
  { value: 'all', label: 'All' },
];

export function SortLensToggle({ sort, onChange }) {
  return (
    <div className="seg-group" role="group" aria-label="Catalog sort order">
      <button
        type="button"
        className="seg-btn"
        aria-pressed={sort !== 'obscure'}
        onClick={() => onChange('top')}
      >
        Most Played
      </button>
      <button
        type="button"
        className="seg-btn"
        aria-pressed={sort === 'obscure'}
        onClick={() => onChange('obscure')}
      >
        Most Obscure
      </button>
    </div>
  );
}

export function ScopeCapSelect({ cap, onChange }) {
  const activeCap = cap || 'all';
  return (
    <div className="seg-group" role="group" aria-label="Catalog result cap">
      {CAP_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="seg-btn"
          aria-pressed={activeCap === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
