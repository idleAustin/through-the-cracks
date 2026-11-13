// Episodes archive view with loading skeletons, empty/error states, playlist modal trigger, and pagination.
import React, { useEffect, useRef, useState } from 'react';
import { getEpisodeById, getEpisodes } from '../api';
import { ArchiveErrorState, EmptyArchiveState, SkeletonRows } from '../components/DataState';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';

export default function EpisodesView({ onSelectEpisode }) {
  const [page, setPage] = useState(1);
  const [episodesData, setEpisodesData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const inFlightRef = useRef({ key: null, promise: null });

  useEffect(() => {
    let isMounted = true;
    const requestKey = `${page}:${retryKey}`;
    if (inFlightRef.current.key !== requestKey) {
      inFlightRef.current = { key: requestKey, promise: getEpisodes(page, 20) };
    }
    setLoading(true);
    setError('');
    inFlightRef.current.promise
      .then((res) => {
        if (isMounted) {
          setEpisodesData(res.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err?.message || 'Could not load episodes.');
          setLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [page, retryKey]);

  const handleEpisodeClick = async (ep) => {
    try {
      const fullEp = await getEpisodeById(ep.id);
      onSelectEpisode(fullEp.data);
    } catch {
      onSelectEpisode(ep);
    }
  };

  return (
    <section className="ink-panel panel-pad">
      <div className="controls-bar">
        <div>
          <h2 className="panel-title">
            <Icon name="radio" />
            Episode Playlist Archive
          </h2>
          <div className="panel-subtitle">
            Browse playlists from all{' '}
            {episodesData?.pagination?.total?.toLocaleString() || '1,317'} archived episodes
          </div>
        </div>
      </div>

      {loading ? (
        <SkeletonRows label="Loading episodes" />
      ) : error ? (
        <ArchiveErrorState message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : !episodesData?.episodes?.length ? (
        <EmptyArchiveState items="episodes" onRetry={() => setRetryKey((k) => k + 1)} />
      ) : (
        <>
          <div className="table-container">
            <table className="data-table" id="episodes-table">
              <thead>
                <tr>
                  <th>Air Date</th>
                  <th>Day</th>
                  <th>Episode</th>
                  <th>Episode Title</th>
                  <th>Songs</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {episodesData.episodes.map((ep, idx) => (
                  <tr
                    key={idx}
                    id={`episode-row-${idx + 1}`}
                    className="row-clickable"
                    tabIndex={0}
                    onClick={() => handleEpisodeClick(ep)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleEpisodeClick(ep);
                      }
                    }}
                  >
                    <td className="cell-primary">{ep.airDate}</td>
                    <td><span className="badge">{ep.dayOfWeek || 'Episode'}</span></td>
                    <td>
                      {ep.episodeNumber ? (
                        <span className="badge badge-accent">#{ep.episodeNumber}</span>
                      ) : (
                        <span className="cell-dim">—</span>
                      )}
                    </td>
                    <td className="cell-primary">{ep.title}</td>
                    <td className="cell-mono">
                      {ep.songCount || ep.songs?.length || 0}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEpisodeClick(ep);
                        }}
                        aria-label={`View playlist for ${ep.title}`}
                      >
                        <Icon name="playlist_play" size="sm" />
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            pagination={episodesData?.pagination}
            page={page}
            onPageChange={setPage}
            noun="episodes"
            idPrefix="episodes"
          />
        </>
      )}
    </section>
  );
}
