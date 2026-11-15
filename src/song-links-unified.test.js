// Integration tests for unified Stage 2 discovery, hit filtering, ytm_factory rotation, and cooldown resets.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISCOVER_SCRIPT = path.join(ROOT, 'scripts', 'discover-song-links.py');
const VENV_PY = path.join(ROOT, '.kennel-hub', 'session', '20261113-03-youtube-playlist-generator', '.venv', 'bin', 'python');
const PYTHON_BIN = existsSync(VENV_PY) ? VENV_PY : 'python3';
const HAS_RAPIDFUZZ = spawnSync(PYTHON_BIN, ['-c', 'import rapidfuzz']).status === 0;
const tempDirs = [];

function makeTempDir(prefix = 'ttc-unified-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const readCkpt = (file) =>
  readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().startsWith('{"song_key"')).map((l) => JSON.parse(l));

const runPy = (dir, logPath, args, extraEnv = {}) =>
  spawnSync(PYTHON_BIN, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: dir, FAKE_YTM_LOG: logPath, ...extraEnv } });

function writeRapidFuzzStub(dir) {
  if (HAS_RAPIDFUZZ) return;
  writeFileSync(
    path.join(dir, 'rapidfuzz.py'),
    `from difflib import SequenceMatcher
def _ratio(a, b): return SequenceMatcher(None, a or "", b or "").ratio() * 100.0
def _token_sort_ratio(a, b): return _ratio(" ".join(sorted((a or "").split())), " ".join(sorted((b or "").split())))
def _token_set_ratio(a, b):
    t1, t2 = set((a or "").split()), set((b or "").split())
    inter = sorted(t1 & t2)
    c1, c2 = " ".join(inter + sorted(t1 - t2)), " ".join(inter + sorted(t2 - t1))
    return max(_ratio(" ".join(inter), c1), _ratio(" ".join(inter), c2), _ratio(c1, c2)) if inter else _ratio(c1, c2)
class fuzz:
    ratio, token_sort_ratio, token_set_ratio = staticmethod(_ratio), staticmethod(_token_sort_ratio), staticmethod(_token_set_ratio)
`,
    'utf8',
  );
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('Stage 2 unified search mode', () => {
  it('defaults to single unified filter=None limit=10 call and filters disallowed or unavailable hits', () => {
    const dir = makeTempDir('ttc-unified-filter-');
    const inputPath = path.join(dir, 'catalog.json');
    const cliCkpt = path.join(dir, 'cli-ckpt.jsonl');
    const cliLog = path.join(dir, 'cli-calls.jsonl');
    const pyCkpt = path.join(dir, 'py', 'py-ckpt.jsonl');
    const pyLog = path.join(dir, 'py-calls.jsonl');
    writeRapidFuzzStub(dir);

    const catalog = [
      { song_key: 'artist high|||title high', artist: 'Artist High', song_title: 'Title High', album: 'Album High', totalPlays: 5 },
      { song_key: 'artist med|||title med', artist: 'Artist Med', song_title: 'Title Med', album: 'Album Med', totalPlays: 4 },
      { song_key: 'artist low|||title low', artist: 'Artist Low', song_title: 'Title Low', album: 'Album Low', totalPlays: 3 },
      { song_key: 'artist empty|||title empty', artist: 'Artist Empty', song_title: 'Title Empty', album: 'Album Empty', totalPlays: 2 },
      { song_key: 'artist filtered|||title filtered', artist: 'Artist Filtered', song_title: 'Title Filtered', album: 'Album Filtered', totalPlays: 1 },
    ];
    writeFileSync(inputPath, JSON.stringify(catalog), 'utf8');
    writeFileSync(
      path.join(dir, 'ytmusicapi.py'),
      `import json, os
def _rejected(artist, title, album):
    base = {"title": title, "artists": [{"name": artist}], "album": {"name": album}, "duration_seconds": 200}
    items = [{**base, "videoId": f"bad-{rt}", "resultType": rt, "isAvailable": True} for rt in ("album", "artist", "playlist", "episode", "station", None)]
    items.append({**base, "videoId": "bad-missing", "isAvailable": True})
    items.append({**base, "videoId": "bad-unavail-song", "resultType": "song", "isAvailable": False})
    items.append({**base, "videoId": "bad-unavail-vid", "resultType": "video", "isAvailable": False})
    return items
class YTMusic:
    def search(self, query, filter=None, limit=10):
        with open(os.environ["FAKE_YTM_LOG"], "a", encoding="utf-8") as fh:
            fh.write(json.dumps([query, filter, limit]) + "\\n")
        if query == "Artist High Title High":
            return _rejected("Artist High", "Title High", "Album High") + [
                {"videoId": "good-song", "title": "Title High", "artists": [{"name": "Artist High"}], "album": {"name": "Album High"}, "resultType": "song", "duration_seconds": 200, "isAvailable": True},
            ]
        if query == "Artist Med Title Med":
            return _rejected("Artist Med", "Title Med", "Album Med") + [
                {"videoId": "good-med-vid", "title": "Title Med", "artists": [{"name": "Artist Med"}], "resultType": "video", "duration_seconds": 200},
            ]
        if query == "Artist Low Title Low":
            return [{"videoId": "good-low-vid", "title": "Title Low (Live)", "artists": [{"name": "Artist Low"}], "resultType": "video", "duration_seconds": 200}]
        if query == "Artist Filtered Title Filtered":
            return _rejected("Artist Filtered", "Title Filtered", "Album Filtered")
        return []
`,
      'utf8',
    );

    const cliRes = runPy(dir, cliLog, [DISCOVER_SCRIPT, '--pass=all', '--input', inputPath, '--checkpoint', cliCkpt, '--retry-delays=0', '--min-jitter=0', '--max-jitter=0']);
    expect(cliRes.status, cliRes.stderr).toBe(0);

    const expectedCalls = [
      ['Artist High Title High', null, 10],
      ['Artist Med Title Med', null, 10],
      ['Artist Low Title Low', null, 10],
      ['Artist Empty Title Empty', null, 10],
      ['Artist Filtered Title Filtered', null, 10],
    ];
    const expectedRecords = [
      ['artist high|||title high', 'good-song', 'song', 'high', 100],
      ['artist med|||title med', 'good-med-vid', 'video', 'medium', 75],
      ['artist low|||title low', 'good-low-vid', 'video', 'low', 60],
      ['artist empty|||title empty', null, null, 'unmatched', 0],
      ['artist filtered|||title filtered', null, null, 'unmatched', 0],
    ];

    expect(readFileSync(cliLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual(expectedCalls);
    expect(readCkpt(cliCkpt).map((r) => [r.song_key, r.video_id, r.result_type, r.match_tier, r.confidence_score])).toEqual(expectedRecords);
    expect(JSON.parse(readFileSync(path.join(dir, 'discovery-status.json'), 'utf8'))).toMatchObject({
      phase: 'completed', searchMode: 'unified', tiers: { high: 1, medium: 1, low: 1, unmatched: 2 },
    });

    const pyCheck = `import importlib.util, json
from pathlib import Path
from ytmusicapi import YTMusic
spec = importlib.util.spec_from_file_location("discover", ${JSON.stringify(DISCOVER_SCRIPT)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
summary = mod.run_discovery(input_path=Path(${JSON.stringify(inputPath)}), checkpoint_path=Path(${JSON.stringify(pyCkpt)}), min_jitter=0.0, max_jitter=0.0, ytm=YTMusic())
print(json.dumps(summary))`;
    const pyRes = runPy(dir, pyLog, ['-c', pyCheck]);
    expect(pyRes.status, pyRes.stderr).toBe(0);
    expect(JSON.parse(pyRes.stdout.trim().split('\n').pop())).toMatchObject({
      totalInPass: 5, processed: 5, tiers: { high: 1, medium: 1, low: 1, unmatched: 2 },
    });
    expect(readFileSync(pyLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual(expectedCalls);
    expect(readCkpt(pyCkpt).map((r) => [r.song_key, r.video_id, r.result_type, r.match_tier, r.confidence_score])).toEqual(expectedRecords);
  });

  it('defers ytm_factory until initial cooldown ends, rotates on retry and batch cooldown, resets pacer, and rejects bogus search_mode', () => {
    const dir = makeTempDir('ttc-unified-factory-');
    const inputPath = path.join(dir, 'catalog.json');
    const ckptPath = path.join(dir, 'checkpoint.jsonl');
    const logPath = path.join(dir, 'unused.jsonl');
    writeRapidFuzzStub(dir);

    const catalog = Array.from({ length: 4 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return { song_key: `artist ${n}|||song ${n}`, artist: `Artist ${n}`, song_title: `Song ${n}`, album: `Album ${n}`, totalPlays: 2 };
    });
    writeFileSync(inputPath, JSON.stringify(catalog), 'utf8');

    const pyCheck = `
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("discover", ${JSON.stringify(DISCOVER_SCRIPT)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

events, snapshots, clients = [], {}, []
status_path = Path(${JSON.stringify(ckptPath)}).parent / "discovery-status.json"

class MockClient:
    def __init__(self, session_id):
        self.session_id = session_id
        self.failed_once = False
    def search(self, query, filter=None, limit=10):
        events.append(["search", self.session_id, query, filter, limit])
        if self.session_id == 1 and not self.failed_once:
            self.failed_once = True
            json.loads("")
        if self.session_id == 3 and "Artist 03" in query:
            snapshots["song3Active"] = json.loads(status_path.read_text(encoding="utf-8"))
        n = query.split()[1]
        return [{"videoId": f"vid-{n}", "title": f"Song {n}", "artists": [{"name": f"Artist {n}"}], "album": {"name": f"Album {n}"}, "resultType": "song", "duration_seconds": 200}]

def ytm_factory():
    sid = len(clients) + 1
    client = MockClient(sid)
    clients.append(client)
    events.append(["factory", sid])
    return client

def sleep_fn(sec):
    events.append(["sleep", sec])
    snap = json.loads(status_path.read_text(encoding="utf-8"))
    key = {20.0: "initialCooldown", 15.0: "retryBackoff", 45.0: "batchCooldown"}.get(sec)
    if key:
        snapshots[key] = {"factoryCalls": len(clients), "status": snap}

summary = mod.run_discovery(
    input_path=Path(${JSON.stringify(inputPath)}), checkpoint_path=Path(${JSON.stringify(ckptPath)}),
    pass_mode="all", batch_size=2, cooldown_min=45.0, cooldown_max=45.0, initial_cooldown=20.0,
    retry_delays=(15.0,), min_jitter=0.0, max_jitter=0.0, ytm_factory=ytm_factory, sleep_fn=sleep_fn,
)
bogus_run_err = bogus_song_err = None
try:
    mod.run_discovery(input_path=Path(${JSON.stringify(inputPath)}), checkpoint_path=Path(${JSON.stringify(ckptPath)}), search_mode="bogus")
except ValueError as exc:
    bogus_run_err = str(exc)
try:
    mod.discover_song({"song_key": "a|||b", "artist": "A", "song_title": "B"}, None, search_mode="bogus")
except ValueError as exc:
    bogus_song_err = str(exc)

print(json.dumps({
    "summary": summary, "events": events, "snapshots": snapshots,
    "finalStatus": json.loads(status_path.read_text(encoding="utf-8")),
    "bogusRunErr": bogus_run_err, "bogusSongErr": bogus_song_err,
}))
`;
    const res = runPy(dir, logPath, ['-c', pyCheck]);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());

    expect(out.summary).toMatchObject({ totalInPass: 4, processed: 4, tiers: { high: 4, medium: 0, low: 0, unmatched: 0 } });
    expect(out.events).toEqual([
      ['sleep', 20.0],
      ['factory', 1],
      ['search', 1, 'Artist 01 Song 01', null, 10],
      ['sleep', 15.0],
      ['factory', 2],
      ['search', 2, 'Artist 01 Song 01', null, 10],
      ['search', 2, 'Artist 02 Song 02', null, 10],
      ['sleep', 45.0],
      ['factory', 3],
      ['search', 3, 'Artist 03 Song 03', null, 10],
      ['search', 3, 'Artist 04 Song 04', null, 10],
    ]);
    expect(out.snapshots.initialCooldown.factoryCalls).toBe(0);
    expect(out.snapshots.initialCooldown.status).toMatchObject({ phase: 'initial_cooldown', searchMode: 'unified' });
    expect(out.snapshots.retryBackoff.factoryCalls).toBe(1);
    expect(out.snapshots.retryBackoff.status).toMatchObject({ phase: 'retry_backoff', paceMultiplier: 1.5, cleanStreak: 0 });
    expect(out.snapshots.retryBackoff.status.recentRetries[0].error).toContain('Expecting value: line 1 column 1 (char 0)');
    expect(out.snapshots.batchCooldown.factoryCalls).toBe(2);
    expect(out.snapshots.batchCooldown.status).toMatchObject({ phase: 'batch_cooldown', paceMultiplier: 1.5, cleanStreak: 2 });
    expect(out.snapshots.song3Active).toMatchObject({ phase: 'active_batch', paceMultiplier: 1.0, cleanStreak: 0, searchMode: 'unified' });
    expect(out.finalStatus).toMatchObject({
      phase: 'completed', searchMode: 'unified', paceMultiplier: 1.0, cleanStreak: 0, retryCount: 1, processedInRun: 4,
    });
    expect(out.bogusRunErr).toContain('bogus');
    expect(out.bogusSongErr).toContain('bogus');
  });
});
