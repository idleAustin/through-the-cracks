// Overview dashboard displaying KPI summaries, archive timeline, and top artist/song lists.
import React from 'react';
import { ArchiveErrorState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';

export default function OverviewView({ data, loading, error, onRetry, onSelectArtist }) {
  if (error) {
    return <ArchiveErrorState message={error} onRetry={onRetry} />;
  }

  if (loading || !data) {
    return <SkeletonRows count={4} label="Loading overview" />;
  }

  const kpis = [
    {
      id: 'kpi-episodes',
      label: 'Total Episodes',
      value: data.totalEpisodes,
      sub: 'Digitized playlists (2013–2026)',
    },
    {
      id: 'kpi-plays',
      label: 'Song Spins',
      value: data.totalSongPlays,
      sub: 'Individual song spins',
    },
    {
      id: 'kpi-artists',
      label: 'Unique Artists',
      value: data.uniqueArtists,
      sub: 'Independent & roots musicians',
    },
    {
      id: 'kpi-songs',
      label: 'Unique Songs',
      value: data.uniqueSongs,
      sub: `Across ${data.uniqueAlbums?.toLocaleString() ?? '—'} albums`,
    },
  ];

  return (
    <div className="section-stack">
      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <div key={kpi.id} className="ink-panel kpi-card">
            <div className="kpi-label">{kpi.label}</div>
            <div className="kpi-value" id={kpi.id}>{kpi.value?.toLocaleString()}</div>
            <div className="kpi-subtext">{kpi.sub}</div>
          </div>
        ))}
      </div>

      <div className="ink-panel ink-panel--highlight timeline-banner">
        <div>
          <div className="eyebrow">WEVL 89.9 FM Digital Archive Timeline</div>
          <div className="timeline-range">
            <span>{data.dateRange?.earliest}</span>
            <Icon name="arrow_forward" size="sm" />
            <span>{data.dateRange?.latest}</span>
          </div>
        </div>
        <span className="badge">On air since Dec 7, 1991 · 34+ years of Memphis radio</span>
      </div>

      <div className="grid-auto">
        <section className="ink-panel panel-pad">
          <div className="panel-header">
            <h3 className="panel-title">
              <Icon name="trophy" />
              Most Spun Artists
            </h3>
            <span className="badge">All-time</span>
          </div>

          <div className="list-stack">
            {data.topArtists?.map((artist, idx) => (
              <button
                key={idx}
                id={`top-artist-${idx + 1}`}
                type="button"
                className="list-row list-row--clickable"
                onClick={() => onSelectArtist(artist.name)}
              >
                <span className="list-row-main">
                  <span className={`rank-chip ${idx < 3 ? 'rank-chip--top' : ''}`}>
                    {idx + 1}
                  </span>
                  <span className="list-row-title">{artist.name}</span>
                </span>
                <span className="metric-value">{artist.plays} spins</span>
              </button>
            ))}
          </div>
        </section>

        <section className="ink-panel panel-pad">
          <div className="panel-header">
            <h3 className="panel-title">
              <Icon name="music_note" />
              Top Spun Songs
            </h3>
            <span className="badge">Most spun</span>
          </div>

          <div className="list-stack">
            {data.topSongs?.map((song, idx) => (
              <div key={idx} id={`top-song-${idx + 1}`} className="list-row">
                <span className="list-row-main">
                  <span className="list-row-text">
                    <span className="list-row-title">"{song.song}"</span>
                    <span className="list-row-sub">{song.artist}</span>
                  </span>
                </span>
                <span className="metric-value">{song.plays} spins</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
