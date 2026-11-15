// Route container for /playlist managing 2-hour cached session state, background playback, swaps, and exports.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getRandomPlaylist } from '../api';
import {
  DEFAULT_PLAYLIST_FILTERS,
  buildYouTubeQueueUrl,
  copyTextToClipboard,
  formatPlaylistText,
  parsePlaylistFilters,
} from '../utils/playlist-helpers';
import { readStoredPlaylistSession, writeStoredPlaylistSession } from '../utils/playlist-storage';
import { resolvePlaylistSlotSwap } from '../utils/playlist-swap';
import PlaylistBooth from './PlaylistBooth';
import usePlaylistFilterUrlSync from './usePlaylistFilterUrlSync';

function buildDrawKey(mode, minScore, onePerArtist, drawTick) {
  return `${mode}:${minScore}:${onePerArtist}:${drawTick}`;
}

export default function PlaylistView({
  isActiveRoute = true,
  playerControlRef = null,
  onSessionStateChange = null,
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const initialBootstrapRef = useRef(null);
  if (initialBootstrapRef.current === null) {
    const initialFilters = parsePlaylistFilters(location.search);
    const stored = readStoredPlaylistSession(initialFilters);
    initialBootstrapRef.current = { filters: stored ? stored.filters : initialFilters, stored };
  }

  const { filters: bootstrapFilters, stored: storedBoot } = initialBootstrapRef.current;
  const [queue, setQueue] = useState(() => (storedBoot ? storedBoot.queue : []));
  const [poolSize, setPoolSize] = useState(() => (storedBoot ? storedBoot.poolSize : 0));
  const [activeIndex, setActiveIndex] = useState(() => (storedBoot ? storedBoot.activeIndex : 0));
  const [autoplay, setAutoplay] = useState(false);
  const [playerStatus, setPlayerStatus] = useState('cued');
  const [playbackEngaged, setPlaybackEngaged] = useState(false);
  const [loading, setLoading] = useState(() => !storedBoot);
  const [rolling, setRolling] = useState(false);
  const [swappingSlots, setSwappingSlots] = useState(() => new Set());
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState('idle');
  const [drawTick, setDrawTick] = useState(0);

  const mountedRef = useRef(true);
  const drawSeqRef = useRef(0);
  const hydratedDrawKeyRef = useRef(
    storedBoot
      ? buildDrawKey(storedBoot.filters.mode, storedBoot.filters.minScore, storedBoot.filters.onePerArtist, 0)
      : null,
  );
  const queueFiltersRef = useRef(storedBoot ? storedBoot.filters : null);
  const lastPersistedSnapshotRef = useRef(
    storedBoot
      ? { queue: storedBoot.queue, poolSize: storedBoot.poolSize, activeIndex: storedBoot.activeIndex }
      : null,
  );
  const queueRef = useRef(queue);
  const activeIndexRef = useRef(activeIndex);
  const playerStatusRef = useRef(playerStatus);
  const errorRef = useRef(error);
  const swappingSlotsRef = useRef(new Set());
  const inFlightReplacementIdsRef = useRef(new Set());
  const copyTimerRef = useRef(null);

  queueRef.current = queue;
  activeIndexRef.current = activeIndex;
  playerStatusRef.current = playerStatus;
  errorRef.current = error;

  const handleRoll = useCallback(() => {
    setDrawTick((t) => t + 1);
  }, []);

  const {
    filters,
    filtersRef,
    playlistHref,
    handleModeChange,
    handleMinScoreChange,
    handleToggleOnePerArtist,
    handleClearFilters,
  } = usePlaylistFilterUrlSync({
    isActiveRoute,
    initialFilters: bootstrapFilters,
    hasPlayableQueue: () => queueRef.current.length > 0,
    onClearAlreadyDefault: handleRoll,
  });

  useEffect(() => {
    for (const item of queue) {
      if (item?.videoId) inFlightReplacementIdsRef.current.delete(item.videoId);
    }
  }, [queue]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const drawKey = buildDrawKey(filters.mode, filters.minScore, filters.onePerArtist, drawTick);
    if (hydratedDrawKeyRef.current === drawKey) return undefined;
    hydratedDrawKeyRef.current = null;

    const seq = drawSeqRef.current + 1;
    drawSeqRef.current = seq;
    const controller = new AbortController();
    const drawnFilters = {
      mode: filters.mode,
      minScore: filters.minScore,
      onePerArtist: filters.onePerArtist,
    };

    swappingSlotsRef.current.clear();
    inFlightReplacementIdsRef.current.clear();
    setSwappingSlots(new Set());
    setCopyState('idle');
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }

    if (queueRef.current.length === 0 || errorRef.current) {
      setQueue([]);
      setLoading(true);
    } else {
      setRolling(true);
    }
    setError('');

    getRandomPlaylist({
      count: DEFAULT_PLAYLIST_FILTERS.count,
      mode: drawnFilters.mode,
      minScore: drawnFilters.minScore,
      onePerArtist: drawnFilters.onePerArtist,
      signal: controller.signal,
    })
      .then((res) => {
        if (!mountedRef.current || drawSeqRef.current !== seq || controller.signal.aborted) return;
        const data = res.data || {};
        const songs = Array.isArray(data.songs) ? data.songs : [];
        const nextPoolSize = Number(data.poolSize ?? 0);

        if (songs.length > 0) {
          queueFiltersRef.current = drawnFilters;
          writeStoredPlaylistSession({
            filters: drawnFilters,
            queue: songs,
            poolSize: nextPoolSize,
            activeIndex: 0,
          });
          lastPersistedSnapshotRef.current = { queue: songs, poolSize: nextPoolSize, activeIndex: 0 };
        } else {
          queueFiltersRef.current = null;
          lastPersistedSnapshotRef.current = null;
          setPlaybackEngaged(false);
        }

        setQueue(songs);
        setPoolSize(nextPoolSize);
        setActiveIndex(0);
        setAutoplay(false);
        setPlayerStatus('cued');
        setLoading(false);
        setRolling(false);
      })
      .catch((err) => {
        if (
          err?.name === 'AbortError'
          || controller.signal.aborted
          || !mountedRef.current
          || drawSeqRef.current !== seq
        ) {
          return;
        }
        setError(err?.message || 'Could not load random Playlist.');
        setPlaybackEngaged(false);
        setLoading(false);
        setRolling(false);
      });

    return () => controller.abort();
  }, [filters.mode, filters.minScore, filters.onePerArtist, drawTick]);

  useEffect(() => {
    if (loading || rolling || error || queue.length === 0 || !queueFiltersRef.current) return;
    const last = lastPersistedSnapshotRef.current;
    if (last && last.queue === queue && last.poolSize === poolSize && last.activeIndex === activeIndex) return;
    writeStoredPlaylistSession({ filters: queueFiltersRef.current, queue, poolSize, activeIndex });
    lastPersistedSnapshotRef.current = { queue, poolSize, activeIndex };
  }, [activeIndex, error, loading, poolSize, queue, rolling]);

  useEffect(() => {
    if (autoplay || playerStatus === 'playing' || playerStatus === 'buffering') {
      setPlaybackEngaged(true);
    }
  }, [autoplay, playerStatus]);

  useEffect(() => {
    if (!loading && (error || queue.length === 0)) setPlaybackEngaged(false);
  }, [error, loading, queue.length]);

  const handleRetry = useCallback(() => {
    setQueue([]);
    setError('');
    setLoading(true);
    setDrawTick((t) => t + 1);
  }, []);

  const handleSelectIndex = useCallback((index) => {
    setActiveIndex(index);
    setAutoplay(true);
  }, []);

  const handleStep = useCallback((delta) => {
    const len = queueRef.current.length;
    if (len <= 1) return;
    setActiveIndex((prev) => (prev + delta + len) % len);
    setAutoplay(true);
  }, []);

  const handleTogglePlayPause = useCallback(() => {
    const status = playerStatusRef.current;
    if (status === 'playing' || status === 'buffering') {
      playerControlRef?.current?.pause?.();
      setAutoplay(false);
      setPlayerStatus((prev) => (prev === 'playing' || prev === 'buffering' ? 'paused' : prev));
      return;
    }
    setAutoplay(true);
    setPlaybackEngaged(true);
    playerControlRef?.current?.play?.();
  }, [playerControlRef]);

  const handleStopPlayback = useCallback(() => {
    playerControlRef?.current?.pause?.();
    setAutoplay(false);
    setPlaybackEngaged(false);
    setPlayerStatus((prev) => (prev === 'playing' || prev === 'buffering' ? 'paused' : prev));
  }, [playerControlRef]);

  const handleSwapIndex = useCallback(async (index) => {
    if (!queueRef.current[index] || swappingSlotsRef.current.has(index)) return;
    const seq = drawSeqRef.current;
    swappingSlotsRef.current.add(index);
    setSwappingSlots(new Set(swappingSlotsRef.current));

    try {
      const outcome = await resolvePlaylistSlotSwap({
        index,
        getQueue: () => queueRef.current,
        getFilters: () => filtersRef.current,
        inFlightReplacementIds: inFlightReplacementIdsRef.current,
        isStale: () => !mountedRef.current || drawSeqRef.current !== seq,
      });
      if (!outcome) return;

      const { replacement, poolSize: nextPoolSize } = outcome;
      inFlightReplacementIdsRef.current.add(replacement.videoId);
      setQueue((prev) => {
        if (!prev[index] || prev.some((item, idx) => idx !== index && item.videoId === replacement.videoId)) {
          return prev;
        }
        return prev.map((item, idx) => (idx === index ? replacement : item));
      });
      if (nextPoolSize !== undefined) setPoolSize(nextPoolSize);
      if (index === activeIndexRef.current) setAutoplay(true);
    } catch {
      // Keep current queue intact if an individual swap request fails.
    } finally {
      if (mountedRef.current && drawSeqRef.current === seq) {
        swappingSlotsRef.current.delete(index);
        setSwappingSlots(new Set(swappingSlotsRef.current));
      }
    }
  }, [filtersRef]);

  const handlePlayerEnded = useCallback(() => {
    const len = queueRef.current.length;
    if (len <= 1) {
      setAutoplay(false);
      setPlayerStatus('ended');
      return;
    }
    setActiveIndex((prev) => (prev + 1) % len);
    setAutoplay(true);
  }, []);

  const handleCopyPlaylist = useCallback(async () => {
    const text = formatPlaylistText(queueRef.current);
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (!mountedRef.current) return;
    setCopyState(ok ? 'copied' : 'failed');
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setCopyState('idle');
      copyTimerRef.current = null;
    }, ok ? 1800 : 2200);
  }, []);

  const handleInspectArtist = useCallback((artistName) => {
    navigate(`/artists?artist=${encodeURIComponent(artistName)}`);
  }, [navigate]);

  const handleInspectSongAirings = useCallback((songTitle, artistName) => {
    const params = new URLSearchParams();
    params.set('song', songTitle);
    if (artistName) params.set('artist', artistName);
    navigate(`/episodes?${params.toString()}`);
  }, [navigate]);

  const youtubeQueueUrl = useMemo(() => buildYouTubeQueueUrl(queue), [queue]);
  const activeSong = queue[activeIndex] || null;

  useEffect(() => {
    if (typeof onSessionStateChange !== 'function') return;
    onSessionStateChange({
      activeSong,
      activeIndex,
      totalSlots: queue.length,
      playerStatus,
      playbackEngaged,
      playlistHref,
      onTogglePlayPause: handleTogglePlayPause,
      onStep: handleStep,
      onStopPlayback: handleStopPlayback,
    });
  }, [
    activeIndex,
    activeSong,
    handleStep,
    handleStopPlayback,
    handleTogglePlayPause,
    onSessionStateChange,
    playbackEngaged,
    playerStatus,
    playlistHref,
    queue.length,
  ]);

  return (
    <PlaylistBooth
      filters={filters}
      queue={queue}
      activeIndex={activeIndex}
      activeSong={activeSong}
      autoplay={autoplay}
      playerStatus={playerStatus}
      playerControlRef={playerControlRef}
      poolSize={poolSize}
      loading={loading}
      rolling={rolling}
      swappingSlots={swappingSlots}
      error={error}
      youtubeQueueUrl={youtubeQueueUrl}
      copyState={copyState}
      onModeChange={handleModeChange}
      onMinScoreChange={handleMinScoreChange}
      onToggleOnePerArtist={handleToggleOnePerArtist}
      onClearFilters={handleClearFilters}
      onRetry={handleRetry}
      onRoll={handleRoll}
      onSelectIndex={handleSelectIndex}
      onStep={handleStep}
      onSwapIndex={handleSwapIndex}
      onCopyPlaylist={handleCopyPlaylist}
      onPlayerEnded={handlePlayerEnded}
      onPlayerStatusChange={setPlayerStatus}
      onInspectArtist={handleInspectArtist}
      onInspectSongAirings={handleInspectSongAirings}
    />
  );
}
