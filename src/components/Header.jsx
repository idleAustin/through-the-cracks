import React from 'react';
import Icon from './Icon';

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'bar_chart' },
  { id: 'artists', label: 'Artists', icon: 'mic' },
  { id: 'songs', label: 'Songs', icon: 'music_note' },
  { id: 'episodes', label: 'Episodes', icon: 'radio' },
  { id: 'search', label: 'Search', icon: 'search' },
];

export default function Header({ activeTab, setActiveTab, dataSource, theme, onToggleTheme }) {
  const isLive = dataSource === 'express-api';
  const isDark = theme === 'dark';

  return (
    <header className="navbar">
      <div className="logo-section">
        <div>
          <div className="brand-title">Through the Cracks</div>
          <div className="brand-subtitle">WEVL 89.9 FM · Memphis, TN</div>
        </div>
      </div>

      <nav className="nav-links" aria-label="Primary">
        {TABS.map(tab => (
          <button
            key={tab.id}
            id={`nav-${tab.id}`}
            className={`nav-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            aria-label={tab.label}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            <Icon name={tab.icon} size="sm" />
            <span className="nav-btn-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="header-actions">
        {isLive ? (
          <span
            className="badge badge-accent badge-live"
            title="Connected to Express API & BigQuery dataset"
          >
            Live · BigQuery
          </span>
        ) : (
          <span className="badge" title="Reading from pre-computed static JSON files">
            <Icon name="database" size="sm" />
            Local JSON
          </span>
        )}

        <button
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          title={isDark ? 'Light mode' : 'Dark mode'}
        >
          <Icon name={isDark ? 'light_mode' : 'dark_mode'} size="sm" />
        </button>
      </div>
    </header>
  );
}
