// Unit and integration tests for Song Metadata & Data Load visualizer payload and HTTP routes.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createVisualizerServer } from '../scripts/song-links-visualizer.js';
import {
  buildMetadataVisualizerPayload,
  createMetadataVisualizerServer,
} from '../scripts/song-metadata-visualizer.js';

const tempDirs = [];
const NOW_MS = Date.parse('2026-11-15T18:00:00.000Z');
const isoAgo = (min) => new Date(NOW_MS - min * 60_000).toISOString();

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ttc-meta-viz-'));
  tempDirs.push(dir);
  return dir;
}

function setupMetadataFixtures() {
  const dir = makeTempDir();
  const paths = {
    catalogPath: path.join(dir, 'catalog-input.json'),
    checkpointPath: path.join(dir, 'checkpoint.jsonl'),
    statusPath: path.join(dir, 'discovery-status.json'),
    summaryPath: path.join(dir, 'summary.json'),
    logPath: path.join(dir, 'discovery.log'),
    sqlitePath: path.join(dir, 'song-metadata.sqlite'),
    httpCachePath: path.join(dir, 'http-cache.sqlite'),
    nowMs: NOW_MS,
  };

  writeFileSync(
    paths.catalogPath,
    JSON.stringify({
      stats: { totalSongs: 5, totalArtists: 3, albumGroupCount: 2 },
      artists: [
        { artist: 'Artist A', artistKey: 'artist a', totalPlays: 18 },
        { artist: 'Artist B', artistKey: 'artist b', totalPlays: 5 },
        { artist: 'Artist C', artistKey: 'artist c', totalPlays: 1 },
      ],
      albums: [
        {
          albumKey: 'artist a|||album one',
          artist: 'Artist A',
          album: 'Album One',
          totalPlays: 18,
          maxSongPlays: 12,
          songCount: 2,
          multiSpinCount: 2,
          songKeys: ['artist a|||staple', 'artist a|||favorite'],
        },
        {
          albumKey: 'artist b|||album two',
          artist: 'Artist B',
          album: 'Album Two',
          totalPlays: 3,
          maxSongPlays: 3,
          songCount: 1,
          multiSpinCount: 1,
          songKeys: ['artist b|||rotation'],
        },
      ],
      songs: [
        { song_key: 'artist a|||staple', artist: 'Artist A', album_key: 'artist a|||album one', is_single: false, totalPlays: 12 },
        { song_key: 'artist a|||favorite', artist: 'Artist A', album_key: 'artist a|||album one', is_single: false, totalPlays: 6 },
        { song_key: 'artist b|||rotation', artist: 'Artist B', album_key: 'artist b|||album two', is_single: false, totalPlays: 3 },
        { song_key: 'artist b|||single multi', artist: 'Artist B', album_key: null, is_single: true, totalPlays: 2 },
        { song_key: 'artist c|||deep cut', artist: 'Artist C', album_key: null, is_single: true, totalPlays: 1 },
      ],
    }),
  );

  writeFileSync(
    paths.checkpointPath,
    `${JSON.stringify({
      song_key: 'artist a|||staple',
      artist: 'Artist A',
      song_title: 'Staple',
      album: 'Album One',
      checked_at: isoAgo(5),
      sources_checked: ['mb', 'discogs', 'wiki'],
      mb: { found: true, release_year: 2010, writers: ['Writer One'] },
      discogs: { found: true, release_year: 2010, writers: [] },
      artist_profile: { wiki_summary: 'Bio text.' },
    })}\n`,
  );

  writeFileSync(
    paths.statusPath,
    JSON.stringify({
      pid: process.pid,
      phase: 'running',
      passFilter: 'multi',
      sources: ['mb', 'discogs', 'wiki'],
      authModes: { discogs: 'consumer_key_secret', shs: 'unauthenticated' },
      albumsProcessed: 1,
      totalAlbumsTarget: 2,
      songsWritten: 1,
      totalSongsTarget: 4,
      currentItem: 'Artist A - Album One',
      errorCount: 0,
      rateStats: { mb: { requests: 3, cache_hits: 1 }, discogs: { requests: 2, cache_hits: 0 } },
    }),
  );

  writeFileSync(
    paths.summaryPath,
    JSON.stringify({
      discoveredSongs: 1,
      uncleanedSuffixCount: 0,
      coverage: { releaseYearPct: 100, releaseYearCount: 1, writersPct: 100, writersCount: 1, personnelPct: 100, personnelCount: 1, studiosPct: 0, studiosCount: 0, artistBioPct: 100, artistBioCount: 1 },
      topWriters: [{ name: 'Writer One', count: 1 }],
      topStudios: [],
      sampleSongs: [{ song_key: 'artist a|||staple', artist: 'Artist A', song_title: 'Staple', totalPlays: 12, release_year: 2010, writers: ['Writer One'], facts: ['Written by Writer One.'] }],
    }),
  );
  writeFileSync(paths.logPath, 'line 1\nline 2\n');
  writeFileSync(paths.sqlitePath, 'sqlite-bytes');
  writeFileSync(paths.httpCachePath, 'cache-bytes');
  return paths;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('song-metadata-visualizer', () => {
  it('computes pre-run load, spin tiers, upcoming albums, and incremental checkpoint updates', () => {
    const opts = setupMetadataFixtures();
    const initial = buildMetadataVisualizerPayload(opts);

    expect(initial.catalog).toMatchObject({
      prepared: true, totalSongs: 5, totalArtists: 3, albumGroupCount: 2,
      albumCoveredSongs: 3, singleSongs: 2, pass1MultiTotal: 4, pass2SingleTotal: 1,
      overallCompleted: 1, pass1Completed: 1, pass2Completed: 0, albumsCompleted: 0, albumsTouched: 1,
    });
    expect(initial.spinTiers.map((t) => [t.id, t.total, t.completed])).toEqual([
      ['staples', 1, 1], ['favorites', 1, 0], ['rotation', 2, 0], ['deep_cuts', 1, 0],
    ]);
    expect(initial.workload).toMatchObject({
      pass1RemainingAlbums: 2, pass1RemainingSingles: 1, fullRemainingAlbums: 2, fullRemainingSingles: 2,
    });
    expect(initial.upcomingAlbums.map((a) => a.album)).toEqual(['Album One', 'Album Two']);
    expect(initial.sources).toMatchObject({ totalChecked: 1, mbHits: 1, discogsHits: 1, wikiHits: 1, shsHits: 0 });
    expect(initial.runtime).toMatchObject({ alive: true, phase: 'running', albumsProcessed: 1 });
    expect(initial.logTail).toEqual(['line 1', 'line 2']);

    appendFileSync(opts.checkpointPath, `${JSON.stringify({
      song_key: 'artist a|||staple', artist: 'Artist A', song_title: 'Staple', album: 'Album One',
      checked_at: isoAgo(1), sources_checked: ['shs'], shs: { found: true, writers: ['Writer One'] },
    })}\n${JSON.stringify({
      song_key: 'artist a|||favorite', artist: 'Artist A', song_title: 'Favorite', album: 'Album One',
      checked_at: isoAgo(1), sources_checked: ['mb'], mb: { found: true, release_year: 2010 },
    })}\n`);

    const updated = buildMetadataVisualizerPayload(opts);
    expect(updated.catalog).toMatchObject({ overallCompleted: 2, pass1Completed: 2, albumsCompleted: 1 });
    expect(updated.sources).toMatchObject({ totalChecked: 2, mbHits: 2, discogsHits: 1, shsHits: 1 });
    expect(updated.upcomingAlbums.map((a) => a.album)).toEqual(['Album Two']);
  });

  it('serves unified tabs on / and /metadata alongside /tokens.css, /visualizer.css, /visualizer-client.js, and /api/metadata-status', async () => {
    const metaOpts = setupMetadataFixtures();
    const server = createVisualizerServer({ metadataOptions: metaOpts });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;

      const homeHtml = await (await fetch(`${base}/`)).text();
      expect(homeHtml).toContain('data-default-tab="links"');
      expect(homeHtml).toContain('id="panelMetadata"');
      expect(homeHtml).toContain('id="mSpinTiersList"');

      const metaHtml = await (await fetch(`${base}/metadata`)).text();
      expect(metaHtml).toContain('data-default-tab="metadata"');

      expect((await fetch(`${base}/tokens.css`)).status).toBe(200);
      expect((await fetch(`${base}/visualizer.css`)).status).toBe(200);
      expect((await fetch(`${base}/visualizer-client.js`)).status).toBe(200);

      const apiMeta = await fetch(`${base}/api/metadata-status`);
      expect(apiMeta.status).toBe(200);
      const body = await apiMeta.json();
      expect(body.catalog.totalSongs).toBe(5);

      const standalone = createMetadataVisualizerServer(metaOpts);
      await new Promise((resolve) => standalone.listen(0, '127.0.0.1', resolve));
      try {
        const sPort = standalone.address().port;
        const sHtml = await (await fetch(`http://127.0.0.1:${sPort}/`)).text();
        expect(sHtml).toContain('data-default-tab="metadata"');
      } finally {
        await new Promise((resolve) => standalone.close(resolve));
      }
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

