// Root application routes, persistent Broadcast Booth host, and shared archive overview telemetry state.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { getOverview } from './api';
import AppShell from './components/AppShell';
import { NotFoundState } from './components/DataState';
import ArtistsView from './views/ArtistsView';
import EpisodesView from './views/EpisodesView';
import OverviewView from './views/OverviewView';
import PlaylistView from './views/PlaylistView';
import SearchView from './views/SearchView';
import SongsView from './views/SongsView';

export default function App() {
  const location = useLocation();
  const normalizedPath = location.pathname.replace(/\/+$/, '') || '/';
  const isPlaylistRoute = normalizedPath === '/playlist';

  const [playlistVisited, setPlaylistVisited] = useState(() => isPlaylistRoute);
  const [playlistBarState, setPlaylistBarState] = useState(null);
  const playerControlRef = useRef(null);
  const playlistHostRef = useRef(null);

  const [overviewData, setOverviewData] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState('');
  const [overviewRetryKey, setOverviewRetryKey] = useState(0);
  const overviewInFlightRef = useRef({ key: null, promise: null });

  useEffect(() => {
    if (isPlaylistRoute) {
      setPlaylistVisited(true);
      return;
    }
    if (
      playlistHostRef.current
      && document.activeElement instanceof HTMLElement
      && playlistHostRef.current.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
  }, [isPlaylistRoute]);

  const playlistActivated = playlistVisited || isPlaylistRoute;

  useEffect(() => {
    let active = true;
    if (overviewInFlightRef.current.key !== overviewRetryKey) {
      overviewInFlightRef.current = { key: overviewRetryKey, promise: getOverview() };
    }
    setOverviewLoading(true);
    setOverviewError('');
    overviewInFlightRef.current.promise
      .then((res) => {
        if (active) {
          setOverviewData(res.data);
          setOverviewLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setOverviewError(err?.message || 'Could not load archive overview.');
          setOverviewLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [overviewRetryKey]);

  const retryOverview = useCallback(() => {
    setOverviewRetryKey((key) => key + 1);
  }, []);

  const footerSpins =
    overviewData?.totalSongPlays != null
      ? Number(overviewData.totalSongPlays).toLocaleString('en-US')
      : '—';
  const earliestYear = overviewData?.dateRange?.earliest?.slice(0, 4) || '2013';
  const latestYear = overviewData?.dateRange?.latest?.slice(0, 4) || '2026';

  return (
    <AppShell
      totalSpins={overviewData?.totalSongPlays ?? null}
      latestEpisodeId={overviewData?.latestEpisodeId ?? null}
      isPlaylistRoute={isPlaylistRoute}
      playlistSession={playlistBarState}
    >
      <Routes>
        <Route
          path="/"
          element={
            <OverviewView
              data={overviewData}
              loading={overviewLoading}
              error={overviewError}
              onRetry={retryOverview}
            />
          }
        />
        <Route path="/artists" element={<ArtistsView />} />
        <Route path="/songs" element={<SongsView />} />
        <Route path="/episodes" element={<EpisodesView />} />
        <Route path="/search" element={<SearchView />} />
        <Route path="/playlist" element={null} />
        <Route path="*" element={<NotFoundState />} />
      </Routes>

      {playlistActivated ? (
        <div
          ref={playlistHostRef}
          className={isPlaylistRoute ? 'playlist-persistent-host' : 'playlist-persistent-host is-offroute'}
          aria-hidden={!isPlaylistRoute ? 'true' : undefined}
          inert={!isPlaylistRoute ? true : undefined}
        >
          <PlaylistView
            isActiveRoute={isPlaylistRoute}
            playerControlRef={playerControlRef}
            onSessionStateChange={setPlaylistBarState}
          />
        </div>
      ) : null}

      <footer className="app-footer">
        <div>
          Through the Cracks · WEVL 89.9 FM Radio Archive · Hosted by Ed Dirmeyer · Premiered Dec 7, 1991
        </div>
        <div>
          Blogger API v3 &amp; Cloudflare D1 · <span className="font-mono num">{footerSpins}</span> spins recorded (<span className="font-mono num">{earliestYear}–{latestYear}</span> digital archive)
        </div>
      </footer>
    </AppShell>
  );
}
