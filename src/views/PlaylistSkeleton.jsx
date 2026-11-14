// Layout-matched skeleton cockpit matching the 2-column Broadcast Deck and 10-row Playlist queue.
import React from 'react';

export default function PlaylistSkeleton() {
  return (
    <div
      className="booth-cockpit booth-skeleton-cockpit"
      role="status"
      aria-busy="true"
      aria-label="Loading random playlist"
    >
      <section className="surface-region booth-deck" aria-hidden="true">
        <div className="region-toolbar">
          <span className="skeleton booth-skel-toolbar-title" />
          <span className="skeleton booth-skel-chip" />
        </div>
        <div className="yt-deck-frame">
          <span className="skeleton booth-skel-video" />
        </div>
        <div className="booth-meta">
          <span className="skeleton booth-skel-song" />
          <span className="skeleton booth-skel-credit" />
          <span className="skeleton booth-skel-prov" />
        </div>
        <div className="booth-upnext is-single">
          <span className="skeleton booth-skel-credit" />
          <span className="skeleton booth-skel-prov" />
        </div>
        <div className="booth-controls">
          <div className="booth-skel-dock">
            {Array.from({ length: 5 }, (_, idx) => (
              <span key={idx} className="skeleton booth-skel-dock-btn" />
            ))}
          </div>
          <div className="booth-export-row">
            <span className="skeleton booth-skel-export-btn" />
            <span className="skeleton booth-skel-export-btn" />
          </div>
        </div>
      </section>

      <section className="surface-region booth-playlist" aria-hidden="true">
        <div className="region-toolbar">
          <span className="skeleton booth-skel-toolbar-title" />
          <span className="skeleton booth-skel-chip" />
        </div>
        <div className="booth-skel-list">
          {Array.from({ length: 10 }, (_, idx) => (
            <div key={idx} className="booth-skel-row">
              <span className="skeleton booth-skel-slot" />
              <span className="skeleton booth-skel-row-title" />
              <span className="skeleton booth-skel-row-artist" />
              <span className="skeleton booth-skel-row-num" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
