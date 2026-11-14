// Broadcast Booth cockpit orchestrator combining filter controls, loading/empty/error states, Broadcast Deck, and Playlist queue.
import React from 'react';
import { ArchiveErrorState, EmptyFilterState } from '../components/DataState';
import { useMediaQuery } from '../utils/format';
import PlaylistDeckCard from './PlaylistDeckCard';
import PlaylistFilterBar from './PlaylistFilterBar';
import PlaylistQueueCard from './PlaylistQueueCard';
import PlaylistSkeleton from './PlaylistSkeleton';

export default function PlaylistBooth({
  filters,
  queue,
  activeIndex,
  activeSong,
  autoplay,
  playerStatus,
  poolSize,
  loading,
  rolling,
  swappingSlots,
  error,
  youtubeQueueUrl,
  copyState,
  onModeChange,
  onMinScoreChange,
  onToggleOnePerArtist,
  onClearFilters,
  onRetry,
  onRoll,
  onSelectIndex,
  onStep,
  onSwapIndex,
  onCopyPlaylist,
  onPlayerEnded,
  onPlayerStatusChange,
  onInspectArtist,
  onInspectSongAirings,
}) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const canSwap = poolSize > queue.length;

  return (
    <div className="booth-page">
      <PlaylistFilterBar
        filters={filters}
        poolSize={poolSize}
        loading={loading}
        rolling={rolling}
        error={error}
        onModeChange={onModeChange}
        onMinScoreChange={onMinScoreChange}
        onToggleOnePerArtist={onToggleOnePerArtist}
        onRoll={onRoll}
      />

      {loading && queue.length === 0 ? (
        <PlaylistSkeleton />
      ) : error ? (
        <ArchiveErrorState
          message={error}
          onRetry={onRetry}
          headingLevel="h2"
          title="Playlist draw failed."
          retryLabel="Retry Roll"
        />
      ) : poolSize === 0 || queue.length === 0 || !activeSong ? (
        <EmptyFilterState
          items="Songs"
          headingLevel="h2"
          title="No eligible Songs match those filters."
          description="Widen the Spin filter, include medium confidence matches, or allow repeat Artists to roll a Playlist."
          clearLabel="Clear Filters"
          onClear={onClearFilters}
        />
      ) : (
        <div className="booth-cockpit" aria-busy={rolling ? 'true' : undefined}>
          <PlaylistDeckCard
            queue={queue}
            activeIndex={activeIndex}
            activeSong={activeSong}
            autoplay={autoplay}
            playerStatus={playerStatus}
            canSwap={canSwap}
            isActiveSwapping={swappingSlots.has(activeIndex)}
            youtubeQueueUrl={youtubeQueueUrl}
            copyState={copyState}
            onSelectIndex={onSelectIndex}
            onStep={onStep}
            onSwapIndex={onSwapIndex}
            onCopyPlaylist={onCopyPlaylist}
            onPlayerEnded={onPlayerEnded}
            onPlayerStatusChange={onPlayerStatusChange}
            onInspectArtist={onInspectArtist}
            onInspectSongAirings={onInspectSongAirings}
          />

          <PlaylistQueueCard
            queue={queue}
            activeIndex={activeIndex}
            isMobile={isMobile}
            canSwap={canSwap}
            swappingSlots={swappingSlots}
            onSelectIndex={onSelectIndex}
            onSwapIndex={onSwapIndex}
            onInspectArtist={onInspectArtist}
          />
        </div>
      )}
    </div>
  );
}
