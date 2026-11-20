// Unit tests for scripts/sync-metadata-r2.js checkpoint compaction, atlas validation, and R2 sync commands.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeCheckpointLines,
  pullCheckpoint,
  pushAtlas,
  pushCheckpoint,
  r2ObjectUrl,
  redactTokenError,
  validateAtlasJson,
} from '../scripts/sync-metadata-r2.js';

describe('scripts/sync-metadata-r2.js', () => {
  const tempDirs = [];
  const makeDir = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ttc-meta-r2-'));
    tempDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('compacts sequential JSONL checkpoints identically to load_merged_checkpoints', () => {
    const raw = [
      JSON.stringify({
        song_key: 'a|||one', artist: 'A', song_title: 'One',
        mb: { found: true, year: 1995 }, sources_checked: ['mb'], checked_at: '2026-11-15T00:00:00Z',
      }),
      '{malformed-json-line',
      JSON.stringify({ artist: 'No Key' }),
      JSON.stringify({
        song_key: 'a|||one', artist: 'A', song_title: 'One',
        discogs: { found: true, label: 'Sugar Hill' }, mb: {}, sources_checked: ['discogs', 'wiki'], checked_at: '2026-11-19T06:00:00Z',
      }),
      JSON.stringify({
        song_key: 'b|||two', artist: 'B', song_title: 'Two',
        sources_checked: ['mb'], checked_at: '2026-11-19T06:01:00Z',
      }),
    ].join('\n');

    const compacted = mergeCheckpointLines(raw);
    const lines = compacted.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      song_key: 'a|||one',
      mb: { found: true, year: 1995 },
      discogs: { found: true, label: 'Sugar Hill' },
      sources_checked: ['discogs', 'mb', 'wiki'],
      checked_at: '2026-11-19T06:00:00Z',
    });
    expect(lines[1].song_key).toBe('b|||two');
  });

  it('validates metadata-atlas JSON, builds encoded R2 URLs, and redacts bearer/query secrets', () => {
    expect(() => validateAtlasJson('[]')).toThrow(/Invalid metadata-atlas JSON/);
    expect(() => validateAtlasJson('{"summary":{},"decades":[]}')).toThrow(/Invalid metadata-atlas JSON/);
    expect(validateAtlasJson('{"summary":{"totalSongs":10},"decades":[],"states":{}}').summary.totalSongs).toBe(10);

    expect(r2ObjectUrl({ accountId: 'acct1', bucket: 'bkt', key: 'state/song-metadata/checkpoint.jsonl.gz' })).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct1/r2/buckets/bkt/objects/state/song-metadata/checkpoint.jsonl.gz',
    );
    expect(redactTokenError('Bearer secret.tok-123 failed at ?token=abc&key=xyz')).toBe(
      'Bearer [REDACTED] failed at ?token=[REDACTED]&key=[REDACTED]',
    );
  });

  it('handles pull (404 skip, --require fail, retry, gzip round-trip) and push-checkpoint', async () => {
    const dir = makeDir();
    const ckptPath = path.join(dir, 'nested', 'checkpoint.jsonl');

    const notFoundFetch = vi.fn(async () => new Response('Not found', { status: 404 }));
    const skipRes = await pullCheckpoint({ outPath: ckptPath, token: 'tok', fetchImpl: notFoundFetch, sleepFn: async () => {} });
    expect(skipRes).toMatchObject({ skipped: true, reason: 'not_found' });

    await expect(
      pullCheckpoint({ outPath: ckptPath, require: true, token: 'tok', fetchImpl: notFoundFetch, sleepFn: async () => {} }),
    ).rejects.toThrow(/Missing required R2 metadata checkpoint/);

    const sampleJsonl = `${JSON.stringify({ song_key: 'todd|||broke', sources_checked: ['mb'] })}\n`;
    const gz = gzipSync(Buffer.from(sampleJsonl, 'utf8'));
    let calls = 0;
    const flakyPullFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limit', { status: 503 });
      return new Response(gz, { status: 200 });
    });

    const pullRes = await pullCheckpoint({ outPath: ckptPath, token: 'tok', fetchImpl: flakyPullFetch, sleepFn: async () => {} });
    expect(pullRes).toMatchObject({ skipped: false, lineCount: 1 });
    expect(readFileSync(ckptPath, 'utf8')).toBe(sampleJsonl);

    writeFileSync(
      ckptPath,
      `${sampleJsonl}${JSON.stringify({ song_key: 'todd|||broke', discogs: { found: true }, sources_checked: ['discogs'] })}\n`,
      'utf8',
    );
    const putBodies = [];
    const putFetch = vi.fn(async (_url, init) => {
      putBodies.push(Buffer.from(init.body));
      expect(init.headers['Content-Type']).toBe('application/gzip');
      return new Response('ok', { status: 200 });
    });
    const pushRes = await pushCheckpoint({ inPath: ckptPath, token: 'tok', fetchImpl: putFetch, sleepFn: async () => {} });
    expect(pushRes.lineCount).toBe(1);
    const roundTripped = gunzipSync(putBodies[0]).toString('utf8');
    expect(JSON.parse(roundTripped.trim())).toMatchObject({
      song_key: 'todd|||broke',
      discogs: { found: true },
      sources_checked: ['discogs', 'mb'],
    });
  });

  it('pushes validated metadata-atlas.json and bumps manifest updatedAt without clobbering counts', async () => {
    const dir = makeDir();
    const atlasPath = path.join(dir, 'metadata-atlas.json');
    writeFileSync(atlasPath, JSON.stringify({ summary: { totalSongs: 16300 }, decades: [], states: {} }), 'utf8');

    const requests = [];
    const manifest = { version: 1, updatedAt: '2026-11-18T00:00:00Z', totalEpisodes: 1346, totalSongPlays: 37718, latestEpisodeId: 'ep-18' };
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === 'GET' && url.endsWith('/v1/manifest.json')) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response('ok', { status: 200 });
    });

    const out = await pushAtlas({
      inPath: atlasPath,
      bumpManifest: true,
      now: '2026-11-20T06:20:00.000Z',
      token: 'tok',
      fetchImpl,
      sleepFn: async () => {},
    });
    expect(out).toMatchObject({ key: 'v1/metadata-atlas.json', totalSongs: 16300, manifestBumped: true });
    expect(requests.map((r) => `${r.method} ${r.url.split('/objects/')[1]}`)).toEqual([
      'PUT v1/metadata-atlas.json',
      'GET v1/manifest.json',
      'PUT v1/manifest.json',
    ]);
    expect(requests[2].body).toEqual({ ...manifest, updatedAt: '2026-11-20T06:20:00.000Z' });
  });
});
