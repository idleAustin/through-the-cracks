// Application shell coordinating live/static archive mode telemetry, Command Palette shortcuts, Now Playing mini-bar, and main canvas.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getArchiveMode, subscribeArchiveMode } from '../api';
import CommandPalette from './CommandPalette';
import { CockpitSidebar, MobileBottomTabs, MobileTopBar } from './Header';
import PlaylistMiniBar from './PlaylistMiniBar';

export default function AppShell({
  totalSpins,
  latestEpisodeId = null,
  isPlaylistRoute = false,
  playlistSession = null,
  children,
}) {
  const [archiveMode, setArchiveMode] = useState(() => getArchiveMode());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const previousFocusRef = useRef(null);

  const playlistHref = playlistSession?.playlistHref || '/playlist';
  const showMiniBar = Boolean(
    !isPlaylistRoute
    && playlistSession?.playbackEngaged
    && playlistSession?.activeSong,
  );

  useEffect(() => subscribeArchiveMode(setArchiveMode), []);

  const openPalette = useCallback(() => {
    if (!paletteOpen && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    setPaletteOpen(true);
  }, [paletteOpen]);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    const target = previousFocusRef.current;
    previousFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (target && typeof target.focus === 'function' && target.isConnected) {
        target.focus();
      }
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (paletteOpen) {
          closePalette();
        } else {
          openPalette();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closePalette, openPalette, paletteOpen]);

  return (
    <div className="app-root">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell">
        <CockpitSidebar
          archiveMode={archiveMode}
          totalSpins={totalSpins}
          onQuickJump={openPalette}
          playlistHref={playlistHref}
        />

        <div className="app-content-column">
          <MobileTopBar archiveMode={archiveMode} playlistHref={playlistHref} />
          <main
            id="main-content"
            className={showMiniBar ? 'app-work-area has-minibar' : 'app-work-area'}
            tabIndex={-1}
          >
            <div className="work-canvas">{children}</div>
          </main>
          {showMiniBar ? (
            <PlaylistMiniBar
              activeSong={playlistSession.activeSong}
              activeIndex={playlistSession.activeIndex}
              totalSlots={playlistSession.totalSlots}
              playerStatus={playlistSession.playerStatus}
              playlistHref={playlistHref}
              onTogglePlayPause={playlistSession.onTogglePlayPause}
              onStep={playlistSession.onStep}
              onStopPlayback={playlistSession.onStopPlayback}
            />
          ) : null}
          <MobileBottomTabs />
        </div>
      </div>

      <CommandPalette
        isOpen={paletteOpen}
        onClose={closePalette}
        latestEpisodeId={latestEpisodeId}
        playlistHref={playlistHref}
      />
    </div>
  );
}
