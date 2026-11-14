// Route container for /playlist managing URL-synced filters, random 10-Song Playlist draws, concurrent slot swaps, and exports.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getRandomPlaylist } from '../api';
import {
  DEFAULT_PLAYLIST_FILTERS,
  applyPlaylistFiltersToSearchParams,
  areDefaultPlaylistFilters,
  buildSwapExcludeArtists,
  buildSwapExcludeIds,
  buildYouTubeQueueUrl,
  copyTextToClipboard,
  formatPlaylistText,
  parsePlaylistFilters,
} from '../utils/playlist-helpers';
import PlaylistBooth from './PlaylistBooth';

export default function PlaylistView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parsePlaylistFilters(searchParams), [searchParams]);

  const [queue, setQueue] = useState([]);
  const [poolSize, setPoolSize] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [playerStatus, setPlayerStatus] = useState('cued');
  const [loading, setLoading] = useState(true);
  const [rolling, setRolling] = useState(false);
  const [swappingSlots, setSwappingSlots] = useState(() => new Set());
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState('idle');
  const [drawTick, setDrawTick] = useState(0);

  const mountedRef = useRef(true);
  const drawSeqRef = useRef(0);
  const queueRef = useRef(queue);
  const activeIndexRef = useRef(activeIndex);
  const filtersRef = useRef(filters);
  const errorRef = useRef(error);
  const swappingSlotsRef = useRef(new Set());
  const inFlightReplacementIdsRef = useRef(new Set());
  const copyTimerRef = useRef(null);
  const pendingParamsRef = useRef(null);

  queueRef.current = queue;
  activeIndexRef.current = activeIndex;
  filtersRef.current = filters;
  errorRef.current = error;

  useEffect(() => {
    pendingParamsRef.current = null;
  }, [searchParams]);

  useEffect(() => {
    for (const item of queue) {
      if (item?.videoId) {
        inFlightReplacementIdsRef.current.delete(item.videoId);
      }
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
    const seq = drawSeqRef.current + 1;
    drawSeqRef.current = seq;
    const controller = new AbortController();

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
      mode: filters.mode,
      minScore: filters.minScore,
      onePerArtist: filters.onePerArtist,
      signal: controller.signal,
    })
      .then((res) => {
        if (!mountedRef.current || drawSeqRef.current !== seq || controller.signal.aborted) return;
        const data = res.data || {};
        setQueue(Array.isArray(data.songs) ? data.songs : []);
        setPoolSize(Number(data.poolSize ?? 0));
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
        setLoading(false);
        setRolling(false);
      });

    return () => {
      controller.abort();
    };
  }, [filters.mode, filters.minScore, filters.onePerArtist, drawTick]);

  const updateFilters = useCallback((deriveNext) => {
    const base = pendingParamsRef.current || searchParams;
    const current = parsePlaylistFilters(base);
    const next = applyPlaylistFiltersToSearchParams(base, deriveNext(current));
    pendingParamsRef.current = next;
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const handleModeChange = useCallback((nextMode) => {
    updateFilters((current) => ({ ...current, mode: nextMode }));
  }, [updateFilters]);

  const handleMinScoreChange = useCallback((nextMinScore) => {
    updateFilters((current) => ({ ...current, minScore: nextMinScore }));
  }, [updateFilters]);

  const handleToggleOnePerArtist = useCallback(() => {
    updateFilters((current) => ({ ...current, onePerArtist: !current.onePerArtist }));
  }, [updateFilters]);

  const handleClearFilters = useCallback(() => {
    const base = pendingParamsRef.current || searchParams;
    const alreadyDefault = areDefaultPlaylistFilters(parsePlaylistFilters(base));
    const next = new URLSearchParams(base);
    next.delete('mode');
    next.delete('minScore');
    next.delete('onePerArtist');
    pendingParamsRef.current = next;
    setSearchParams(next);
    if (alreadyDefault) {
      setDrawTick((t) => t + 1);
    }
  }, [searchParams, setSearchParams]);

  const handleRetry = useCallback(() => {
    setQueue([]);
    setError('');
    setLoading(true);
    setDrawTick((t) => t + 1);
  }, []);

  const handleRoll = useCallback(() => {
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

  const handleSwapIndex = useCallback(async (index) => {
    const currentQueue = queueRef.current;
    if (!currentQueue[index] || swappingSlotsRef.current.has(index)) return;

    const seq = drawSeqRef.current;
    swappingSlotsRef.current.add(index);
    setSwappingSlots(new Set(swappingSlotsRef.current));

    const fetchSwapCandidate = async (exclude, excludeArtist) => {
      const currentFilters = filtersRef.current;
      return getRandomPlaylist({
        mode: currentFilters.mode,
        minScore: currentFilters.minScore,
        onePerArtist: currentFilters.onePerArtist,
        count: 1,
        exclude,
        excludeArtist,
      });
    };

    try {
      const exclude = buildSwapExcludeIds(
        currentQueue,
        index,
        Array.from(inFlightReplacementIdsRef.current),
      );
      const excludeArtist = buildSwapExcludeArtists(
        currentQueue,
        index,
        filtersRef.current.onePerArtist,
      );

      let res = await fetchSwapCandidate(exclude, excludeArtist);
      let replacement = res.data?.songs?.[0] || null;
      if (!replacement && excludeArtist.length > 0) {
        res = await fetchSwapCandidate(exclude, []);
        replacement = res.data?.songs?.[0] || null;
      }

      if (!mountedRef.current || drawSeqRef.current !== seq || !replacement) return;

      const isSlotCollision = (candidateId) => (
        queueRef.current.some((item, idx) => idx !== index && item.videoId === candidateId)
        || inFlightReplacementIdsRef.current.has(candidateId)
      );

      let attempts = 0;
      const seenExcluded = new Set(inFlightReplacementIdsRef.current);
      while (replacement && isSlotCollision(replacement.videoId) && attempts < 2) {
        attempts += 1;
        seenExcluded.add(replacement.videoId);
        inFlightReplacementIdsRef.current.forEach((id) => seenExcluded.add(id));
        const retryExclude = buildSwapExcludeIds(
          queueRef.current,
          index,
          Array.from(seenExcluded),
        );
        const retryArtists = buildSwapExcludeArtists(
          queueRef.current,
          index,
          filtersRef.current.onePerArtist,
        );
        res = await fetchSwapCandidate(retryExclude, retryArtists);
        replacement = res.data?.songs?.[0] || null;
        if (!replacement && retryArtists.length > 0) {
          res = await fetchSwapCandidate(retryExclude, []);
          replacement = res.data?.songs?.[0] || null;
        }
        if (!mountedRef.current || drawSeqRef.current !== seq || !replacement) return;
      }

      if (isSlotCollision(replacement.videoId)) return;

      inFlightReplacementIdsRef.current.add(replacement.videoId);
      setQueue((prev) => {
        if (!prev[index]) return prev;
        if (prev.some((item, idx) => idx !== index && item.videoId === replacement.videoId)) {
          return prev;
        }
        return prev.map((item, idx) => (idx === index ? replacement : item));
      });
      if (res.data?.poolSize !== undefined) {
        setPoolSize(Number(res.data.poolSize));
      }
      if (index === activeIndexRef.current) {
        setAutoplay(true);
      }
    } catch {
      // Keep current queue intact if an individual swap request fails.
    } finally {
      if (mountedRef.current && drawSeqRef.current === seq) {
        swappingSlotsRef.current.delete(index);
        setSwappingSlots(new Set(swappingSlotsRef.current));
      }
    }
  }, []);

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

  return (
    <PlaylistBooth
      filters={filters}
      queue={queue}
      activeIndex={activeIndex}
      activeSong={queue[activeIndex] || null}
      autoplay={autoplay}
      playerStatus={playerStatus}
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
