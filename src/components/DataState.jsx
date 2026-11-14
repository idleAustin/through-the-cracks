// Shared loading skeleton, empty-filter, error-retry, and unknown-route state components.
import React from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';

export function SkeletonRows({ count = 6, label = 'Loading archive data' }) {
  return (
    <div className="skeleton-stack" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, idx) => (
        <div key={idx} className="skeleton-row">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-meta" />
        </div>
      ))}
    </div>
  );
}

export function EmptyFilterState({
  items = 'items',
  onClear,
  headingLevel = 'h3',
  title,
  description,
  clearLabel = 'Clear Filter',
  clearIcon,
}) {
  const Heading = headingLevel === 'h2' ? 'h2' : 'h3';
  return (
    <div className="empty-state">
      <Icon name="search" size="lg" />
      <Heading>{title ?? `No ${items} match that filter.`}</Heading>
      <p>{description ?? `Check spelling or clear the active filter to view all ${items}.`}</p>
      {onClear ? (
        <button type="button" className="btn btn-secondary" onClick={onClear}>
          {clearIcon ? <Icon name={clearIcon} size="sm" /> : null}
          {clearLabel}
        </button>
      ) : null}
    </div>
  );
}

export function ArchiveErrorState({
  message = 'Could not load archive data.',
  onRetry,
  headingLevel = 'h3',
  title = 'Archive request failed.',
  retryLabel = 'Retry Fetch',
}) {
  const Heading = headingLevel === 'h2' ? 'h2' : 'h3';
  return (
    <div className="empty-state is-error" role="alert">
      <Icon name="alert" size="lg" />
      <Heading>{title}</Heading>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyArchiveState({ items = 'episodes', onRetry }) {
  return (
    <div className="empty-state">
      <Icon name="radio" size="lg" />
      <h3>No {items} archived yet.</h3>
      <p>Archived entries will appear here once synced.</p>
      {onRetry ? (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Retry Fetch
        </button>
      ) : null}
    </div>
  );
}

export function NotFoundState() {
  return (
    <div className="empty-state">
      <Icon name="compass" size="lg" />
      <h3>Route not found.</h3>
      <p>That archive path does not exist.</p>
      <Link className="btn btn-secondary" to="/">
        Return to Overview
      </Link>
    </div>
  );
}

