// Episodes archive view with Studio Log filter bar, collapsible rail, and ordered Broadcast Log playlist.
import React from 'react';
import BroadcastPlaylist from '../components/BroadcastPlaylist';
import { ArchiveErrorState, EmptyArchiveState, EmptyFilterState, SkeletonRows } from '../components/DataState';
import EpisodeAirDateRail from '../components/EpisodeAirDateRail';
import EpisodeFilterBar from '../components/EpisodeFilterBar';
import Icon from '../components/Icon';
import { formatInt } from '../utils/format';
import { useEpisodesStudioState } from '../utils/useEpisodesStudioState';

export default function EpisodesView({ onPauseBackgroundPlaylist }) {
  const s = useEpisodesStudioState();

  if (s.isNarrow && s.selectedEpisodeId) {
    return (
      <div className="episodes-view">
        <div className="push-detail-bar">
          <button
            type="button"
            className="btn btn-secondary push-back-btn"
            onClick={s.handleBackToList}
          >
            <Icon name="arrow-left" size="sm" />
            Back
          </button>
        </div>

        <BroadcastPlaylist
          episode={s.detailEpisode}
          loading={s.detailLoading}
          error={s.detailError}
          onRetry={s.retryDetail}
          activeSong={s.song}
          activeArtist={s.artist}
          onSelectSong={s.handleSelectSong}
          onSelectArtist={s.handleSelectArtist}
          onStepEpisode={s.handleStepEpisode}
          onPauseBackgroundPlaylist={onPauseBackgroundPlaylist}
        />
      </div>
    );
  }

  return (
    <div className="episodes-view">
      <div className="episodes-head">
        <div>
          <h1>Episodes</h1>
          <p className="episodes-subtitle">
            {s.song
              ? `${formatInt(s.total)} matching ${s.total === 1 ? 'air date' : 'air dates'}`
              : 'Episode air dates and ordered playlists (newest first)'}
          </p>
        </div>

        {!s.loading && !s.error && s.episodes.length > 0 && (
          <span className="episodes-count">
            <span className="font-mono num">{formatInt(s.total)}</span> archived air dates
          </span>
        )}
      </div>

      <EpisodeFilterBar
        searchInput={s.searchDraft}
        onSearchChange={s.setSearchDraft}
        onClearSearch={s.handleClearSearch}
        year={s.year}
        yearOptions={s.yearOptions}
        onYearChange={s.handleYearChange}
        day={s.day}
        onDayChange={s.handleDayChange}
        onRandomEpisode={s.handleRandomEpisode}
        randomBusy={s.randomBusy}
        total={s.loading ? 0 : s.total}
      />

      {(s.song || s.artist) && (
        <div className="filter-banner">
          <span className="filter-banner-text">
            {s.song ? (
              <>
                <strong>Played Song:</strong> &ldquo;{s.song}&rdquo;
                {s.artist ? ` — ${s.artist}` : ''}
              </>
            ) : (
              <>
                <strong>Played Artist:</strong> {s.artist}
              </>
            )}{' '}
            <span>
              (<span className="font-mono num">{formatInt(s.total)}</span> {s.total === 1 ? 'air date' : 'air dates'})
            </span>
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm filter-clear-btn"
            onClick={s.handleClearSongFilter}
          >
            {s.song ? 'Clear Song Filter' : 'Clear Artist Filter'}
          </button>
        </div>
      )}

      {s.loading ? (
        <SkeletonRows label="Loading episodes" />
      ) : s.error ? (
        <ArchiveErrorState message={s.error} onRetry={s.retryList} />
      ) : s.episodes.length === 0 ? (
        s.hasActiveFilter ? (
          <EmptyFilterState items="episodes" onClear={s.handleClearAllFilters} />
        ) : (
          <EmptyArchiveState items="episodes" onRetry={s.retryList} />
        )
      ) : s.isNarrow ? (
        <EpisodeAirDateRail
          isNarrow
          episodes={s.episodes}
          total={s.total}
          effectiveEpisodeId={s.effectiveEpisodeId}
          onSelectEpisode={s.handleSelectEpisode}
          pagination={s.episodesData?.pagination}
          page={s.page}
          onPageChange={s.handlePageChange}
        />
      ) : (
        <div className={`broadcast-log${s.isRailCollapsed ? ' is-rail-collapsed' : ''}`}>
          <EpisodeAirDateRail
            isNarrow={false}
            isCollapsed={s.isRailCollapsed}
            onToggleCollapse={s.handleToggleRailCollapse}
            episodes={s.episodes}
            total={s.total}
            effectiveEpisodeId={s.effectiveEpisodeId}
            onSelectEpisode={s.handleSelectEpisode}
            pagination={s.episodesData?.pagination}
            page={s.page}
            onPageChange={s.handlePageChange}
          />

          <BroadcastPlaylist
            episode={s.detailEpisode}
            loading={s.detailLoading}
            error={s.detailError}
            onRetry={s.retryDetail}
            activeSong={s.song}
            activeArtist={s.artist}
            onSelectSong={s.handleSelectSong}
            onSelectArtist={s.handleSelectArtist}
            onStepEpisode={s.handleStepEpisode}
            onPauseBackgroundPlaylist={onPauseBackgroundPlaylist}
          />
        </div>
      )}
    </div>
  );
}
