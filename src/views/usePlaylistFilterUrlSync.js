// Route-guarded URL searchParam synchronization hook for Broadcast Booth (/playlist) filter state.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEFAULT_PLAYLIST_FILTERS,
  applyPlaylistFiltersToSearchParams,
  areDefaultPlaylistFilters,
  buildPlaylistHref,
  hasExplicitPlaylistFilterParams,
  parsePlaylistFilters,
} from '../utils/playlist-helpers';
import { areSamePlaylistFilters } from '../utils/playlist-storage';

export default function usePlaylistFilterUrlSync({
  isActiveRoute = true,
  initialFilters,
  hasPlayableQueue,
  onClearAlreadyDefault,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => initialFilters || parsePlaylistFilters(searchParams));

  const filtersRef = useRef(filters);
  const prevIsActiveRouteRef = useRef(Boolean(isActiveRoute));
  const restoringUrlParamsRef = useRef(null);
  const pendingParamsRef = useRef(null);
  const hasPlayableQueueRef = useRef(hasPlayableQueue);

  filtersRef.current = filters;
  hasPlayableQueueRef.current = hasPlayableQueue;

  useEffect(() => {
    if (!isActiveRoute) {
      prevIsActiveRouteRef.current = false;
      restoringUrlParamsRef.current = null;
      pendingParamsRef.current = null;
      return;
    }

    pendingParamsRef.current = null;
    const justEnteredRoute = !prevIsActiveRouteRef.current;
    prevIsActiveRouteRef.current = true;

    if (restoringUrlParamsRef.current !== null) {
      if (searchParams.toString() === restoringUrlParamsRef.current) {
        restoringUrlParamsRef.current = null;
      } else {
        setSearchParams(new URLSearchParams(restoringUrlParamsRef.current), { replace: true });
      }
      return;
    }

    if (
      justEnteredRoute
      && !hasExplicitPlaylistFilterParams(searchParams)
      && hasPlayableQueueRef.current?.()
      && !areDefaultPlaylistFilters(filtersRef.current)
    ) {
      const restored = applyPlaylistFiltersToSearchParams(searchParams, filtersRef.current);
      restoringUrlParamsRef.current = restored.toString();
      setSearchParams(restored, { replace: true });
      return;
    }

    const nextFilters = parsePlaylistFilters(searchParams);
    setFilters((prev) => (areSamePlaylistFilters(prev, nextFilters) ? prev : nextFilters));
  }, [isActiveRoute, searchParams, setSearchParams]);

  const updateFilters = useCallback((deriveNext) => {
    const base = pendingParamsRef.current || (isActiveRoute ? searchParams : new URLSearchParams());
    const current = isActiveRoute ? parsePlaylistFilters(base) : filtersRef.current;
    const nextFilters = deriveNext(current);
    const next = applyPlaylistFiltersToSearchParams(base, nextFilters);
    pendingParamsRef.current = next;
    setFilters((prev) => (areSamePlaylistFilters(prev, nextFilters) ? prev : nextFilters));
    if (isActiveRoute) {
      setSearchParams(next);
    }
  }, [isActiveRoute, searchParams, setSearchParams]);

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
    const base = pendingParamsRef.current || (isActiveRoute ? searchParams : new URLSearchParams());
    const current = isActiveRoute ? parsePlaylistFilters(base) : filtersRef.current;
    const alreadyDefault = areDefaultPlaylistFilters(current);
    const next = new URLSearchParams(base);
    next.delete('mode');
    next.delete('minScore');
    next.delete('onePerArtist');
    pendingParamsRef.current = next;
    setFilters((prev) => (
      areSamePlaylistFilters(prev, DEFAULT_PLAYLIST_FILTERS)
        ? prev
        : {
          mode: DEFAULT_PLAYLIST_FILTERS.mode,
          minScore: DEFAULT_PLAYLIST_FILTERS.minScore,
          onePerArtist: DEFAULT_PLAYLIST_FILTERS.onePerArtist,
        }
    ));
    if (isActiveRoute) {
      setSearchParams(next);
    }
    if (alreadyDefault) {
      onClearAlreadyDefault?.();
    }
  }, [isActiveRoute, onClearAlreadyDefault, searchParams, setSearchParams]);

  const playlistHref = useMemo(() => buildPlaylistHref(filters), [filters]);

  return {
    filters,
    filtersRef,
    playlistHref,
    handleModeChange,
    handleMinScoreChange,
    handleToggleOnePerArtist,
    handleClearFilters,
  };
}
