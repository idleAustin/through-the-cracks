// Episode DNA summary strip: 5-cell provenance readout plus opener, closer, and repeat-artist bookmarks.
import React from 'react';
import { formatInt } from '../utils/format';

function formatPercent(part, total) {
  if (!total || total <= 0) return '0%';
  return `${Math.round((Number(part || 0) / total) * 100)}%`;
}

function formatDebutArtistsSummary(debutArtists = []) {
  if (!Array.isArray(debutArtists) || debutArtists.length === 0) return 'None this episode';
  const head = debutArtists.slice(0, 2).join(', ');
  const extra = debutArtists.length - 2;
  return extra > 0 ? `${head} +${extra} more` : head;
}

export default function EpisodeDnaStrip({ episode, spinCount, weekday = '' }) {
  const dna = episode?.dna;
  if (!dna) return null;

  const debutArtists = Array.isArray(episode.debutArtists) ? episode.debutArtists : [];
  const doubledArtists = Array.isArray(episode.doubledArtists) ? episode.doubledArtists : [];
  const topStaple = Number(episode.topStaplePlayCount || 0);
  const opener = episode.opener;
  const closer = episode.closer;

  const cells = [
    {
      key: 'spins',
      label: 'Spins',
      value: formatInt(spinCount),
      sub: weekday || 'Episode playlist',
    },
    {
      key: 'song-debuts',
      label: 'Song Debuts',
      value: formatInt(dna.debutSongCount),
      sub: `${formatPercent(dna.debutSongCount, spinCount)} first aired`,
    },
    {
      key: 'artist-debuts',
      label: 'Artist Debuts',
      value: formatInt(dna.debutArtistCount),
      sub: formatDebutArtistsSummary(debutArtists),
    },
    {
      key: 'only-spin',
      label: 'Only Spin (1x)',
      value: formatInt(dna.onlySpinCount),
      sub: `${formatPercent(dna.onlySpinCount, spinCount)} single airing`,
    },
    {
      key: 'staples',
      label: '5+ Staples',
      value: formatInt(dna.stapleCount),
      sub: topStaple >= 5 ? (<>Top: <span className="font-mono num">{formatInt(topStaple)}x</span></>) : 'None',
    },
  ];

  const hasBookmarks = Boolean(opener || closer || doubledArtists.length > 0);

  return (
    <div className="episode-dna" aria-label="Episode DNA">
      <dl className="dna-strip">
        {cells.map((cell) => (
          <div key={cell.key} className="dna-cell">
            <dt className="dna-label">{cell.label}</dt>
            <dd className="dna-value font-mono num">{cell.value}</dd>
            <dd className="dna-sub">
              <span>{cell.sub}</span>
            </dd>
          </div>
        ))}
      </dl>

      {hasBookmarks ? (
        <div className="dna-bookmarks">
          {opener ? (
            <span className="dna-bookmark">
              <span className="dna-bookmark-key">Opener</span>
              <span className="dna-bookmark-val">{opener.artist} — {opener.songTitle}</span>
            </span>
          ) : null}
          {closer ? (
            <span className="dna-bookmark">
              <span className="dna-bookmark-key">Closer</span>
              <span className="dna-bookmark-val">{closer.artist} — {closer.songTitle}</span>
            </span>
          ) : null}
          {doubledArtists.length > 0 ? (
            <span className="dna-bookmark">
              <span className="dna-bookmark-key">2+ Spins</span>
              <span className="dna-bookmark-val">{doubledArtists.join(', ')}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
