// Four-cell Archive Telemetry Readout Strip for the Overview dashboard.
import React from 'react';
import { formatAirDate, formatInt } from '../utils/format';

export default function OverviewReadoutStrip({ data }) {
  const avgSpins = (
    Number(data.totalSongPlays || 0) / Math.max(1, Number(data.totalEpisodes || 1))
  ).toFixed(1);
  const topArtist = data.topArtists?.[0];

  return (
    <dl className="readout-strip">
      <div className="readout-cell">
        <dt>Total Spins</dt>
        <dd>
          <span className="readout-num" id="kpi-plays">{formatInt(data.totalSongPlays)}</span>
          <span className="readout-unit">spins</span>
        </dd>
        <p className="readout-context">
          Avg <span className="font-mono num">{avgSpins}</span> spins per episode
        </p>
      </div>
      <div className="readout-cell">
        <dt>Archived Episodes</dt>
        <dd>
          <span className="readout-num" id="kpi-episodes">{formatInt(data.totalEpisodes)}</span>
          <span className="readout-unit">episodes</span>
        </dd>
        <p className="readout-context">
          <span className="font-mono num">{formatAirDate(data.dateRange?.earliest)}</span>
          {' to '}
          <span className="font-mono num">{formatAirDate(data.dateRange?.latest)}</span>
        </p>
      </div>
      <div className="readout-cell">
        <dt>Catalog Artists</dt>
        <dd>
          <span className="readout-num" id="kpi-artists">{formatInt(data.uniqueArtists)}</span>
          <span className="readout-unit">artists</span>
        </dd>
        <p className="readout-context">
          Top: {topArtist?.name || '—'} (<span className="font-mono num">{formatInt(topArtist?.plays)}</span> spins)
        </p>
      </div>
      <div className="readout-cell">
        <dt>Unique Songs</dt>
        <dd>
          <span className="readout-num" id="kpi-songs">{formatInt(data.uniqueSongs)}</span>
          <span className="readout-unit">songs</span>
        </dd>
        <p className="readout-context">
          Across <span className="font-mono num">{formatInt(data.uniqueAlbums)}</span> albums
        </p>
      </div>
    </dl>
  );
}
