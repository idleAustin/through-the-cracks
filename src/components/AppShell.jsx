// Application shell coordinating live/static archive mode telemetry, Command Palette shortcuts, and main canvas.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getArchiveMode, subscribeArchiveMode } from '../api';
import CommandPalette from './CommandPalette';
import { CockpitSidebar, MobileBottomTabs, MobileTopBar } from './Header';

export default function AppShell({ totalSpins, latestEpisodeId = null, children }) {
  const [archiveMode, setArchiveMode] = useState(() => getArchiveMode());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const previousFocusRef = useRef(null);

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
        />

        <div className="app-content-column">
          <MobileTopBar archiveMode={archiveMode} />
          <main id="main-content" className="app-work-area" tabIndex={-1}>
            <div className="work-canvas">{children}</div>
          </main>
          <MobileBottomTabs />
        </div>
      </div>

      <CommandPalette
        isOpen={paletteOpen}
        onClose={closePalette}
        latestEpisodeId={latestEpisodeId}
      />
    </div>
  );
}
