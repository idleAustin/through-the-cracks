// Search Artist Dashboard shell: fetches artist profile and renders hero, 6-cell readout strip, year/rotation grids, and 3 leaderboards.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getArtistProfile } from '../api';
import { formatAirDate, formatInt, formatShortMonthYear, normalizeSongKey } from '../utils/format';
import ArtistLeaderboard from './ArtistLeaderboard';
import ArtistRotationCard from './ArtistRotationCard';
import ArtistYearPanel from './ArtistYearPanel';
import { ArchiveErrorState, EmptyFilterState, SkeletonRows } from './DataState';
import Icon from './Icon';

export default function ArtistDashboard({ artistName, onBack, onSelectArtist }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [expandedSong, setExpandedSong] = useState(null);

  useEffect(() => {
    setExpandedSong(null);
    if (!artistName) {
      setData(null);
      setLoading(false);
      setError('');
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    getArtistProfile(artistName)
      .then((res) => {
        if (cancelled) return;
        setData(res?.data ?? null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(err?.message || `Could not load profile for ${artistName}.`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artistName, retryKey]);

  const canonicalSongMap = useMemo(() => {
    const map = new Map();
    for (const song of data?.topSongs || []) {
      const key = normalizeSongKey(song.songTitle);
      if (key && !map.has(key)) map.set(key, song.songTitle);
    }
    return map;
  }, [data]);

  const handleToggleSong = useCallback(
    (songTitle) => {
      const key = normalizeSongKey(songTitle);
      if (!key) return;
      const canonical = canonicalSongMap.get(key) || songTitle;
      setExpandedSong((prev) => (normalizeSongKey(prev) === key ? null : canonical));
    },
    [canonicalSongMap],
  );

  const airingsBySong = useMemo(() => {
    const map = new Map();
    for (const airing of data?.airings || []) {
      const key = normalizeSongKey(airing.songTitle);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(airing);
    }
    return map;
  }, [data]);

  const getAiringsForSong = useCallback(
    (songTitle) => airingsBySong.get(normalizeSongKey(songTitle)) || [],
    [airingsBySong],
  );

  const songItems = useMemo(
    () =>
      (data?.topSongs || []).map((s) => ({
        key: s.songTitle,
        label: s.songTitle,
        sub: s.album || '—',
        count: s.totalPlays,
      })),
    [data],
  );

  const albumItems = useMemo(
    () =>
      (data?.topAlbums || []).map((a) => ({
        key: a.album,
        label: a.album,
        sub: (
          <>
            <span className="mono">{formatInt(a.uniqueSongs)}</span>{' '}
            {a.uniqueSongs === 1 ? 'song' : 'songs'} · since{' '}
            <span className="mono">{formatShortMonthYear(a.firstAppearance)}</span>
          </>
        ),
        count: a.totalPlays,
      })),
    [data],
  );

  const alongsideItems = useMemo(
    () =>
      (data?.playedAlongside || []).map((p) => ({
        key: p.name,
        label: p.name,
        sub: (
          <>
            <span className="mono">#{formatInt(p.rank)}</span> all-time
          </>
        ),
        count: p.sharedEpisodes,
      })),
    [data],
  );

  if (loading || error || !data) {
    const headingText = artistName || 'Artist profile';
    return (
      <section className="ad-wrap" aria-label={`${headingText} dashboard`}>
        <header className="surface-region ad-hero ad-hero--state">
          <div className="ad-hero-main">
            {loading || error ? (
              <div className="ad-back-row">
                <button type="button" className="btn btn-secondary ad-back-btn" onClick={onBack}>
                  <Icon name="arrow-left" size="sm" />
                  Back to results
                </button>
              </div>
            ) : null}
            <h1>{headingText}</h1>
          </div>
        </header>

        {loading ? (
          <div className="surface-region ad-state-card">
            <SkeletonRows count={6} label={`Loading ${headingText} dashboard`} />
          </div>
        ) : error ? (
          <ArchiveErrorState
            headingLevel="h2"
            message={error}
            onRetry={() => setRetryKey((k) => k + 1)}
          />
        ) : (
          <EmptyFilterState
            headingLevel="h2"
            title="No artist matches that name in the archive."
            description="Check spelling or return to search results to choose another artist."
            clearLabel="Back to results"
            clearIcon="arrow-left"
            onClear={onBack}
          />
        )}
      </section>
    );
  }

  const summary = data.summary || {};
  const rotation = data.rotation || {};
  const archive = data.archive || {};
  const peakYear = data.peakYear;
  const sharePct = (Number(summary.shareOfSpins || 0) * 100).toFixed(2);
  const topAlbumName = data.topAlbums?.[0]?.album || '';
  const hasAlbum = Boolean(summary.uniqueAlbums > 0 && topAlbumName);

  const kpis = [
    {
      label: 'Spins',
      value: <span className="mono">{formatInt(summary.totalPlays)}</span>,
      sub: (
        <>
          <span className="mono">{sharePct}%</span> of all spins
        </>
      ),
    },
    {
      label: 'Episodes',
      value: <span className="mono">{formatInt(summary.episodeCount)}</span>,
      sub: (
        <>
          of <span className="mono">{formatInt(archive.totalEpisodes)}</span> archived
        </>
      ),
    },
    {
      label: 'Songs',
      value: <span className="mono">{formatInt(summary.uniqueSongs)}</span>,
      sub: (
        <>
          <span className="mono">{formatInt(summary.oneSpinSongs)}</span> spun once
        </>
      ),
    },
    {
      label: 'Albums',
      value: <span className="mono">{formatInt(summary.uniqueAlbums)}</span>,
      sub: hasAlbum ? `top: ${topAlbumName}` : 'no album credited',
      subTitle: hasAlbum ? topAlbumName : undefined,
    },
    {
      label: 'Avg gap',
      value: rotation.avgGapDays != null ? <span className="mono">{formatInt(rotation.avgGapDays)}d</span> : '—',
      sub: 'between airings',
    },
    {
      label: 'Last spin',
      value:
        summary.daysSinceLast != null ? (
          <>
            <span className="mono">{formatInt(summary.daysSinceLast)}d</span>{' '}
            <span className="ad-kpi-unit">ago</span>
          </>
        ) : (
          '—'
        ),
      sub: <span className="mono">{formatAirDate(summary.lastAppearance)}</span>,
    },
  ];

  return (
    <section className="ad-wrap" aria-label={`${data.artist} dashboard`}>
      <header className="surface-region ad-hero">
        <div className="ad-hero-main">
          <div className="ad-back-row">
            <button type="button" className="btn btn-secondary ad-back-btn" onClick={onBack}>
              <Icon name="arrow-left" size="sm" />
              Back to results
            </button>
          </div>
          <h1>{data.artist}</h1>
          <p className="ad-hero-summary">
            On the air <span className="mono">{formatAirDate(summary.firstAppearance)}</span> through{' '}
            <span className="mono">{formatAirDate(summary.lastAppearance)}</span>.
            {peakYear && peakYear.spins > 0 ? (
              <>
                {' '}
                Peak year <span className="mono">{peakYear.year}</span>,{' '}
                <span className="mono">{formatInt(peakYear.spins)}</span>{' '}
                {peakYear.spins === 1 ? 'spin' : 'spins'}.
              </>
            ) : null}
          </p>
        </div>

        <div className="ad-rank-box">
          <span className="ad-rank-num mono">#{formatInt(data.rank)}</span>
          <span className="ad-rank-meta">
            of <span className="mono">{formatInt(data.totalArtists)}</span> artists by spins
          </span>
        </div>
      </header>

      <dl className="readout-strip ad-kpi-grid" aria-label="Artist summary metrics">
        {kpis.map((tile) => (
          <div key={tile.label} className="readout-cell ad-kpi">
            <dt className="ad-kpi-label">{tile.label}</dt>
            <dd className="ad-kpi-val">{tile.value}</dd>
            <dd className="ad-kpi-sub" title={tile.subTitle}>
              {tile.sub}
            </dd>
          </div>
        ))}
      </dl>

      <div className="ad-mid-grid">
        <ArtistYearPanel
          artistName={data.artist}
          years={data.years}
          peakYear={data.peakYear}
          months={data.months}
          airings={data.airings}
          archiveDateRange={archive.dateRange}
          expandedSong={expandedSong}
          onSelectSong={handleToggleSong}
          getAiringsForSong={getAiringsForSong}
        />
        <ArtistRotationCard rotation={rotation} />
      </div>

      <div className="ad-boards-grid">
        <ArtistLeaderboard
          id="ad-top-songs"
          title="Top songs"
          unit="spins"
          items={songItems}
          expandedKey={expandedSong}
          onToggleItem={handleToggleSong}
          getAiringsForItem={getAiringsForSong}
        />
        <ArtistLeaderboard
          id="ad-top-albums"
          title="Top albums"
          unit="spins"
          items={albumItems}
        />
        <ArtistLeaderboard
          id="ad-played-alongside"
          title="Played alongside"
          unit="shared episodes"
          items={alongsideItems}
          onSelectItem={onSelectArtist}
        />
      </div>
    </section>
  );
}
