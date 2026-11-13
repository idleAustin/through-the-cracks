// Responsive cockpit navigation chrome: desktop left sidebar rail, mobile top bar, and mobile bottom tab bar.
import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTheme } from '../theme';
import Icon from './Icon';
import Tooltip from './Tooltip';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/artists', label: 'Artists', icon: 'artists', end: false },
  { to: '/songs', label: 'Songs', icon: 'songs', end: false },
  { to: '/episodes', label: 'Episodes', icon: 'episodes', end: false },
  { to: '/search', label: 'Search', icon: 'search', end: false },
];

function getQuickJumpShortcut() {
  if (typeof navigator === 'undefined') return 'Ctrl+K';
  const platform = navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl+K';
}

function getThemeToggleMeta(resolvedTheme) {
  const toLight = resolvedTheme === 'dark';
  return {
    label: toLight ? 'Switch to light theme' : 'Switch to dark theme',
    shortLabel: toLight ? 'Light' : 'Dark',
    icon: toLight ? 'sun' : 'moon',
  };
}

export function CockpitSidebar({ archiveMode, totalSpins, onQuickJump }) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const isLive = archiveMode === 'live';
  const themeMeta = getThemeToggleMeta(resolvedTheme);
  const shortcutLabel = getQuickJumpShortcut();
  const spinsText = totalSpins != null ? `${totalSpins.toLocaleString('en-US')} spins` : '— spins';

  return (
    <aside className="cockpit-sidebar" aria-label="Archive cockpit">
      <div className="cockpit-top">
        <div className="cockpit-brand">
          <div className="cockpit-wordmark">Through the Cracks</div>
          <span className="status-badge">
            <span className={`status-dot ${isLive ? 'is-live' : 'is-static'}`} aria-hidden="true" />
            <span>{isLive ? 'WEVL 89.9 · Live Archive' : 'WEVL 89.9 · Static Snapshot'}</span>
          </span>
        </div>

        <button
          type="button"
          className="cmd-trigger-btn"
          onClick={onQuickJump}
          aria-label={`Quick jump (${shortcutLabel})`}
        >
          <span className="cmd-trigger-left">
            <Icon name="search" size="sm" />
            <span>Quick jump</span>
          </span>
          <kbd className="kbd">{shortcutLabel}</kbd>
        </button>

        <nav className="cockpit-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? 'cockpit-nav-link is-active' : 'cockpit-nav-link'
              }
            >
              {({ isActive }) => (
                <>
                  <span className="cockpit-nav-main">
                    <Icon name={item.icon} size="sm" />
                    <span>{item.label}</span>
                  </span>
                  {isActive ? <span className="nav-lime-dot" aria-hidden="true" /> : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="cockpit-footer">
        <span className="cockpit-spins num">{spinsText}</span>
        <div className="icon-dock" role="toolbar" aria-label="Appearance controls">
          <Tooltip label={themeMeta.label} position="left">
            <button
              type="button"
              className="icon-action-btn"
              onClick={toggleTheme}
              aria-label={themeMeta.label}
            >
              <Icon name={themeMeta.icon} size="sm" />
            </button>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}

export function MobileTopBar({ archiveMode }) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const isLive = archiveMode === 'live';
  const themeMeta = getThemeToggleMeta(resolvedTheme);

  return (
    <header className="mobile-topbar">
      <div className="mobile-brand">
        <div className="mobile-wordmark">Through the Cracks</div>
        <span className="mobile-station">
          <span className={`status-dot ${isLive ? 'is-live' : 'is-static'}`} aria-hidden="true" />
          <span>WEVL 89.9 FM</span>
        </span>
      </div>

      <button
        type="button"
        className="mobile-theme-btn"
        onClick={toggleTheme}
        aria-label={themeMeta.label}
      >
        <Icon name={themeMeta.icon} size="sm" />
        <span className="mobile-theme-label">{themeMeta.shortLabel}</span>
      </button>
    </header>
  );
}

export function MobileBottomTabs() {
  return (
    <nav className="mobile-bottom-tabs" aria-label="Primary navigation">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            isActive ? 'mobile-tab-link is-active' : 'mobile-tab-link'
          }
        >
          <Icon name={item.icon} size="sm" />
          <span className="mobile-tab-label">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
