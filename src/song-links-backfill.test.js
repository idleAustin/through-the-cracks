// Integration tests for 4-stage song_links backfill, compatibility gating, D1 non-drop seed, and R2 plan.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareCatalogInput, summarizeCatalogInput } from '../scripts/prepare-song-links-input.js';
import { ARCHIVE_DROP_TABLES, buildArchiveSeedSql } from '../scripts/seed-d1.js';
import { collectSnapshotPlan } from '../scripts/seed-r2.js';
import { evaluateVideoCompatibility, isUsPlayableRegion, parseIsoDuration } from '../scripts/song-links-export-helpers.js';
import { runVerifyAndExport, verifyCheckpointRecords } from '../scripts/verify-and-export-song-links.js';
import { buildSongKey } from '../server/playlistBuilder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENV_PY = path.join(ROOT, '.kennel-hub', 'session', '20261113-03-youtube-playlist-generator', '.venv', 'bin', 'python');
const PYTHON_BIN = existsSync(VENV_PY) ? VENV_PY : 'python3';
const tempDirs = [];

function makeTempDir(prefix = 'ttc-backfill-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('Stage 1: prepare-song-links-input', () => {
  it('pre-keys with buildSongKey, deduplicates canonical aliases, preserves fields, and sorts deterministically', () => {
    const input = [
      { artist: 'willis nelson', songTitle: 'Blue Eyes Crying', album: 'Red Headed Stranger', totalPlays: 2, episodes: ['ep1'] },
      { artist: 'Willie Nelson', songTitle: 'Blue Eyes Crying', album: 'Red Headed Stranger', totalPlays: 5, episodes: ['ep2', 'ep1'] },
      { artist: 'Zed Artist', songTitle: 'Single Cut', album: 'Debut', totalPlays: 1 },
      { artist: 'Alpha Artist', songTitle: 'Single Cut', album: 'First', totalPlays: 1 },
      { artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Viva Satellite', totalPlays: 9 },
    ];

    const prepared = prepareCatalogInput(input);
    expect(prepared.map((r) => [r.song_key, r.totalPlays])).toEqual([
      [buildSongKey('Todd Snider', 'Alright Guy'), 9],
      [buildSongKey('Willie Nelson', 'Blue Eyes Crying'), 7],
      [buildSongKey('Alpha Artist', 'Single Cut'), 1],
      [buildSongKey('Zed Artist', 'Single Cut'), 1],
    ]);
    expect(prepared[1]).toMatchObject({
      song_key: 'willie nelson|||blue eyes crying',
      artist: 'Willie Nelson',
      song_title: 'Blue Eyes Crying',
      album: 'Red Headed Stranger',
      totalPlays: 7,
      episodes: ['ep1', 'ep2'],
    });
    expect(summarizeCatalogInput(prepared)).toEqual({ total: 4, multi: 2, single: 2 });
  });

  it('produces exact 16,285 unique keys (9,289 multi + 6,996 single) from public/data/songs.json', () => {
    const songs = JSON.parse(readFileSync(path.join(ROOT, 'public', 'data', 'songs.json'), 'utf8'));
    const prepared = prepareCatalogInput(songs);
    expect(summarizeCatalogInput(prepared)).toEqual({ total: 16285, multi: 9289, single: 6996 });
    expect(prepared.findIndex((r) => r.song_key !== buildSongKey(r.artist, r.song_title))).toBe(-1);
    expect(prepared.findIndex((r, i) => i > 0 && !(prepared[i - 1].totalPlays > r.totalPlays || (prepared[i - 1].totalPlays === r.totalPlays && prepared[i - 1].song_key < r.song_key)))).toBe(-1);
  });
});

describe('Stage 2: discover-song-links.py', () => {
  const DISCOVER_SCRIPT = path.join(ROOT, 'scripts', 'discover-song-links.py');
  const writeStubYtm = (stubDir) => {
    writeFileSync(
      path.join(stubDir, 'ytmusicapi.py'),
      `import json, os
class YTMusic:
    def search(self, query, filter="songs", limit=5):
        with open(os.environ["FAKE_YTM_LOG"], "a", encoding="utf-8") as fh:
            fh.write(json.dumps([query, filter]) + "\\n")
        if os.environ.get("FAKE_YTM_MODE") == "429" and "Todd Snider" not in query:
            raise RuntimeError("HTTP 429 Too Many Requests")
        if "Todd Snider" in query and filter == "songs":
            return [{"videoId": "vid-todd", "title": "Alright Guy", "artists": [{"name": "Todd Snider"}], "album": {"name": "Viva Satellite"}, "resultType": "song", "duration_seconds": 210}]
        if "Medium Artist" in query and filter == "songs":
            return [{"videoId": "vid-med", "title": "Upgrade Tune", "artists": [{"name": "Medium Artist"}], "resultType": "video", "duration_seconds": 200}]
        if "Medium Artist" in query and filter == "videos":
            return [{"videoId": "vid-high-vid", "title": "Upgrade Tune", "artists": [{"name": "Medium Artist - Topic"}], "album": {"name": "Rare LP"}, "resultType": "video", "duration_seconds": 200}]
        if "One Spin" in query and filter == "songs":
            return [{"videoId": "vid-one", "title": "Deep Cut", "artists": [{"name": "One Spin"}], "album": {"name": "Solo"}, "resultType": "song", "duration_seconds": 180}]
        return []
`,
      'utf8',
    );
  };

  it('runs --pass=multi/--pass=single CLI, >= 85 short-circuit, checkpoint resume, 0.25-0.55s jitter, and safe retry exit', () => {
    const dir = makeTempDir('ttc-stage2-');
    const inputPath = path.join(dir, 'catalog.json');
    const ckptPath = path.join(dir, 'checkpoint.jsonl');
    const logPath = path.join(dir, 'calls.jsonl');
    const retryInputPath = path.join(dir, 'retry-catalog.json');
    const retryCkptPath = path.join(dir, 'retry-checkpoint.jsonl');
    writeStubYtm(dir);

    const catalog = [
      { song_key: 'already done|||skip me', artist: 'Already Done', song_title: 'Skip Me', album: 'Old', totalPlays: 5 },
      { song_key: 'todd snider|||alright guy', artist: 'Todd Snider', song_title: 'Alright Guy', album: 'Viva Satellite', totalPlays: 4 },
      { song_key: 'medium artist|||upgrade tune', artist: 'Medium Artist', song_title: 'Upgrade Tune', album: 'Rare LP', totalPlays: 3 },
      { song_key: 'ghost artist|||missing tune', artist: 'Ghost Artist', song_title: 'Missing Tune', album: 'None', totalPlays: 2 },
      { song_key: 'one spin|||deep cut', artist: 'One Spin', song_title: 'Deep Cut', album: 'Solo', totalPlays: 1 },
    ];
    writeFileSync(inputPath, JSON.stringify(catalog), 'utf8');
    writeFileSync(ckptPath, `${JSON.stringify({ song_key: 'already done|||skip me', match_tier: 'high' })}\n{"corrupt": `, 'utf8');

    const runCli = (args, extraEnv = {}) =>
      spawnSync(PYTHON_BIN, [DISCOVER_SCRIPT, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: dir, FAKE_YTM_LOG: logPath, ...extraEnv },
      });

    const multiRes = runCli(['--pass=multi', '--input', inputPath, '--checkpoint', ckptPath, '--retry-delays=0,0,0', '--min-jitter=0', '--max-jitter=0']);
    expect(multiRes.status, multiRes.stderr).toBe(0);
    const singleRes = runCli(['--pass=single', '--input', inputPath, '--checkpoint', ckptPath, '--retry-delays=0,0,0', '--min-jitter=0', '--max-jitter=0']);
    expect(singleRes.status, singleRes.stderr).toBe(0);

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls).toEqual([
      ['Todd Snider Alright Guy', 'songs'],
      ['Medium Artist Upgrade Tune', 'songs'],
      ['Medium Artist Upgrade Tune', 'videos'],
      ['Ghost Artist Missing Tune', 'songs'],
      ['Ghost Artist Missing Tune', 'videos'],
      ['One Spin Deep Cut', 'songs'],
    ]);
    const ckptRows = readFileSync(ckptPath, 'utf8').split('\n').filter((l) => l.trim().startsWith('{"song_key"')).map((l) => JSON.parse(l));
    expect(ckptRows.map((r) => [r.song_key, r.video_id, r.match_tier])).toEqual([
      ['already done|||skip me', undefined, 'high'],
      ['todd snider|||alright guy', 'vid-todd', 'high'],
      ['medium artist|||upgrade tune', 'vid-high-vid', 'high'],
      ['ghost artist|||missing tune', null, 'unmatched'],
      ['one spin|||deep cut', 'vid-one', 'high'],
    ]);

    writeFileSync(retryInputPath, JSON.stringify(catalog.slice(1, 3)), 'utf8');
    const failCli = runCli(['--pass=all', '--input', retryInputPath, '--checkpoint', retryCkptPath, '--retry-delays=0,0,0', '--min-jitter=0', '--max-jitter=0'], { FAKE_YTM_MODE: '429' });
    expect(failCli.status).toBe(1);
    const savedOnAbort = readFileSync(retryCkptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(savedOnAbort.map((r) => [r.song_key, r.match_tier])).toEqual([['todd snider|||alright guy', 'high']]);

    // Verify default 0.25s-0.55s jitter guard and (30, 120, 600) exponential backoff delays
    const jitterCkpt = path.join(dir, 'jitter-ckpt.jsonl');
    const backoffCkpt = path.join(dir, 'backoff-ckpt.jsonl');
    const pyCheck = `
import importlib.util, json, os
from pathlib import Path
from ytmusicapi import YTMusic
spec = importlib.util.spec_from_file_location("discover", ${JSON.stringify(DISCOVER_SCRIPT)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
sleeps = []
mod.run_discovery(input_path=Path(${JSON.stringify(inputPath)}), checkpoint_path=Path(${JSON.stringify(jitterCkpt)}), pass_mode="multi", ytm=YTMusic(), sleep_fn=sleeps.append)
os.environ["FAKE_YTM_MODE"] = "429"
backoff, raised = [], False
try:
    mod.run_discovery(input_path=Path(${JSON.stringify(retryInputPath)}), checkpoint_path=Path(${JSON.stringify(backoffCkpt)}), pass_mode="all", min_jitter=0.0, max_jitter=0.0, ytm=YTMusic(), sleep_fn=backoff.append)
except mod.DiscoveryRetryExhaustedError:
    raised = True
print(json.dumps({"sleeps": sleeps, "backoff": backoff, "defaults": list(mod.DEFAULT_RETRY_DELAYS), "raised": raised}))
`;
    const pyRes = spawnSync(PYTHON_BIN, ['-c', pyCheck], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: dir, FAKE_YTM_LOG: logPath, FAKE_YTM_MODE: '' },
    });
    expect(pyRes.status, pyRes.stderr).toBe(0);
    const parsed = JSON.parse(pyRes.stdout.trim().split('\n').pop());
    expect(parsed.sleeps.length).toBeGreaterThanOrEqual(4);
    expect(parsed.sleeps.every((s) => s >= 0.25 && s <= 0.55)).toBe(true);
    expect(parsed).toMatchObject({ defaults: [30, 120, 600], backoff: [30, 120, 600], raised: true });
    expect(readFileSync(backoffCkpt, 'utf8')).not.toContain('unmatched');
  });
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

describe('D1 archive seed non-drop guard & R2 snapshot plan inclusion', () => {
  it('never emits DROP TABLE IF EXISTS song_links and preserves song_links across archive reseeds', async () => {
    expect(ARCHIVE_DROP_TABLES).not.toContain('song_links');
    const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
    const { sql } = await buildArchiveSeedSql({
      schemaSql,
      episodes: [
        {
          id: 'ep-1',
          airDate: '2026-10-01',
          title: 'Through the Cracks 10/1/26',
          songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Viva Satellite' }],
        },
      ],
    });
    expect(sql).not.toMatch(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?song_links\b/i);

    const mem = new DatabaseSync(':memory:');
    try {
      mem.exec(schemaSql);
      mem.prepare(`INSERT INTO song_links (song_key, artist, song_title, video_id, confidence_score, match_tier, is_embeddable, us_playable, status_reason, checked_at, updated_at)
        VALUES ('todd snider|||alright guy', 'Todd Snider', 'Alright Guy', 'manual-survives', 100, 'manual', 1, 1, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
      mem.exec(sql);
      const survived = mem.prepare('SELECT video_id, match_tier FROM song_links').get();
      expect(survived).toEqual({ video_id: 'manual-survives', match_tier: 'manual' });
      expect(mem.prepare('SELECT COUNT(1) AS c FROM episodes').get().c).toBe(1);
    } finally {
      mem.close();
    }
  });

  it('includes v1/song-links.json in R2 snapshot plan only when song-links.json is present', () => {
    const dir = makeTempDir('ttc-r2-plan-');
    for (const file of ['overview.json', 'year-spins.json', 'episodes-index.json', 'artists.json', 'songs.json', 'albums.json', 'years.json']) {
      writeFileSync(path.join(dir, file), file === 'overview.json' ? JSON.stringify({ totalEpisodes: 1, totalSongPlays: 2, latestEpisodeId: 'ep1' }) : '[]', 'utf8');
    }
    expect(collectSnapshotPlan(dir).entries.some((e) => e.relPath === 'song-links.json')).toBe(false);

    writeFileSync(path.join(dir, 'song-links.json'), '[]', 'utf8');
    expect(collectSnapshotPlan(dir).entries.some((e) => e.relPath === 'song-links.json')).toBe(true);

    const dryRunOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-r2.js'), '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
    expect(dryRunOut).toContain('v1/song-links.json');
  });
});
