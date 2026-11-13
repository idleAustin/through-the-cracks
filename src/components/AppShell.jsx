// Application shell coordinating live/static archive mode telemetry, quick-jump keyboard shortcuts, and main canvas.
import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getArchiveMode, subscribeArchiveMode } from '../api';
import { CockpitSidebar, MobileBottomTabs, MobileTopBar } from './Header';

export default function AppShell({ totalSpins, children }) {
  const [archiveMode, setArchiveMode] = useState(() => getArchiveMode());
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setArchiveMode(getArchiveMode());
    return subscribeArchiveMode((nextMode) => {
      setArchiveMode(nextMode);
    });
  }, []);

  const handleQuickJump = useCallback(() => {
    const focusSearchInput = () => {
      const input = document.getElementById('global-search-input');
      if (input) {
        input.focus();
      }
    };

    if (location.pathname !== '/search') {
      navigate('/search');
      window.setTimeout(focusSearchInput, 0);
      return;
    }

    focusSearchInput();
  }, [location.pathname, navigate]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        handleQuickJump();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [handleQuickJump]);

  return (
    <div className="app-root">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell">
        <CockpitSidebar
          archiveMode={archiveMode}
          totalSpins={totalSpins}
          onQuickJump={handleQuickJump}
        />

        <div className="app-content-column">
          <MobileTopBar archiveMode={archiveMode} />
          <main id="main-content" className="app-work-area" tabIndex={-1}>
            <div className="work-canvas">{children}</div>
          </main>
          <MobileBottomTabs />
        </div>
      </div>
    </div>
  );
}

