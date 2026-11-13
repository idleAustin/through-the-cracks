// Overview telemetry dashboard: Readout Strip, dynamic Annual Spin Volume chart, and asymmetric linked catalog cards.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getArtists, getArtistSongs, getSongs, getYearSpins } from '../api';
import AnnualSpinChart from '../components/AnnualSpinChart';
import { ArchiveErrorState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import OverviewCards from '../components/OverviewCards';
import { formatAirDate, formatInt, useMediaQuery } from '../utils/format';

const VALID_CAPS = new Set(['10', '25', '50', '100', 'all']);

function sortScopedSongs(songs, rank) {
  return [...songs].sort((a, b) => {
    const playsA = Number(a.totalPlays || 0);
    const playsB = Number(b.totalPlays || 0);
    if (rank === 'obscure') {
      const firstA = String(a.firstPlayed || a.firstAppearance || '');
      const firstB = String(b.firstPlayed || b.firstAppearance || '');
      return (
        playsA - playsB
        || (firstA && firstB ? firstA.localeCompare(firstB) : (firstA ? -1 : (firstB ? 1 : 0)))
        || String(a.songTitle || '').localeCompare(String(b.songTitle || ''))
      );
    }
    return playsB - playsA || String(a.songTitle || '').localeCompare(String(b.songTitle || ''));
  });
}

function seedYearData(yearSummary) {
  if (!Array.isArray(yearSummary) || yearSummary.length === 0) return null;
  return {
    years: yearSummary.map((y) => Number(y.year)),
    spins: yearSummary.map((y) => Number(y.songCount || 0)),
    scope: 'archive',
    artist: null,
    song: null,
  };
}

export default function OverviewView({ data, loading, error, onRetry }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isCompact = useMediaQuery('(max-width: 768px)');
  const rowCap = isCompact ? 6 : 10;

  const rank = searchParams.get('rank') === 'obscure' ? 'obscure' : 'top';
  const rawCap = searchParams.get('cap') || '10';
  const cap = VALID_CAPS.has(rawCap) ? rawCap : '10';
  const apage = Math.max(1, parseInt(searchParams.get('apage') || '1', 10) || 1);
  const spage = Math.max(1, parseInt(searchParams.get('spage') || '1', 10) || 1);

  const [selectedArtist, setSelectedArtist] = useState(null);
  const [focusedSong, setFocusedSong] = useState(null);
  const [chartScope, setChartScope] = useState('all');

  const [artistsState, setArtistsState] = useState({ items: [], pagination: null, loading: true, error: '' });
  const [songsState, setSongsState] = useState({ items: [], pagination: null, loading: true, error: '' });
  const [yearState, setYearState] = useState({ data: null, loading: true, error: '' });
  const [artistsRetry, setArtistsRetry] = useState(0);
  const [songsRetry, setSongsRetry] = useState(0);
  const [yearsRetry, setYearsRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setArtistsState((prev) => ({ ...prev, loading: true, error: '' }));
    getArtists({ sort: rank, cap, page: apage, limit: rowCap })
      .then((res) => {
        if (!active) return;
        const payload = res.data || {};
        setArtistsState({
          items: payload.items || payload.artists || [],
          pagination: payload.pagination || {
            page: apage,
            limit: rowCap,
            total: payload.total ?? 0,
            totalPages: Math.max(1, Math.ceil((payload.total ?? 0) / rowCap)),
          },
          loading: false,
          error: '',
        });
      })
      .catch((err) => {
        if (!active) return;
        setArtistsState({
          items: [],
          pagination: null,
          loading: false,
          error: err?.message || 'Could not load artists.',
        });
      });
    return () => {
      active = false;
    };
  }, [rank, cap, apage, rowCap, artistsRetry]);

  useEffect(() => {
    let active = true;
    setSongsState((prev) => ({ ...prev, loading: true, error: '' }));

    const loadSongs = selectedArtist
      ? getArtistSongs(selectedArtist).then((res) => {
        const sorted = sortScopedSongs(res.data?.songs || [], rank);
        const capLimit = cap === 'all' ? sorted.length : Number(cap);
        const capped = sorted.slice(0, capLimit);
        const total = capped.length;
        const totalPages = total === 0 ? 0 : Math.ceil(total / rowCap);
        const safePage = Math.max(1, Math.min(spage, totalPages || 1));
        const offset = (safePage - 1) * rowCap;
        return {
          items: capped.slice(offset, offset + rowCap).map((s) => ({
            ...s,
            artist: selectedArtist,
          })),
          pagination: { page: safePage, limit: rowCap, total, totalPages },
        };
      })
      : getSongs({ sort: rank, cap, page: spage, limit: rowCap }).then((res) => {
        const payload = res.data || {};
        return {
          items: payload.items || payload.songs || [],
          pagination: payload.pagination || {
            page: spage,
            limit: rowCap,
            total: payload.total ?? 0,
            totalPages: Math.max(1, Math.ceil((payload.total ?? 0) / rowCap)),
          },
        };
      });

    loadSongs
      .then((res) => {
        if (!active) return;
        setSongsState({ items: res.items, pagination: res.pagination, loading: false, error: '' });
      })
      .catch((err) => {
        if (!active) return;
        setSongsState({
          items: [],
          pagination: null,
          loading: false,
          error: err?.message || 'Could not load songs.',
        });
      });

    return () => {
      active = false;
    };
  }, [selectedArtist, rank, cap, spage, rowCap, songsRetry]);

  const queryArtist =
    chartScope === 'song' && focusedSong
      ? focusedSong.artist
      : (chartScope === 'artist' && selectedArtist ? selectedArtist : '');
  const querySong = chartScope === 'song' && focusedSong ? focusedSong.title : '';

  useEffect(() => {
    let active = true;
    setYearState((prev) => ({ ...prev, loading: true, error: '' }));
    getYearSpins({ artist: queryArtist, song: querySong })
      .then((res) => {
        if (!active) return;
        setYearState({ data: res.data, loading: false, error: '' });
      })
      .catch((err) => {
        if (!active) return;
        setYearState({
          data: null,
          loading: false,
          error: err?.message || 'Could not load annual spin volume.',
        });
      });
    return () => {
      active = false;
    };
  }, [queryArtist, querySong, yearsRetry]);

  const handleRankChange = useCallback(
    (nextRank) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextRank === 'obscure') next.set('rank', 'obscure');
        else next.delete('rank');
        next.delete('apage');
        next.delete('spage');
        return next;
      });
    },
    [setSearchParams],
  );

  const handleCapChange = useCallback(
    (nextCap) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextCap && nextCap !== '10') next.set('cap', nextCap);
        else next.delete('cap');
        next.delete('apage');
        next.delete('spage');
        return next;
      });
    },
    [setSearchParams],
  );

  const handleArtistsPageChange = useCallback(
    (nextPage) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextPage > 1) next.set('apage', String(nextPage));
        else next.delete('apage');
        return next;
      });
    },
    [setSearchParams],
  );

  const handleSongsPageChange = useCallback(
    (nextPage) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (nextPage > 1) next.set('spage', String(nextPage));
        else next.delete('spage');
        return next;
      });
    },
    [setSearchParams],
  );

  const handleSelectArtist = useCallback(
    (artistName) => {
      if (selectedArtist === artistName) {
        setSelectedArtist(null);
        setFocusedSong(null);
        setChartScope('all');
      } else {
        setSelectedArtist(artistName);
        setFocusedSong(null);
        setChartScope('artist');
      }
      setSearchParams((prev) => {
        if (!prev.has('spage')) return prev;
        const next = new URLSearchParams(prev);
        next.delete('spage');
        return next;
      });
    },
    [selectedArtist, setSearchParams],
  );

  const handleClearArtistScope = useCallback(() => {
    setSelectedArtist(null);
    setChartScope((prev) => (prev === 'artist' ? 'all' : prev));
    setSearchParams((prev) => {
      if (!prev.has('spage')) return prev;
      const next = new URLSearchParams(prev);
      next.delete('spage');
      return next;
    });
  }, [setSearchParams]);

  const handleSelectSong = useCallback((songTitle, artistName) => {
    setFocusedSong({ title: songTitle, artist: artistName });
    setChartScope('song');
  }, []);

  const handleViewSongDates = useCallback(
    (songTitle, artistName) => {
      navigate(
        `/episodes?song=${encodeURIComponent(songTitle)}&artist=${encodeURIComponent(artistName)}`,
      );
    },
    [navigate],
  );

  if (error) {
    return <ArchiveErrorState message={error} onRetry={onRetry} />;
  }

  if (loading || !data) {
    return <SkeletonRows count={4} label="Loading overview" />;
  }

  const latestDate = data.latestEpisodeDate || data.dateRange?.latest;
  const latestUrl = data.latestEpisodeId
    ? `/episodes?episode=${encodeURIComponent(data.latestEpisodeId)}`
    : '/episodes';
  const avgSpins = (Number(data.totalSongPlays || 0) / Math.max(1, Number(data.totalEpisodes || 1))).toFixed(1);
  const topArtist = data.topArtists?.[0];
  const chartData = yearState.data || (chartScope === 'all' ? seedYearData(data.yearSummary) : null);

  return (
    <div className="overview-page">
      <header className="overview-header">
        <div className="overview-header-copy">
          <h1>Archive Telemetry</h1>
          <p className="overview-subtitle">
            WEVL 89.9 FM Memphis · Hosted by Ed Dirmeyer · On air since Dec 7, 1991
          </p>
        </div>

        <Link to={latestUrl} className="btn btn-primary latest-broadcast-btn">
          <Icon name="playlist" size="sm" />
          Latest Broadcast ({formatAirDate(latestDate)})
        </Link>
      </header>

      <dl className="readout-strip">
        <div className="readout-cell">
          <dt>Total Spins</dt>
          <dd>
            <span className="readout-num" id="kpi-plays">{formatInt(data.totalSongPlays)}</span>
            <span className="readout-unit">spins</span>
          </dd>
          <p className="readout-context">Avg {avgSpins} spins per episode</p>
        </div>
        <div className="readout-cell">
          <dt>Archived Episodes</dt>
          <dd>
            <span className="readout-num" id="kpi-episodes">{formatInt(data.totalEpisodes)}</span>
            <span className="readout-unit">episodes</span>
          </dd>
          <p className="readout-context">
            {formatAirDate(data.dateRange?.earliest)} to {formatAirDate(data.dateRange?.latest)}
          </p>
        </div>
        <div className="readout-cell">
          <dt>Catalog Artists</dt>
          <dd>
            <span className="readout-num" id="kpi-artists">{formatInt(data.uniqueArtists)}</span>
            <span className="readout-unit">artists</span>
          </dd>
          <p className="readout-context">
            Top: {topArtist?.name || '—'} ({formatInt(topArtist?.plays)} spins)
          </p>
        </div>
        <div className="readout-cell">
          <dt>Unique Songs</dt>
          <dd>
            <span className="readout-num" id="kpi-songs">{formatInt(data.uniqueSongs)}</span>
            <span className="readout-unit">songs</span>
          </dd>
          <p className="readout-context">Across {formatInt(data.uniqueAlbums)} albums</p>
        </div>
      </dl>

      <AnnualSpinChart
        scope={chartScope}
        artistName={selectedArtist}
        songTitle={focusedSong?.title || ''}
        songArtist={focusedSong?.artist || ''}
        yearData={chartData}
        loading={yearState.loading}
        error={yearState.error}
        isCompact={isCompact}
        onScopeChange={setChartScope}
        onRetry={() => setYearsRetry((k) => k + 1)}
      />

      <OverviewCards
        overview={data}
        rank={rank}
        cap={cap}
        apage={apage}
        spage={spage}
        rowCap={rowCap}
        selectedArtist={selectedArtist}
        focusedSong={focusedSong}
        isCompact={isCompact}
        artistsState={artistsState}
        songsState={songsState}
        onRankChange={handleRankChange}
        onCapChange={handleCapChange}
        onArtistsPageChange={handleArtistsPageChange}
        onSongsPageChange={handleSongsPageChange}
        onSelectArtist={handleSelectArtist}
        onClearArtistScope={handleClearArtistScope}
        onSelectSong={handleSelectSong}
        onViewSongDates={handleViewSongDates}
        onRetryArtists={() => setArtistsRetry((k) => k + 1)}
        onRetrySongs={() => setSongsRetry((k) => k + 1)}
      />
    </div>
  );
}
