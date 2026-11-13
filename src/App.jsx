// Root application routes, archive overview state, and detail modals.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { getOverview } from './api';
import AppShell from './components/AppShell';
import ArtistSongsModal from './components/ArtistSongsModal';
import { NotFoundState } from './components/DataState';
import EpisodeModal from './components/EpisodeModal';
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
  const [selectedEpisode, setSelectedEpisode] = useState(null);
  const [selectedArtist, setSelectedArtist] = useState(null);
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

  const handleSelectArtist = (artistName) => {
    setSelectedArtist(artistName);
  };

  return (
    <AppShell totalSpins={overviewData?.totalSongPlays ?? null}>
      <Routes>
        <Route
          path="/"
          element={
            <OverviewView
              data={overviewData}
              loading={overviewLoading}
              error={overviewError}
              onRetry={retryOverview}
              onSelectArtist={handleSelectArtist}
            />
          }
        />
        <Route
          path="/artists"
          element={<ArtistsView onSelectArtist={handleSelectArtist} />}
        />
        <Route
          path="/songs"
          element={<SongsView onSelectArtist={handleSelectArtist} />}
        />
        <Route
          path="/episodes"
          element={<EpisodesView onSelectEpisode={setSelectedEpisode} />}
        />
        <Route
          path="/search"
          element={<SearchView onSelectArtist={handleSelectArtist} />}
        />
        <Route path="*" element={<NotFoundState />} />
      </Routes>

      <EpisodeModal
        episode={selectedEpisode}
        onClose={() => setSelectedEpisode(null)}
      />

      <ArtistSongsModal
        artistName={selectedArtist}
        onClose={() => setSelectedArtist(null)}
      />

      <footer className="app-footer">
        <div>
          Through the Cracks · WEVL 89.9 FM Radio Archive · Hosted by Ed Dirmeyer · Premiered Dec 7, 1991
        </div>
        <div>
          Blogger API v3 &amp; Google BigQuery · 36,902 spins recorded (<span className="num">2013–2026</span> digital archive)
        </div>
      </footer>
    </AppShell>
  );
}
