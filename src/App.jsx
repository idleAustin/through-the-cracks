// Root application routes and shared archive overview telemetry state.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { getOverview } from './api';
import AppShell from './components/AppShell';
import { NotFoundState } from './components/DataState';
import ArtistsView from './views/ArtistsView';
import EpisodesView from './views/EpisodesView';
import OverviewView from './views/OverviewView';
import SearchView from './views/SearchView';
import SongsView from './views/SongsView';

export default function App() {
  const [overviewData, setOverviewData] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState('');
  const [overviewRetryKey, setOverviewRetryKey] = useState(0);
  const overviewInFlightRef = useRef({ key: null, promise: null });

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

  return (
    <AppShell
      totalSpins={overviewData?.totalSongPlays ?? null}
      latestEpisodeId={overviewData?.latestEpisodeId ?? null}
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
        <Route path="*" element={<NotFoundState />} />
      </Routes>

      <footer className="app-footer">
        <div>
          Through the Cracks · WEVL 89.9 FM Radio Archive · Hosted by Ed Dirmeyer · Premiered Dec 7, 1991
        </div>
        <div>
          Blogger API v3 &amp; Google BigQuery · <span className="font-mono num">36,902</span> spins recorded (<span className="font-mono num">2013–2026</span> digital archive)
        </div>
      </footer>
    </AppShell>
  );
}
