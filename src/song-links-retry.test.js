// Unit and integration tests for Python fallback scorer upgrades and retry-unmatched-song-links.py runner.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RETRY_SCRIPT = path.join(ROOT, 'scripts', 'retry-unmatched-song-links.py');
const VENV_PY = path.join(ROOT, '.kennel-hub', 'session', '20261113-03-youtube-playlist-generator', '.venv', 'bin', 'python');
const PYTHON_BIN = existsSync(VENV_PY) ? VENV_PY : 'python3';
const HAS_RAPIDFUZZ = spawnSync(PYTHON_BIN, ['-c', 'import rapidfuzz']).status === 0;
const tempDirs = [];

function makeTempDir(prefix = 'ttc-retry-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const runPy = (dir, logPath, args, extraEnv = {}) =>
  spawnSync(PYTHON_BIN, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: dir, FAKE_YTM_LOG: logPath, ...extraEnv } });

const readJsonl = (file) =>
  readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') || l.startsWith('[')).map((l) => JSON.parse(l));

function writeStubDeps(dir, stubYtmSource) {
  writeFileSync(path.join(dir, 'ytmusicapi.py'), stubYtmSource, 'utf8');
  if (!HAS_RAPIDFUZZ) {
    writeFileSync(
      path.join(dir, 'rapidfuzz.py'),
      `from difflib import SequenceMatcher
def _r(a, b): return SequenceMatcher(None, a or "", b or "").ratio() * 100.0
def _ts(a, b): return _r(" ".join(sorted((a or "").split())), " ".join(sorted((b or "").split())))
def _tset(a, b):
    t1, t2 = set((a or "").split()), set((b or "").split())
    inter = sorted(t1 & t2)
    c1, c2 = " ".join(inter + sorted(t1 - t2)), " ".join(inter + sorted(t2 - t1))
    return max(_r(" ".join(inter), c1), _r(" ".join(inter), c2), _r(c1, c2)) if inter else _r(c1, c2)
class fuzz:
    ratio, token_sort_ratio, token_set_ratio = staticmethod(_r), staticmethod(_ts), staticmethod(_tset)
`,
      'utf8',
    );
  }
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('Stage 2 multi-pass scorer and unmatched retry runner', () => {
  it('upgrades score_candidate for delimiter splits, quoted titles, and multi-artist lists, plus build_fallback_queries', () => {
    const dir = makeTempDir('ttc-scorer-');
    writeStubDeps(dir, 'class YTMusic:\n    pass\n');
    const pyCheck = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
from song_links_scorer import build_fallback_queries, extract_primary_artist, normalize_text, score_candidate

colin = score_candidate(
    {"artist": "Colin Linden & Luther Dickinson", "song_title": "Lover Please (w/ Billy Swan)"},
    {"videoId": "v-colin", "title": "Colin Linden & Luther Dickinson with The Tennessee Valentines - Lover Please (ft. Billy Swan)", "artists": [{"name": "Folk Roots and Blues"}], "resultType": "video", "duration_seconds": 195},
)
kim = score_candidate(
    {"artist": "Kim Richardson", "song_title": "The Boat Song"},
    {"videoId": "v-kim", "title": 'Kim Richardson performing "The Boat Song (You & Me)"', "artists": [{"name": "tmcdonell9"}], "resultType": "video", "duration_seconds": 210},
)
buddy = score_candidate(
    {"artist": "Buddy Miller & Jim Lauderdale", "song_title": "I Want To Do Everything For You"},
    {"videoId": "v-buddy", "title": "I Want to Do Everything for You", "artists": [{"name": "Buddy Miller"}, {"name": "Jim Lauderdale"}], "resultType": "song", "duration_seconds": 190},
)
bad_artist = score_candidate(
    {"artist": "Shawn Colvin", "song_title": "All He Wants Is You"},
    {"videoId": "v-bad", "title": "All He Wants Is You", "artists": [{"name": "Minor Wilson"}], "resultType": "video", "duration_seconds": 200},
)
bad_title = score_candidate(
    {"artist": "Kim Richardson", "song_title": "The Boat Song"},
    {"videoId": "v-wrong", "title": "Roll The Stone Away", "artists": [{"name": "Kim Richardson"}], "resultType": "song", "duration_seconds": 200},
)
fp_larry = score_candidate(
    {"artist": "Larry Raspberry & The High Steppers", "song_title": "Love The Life"},
    {"videoId": "v-fp1", "title": "I Love You", "artists": [{"name": "Larry Long"}, {"name": "Yohannes Tona"}], "resultType": "song", "duration_seconds": 200},
)
fp_terry = score_candidate(
    {"artist": "Terry Radigan", "song_title": "My Love Is Real"},
    {"videoId": "v-fp2", "title": "My Love Is Your Love", "artists": [{"name": "Terry Linen"}], "resultType": "song", "duration_seconds": 200},
)
fp_shawn = score_candidate(
    {"artist": "Shawn Colvin", "song_title": "All He Wants Is You"},
    {"videoId": "v-fp3", "title": "20250829 Lori Spencer & Dawn Coleman - All He Wants Is You - Shawn Colvin", "artists": [{"name": "Larry Dunlap"}], "resultType": "video", "duration_seconds": 185},
)
tp_al = score_candidate(
    {"artist": "Al Anderson", "song_title": "It Came From The South"},
    {"videoId": "v-tp1", "title": "IT CAME FROM THE SOUTH - AL ANDERSON & THE JOINED AT THE HIP BAND", "artists": [{"name": "lazy poker"}], "resultType": "video", "duration_seconds": 210},
)
tp_jen = score_candidate(
    {"artist": "Jen Mize", "song_title": "Cuervo"},
    {"videoId": "v-tp2", "title": "Cuervo - Jen Mize and Mark Sholtez - Django Marrickville - 17-3-19", "artists": [{"name": "TheAussiemusicman"}], "resultType": "video", "duration_seconds": 220},
)
tp_road = score_candidate(
    {"artist": "Larry Raspberry & The High Steppers", "song_title": "Road Blues"},
    {"videoId": "v-tp3", "title": "Larry Raspberry & The Highsteppers - Road Blues (Audio)", "artists": [{"name": "DeaconBlues61"}], "resultType": "video", "duration_seconds": 195},
)
print(json.dumps({
    "normW": normalize_text("Track Name w/ Guest"),
    "lead": extract_primary_artist("Colin Linden & Luther Dickinson"),
    "colin": colin, "kim": kim, "buddy": buddy, "badArtist": bad_artist, "badTitle": bad_title,
    "fpLarry": fp_larry, "fpTerry": fp_terry, "fpShawn": fp_shawn,
    "tpAl": tp_al, "tpJen": tp_jen, "tpRoad": tp_road,
    "qParen": build_fallback_queries({"artist": "Chip Taylor", "song_title": "The Way Of It (w/ John Prine)"}),
    "qLeadParen": build_fallback_queries({"artist": "Peter Mulvey", "song_title": "(I Don't Know Why) But I Do"}),
    "qCollab": build_fallback_queries({"artist": "Colin Linden & Luther Dickinson", "song_title": "Lover Please (w/ Billy Swan)"}),
    "qClause": build_fallback_queries({"artist": "Margo Cilker", "song_title": "First Part, Second Part"}),
}))`;
    const res = runPy(dir, path.join(dir, 'unused.log'), ['-c', pyCheck]);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout.trim().split('\n').at(-1));

    expect(out.normW).toBe('track name');
    expect(out.lead).toBe('Colin Linden');
    expect(out.colin.score).toBeGreaterThanOrEqual(65);
    expect(out.kim.score).toBeGreaterThanOrEqual(65);
    expect(out.buddy.score).toBeGreaterThanOrEqual(85);
    expect(out.tpAl.score).toBeGreaterThanOrEqual(65);
    expect(out.tpJen.score).toBeGreaterThanOrEqual(65);
    expect(out.tpRoad.score).toBeGreaterThanOrEqual(65);
    expect(out.badArtist.score).toBe(0);
    expect(out.badTitle.score).toBe(0);
    expect(out.fpLarry.score).toBe(0);
    expect(out.fpTerry.score).toBeLessThan(65);
    expect(out.fpShawn.score).toBe(0);

    expect(out.qParen.map((x) => x[0])).toEqual(['stripped_unified', 'songs_filter', 'videos_filter', 'partial_title']);
    expect(out.qParen[0]).toEqual(['stripped_unified', 'Chip Taylor The Way Of It', null]);
    expect(out.qLeadParen[0]).toEqual(['unwrapped_unified', "Peter Mulvey I Don't Know Why But I Do", null]);
    expect(out.qCollab.at(-1)).toEqual(['primary_artist', 'Colin Linden Lover Please', null]);
    expect(out.qClause.at(-1)).toEqual(['partial_title', 'Margo Cilker Second Part', null]);
  });

  it('retries only unmatched rows sorted by plays DESC, short-circuits, resumes cleanly, and guards retries', () => {
    const dir = makeTempDir('ttc-runner-');
    const verifiedPath = path.join(dir, 'verified.jsonl');
    const inputPath = path.join(dir, 'catalog-input.json');
    const ckptPath = path.join(dir, 'retry-ckpt.jsonl');
    const logPath = path.join(dir, 'calls.jsonl');

    writeStubDeps(dir, `import json, os
class YTMusic:
    def search(self, query, filter=None, limit=10):
        with open(os.environ["FAKE_YTM_LOG"], "a", encoding="utf-8") as fh:
            fh.write(json.dumps([query, filter]) + "\\n")
        if os.environ.get("FAKE_429") == "1":
            raise RuntimeError("HTTP 429 Too Many Requests")
        if query == "High Play Song Title" and filter is None:
            return [{"videoId": "vid-hi", "title": "Song Title", "artists": [{"name": "High Play"}], "resultType": "song", "duration_seconds": 200}]
        if query == "Mid Play Tune Name" and filter == "songs":
            return [{"videoId": "vid-mid", "title": "Tune Name", "artists": [{"name": "Mid Play"}], "resultType": "video", "duration_seconds": 195}]
        if query == '"Solo Act" Deep Cut' and filter == "videos":
            return [{"videoId": "vid-solo", "title": "Deep Cut", "artists": [{"name": "Solo Act"}], "resultType": "video", "duration_seconds": 180}]
        if query == "Low Only Slow Cut" and filter == "songs":
            return [{"videoId": "vid-low", "title": "Slow Cut (Live)", "artists": [{"name": "Low Only"}], "resultType": "video", "duration_seconds": 180}]
        return []
`);

    const verifiedLines = [
      { song_key: 'already ok|||done', artist: 'Already Ok', song_title: 'Done', video_id: 'v-ok', match_tier: 'high', totalPlays: 50 },
      { song_key: 'updated ok|||recheck', artist: 'Updated Ok', song_title: 'Recheck', video_id: null, match_tier: 'unmatched', totalPlays: 20 },
      { song_key: 'updated ok|||recheck', artist: 'Updated Ok', song_title: 'Recheck', video_id: 'v-fixed', match_tier: 'medium', totalPlays: 20 },
      { song_key: 'high play|||song title (w/ guest)', artist: 'High Play', song_title: 'Song Title (w/ Guest)', video_id: null, match_tier: 'unmatched', totalPlays: 1 },
      { song_key: 'mid play|||tune name', artist: 'Mid Play', song_title: 'Tune Name', video_id: null, match_tier: 'unmatched', totalPlays: 3 },
      { song_key: 'solo act|||deep cut', artist: 'Solo Act', song_title: 'Deep Cut', video_id: null, match_tier: 'unmatched', totalPlays: 1 },
      { song_key: 'low only|||slow cut', artist: 'Low Only', song_title: 'Slow Cut', video_id: null, match_tier: 'unmatched', totalPlays: 1 },
    ];
    writeFileSync(verifiedPath, verifiedLines.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    writeFileSync(inputPath, JSON.stringify([
      { song_key: 'high play|||song title (w/ guest)', artist: 'High Play', song_title: 'Song Title (w/ Guest)', album: 'A1', totalPlays: 9 },
      { song_key: 'mid play|||tune name', artist: 'Mid Play', song_title: 'Tune Name', album: 'A2', totalPlays: 4 },
      { song_key: 'solo act|||deep cut', artist: 'Solo Act', song_title: 'Deep Cut', album: 'A3', totalPlays: 1 },
      { song_key: 'low only|||slow cut', artist: 'Low Only', song_title: 'Slow Cut', album: 'A4', totalPlays: 1 },
    ]), 'utf8');

    const baseArgs = [
      RETRY_SCRIPT, '--verified', verifiedPath, '--input', inputPath, '--checkpoint', ckptPath,
      '--min-jitter=0', '--max-jitter=0', '--batch-size=0', '--cooldown-min=0', '--cooldown-max=0', '--retry-delays=0,0',
    ];
    const pass1 = runPy(dir, logPath, [...baseArgs, '--pass=multi']);
    expect(pass1.status, pass1.stderr).toBe(0);
    const pass2 = runPy(dir, logPath, [...baseArgs, '--pass=all']);
    expect(pass2.status, pass2.stderr).toBe(0);

    const calls = readJsonl(logPath);
    expect(calls).toEqual([
      ['High Play Song Title', null],
      ['Mid Play Tune Name', 'songs'],
      ['Low Only Slow Cut', 'songs'],
      ['"Low Only" Slow Cut', 'videos'],
      ['Solo Act Deep Cut', 'songs'],
      ['"Solo Act" Deep Cut', 'videos'],
    ]);
    expect(readJsonl(ckptPath).map((r) => [r.song_key, r.video_id, r.match_tier, r.matched_via])).toEqual([
      ['high play|||song title (w/ guest)', 'vid-hi', 'high', 'stripped_unified'],
      ['mid play|||tune name', 'vid-mid', 'medium', 'songs_filter'],
      ['low only|||slow cut', null, 'unmatched', null],
      ['solo act|||deep cut', 'vid-solo', 'medium', 'videos_filter'],
    ]);

    const failCkpt = path.join(dir, 'fail-ckpt.jsonl');
    const failRes = runPy(dir, logPath, [
      RETRY_SCRIPT, '--verified', verifiedPath, '--input', inputPath, '--checkpoint', failCkpt,
      '--min-jitter=0', '--max-jitter=0', '--retry-delays=0,0', '--max-run-retries=2',
    ], { FAKE_429: '1' });
    expect(failRes.status).toBe(1);
    expect(readJsonl(failCkpt)).toEqual([]);
  });
});
