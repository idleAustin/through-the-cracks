// Episode air-date chip links for ArtistDashboard.
import React from 'react';
import { Link } from 'react-router-dom';
import { formatAirDate } from '../utils/format';

export function ArtistAiringChip({ airing }) {
  const slotText = airing.episodeSongCount > 0
    ? `#${airing.position}/${airing.episodeSongCount}`
    : `#${airing.position}`;
  return (
    <Link
      to={`/episodes?episode=${encodeURIComponent(airing.episodeId)}`}
      className="ad-chip mono"
    >
      {formatAirDate(airing.airDate)} · {slotText}
    </Link>
  );
}

export default function ArtistAiringChips({ airings = [], label, className = 'ad-airing-chips' }) {
  return (
    <div className={className} aria-label={label}>
      {(airings || []).map((airing, idx) => (
        <ArtistAiringChip key={`${airing.episodeId}-${airing.position}-${idx}`} airing={airing} />
      ))}
    </div>
  );
}
