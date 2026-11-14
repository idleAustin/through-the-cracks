// Integration tests for Stage 1-2 song_links backfill, D1 non-drop seed, and R2 snapshot plan.
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
import { buildSongKey } from '../server/playlistBuilder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENV_PY = path.join(ROOT, '.kennel-hub', 'session', '20261113-03-youtube-playlist-generator', '.venv', 'bin', 'python');
const PYTHON_BIN = existsSync(VENV_PY) ? VENV_PY : 'python3';
const HAS_RAPIDFUZZ = spawnSync(PYTHON_BIN, ['-c', 'import rapidfuzz']).status === 0;
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
      song_key: 'willie nelson|||blue eyes crying', artist: 'Willie Nelson', song_title: 'Blue Eyes Crying',
      album: 'Red Headed Stranger', totalPlays: 7, episodes: ['ep1', 'ep2'],
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
  const readCkpt = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().startsWith('{"song_key"')).map((l) => JSON.parse(l));
  const runPy = (bin, dir, logPath, args, extraEnv = {}) =>
    spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: dir, FAKE_YTM_LOG: logPath, ...extraEnv } });

  const writeStubYtm = (stubDir, { stubRapidFuzz = !HAS_RAPIDFUZZ } = {}) => {
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
    if (stubRapidFuzz) {
      writeFileSync(
        path.join(stubDir, 'rapidfuzz.py'),
        `from difflib import SequenceMatcher
def _ratio(a, b):
    return SequenceMatcher(None, a or "", b or "").ratio() * 100.0
def _token_sort_ratio(a, b):
    return _ratio(" ".join(sorted((a or "").split())), " ".join(sorted((b or "").split())))
def _token_set_ratio(a, b):
    t1, t2 = set((a or "").split()), set((b or "").split())
    inter = sorted(t1 & t2)
    c1, c2 = " ".join(inter + sorted(t1 - t2)), " ".join(inter + sorted(t2 - t1))
    if not inter:
        return _ratio(c1, c2)
    sect = " ".join(inter)
    return max(_ratio(sect, c1), _ratio(sect, c2), _ratio(c1, c2))
class fuzz:
    ratio, token_sort_ratio, token_set_ratio = staticmethod(_ratio), staticmethod(_token_sort_ratio), staticmethod(_token_set_ratio)
`,
        'utf8',
      );
    }
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

    const cliFlags = ['--input', inputPath, '--checkpoint', ckptPath, '--retry-delays=0,0,0', '--min-jitter=0', '--max-jitter=0'];
    const multiRes = runPy(PYTHON_BIN, dir, logPath, [DISCOVER_SCRIPT, '--pass=multi', ...cliFlags]);
    expect(multiRes.status, multiRes.stderr).toBe(0);
    const singleRes = runPy(PYTHON_BIN, dir, logPath, [DISCOVER_SCRIPT, '--pass=single', ...cliFlags]);
    expect(singleRes.status, singleRes.stderr).toBe(0);

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls).toEqual([
      ['Todd Snider Alright Guy', 'songs'], ['Medium Artist Upgrade Tune', 'songs'], ['Medium Artist Upgrade Tune', 'videos'],
      ['Ghost Artist Missing Tune', 'songs'], ['Ghost Artist Missing Tune', 'videos'], ['One Spin Deep Cut', 'songs'],
    ]);
    expect(readCkpt(ckptPath).map((r) => [r.song_key, r.video_id, r.match_tier])).toEqual([
      ['already done|||skip me', undefined, 'high'], ['todd snider|||alright guy', 'vid-todd', 'high'],
      ['medium artist|||upgrade tune', 'vid-high-vid', 'high'], ['ghost artist|||missing tune', null, 'unmatched'],
      ['one spin|||deep cut', 'vid-one', 'high'],
    ]);

    writeFileSync(retryInputPath, JSON.stringify(catalog.slice(1, 3)), 'utf8');
    const failCli = runPy(PYTHON_BIN, dir, logPath, [DISCOVER_SCRIPT, '--pass=all', '--input', retryInputPath, '--checkpoint', retryCkptPath, '--retry-delays=0,0,0', '--min-jitter=0', '--max-jitter=0'], { FAKE_YTM_MODE: '429' });
    expect(failCli.status).toBe(1);
    expect(readCkpt(retryCkptPath).map((r) => [r.song_key, r.match_tier])).toEqual([['todd snider|||alright guy', 'high']]);

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
    const pyRes = runPy(PYTHON_BIN, dir, logPath, ['-c', pyCheck], { FAKE_YTM_MODE: '' });
    expect(pyRes.status, pyRes.stderr).toBe(0);
    const parsed = JSON.parse(pyRes.stdout.trim().split('\n').pop());
    expect(parsed.sleeps.length).toBeGreaterThanOrEqual(4);
    expect(parsed.sleeps.every((s) => s >= 0.25 && s <= 0.55)).toBe(true);
    expect(parsed).toMatchObject({ defaults: [30, 120, 600], backoff: [30, 120, 600], raised: true });
    expect(readFileSync(backoffCkpt, 'utf8')).not.toContain('unmatched');
  });

  it('runs discover-song-links.py under bare system python3 using stdlib rapidfuzz stub', () => {
    const dir = makeTempDir('ttc-stage2-py3-');
    const inputPath = path.join(dir, 'catalog.json');
    const ckptPath = path.join(dir, 'checkpoint.jsonl');
    const logPath = path.join(dir, 'calls.jsonl');
    writeStubYtm(dir, { stubRapidFuzz: true });
    writeFileSync(inputPath, JSON.stringify([
      { song_key: 'todd snider|||alright guy', artist: 'Todd Snider', song_title: 'Alright Guy', album: 'Viva Satellite', totalPlays: 4 },
      { song_key: 'medium artist|||upgrade tune', artist: 'Medium Artist', song_title: 'Upgrade Tune', album: 'Rare LP', totalPlays: 3 },
      { song_key: 'one spin|||deep cut', artist: 'One Spin', song_title: 'Deep Cut', album: 'Solo', totalPlays: 1 },
    ]), 'utf8');
    const res = spawnSync('python3', [DISCOVER_SCRIPT, '--pass=multi', '--input', inputPath, '--checkpoint', ckptPath, '--retry-delays=0,0,0', '--min-jitter=0', '--max-jitter=0'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: dir, FAKE_YTM_LOG: logPath },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(readCkpt(ckptPath).map((r) => [r.song_key, r.video_id, r.match_tier])).toEqual([
      ['todd snider|||alright guy', 'vid-todd', 'high'],
      ['medium artist|||upgrade tune', 'vid-high-vid', 'high'],
    ]);
  });
});

describe('D1 archive seed non-drop guard & R2 snapshot plan inclusion', () => {
  it('never emits DROP TABLE IF EXISTS song_links and preserves song_links across archive reseeds', async () => {
    expect(ARCHIVE_DROP_TABLES).not.toContain('song_links');
    const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
    const { sql } = await buildArchiveSeedSql({
      schemaSql,
      episodes: [{
        id: 'ep-1', airDate: '2026-10-01', title: 'Through the Cracks 10/1/26',
        songs: [{ position: 1, artist: 'Todd Snider', songTitle: 'Alright Guy', album: 'Viva Satellite' }],
      }],
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
