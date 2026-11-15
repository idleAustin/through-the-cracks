// Concurrent-safe single-slot replacement resolver for Broadcast Booth (/playlist) queue swaps.
import { getRandomPlaylist } from '../api';
import { buildSwapExcludeArtists, buildSwapExcludeIds } from './playlist-helpers';

export async function resolvePlaylistSlotSwap({
  index,
  getQueue,
  getFilters,
  inFlightReplacementIds,
  isStale,
}) {
  const fetchSwapCandidate = async (exclude, excludeArtist) => {
    const currentFilters = getFilters();
    return getRandomPlaylist({
      mode: currentFilters.mode,
      minScore: currentFilters.minScore,
      onePerArtist: currentFilters.onePerArtist,
      count: 1,
      exclude,
      excludeArtist,
    });
  };

  const initialQueue = getQueue();
  const exclude = buildSwapExcludeIds(
    initialQueue,
    index,
    Array.from(inFlightReplacementIds),
  );
  const excludeArtist = buildSwapExcludeArtists(
    initialQueue,
    index,
    getFilters().onePerArtist,
  );

  let res = await fetchSwapCandidate(exclude, excludeArtist);
  let replacement = res.data?.songs?.[0] || null;
  if (!replacement && excludeArtist.length > 0) {
    res = await fetchSwapCandidate(exclude, []);
    replacement = res.data?.songs?.[0] || null;
  }

  if (isStale() || !replacement) return null;

  const isSlotCollision = (candidateId) => (
    getQueue().some((item, idx) => idx !== index && item.videoId === candidateId)
    || inFlightReplacementIds.has(candidateId)
  );

  let attempts = 0;
  const seenExcluded = new Set(inFlightReplacementIds);
  while (replacement && isSlotCollision(replacement.videoId) && attempts < 2) {
    attempts += 1;
    seenExcluded.add(replacement.videoId);
    inFlightReplacementIds.forEach((id) => seenExcluded.add(id));
    const latestQueue = getQueue();
    const retryExclude = buildSwapExcludeIds(
      latestQueue,
      index,
      Array.from(seenExcluded),
    );
    const retryArtists = buildSwapExcludeArtists(
      latestQueue,
      index,
      getFilters().onePerArtist,
    );
    res = await fetchSwapCandidate(retryExclude, retryArtists);
    replacement = res.data?.songs?.[0] || null;
    if (!replacement && retryArtists.length > 0) {
      res = await fetchSwapCandidate(retryExclude, []);
      replacement = res.data?.songs?.[0] || null;
    }
    if (isStale() || !replacement) return null;
  }

  if (isSlotCollision(replacement.videoId)) return null;

  return {
    replacement,
    poolSize: res.data?.poolSize !== undefined ? Number(res.data.poolSize) : undefined,
  };
}
