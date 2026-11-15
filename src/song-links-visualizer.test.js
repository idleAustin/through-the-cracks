// Unit and integration tests for scripts/song-links-visualizer.js payload building and HTTP server.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildVisualizerPayload,
  createVisualizerServer,
  isProcessAlive,
  readLogTail,
} from '../scripts/song-links-visualizer.js';

const tempDirs = [];
const NOW_MS = Date.parse('2026-11-15T02:00:00.000Z');
const isoAgo = (min) => new Date(NOW_MS - min * 60_000).toISOString();

function makeTempDir(prefix = 'ttc-viz-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setupFixtures(nowMs = NOW_MS) {
  const dir = makeTempDir();
  const paths = {
    catalogPath: path.join(dir, 'catalog-input.json'),
    verifiedSnapshotPath: path.join(dir, 'public-song-links.json'),
    checkpointPath: path.join(dir, 'checkpoint.jsonl'),
    statusPath: path.join(dir, 'discovery-status.json'),
    logPath: path.join(dir, 'discovery.log'),
  };

  writeFileSync(paths.catalogPath, JSON.stringify([
    { song_key: 'a|||one', totalPlays: 5 }, { song_key: 'b|||two', totalPlays: 3 },
    { song_key: 'c|||three', totalPlays: 2 }, { song_key: 'd|||four', totalPlays: 2 },
    { song_key: 'e|||five', totalPlays: 1 }, { song_key: 'f|||six', totalPlays: 1 },
    { song_key: 'g|||seven', totalPlays: 1 }, { song_key: 'h|||eight', totalPlays: 1 },
  ]));
  writeFileSync(paths.verifiedSnapshotPath, JSON.stringify([
    { song_key: 'a|||one', video_id: 'vid-a' },
    { song_key: 'b|||two', video_id: 'vid-b' },
    { song_key: 'x|||old', video_id: 'vid-x' },
  ]));

  const rows = [
    { song_key: 'c|||three', artist: 'C', song_title: 'Three', video_id: null, match_tier: 'unmatched', confidence_score: 12, checked_at: isoAgo(70) },
    { song_key: 'f|||six', artist: 'F', song_title: 'Six', video_id: null, match_tier: 'unmatched', confidence_score: 0, checked_at: isoAgo(75) },
    { song_key: 'e|||five', artist: 'E', song_title: 'Five', video_id: 'vid-e', match_tier: 'low', confidence_score: 68, checked_at: isoAgo(30) },
    { song_key: 'b|||two', artist: 'B', song_title: 'Two', video_id: 'vid-b', match_tier: 'medium', confidence_score: 82, checked_at: isoAgo(10) },
    { song_key: 'a|||one', artist: 'A', song_title: 'One', video_id: 'vid-a', match_tier: 'high', confidence_score: 96, checked_at: isoAgo(5) },
    { song_key: 'c|||three', artist: 'C', song_title: 'Three', video_id: 'vid-c', match_tier: 'high', confidence_score: 94, checked_at: isoAgo(2) },
  ];
  writeFileSync(paths.checkpointPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  writeFileSync(paths.statusPath, JSON.stringify({
    pid: process.pid,
    phase: 'batch_cooldown',
    startedAt: isoAgo(20),
    updatedAt: new Date(nowMs - 5000).toISOString(),
    batchSize: 175,
    batchIndex: 2,
    totalBatches: 10,
    batchProcessed: 40,
    paceMultiplier: 1.5,
    cleanStreak: 3,
    minJitter: 1.5,
    maxJitter: 3.0,
    cooldownMin: 480,
    cooldownMax: 600,
    cooldownSeconds: 540,
    cooldownUntil: new Date(nowMs + 120_000).toISOString(),
    processedInRun: 25,
    pendingTotal: 500,
    retryCount: 2,
    recentRetries: [
      { at: isoAgo(8), query: 'C Three', error: '429 rate limit' },
      { at: isoAgo(3), query: 'D Four', error: 'timeout' },
    ],
  }));

  writeFileSync(paths.logPath, 'line 1\nline 2\n\nline 3\nline 4\nline 5\n');
  return { ...paths, nowMs };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('song-links-visualizer', () => {
  it('builds telemetry payload, handles duplicate overrides, incremental appends, runtime state, and log tails', () => {
    const opts = setupFixtures(NOW_MS);
    const payload = buildVisualizerPayload(opts);

    expect(payload.catalog).toEqual({
      totalSongs: 8, pass1MultiTotal: 4, pass2SingleTotal: 4,
      pass1Completed: 3, pass2Completed: 2, overallCompleted: 5,
      overallPct: 62.5, pass1Pct: 75, pass2Pct: 50, productionLivePool: 3,
    });
    expect(payload.tiers).toEqual({
      high: 2, medium: 1, low: 1, unmatched: 1, totalChecked: 5, matchedTotal: 4, matchRatePct: 80,
    });
    expect(payload.recentMatches[0]).toMatchObject({
      songKey: 'c|||three', matchTier: 'high', videoId: 'vid-c', youtubeUrl: 'https://www.youtube.com/watch?v=vid-c',
    });
    expect(payload.recentMatches[4]).toMatchObject({ songKey: 'f|||six', videoId: null, youtubeUrl: null });
    expect(payload.throughput).toMatchObject({ songsLast15m: 3, songsLast60m: 4, pass1Remaining: 1, fullCatalogRemaining: 3 });
    expect(payload.throughput.pass1EtaSeconds).toBeGreaterThan(0);
    expect(payload.throughput.pass1EtaIso).toEqual(expect.any(String));
    expect(payload.throughput.fullCatalogEtaSeconds).toBeGreaterThan(0);
    expect(payload.throughput.fullCatalogEtaIso).toEqual(expect.any(String));

    expect(payload.runtime).toMatchObject({
      alive: true, pid: process.pid, phase: 'batch_cooldown',
      startedAt: isoAgo(20), updatedAt: new Date(NOW_MS - 5000).toISOString(),
      batchSize: 175, batchIndex: 2, totalBatches: 10, batchProcessed: 40,
      paceMultiplier: 1.5, cleanStreak: 3, minJitter: 1.5, maxJitter: 3.0,
      effectiveMinJitter: 2.25, effectiveMaxJitter: 4.5,
      cooldownMin: 480, cooldownMax: 600, cooldownSeconds: 540,
      cooldownRemainingSec: 120, processedInRun: 25, pendingTotal: 500, retryCount: 2,
    });
    expect(payload.runtime.recentRetries.map((r) => r.query)).toEqual(['D Four', 'C Three']);
    expect(payload.logTail).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    expect(readLogTail(opts.logPath, 2)).toEqual(['line 4', 'line 5']);
    expect(readLogTail(opts.logPath, 0)).toEqual([]);
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);

    appendFileSync(opts.checkpointPath, `${JSON.stringify({
      song_key: 'g|||seven', artist: 'G', song_title: 'Seven', video_id: 'vid-g',
      match_tier: 'medium', confidence_score: 85, checked_at: isoAgo(1),
    })}\n`);
    const updated = buildVisualizerPayload(opts);
    expect(updated.catalog).toMatchObject({ pass2Completed: 3, pass2Pct: 75, overallCompleted: 6, overallPct: 75 });
    expect(updated.tiers).toMatchObject({ medium: 2, totalChecked: 6, matchedTotal: 5, matchRatePct: 83.33 });
    expect(updated.throughput).toMatchObject({ songsLast15m: 4, songsLast60m: 5, fullCatalogRemaining: 2 });
    expect(updated.recentMatches[0]).toMatchObject({ songKey: 'g|||seven', youtubeUrl: 'https://www.youtube.com/watch?v=vid-g' });
  });

  it('serves dashboard HTML, /api/status JSON, and 404 on unknown routes', async () => {
    const opts = setupFixtures(NOW_MS);
    const expected = buildVisualizerPayload(opts);
    const server = createVisualizerServer(opts);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;

      const htmlRes = await fetch(`${base}/`);
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get('content-type')).toMatch(/text\/html/);
      expect(htmlRes.headers.get('cache-control')).toBe('no-store');
      const html = await htmlRes.text();
      expect(html).toContain('<html');
      expect(html).toContain('THROUGH THE CRACKS');

      const apiRes = await fetch(`${base}/api/status`);
      expect(apiRes.status).toBe(200);
      expect(apiRes.headers.get('content-type')).toMatch(/application\/json/);
      expect(apiRes.headers.get('cache-control')).toBe('no-store');
      expect(await apiRes.json()).toEqual(expected);

      const missRes = await fetch(`${base}/unknown`);
      expect(missRes.status).toBe(404);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
