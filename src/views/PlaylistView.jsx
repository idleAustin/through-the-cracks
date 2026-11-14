// Route container for /playlist managing random 10-Song playlist draws, slot swaps, and Broadcast Deck state.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRandomPlaylist } from '../api';
import PlaylistBooth from './PlaylistBooth';

const DEFAULT_PLAYLIST_OPTIONS = {
  count: 10,
  minScore: 85,
  mode: 'all',
  onePerArtist: true,
};

export default function PlaylistView() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState([]);
  const [poolSize, setPoolSize] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [playerStatus, setPlayerStatus] = useState('cued');
  const [loading, setLoading] = useState(true);
  const [rolling, setRolling] = useState(false);
  const [swappingIndex, setSwappingIndex] = useState(null);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  const mountedRef = useRef(true);
  const drawSeqRef = useRef(0);
  const queueRef = useRef(queue);
  const activeIndexRef = useRef(activeIndex);

  queueRef.current = queue;
  activeIndexRef.current = activeIndex;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const seq = drawSeqRef.current + 1;
    drawSeqRef.current = seq;
    setLoading(true);
    setError('');

    getRandomPlaylist(DEFAULT_PLAYLIST_OPTIONS)
      .then((res) => {
        if (!mountedRef.current || drawSeqRef.current !== seq) return;
        const data = res.data || {};
        setQueue(Array.isArray(data.songs) ? data.songs : []);
        setPoolSize(Number(data.poolSize ?? 0));
        setActiveIndex(0);
        setAutoplay(false);
        setPlayerStatus('cued');
        setLoading(false);
      })
      .catch((err) => {
        if (!mountedRef.current || drawSeqRef.current !== seq) return;
        setError(err?.message || 'Could not load random playlist.');
        setLoading(false);
      });
  }, [retryKey]);

  const handleRetry = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

  const handleRoll = useCallback(async () => {
    const seq = drawSeqRef.current + 1;
    drawSeqRef.current = seq;
    setRolling(true);
    setSwappingIndex(null);
    setError('');

    try {
      const res = await getRandomPlaylist(DEFAULT_PLAYLIST_OPTIONS);
      if (!mountedRef.current || drawSeqRef.current !== seq) return;
      const data = res.data || {};
      setQueue(Array.isArray(data.songs) ? data.songs : []);
      setPoolSize(Number(data.poolSize ?? 0));
      setActiveIndex(0);
      setAutoplay(false);
      setPlayerStatus('cued');
    } catch (err) {
      if (!mountedRef.current || drawSeqRef.current !== seq) return;
      setError(err?.message || 'Could not draw a fresh playlist.');
    } finally {
      if (mountedRef.current && drawSeqRef.current === seq) {
        setRolling(false);
      }
    }
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
    if (!currentQueue[index]) return;

    const seq = drawSeqRef.current;
    setSwappingIndex(index);

    const exclude = currentQueue.map((song) => song.videoId).filter(Boolean);
    const excludeArtist = currentQueue
      .filter((_, idx) => idx !== index)
      .map((song) => song.artist)
      .filter(Boolean);

    try {
      let res = await getRandomPlaylist({
        ...DEFAULT_PLAYLIST_OPTIONS,
        count: 1,
        exclude,
        excludeArtist,
      });

      let replacement = res.data?.songs?.[0] || null;
      if (!replacement && excludeArtist.length > 0) {
        res = await getRandomPlaylist({
          ...DEFAULT_PLAYLIST_OPTIONS,
          count: 1,
          exclude,
          excludeArtist: [],
        });
        replacement = res.data?.songs?.[0] || null;
      }

      if (!mountedRef.current || drawSeqRef.current !== seq || !replacement) return;

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
        setSwappingIndex(null);
      }
    }
  }, []);

  const handlePlayerEnded = useCallback(() => {
    const len = queueRef.current.length;
    if (len <= 1) return;
    if (activeIndexRef.current + 1 < len) {
      setActiveIndex(activeIndexRef.current + 1);
      setAutoplay(true);
    } else {
      setAutoplay(false);
      setPlayerStatus('ended');
    }
  }, []);

  const handleInspectArtist = useCallback((artistName) => {
    navigate(`/artists?artist=${encodeURIComponent(artistName)}`);
  }, [navigate]);

  const handleInspectSongAirings = useCallback((songTitle, artistName) => {
    navigate(`/episodes?song=${encodeURIComponent(songTitle)}&artist=${encodeURIComponent(artistName)}`);
  }, [navigate]);

  return (
    <PlaylistBooth
      queue={queue}
      activeIndex={activeIndex}
      activeSong={queue[activeIndex] || null}
      autoplay={autoplay}
      playerStatus={playerStatus}
      poolSize={poolSize}
      loading={loading}
      rolling={rolling}
      swappingIndex={swappingIndex}
      error={error}
      onRetry={handleRetry}
      onRoll={handleRoll}
      onSelectIndex={handleSelectIndex}
      onStep={handleStep}
      onSwapIndex={handleSwapIndex}
      onPlayerEnded={handlePlayerEnded}
      onPlayerStatusChange={setPlayerStatus}
      onInspectArtist={handleInspectArtist}
      onInspectSongAirings={handleInspectSongAirings}
    />
  );
}
