// Integration tests for Stage 3 & 4 YouTube compatibility verification, manual-safe SQL, and snapshot export.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateVideoCompatibility, isUsPlayableRegion, parseIsoDuration } from '../scripts/song-links-export-helpers.js';
import { runVerifyAndExport, verifyCheckpointRecords } from '../scripts/verify-and-export-song-links.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];

function makeTempDir(prefix = 'ttc-verify-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('Stage 3 & 4: compatibility gating, batching, manual-safe SQL, and snapshot export', () => {
  it('requires YOUTUBE_API_KEY, parses ISO-8601 durations, batches 50 IDs, and enforces public+processed+embeddable+US', async () => {
    await expect(verifyCheckpointRecords([{ song_key: 'a|||b', video_id: 'v1' }], { apiKey: '' })).rejects.toThrow(/YOUTUBE_API_KEY/);
    const cliFail = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-and-export-song-links.js'), '--input', path.join(ROOT, 'package.json')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, YOUTUBE_API_KEY: '' },
    });
    expect(cliFail.status).toBe(1);
    expect(cliFail.stderr).toMatch(/YOUTUBE_API_KEY/);

    expect(parseIsoDuration('PT4M17S')).toBe(257);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('PT')).toBeNull();
    expect(isUsPlayableRegion(null)).toBe(true);
    expect(isUsPlayableRegion({ blocked: ['US'] })).toBe(false);
    expect(isUsPlayableRegion({ allowed: ['CA'] })).toBe(false);
    expect(isUsPlayableRegion({ allowed: ['US', 'CA'], blocked: ['GB'] })).toBe(true);

    expect(evaluateVideoCompatibility(
      { song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v1', confidence_score: 95, match_tier: 'high' },
      { status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { duration: 'PT3M12S' } },
    )).toMatchObject({ is_embeddable: 1, us_playable: 1, status_reason: 'ok', duration_seconds: 192 });
    expect(evaluateVideoCompatibility(
      { song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v2' },
      { status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: false }, contentDetails: { duration: 'PT3M' } },
    )).toMatchObject({ is_embeddable: 0, us_playable: 1, status_reason: 'not_embeddable' });
    expect(evaluateVideoCompatibility(
      { song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v2b' },
      { status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: 'true' }, contentDetails: {} },
    )).toMatchObject({ is_embeddable: 0, us_playable: 1, status_reason: 'not_embeddable' });
    expect(evaluateVideoCompatibility(
      { song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v3' },
      { status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { regionRestriction: { blocked: ['US'] } } },
    )).toMatchObject({ is_embeddable: 1, us_playable: 0, status_reason: 'us_blocked' });
    expect(evaluateVideoCompatibility(
      { song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v3b' },
      { status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { regionRestriction: { allowed: ['CA'] } } },
    )).toMatchObject({ is_embeddable: 1, us_playable: 0, status_reason: 'us_blocked' });
    expect(evaluateVideoCompatibility(
      { song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v4' },
      { status: { privacyStatus: 'unlisted', uploadStatus: 'processed', embeddable: true }, contentDetails: {} },
    )).toMatchObject({ is_embeddable: 0, us_playable: 0, status_reason: 'privacy:unlisted/upload:processed' });
    expect(evaluateVideoCompatibility(
      { song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v4b' },
      { status: { privacyStatus: 'public', uploadStatus: 'uploaded', embeddable: true }, contentDetails: {} },
    )).toMatchObject({ is_embeddable: 0, us_playable: 0, status_reason: 'privacy:public/upload:uploaded' });
    expect(evaluateVideoCompatibility({ song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: 'v5' }, null))
      .toMatchObject({ is_embeddable: 0, us_playable: 0, status_reason: 'missing_or_deleted' });
    expect(evaluateVideoCompatibility({ song_key: 'a|||b', artist: 'A', song_title: 'B', video_id: null }, null))
      .toMatchObject({ is_embeddable: 0, us_playable: 0, status_reason: 'unmatched', match_tier: 'unmatched' });

    const batchRecords = Array.from({ length: 105 }, (_, i) => ({
      song_key: `artist|||song-${i}`,
      artist: 'Artist',
      song_title: `Song ${i}`,
      video_id: `vid-${String(i).padStart(3, '0')}`,
      confidence_score: 90,
      match_tier: 'high',
    }));
    const batchSizes = [];
    const res = await verifyCheckpointRecords(batchRecords, {
      apiKey: 'fake-key',
      fetchFn: async (url) => {
        const parsedUrl = new URL(url);
        expect(parsedUrl.searchParams.get('part')).toBe('status,contentDetails');
        expect(parsedUrl.searchParams.get('key')).toBe('fake-key');
        const ids = parsedUrl.searchParams.get('id').split(',');
        batchSizes.push(ids.length);
        return new Response(
          JSON.stringify({
            items: ids.map((id) => ({
              id,
              status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true },
              contentDetails: { duration: 'PT3M00S' },
            })),
          }),
          { status: 200 },
        );
      },
    });
    expect(batchSizes).toEqual([50, 50, 5]);
    expect(res.apiCalls).toBe(3);
    expect(res.counts.compatible).toBe(105);
  });

  it('escapes SQL quotes, emits manual-guarded chunks, preserves manual overrides, and writes playable snapshot', async () => {
    const dir = makeTempDir('ttc-stage4-');
    const ckptPath = path.join(dir, 'checkpoint.jsonl');
    const verifiedOutPath = path.join(dir, 'verified.jsonl');
    const sqlDir = path.join(dir, 'sql');
    const songsPath = path.join(dir, 'songs.json');
    const snapshotOutPath = path.join(dir, 'song-links.json');

    const rows = [
      { song_key: 'todd snider|||alright guy', artist: 'Todd Snider', song_title: 'Alright Guy', video_id: 'vid-new-auto', yt_title: "Alright Guy (Live '02)", yt_artist: 'Todd Snider', confidence_score: 95, match_tier: 'high' },
      { song_key: "tim o'brien|||workin' on a building", artist: "Tim O'Brien", song_title: "Workin' On A Building", video_id: 'vid-ob', yt_title: "Workin' On A Building", yt_artist: "Tim O'Brien", yt_album: "O'Brien's Best", confidence_score: 92, match_tier: 'high' },
      { song_key: 'blocked artist|||no embed', artist: 'Blocked Artist', song_title: 'No Embed', video_id: 'vid-blk', yt_title: 'No Embed', yt_artist: 'Blocked Artist', confidence_score: 90, match_tier: 'high' },
      { song_key: 'ca only|||us blocked', artist: 'CA Only', song_title: 'US Blocked', video_id: 'vid-ca', yt_title: 'US Blocked', yt_artist: 'CA Only', confidence_score: 91, match_tier: 'high' },
    ];
    writeFileSync(ckptPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    writeFileSync(
      songsPath,
      JSON.stringify([
        { artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Viva Satellite', totalPlays: 12 },
        { artist: "Tim O'Brien", songTitle: "Workin' On A Building", album: 'Cornbread Nation', totalPlays: 8 },
      ]),
      'utf8',
    );

    const out = await runVerifyAndExport({
      inputPath: ckptPath,
      verifiedOutPath,
      sqlDir,
      songsPath,
      snapshotOutPath,
      chunkSize: 2,
      apiKey: 'fake-key',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 'vid-new-auto', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { duration: 'PT3M30S' } },
              { id: 'vid-ob', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { duration: 'PT4M45S' } },
              { id: 'vid-blk', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: false }, contentDetails: { duration: 'PT2M10S' } },
              { id: 'vid-ca', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { duration: 'PT2M20S', regionRestriction: { allowed: ['CA'] } } },
            ],
          }),
          { status: 200 },
        ),
    });

    expect(out.chunkCount).toBe(2);
    expect(out.snapshotCount).toBe(2);
    const chunk1Sql = readFileSync(path.join(sqlDir, 'chunk-001.sql'), 'utf8');
    const chunk2Sql = readFileSync(path.join(sqlDir, 'chunk-002.sql'), 'utf8');
    expect(chunk1Sql).toContain("WHERE song_links.match_tier != 'manual'");
    expect(chunk2Sql).toContain("WHERE song_links.match_tier != 'manual'");
    expect(chunk1Sql).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
    expect(chunk1Sql).toContain("''02");
    expect(chunk1Sql).toContain("O''Brien''s Best");

    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));
      sqlite.prepare(`INSERT INTO song_links (song_key, artist, song_title, video_id, confidence_score, match_tier, is_embeddable, us_playable, status_reason, checked_at, updated_at)
        VALUES ('todd snider|||alright guy', 'Todd Snider', 'Alright Guy', 'manual-kept', 100, 'manual', 1, 1, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
               ('tim o''brien|||workin'' on a building', 'Tim O''Brien', 'Workin'' On A Building', 'old-auto', 70, 'medium', 1, 1, 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
      sqlite.exec(chunk1Sql);
      sqlite.exec(chunk2Sql);

      expect(sqlite.prepare("SELECT video_id, match_tier, confidence_score FROM song_links WHERE song_key = 'todd snider|||alright guy'").get())
        .toEqual({ video_id: 'manual-kept', match_tier: 'manual', confidence_score: 100 });
      expect(sqlite.prepare('SELECT artist, video_id, yt_album, duration_seconds, is_embeddable FROM song_links WHERE song_key = ?').get("tim o'brien|||workin' on a building"))
        .toEqual({ artist: "Tim O'Brien", video_id: 'vid-ob', yt_album: "O'Brien's Best", duration_seconds: 285, is_embeddable: 1 });
      expect(sqlite.prepare('SELECT COUNT(1) AS c FROM song_links').get().c).toBe(4);
    } finally {
      sqlite.close();
    }

    const snap = JSON.parse(readFileSync(snapshotOutPath, 'utf8'));
    expect(snap).toHaveLength(2);
    expect(Object.keys(snap[0]).sort()).toEqual([
      'album', 'artist', 'confidenceScore', 'durationSeconds', 'matchTier',
      'songKey', 'songTitle', 'totalPlays', 'videoId', 'ytArtist', 'ytTitle',
    ]);
    expect(snap.map((s) => s.songKey)).toEqual(['todd snider|||alright guy', "tim o'brien|||workin' on a building"]);
    expect(snap[0]).toMatchObject({ album: 'Viva Satellite', totalPlays: 12, durationSeconds: 210 });
  });
});
