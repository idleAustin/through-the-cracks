// Stateful hook managing Studio Log URL filters, debounced search, pagination, random jump, and provenance detail.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { parseBroadcastDayParam } from '../../server/episodeDetailBuilder.js';
import { getEpisodeById, getEpisodes } from '../api';
import { useMediaQuery } from './format';

const DEFAULT_ARCHIVE_YEARS = [
  '2026', '2025', '2024', '2023', '2022', '2021', '2020',
  '2019', '2018', '2017', '2016', '2015', '2014', '2013',
];

export const RAIL_PAGE_SIZE = 40;

export function useEpisodesStudioState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNarrow = useMediaQuery('(max-width: 1024px)');

  const year = searchParams.get('year') || '';
  const song = searchParams.get('song') || '';
  const artist = searchParams.get('artist') || '';
  const q = searchParams.get('q') || '';
  const day = parseBroadcastDayParam(searchParams.get('day'))?.name || '';
  const isRailCollapsed = searchParams.get('rail') === 'collapsed';
  const selectedEpisodeId = searchParams.get('episode') || '';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);

  const [searchDraft, setSearchDraft] = useState(q);
  const [randomBusy, setRandomBusy] = useState(false);

  const [retryKey, setRetryKey] = useState(0);
  const listRequestKey = `${year}:${song}:${artist}:${q}:${day}:${page}:${retryKey}`;
  const [episodesState, setEpisodesState] = useState({ key: '', data: null, error: '' });
  const [listLoadingState, setListLoadingState] = useState(true);
  const [lastKnownYears, setLastKnownYears] = useState(DEFAULT_ARCHIVE_YEARS);
  const listInFlightRef = useRef({ key: null, promise: null });

  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const [detailState, setDetailState] = useState({ key: '', episode: null, error: '' });
  const [detailLoadingState, setDetailLoadingState] = useState(false);
  const detailInFlightRef = useRef({ key: null, promise: null });

  useEffect(() => {
    setSearchDraft(q);
  }, [q]);

  useEffect(() => {
    const trimmed = searchDraft.trim();
    if (trimmed === q) return undefined;
    const timerId = window.setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (trimmed) next.set('q', trimmed);
        else next.delete('q');
        next.delete('page');
        next.delete('episode');
        return next;
      }, { replace: true });
    }, 160);
    return () => window.clearTimeout(timerId);
  }, [searchDraft, q, setSearchParams]);

  useEffect(() => {
    let isMounted = true;
    if (listInFlightRef.current.key !== listRequestKey) {
      listInFlightRef.current = {
        key: listRequestKey,
        promise: getEpisodes({ year, song, artist, q, day, page, limit: RAIL_PAGE_SIZE }),
      };
    }
    setListLoadingState(true);
    listInFlightRef.current.promise
      .then((res) => {
        if (!isMounted) return;
        const years = res.data?.years;
        if (Array.isArray(years) && years.length > 0) setLastKnownYears(years);
        setEpisodesState({ key: listRequestKey, data: res.data, error: '' });
        setListLoadingState(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        setEpisodesState({
          key: listRequestKey,
          data: null,
          error: err?.message || 'Could not load episodes.',
        });
        setListLoadingState(false);
      });
    return () => {
      isMounted = false;
    };
  }, [listRequestKey, year, song, artist, q, day, page]);

  const isListCurrent = episodesState.key === listRequestKey;
  const listLoading = listLoadingState || !isListCurrent;
  const listError = isListCurrent ? episodesState.error : '';
  const episodesData = isListCurrent ? episodesState.data : null;
  const episodes = useMemo(() => episodesData?.episodes || episodesData?.items || [], [episodesData]);
  const total = Number(episodesData?.pagination?.total ?? episodesData?.total ?? episodes.length);
  const yearOptions = episodesData?.years?.length ? episodesData.years : lastKnownYears;
  const effectiveEpisodeId = selectedEpisodeId
    || (isNarrow || listLoading || listError || !isListCurrent ? '' : (episodes[0]?.id || ''));

  const detailRequestKey = effectiveEpisodeId ? `${effectiveEpisodeId}:${detailRetryKey}` : '';
  const isDetailCurrent = Boolean(detailRequestKey) && detailState.key === detailRequestKey;
  const detailLoading = Boolean(detailRequestKey) && (detailLoadingState || !isDetailCurrent);
  const detailEpisode = isDetailCurrent ? detailState.episode : null;
  const detailError = isDetailCurrent ? detailState.error : '';

  // Sync desktop URL ?episode= only when the current list has resolved and no episode is selected.
  useEffect(() => {
    if (isNarrow || !isListCurrent || listLoading || listError || episodes.length === 0 || selectedEpisodeId) return;
    setSearchParams((prev) => {
      if (prev.get('episode')) return prev;
      const next = new URLSearchParams(prev);
      next.set('episode', episodes[0].id);
      return next;
    }, { replace: true });
  }, [isNarrow, isListCurrent, listLoading, listError, episodes, selectedEpisodeId, setSearchParams]);

  // Fetch active episode detail with archive provenance and neighboring episode IDs.
  useEffect(() => {
    if (!effectiveEpisodeId) {
      setDetailState({ key: '', episode: null, error: '' });
      setDetailLoadingState(false);
      return undefined;
    }

    let isMounted = true;
    if (detailInFlightRef.current.key !== detailRequestKey) {
      detailInFlightRef.current = {
        key: detailRequestKey,
        promise: getEpisodeById(effectiveEpisodeId, { provenance: true }),
      };
    }
    setDetailLoadingState(true);
    detailInFlightRef.current.promise
      .then((res) => {
        if (!isMounted) return;
        setDetailState({ key: detailRequestKey, episode: res.data, error: '' });
        setDetailLoadingState(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        setDetailState({
          key: detailRequestKey,
          episode: null,
          error: err?.message || 'Could not load episode playlist.',
        });
        setDetailLoadingState(false);
      });
    return () => {
      isMounted = false;
    };
  }, [detailRequestKey, effectiveEpisodeId]);

  // Escape closes mobile/narrow push detail without interfering with open dialogs.
  useEffect(() => {
    if (!isNarrow || !selectedEpisodeId) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('episode');
        return next;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isNarrow, selectedEpisodeId, setSearchParams]);

  const updateFilter = (mutate) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      next.delete('page');
      next.delete('episode');
      return next;
    });
  };

  const handleYearChange = (event) => updateFilter((next) => {
    if (event.target.value) next.set('year', event.target.value);
    else next.delete('year');
  });

  const handleDayChange = (nextDay) => {
    if (nextDay === day) return;
    updateFilter((next) => {
      if (nextDay) next.set('day', nextDay);
      else next.delete('day');
    });
  };

  const handleClearSearch = () => {
    setSearchDraft('');
    if (!q) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('q');
      next.delete('page');
      next.delete('episode');
      return next;
    }, { replace: true });
  };

  const handleToggleRailCollapse = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (next.get('rail') === 'collapsed') next.delete('rail');
      else next.set('rail', 'collapsed');
      return next;
    }, { replace: true });
  };

  const handlePageChange = (nextPageOrFn) => {
    const target = typeof nextPageOrFn === 'function' ? nextPageOrFn(page) : nextPageOrFn;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (target > 1) next.set('page', String(target));
      else next.delete('page');
      next.delete('episode');
      return next;
    });
  };

  const handleSelectEpisode = (episodeId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('episode', episodeId);
      return next;
    });
  };

  const handleStepEpisode = (targetId) => {
    if (!targetId) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const noListFilter = !year && !song && !artist && !q && !day;
      if (noListFilter && episodes.length > 0) {
        const totalPages = Number(episodesData?.pagination?.totalPages ?? 1);
        if (targetId === detailEpisode?.prevEpisodeId && effectiveEpisodeId === episodes[0]?.id && page > 1) {
          if (page - 1 > 1) next.set('page', String(page - 1));
          else next.delete('page');
        } else if (
          targetId === detailEpisode?.nextEpisodeId
          && effectiveEpisodeId === episodes[episodes.length - 1]?.id
          && page < totalPages
        ) {
          next.set('page', String(page + 1));
        }
      }
      next.set('episode', targetId);
      return next;
    });
  };

  const handleRandomEpisode = async () => {
    if (randomBusy || listLoading || total <= 0) return;
    setRandomBusy(true);
    try {
      let offset = Math.floor(Math.random() * total);
      if (total > 1 && episodes.length > 0 && effectiveEpisodeId) {
        const idxOnPage = episodes.findIndex((ep) => ep.id === effectiveEpisodeId);
        const globalIdx = idxOnPage >= 0 ? ((page - 1) * RAIL_PAGE_SIZE) + idxOnPage : -1;
        if (globalIdx === offset) offset = (offset + 1 + Math.floor(Math.random() * (total - 1))) % total;
      }
      const res = await getEpisodes({ year, song, artist, q, day, page: offset + 1, limit: 1 });
      const picked = res?.data?.episodes?.[0] || res?.data?.items?.[0];
      if (!picked?.id) return;
      const railPage = Math.floor(offset / RAIL_PAGE_SIZE) + 1;
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (railPage > 1) next.set('page', String(railPage));
        else next.delete('page');
        next.set('episode', picked.id);
        return next;
      });
    } catch {
      // Preserve current episode selection if random lookup fails.
    } finally {
      setRandomBusy(false);
    }
  };

  const handleBackToList = () => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    next.delete('episode');
    return next;
  });

  const handleSelectSong = (songTitle, songArtist) => {
    const next = new URLSearchParams();
    next.set('song', songTitle);
    if (songArtist) next.set('artist', songArtist);
    navigate(`/episodes?${next.toString()}`);
  };

  const handleClearSongFilter = () => updateFilter((next) => {
    next.delete('song');
    next.delete('artist');
  });

  const handleClearAllFilters = () => {
    setSearchDraft('');
    setSearchParams(new URLSearchParams());
  };

  const handleSelectArtist = (artistName) => navigate(`/artists?artist=${encodeURIComponent(artistName)}`);

  return {
    isNarrow,
    year,
    song,
    artist,
    q,
    day,
    isRailCollapsed,
    selectedEpisodeId,
    effectiveEpisodeId,
    page,
    searchDraft,
    setSearchDraft,
    randomBusy,
    episodesData,
    episodes,
    total,
    yearOptions,
    loading: listLoading,
    error: listError,
    retryList: () => setRetryKey((k) => k + 1),
    detailEpisode,
    detailLoading,
    detailError,
    retryDetail: () => setDetailRetryKey((k) => k + 1),
    hasActiveFilter: Boolean(year || song || artist || q || day),
    handleYearChange,
    handleDayChange,
    handleClearSearch,
    handleToggleRailCollapse,
    handlePageChange,
    handleSelectEpisode,
    handleStepEpisode,
    handleRandomEpisode,
    handleBackToList,
    handleSelectSong,
    handleClearSongFilter,
    handleClearAllFilters,
    handleSelectArtist,
  };
}
