// Artist rotation facts panel: silence gaps, episode openers/closers, usual slot marker, and doubled-up spins.
import React from 'react';
import { formatAirDate, formatInt } from '../utils/format';

function getSlotLabel(avgSlot) {
  const value = Number(avgSlot ?? 0);
  if (value < 0.33) return 'Early';
  if (value < 0.66) return 'Mid-set';
  return 'Late';
}

export default function ArtistRotationCard({ rotation }) {
  const longest = rotation?.longestSilence;
  const hasSilenceRange = Boolean(longest?.days > 0 && longest?.from && longest?.to);
  const rawSlot = Number(rotation?.avgSlot ?? 0);
  const clampedSlot = Math.max(0, Math.min(1, Number.isFinite(rawSlot) ? rawSlot : 0));
  const slotLabel = getSlotLabel(clampedSlot);
  const slotPct = Math.round(clampedSlot * 100);

  return (
    <section className="surface-region ad-panel" aria-label="Rotation">
      <header className="ad-panel-head">
        <h2>Rotation</h2>
      </header>

      <dl className="ad-facts">
        <div className="ad-fact-row">
          <dt>Longest silence</dt>
          <dd className="ad-fact-val mono">
            {longest?.days > 0 ? `${formatInt(longest.days)}d` : '—'}
          </dd>
          <dd className="ad-fact-sub">
            {hasSilenceRange ? (
              <>
                <span className="mono">{formatAirDate(longest.from)}</span> to{' '}
                <span className="mono">{formatAirDate(longest.to)}</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>

        <div className="ad-fact-row">
          <dt>Opened an episode</dt>
          <dd className="ad-fact-val mono">{formatInt(rotation?.openers ?? 0)}×</dd>
        </div>

        <div className="ad-fact-row">
          <dt>Closed an episode</dt>
          <dd className="ad-fact-val mono">{formatInt(rotation?.closers ?? 0)}×</dd>
        </div>

        <div className="ad-fact-row">
          <dt>Usual slot</dt>
          <dd className="ad-fact-val">{slotLabel}</dd>
          <dd className="ad-fact-sub">
            <span
              className="ad-slot-track"
              role="img"
              aria-label={`Usual slot: ${slotLabel}, ${slotPct}% into episode`}
            >
              <span className="ad-slot-dot" style={{ left: `${slotPct}%` }} />
            </span>
          </dd>
        </div>

        <div className="ad-fact-row">
          <dt>Doubled up</dt>
          <dd className="ad-fact-val mono">{formatInt(rotation?.doubledUp ?? 0)}</dd>
          <dd className="ad-fact-sub">extra spins in shared episodes</dd>
        </div>
      </dl>
    </section>
  );
}
