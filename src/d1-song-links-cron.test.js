// SQLite-D1 integration tests for incremental YouTube song_links discovery, rotating health recheck, caps, and failure handling.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getD1RandomPlaylist, upsertSongLink } from '../server/d1Playlist.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import {
  SELECT_UNRESOLVED_PLAYS_SQL, SELECT_UNRESOLVED_ROLLUPS_SQL,
  runIncrementalSongLinksCron, selectRecheckRows, selectUnresolvedSongs,
} from '../server/d1SongLinksCron.js';

function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const wrap = (sql, bound = []) => ({
    _sql: sql,
    bind: (...args) => wrap(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...bound) }),
    first: async () => sqlite.prepare(sql).get(...bound) ?? null,
    run: async () => { sqlite.prepare(sql).run(...bound); return { success: true }; },
  });
  return {
    sqlite,
    prepare: (sql) => wrap(sql),
    async batch(stmts) {
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) results.push(/^\s*SELECT\b/i.test(s._sql) ? await s.all() : await s.run());
        sqlite.exec('COMMIT');
      } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
      return results;
    },
  };
}

async function recordSql(db, fn) {
  const orig = db.prepare.bind(db);
  const queries = [];
  db.prepare = (sql) => { queries.push(sql); return orig(sql); };
  try { return { result: await fn(), queries }; } finally { db.prepare = orig; }
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ytItem = (id, { embeddable = true, blocked = null, allowed = null, duration = 'PT3M42S', privacy = 'public', upload = 'processed' } = {}) => ({
  id,
  status: { privacyStatus: privacy, uploadStatus: upload, embeddable },
  contentDetails: {
    duration,
    ...(blocked || allowed ? { regionRestriction: { ...(blocked ? { blocked } : {}), ...(allowed ? { allowed } : {}) } } : {}),
  },
});

async function seedCatalogSongs(db, count, { withRollups = true } = {}) {
  const episodes = [];
  for (let i = 1; i <= count; i += 1) {
    const plays = count - i + 1;
    for (let p = 1; p <= plays; p += 1) {
      const idx = episodes.length + 1;
      episodes.push({
        id: `ep-${idx}`,
        airDate: `2026-10-${String(((idx - 1) % 28) + 1).padStart(2, '0')}`,
        title: `Through the Cracks #${idx}`,
        songs: [{ position: 1, artist: `Artist ${String(i).padStart(3, '0')}`, songTitle: `Song ${String(i).padStart(3, '0')}`, album: 'Album' }],
      });
    }
  }
  await upsertEpisodesIntoD1(db, episodes, { batchSize: 500 });
  if (!withRollups) db.sqlite.exec('DELETE FROM song_rollups');
}

describe('d1SongLinksCron incremental resolver and health recheck', () => {
  const dbs = [];
  const trackDb = async () => {
    const db = createSqliteD1();
    dbs.push(db);
    await ensureD1Schema(db);
    return db;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    while (dbs.length) dbs.pop().sqlite.close();
  });

  it('no-ops with 0 fetches when YOUTUBE_API_KEY is missing or blank', async () => {
    const db = await trackDb();
    await seedCatalogSongs(db, 2);
    const fetchMock = vi.fn();

    for (const apiKey of [undefined, '', '   ']) {
      expect(await runIncrementalSongLinksCron({ db, apiKey, fetchImpl: fetchMock })).toEqual({
        skipped: 'missing_youtube_api_key',
        resolvedCount: 0,
        unmatchedCount: 0,
        recheckedCount: 0,
        playabilityChangedCount: 0,
        externalFetches: 0,
        quotaUnits: 0,
        stoppedEarlyReason: null,
        changesMade: false,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses song_rollups fast-path when populated and falls back to grouped song_plays only when empty', async () => {
    const db = await trackDb();
    await seedCatalogSongs(db, 30, { withRollups: true });

    const fast = await recordSql(db, () => selectUnresolvedSongs(db, 25));
    expect(fast.result).toHaveLength(25);
    expect(fast.result[0]).toMatchObject({ song_key: 'artist 001|||song 001', total_plays: 30 });
    expect(fast.result[24]).toMatchObject({ song_key: 'artist 025|||song 025', total_plays: 6 });
    expect(fast.queries).toContain(SELECT_UNRESOLVED_ROLLUPS_SQL);
    expect(fast.queries).not.toContain(SELECT_UNRESOLVED_PLAYS_SQL);

    db.sqlite.exec('DELETE FROM song_rollups');
    const fallback = await recordSql(db, () => selectUnresolvedSongs(db, 25));
    expect(fallback.result).toHaveLength(25);
    expect(fallback.result[0]).toMatchObject({ song_key: 'artist 001|||song 001', total_plays: 30 });
    expect(fallback.queries).toContain(SELECT_UNRESOLVED_PLAYS_SQL);
  });

  it('verifies new candidates in 1 batched videos.list call and preserves match_tier="manual" rows', async () => {
    const db = await trackDb();
    await seedCatalogSongs(db, 4);
    await upsertSongLink(db, {
      song_key: 'artist 001|||song 001', artist: 'Artist 001', song_title: 'Song 001',
      video_id: 'manual-keep', yt_title: 'Manual Pick', yt_artist: 'Artist 001',
      confidence_score: 100, match_tier: 'manual', is_embeddable: 1, us_playable: 1,
      status_reason: 'ok', checked_at: '2026-11-14T00:00:00.000Z',
    });

    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      const u = new URL(url);
      calls.push(u);
      if (u.pathname.endsWith('/search')) {
        const idx = u.searchParams.get('q').match(/(\d{3})/)?.[1] || '000';
        return jsonRes({
          items: [{
            id: { videoId: `vid-${idx}` },
            snippet: { title: `Song ${idx}`, channelTitle: idx === '002' ? `Artist ${idx} - Topic` : `Artist ${idx}` },
          }],
        });
      }
      return jsonRes({
        items: u.searchParams.get('id').split(',').map((id) => ytItem(id, { embeddable: id !== 'vid-004' })),
      });
    });

    const res = await runIncrementalSongLinksCron({ db, apiKey: 'yt-key', fetchImpl, now: () => '2026-11-14T06:00:00.000Z' });
    expect(res).toMatchObject({ resolvedCount: 3, unmatchedCount: 0, externalFetches: 5, quotaUnits: 302, changesMade: true });

    const searchCalls = calls.filter((u) => u.pathname.endsWith('/search'));
    const videoCalls = calls.filter((u) => u.pathname.endsWith('/videos'));
    expect(searchCalls).toHaveLength(3);
    expect(searchCalls.map((u) => u.searchParams.get('q'))).not.toContain('Artist 001 Song 001');
    expect(searchCalls[0].searchParams.get('videoEmbeddable')).toBe('true');
    expect(searchCalls[0].searchParams.get('maxResults')).toBe('5');
    expect(videoCalls[0].searchParams.get('id').split(',')).toEqual(['vid-002', 'vid-003', 'vid-004']);

    await upsertSongLink(db, {
      song_key: 'artist 001|||song 001', artist: 'Artist 001', song_title: 'Song 001',
      video_id: 'auto-overwrite', confidence_score: 72, match_tier: 'medium', is_embeddable: 1, us_playable: 1, status_reason: 'ok',
    });
    const rows = db.sqlite.prepare('SELECT song_key, video_id, result_type, match_tier, confidence_score, duration_seconds, is_embeddable, status_reason FROM song_links ORDER BY song_key').all();
    expect(rows.find((r) => r.song_key === 'artist 001|||song 001')).toMatchObject({ video_id: 'manual-keep', match_tier: 'manual', confidence_score: 100 });
    expect(rows.find((r) => r.song_key === 'artist 002|||song 002')).toMatchObject({ video_id: 'vid-002', result_type: 'song', match_tier: 'high', duration_seconds: 222, is_embeddable: 1 });
    expect(rows.find((r) => r.song_key === 'artist 003|||song 003')?.result_type).toBe('video');
    expect(rows.find((r) => r.song_key === 'artist 004|||song 004')).toMatchObject({ is_embeddable: 0, status_reason: 'not_embeddable' });
  });

  it('rechecks oldest rows (checked_at ASC), sets changesMade=false when playability unchanged, and drops removed/US-blocked links from pool', async () => {
    const db = await trackDb();
    await seedCatalogSongs(db, 3);
    const seed = [
      { song_key: 'artist 001|||song 001', artist: 'Artist 001', song_title: 'Song 001', video_id: 'man-1', confidence_score: 100, match_tier: 'manual', checked_at: '2026-11-01T00:00:00.000Z' },
      { song_key: 'artist 002|||song 002', artist: 'Artist 002', song_title: 'Song 002', video_id: 'auto-2', confidence_score: 90, match_tier: 'high', checked_at: '2026-11-02T00:00:00.000Z' },
      { song_key: 'artist 003|||song 003', artist: 'Artist 003', song_title: 'Song 003', video_id: 'auto-3', confidence_score: 90, match_tier: 'high', checked_at: '2026-11-03T00:00:00.000Z' },
    ];
    for (const row of seed) await upsertSongLink(db, { ...row, is_embeddable: 1, us_playable: 1, status_reason: 'ok' });

    const unchangedRes = await runIncrementalSongLinksCron({
      db, apiKey: 'yt-key',
      fetchImpl: vi.fn(async () => jsonRes({ items: [ytItem('man-1'), ytItem('auto-2'), ytItem('auto-3')] })),
      now: () => '2026-11-10T06:00:00.000Z',
    });
    expect(unchangedRes).toMatchObject({ recheckedCount: 3, playabilityChangedCount: 0, changesMade: false, externalFetches: 1, quotaUnits: 1 });
    expect(db.sqlite.prepare("SELECT checked_at FROM song_links WHERE song_key = 'artist 001|||song 001'").get().checked_at)
      .toBe('2026-11-10T06:00:00.000Z');

    const degradeRes = await runIncrementalSongLinksCron({
      db, apiKey: 'yt-key',
      fetchImpl: vi.fn(async () => jsonRes({ items: [ytItem('auto-2', { blocked: ['US'] }), ytItem('auto-3')] })),
      now: () => '2026-11-14T06:00:00.000Z',
    });
    expect(degradeRes).toMatchObject({ recheckedCount: 3, playabilityChangedCount: 2, changesMade: true });
    expect(db.sqlite.prepare("SELECT video_id, confidence_score, match_tier, is_embeddable, us_playable, status_reason FROM song_links WHERE song_key = 'artist 001|||song 001'").get())
      .toEqual({ video_id: 'man-1', confidence_score: 100, match_tier: 'manual', is_embeddable: 0, us_playable: 0, status_reason: 'video_missing' });
    expect((await getD1RandomPlaylist(db, { count: 10 })).songs.map((s) => s.videoId)).toEqual(['auto-3']);
  });

  it('enforces exact 25/1/5 caps (31 YouTube fetches, 2506 quota units) and reserves 1 fetch under maxExternalFetches', async () => {
    const db = await trackDb();
    await seedCatalogSongs(db, 30);
    for (let i = 31; i <= 300; i += 1) {
      await upsertSongLink(db, {
        song_key: `linked artist ${i}|||linked song ${i}`, artist: `Linked Artist ${i}`, song_title: `Linked Song ${i}`,
        video_id: `rec-${String(i).padStart(3, '0')}`, confidence_score: 90, match_tier: 'high',
        is_embeddable: 1, us_playable: 1, status_reason: 'ok',
        checked_at: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      });
    }

    const oldest = await selectRecheckRows(db, 250);
    expect(oldest).toHaveLength(250);
    expect([oldest[0].video_id, oldest[249].video_id]).toEqual(['rec-031', 'rec-280']);

    const ytUrls = [];
    const cronRes = await runIncrementalSongLinksCron({
      db, apiKey: 'yt-key',
      fetchImpl: vi.fn(async (url) => {
        ytUrls.push(url);
        const u = new URL(url);
        if (u.pathname.endsWith('/search')) {
          const m = u.searchParams.get('q').match(/(\d{3})/)?.[1] || '001';
          return jsonRes({ items: [{ id: { videoId: `new-${m}` }, snippet: { title: `Song ${m}`, channelTitle: `Artist ${m} - Topic` } }] });
        }
        return jsonRes({ items: u.searchParams.get('id').split(',').map((id) => ytItem(id)) });
      }),
    });

    const searches = ytUrls.filter((u) => u.includes('/search?'));
    const videos = ytUrls.filter((u) => u.includes('/videos?'));
    expect(searches).toHaveLength(25);
    expect(videos).toHaveLength(6);
    expect(new URL(videos[0]).searchParams.get('id').split(',')).toHaveLength(25);
    for (let i = 1; i <= 5; i += 1) expect(new URL(videos[i]).searchParams.get('id').split(',')).toHaveLength(50);
    expect(cronRes).toMatchObject({ resolvedCount: 25, recheckedCount: 250, externalFetches: 31, quotaUnits: 2506 });

    const cappedDb = await trackDb();
    await seedCatalogSongs(cappedDb, 6);
    await upsertSongLink(cappedDb, {
      song_key: 'artist 006|||song 006', artist: 'Artist 006', song_title: 'Song 006',
      video_id: 'old-6', confidence_score: 90, match_tier: 'high', is_embeddable: 1, us_playable: 1,
      status_reason: 'ok', checked_at: '2026-01-01T00:00:00.000Z',
    });
    let seq = 0;
    const capped = await runIncrementalSongLinksCron({
      db: cappedDb, apiKey: 'yt-key', maxExternalFetches: 4,
      fetchImpl: vi.fn(async (url) => {
        seq += 1;
        if (url.includes('/search?')) {
          return jsonRes({ items: [{ id: { videoId: `c-${seq}` }, snippet: { title: `Song 00${seq}`, channelTitle: `Artist 00${seq} - Topic` } }] });
        }
        return jsonRes({ items: new URL(url).searchParams.get('id').split(',').map((id) => ytItem(id)) });
      }),
    });
    expect(capped).toMatchObject({ resolvedCount: 3, recheckedCount: 0, externalFetches: 4, stoppedEarlyReason: 'max_external_fetches' });
  });

  it('stops early on transient 403/429/5xx/quotaExceeded without false unmatched rows while persisting 200 empty searches', async () => {
    for (const [status, body, expectedReason] of [
      [429, { error: { message: 'Rate limited' } }, 'http_429'],
      [403, { error: { errors: [{ reason: 'quotaExceeded' }], message: 'Quota' } }, 'quota_exceeded'],
      [403, { error: { errors: [{ reason: 'forbidden' }], message: 'Forbidden' } }, 'http_403'],
      [503, { error: { message: 'Unavailable' } }, 'http_503'],
    ]) {
      const db = await trackDb();
      await seedCatalogSongs(db, 3);
      let callNum = 0;
      const res = await runIncrementalSongLinksCron({
        db, apiKey: 'yt-key',
        fetchImpl: vi.fn(async () => (++callNum === 1 ? jsonRes({ items: [] }) : jsonRes(body, status))),
      });
      expect(res).toMatchObject({
        resolvedCount: 0, unmatchedCount: 1, externalFetches: 2, stoppedEarlyReason: expectedReason, changesMade: true,
      });
      expect(db.sqlite.prepare('SELECT song_key, match_tier, status_reason FROM song_links').all())
        .toEqual([{ song_key: 'artist 001|||song 001', match_tier: 'unmatched', status_reason: 'no_search_results' }]);
    }

    const db2 = await trackDb();
    await seedCatalogSongs(db2, 2);
    let idx = 0;
    const vidFail = await runIncrementalSongLinksCron({
      db: db2, apiKey: 'yt-key',
      fetchImpl: vi.fn(async (url) => {
        idx += 1;
        if (url.includes('/search?')) {
          return jsonRes({ items: [{ id: { videoId: `v-${idx}` }, snippet: { title: `Song 00${idx}`, channelTitle: `Artist 00${idx} - Topic` } }] });
        }
        return jsonRes({ error: { message: 'Server error' } }, 500);
      }),
    });
    expect(vidFail).toMatchObject({ resolvedCount: 0, unmatchedCount: 0, stoppedEarlyReason: 'http_500', changesMade: false });
    expect(db2.sqlite.prepare('SELECT COUNT(1) AS c FROM song_links').get().c).toBe(0);
  });

  it('runs Pass 1 raw queries first then Pass 2 stripped/fallback queries across the four 11/18 tracks', async () => {
    const db = await trackDb();
    await upsertEpisodesIntoD1(db, [{
      id: 'ep-1118', airDate: '2026-11-18', title: "Playlist for WEVL's Through The Cracks, Wednesday 11/18/2026",
      songs: [
        { position: 4, artist: 'Star & Micey', songTitle: "Can't Keep Running Back (w/ Kait Lawson)", album: 'A' },
        { position: 6, artist: 'Circle Birds', songTitle: 'Evolution', album: 'B' },
        { position: 22, artist: 'Margo Cilker', songTitle: 'Mayhill Peaches, Goodnoe Pairs', album: 'C' },
        { position: 26, artist: 'Cory Branan', songTitle: 'Stepping Outside (w/ Tyler Childers)', album: 'D' },
      ],
    }]);

    const queries = [];
    let verifyBatch = [];
    const responses = new Map([
      ["Star & Micey Can't Keep Running Back (w/ Kait Lawson)", [{ id: { videoId: 'bad-1' }, snippet: { title: 'Unrelated Clip', channelTitle: 'Other' } }]],
      ['Circle Birds Evolution', [{ id: { videoId: 'bad-2' }, snippet: { title: 'Angry Bird Drawing', channelTitle: 'Kids' } }]],
      ['Margo Cilker Mayhill Peaches, Goodnoe Pairs', []],
      ['Cory Branan Stepping Outside (w/ Tyler Childers)', [{ id: { videoId: 'bad-3' }, snippet: { title: 'Sour Mash', channelTitle: 'Fan' } }]],
      ["Star & Micey Can't Keep Running Back", [{ id: { videoId: 'ys4-3tVluoA' }, snippet: { title: "Can't Keep Running Back", channelTitle: 'Star & Micey - Topic' } }]],
      ['"Circle Birds" Evolution', [{ id: { videoId: '3-7PvLC-asg' }, snippet: { title: 'Evolution', channelTitle: 'Circle Birds - Topic' } }]],
      ['Margo Cilker Goodnoe Pairs', [{ id: { videoId: 'margo-id' }, snippet: { title: 'Maryhill Peaches, Goodnoe Pairs', channelTitle: 'Margo Cilker - Topic' } }]],
      ['Cory Branan Stepping Outside', [{ id: { videoId: 'pQ5F4eLzHpo' }, snippet: { title: 'Cory Branan - "Steppin\' Outside" (Official Audio)', channelTitle: 'cory branan' } }]],
    ]);

    const res = await runIncrementalSongLinksCron({
      db, apiKey: 'yt-key', maxRecheck: 0,
      fetchImpl: vi.fn(async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/search')) {
          const q = u.searchParams.get('q');
          queries.push(q);
          return jsonRes({ items: responses.get(q) || [] });
        }
        verifyBatch = u.searchParams.get('id').split(',');
        return jsonRes({ items: verifyBatch.map((id) => ytItem(id)) });
      }),
    });

    expect(queries.slice(0, 4)).toEqual([
      "Star & Micey Can't Keep Running Back (w/ Kait Lawson)",
      'Circle Birds Evolution',
      'Margo Cilker Mayhill Peaches, Goodnoe Pairs',
      'Cory Branan Stepping Outside (w/ Tyler Childers)',
    ]);
    expect(queries.slice(4)).toEqual([
      "Star & Micey Can't Keep Running Back",
      '"Circle Birds" Evolution',
      'Margo Cilker Goodnoe Pairs',
      'Cory Branan Stepping Outside',
    ]);
    expect(verifyBatch).toEqual(['ys4-3tVluoA', '3-7PvLC-asg', 'margo-id', 'pQ5F4eLzHpo']);
    expect(res).toMatchObject({ resolvedCount: 4, unmatchedCount: 0, externalFetches: 9, quotaUnits: 801, changesMade: true });
    const rows = db.sqlite.prepare('SELECT video_id, match_tier, is_embeddable FROM song_links ORDER BY song_key').all();
    expect(rows.every((r) => r.match_tier === 'high' && r.is_embeddable === 1)).toBe(true);
  });

  it('respects maxExternalFetches in Pass 2 without dropping Pass 1 hits and skips false unmatched on Pass 2 errors', async () => {
    const budgetDb = await trackDb();
    await upsertEpisodesIntoD1(budgetDb, [{
      id: 'ep-b', airDate: '2026-11-18', title: 'Show B',
      songs: [
        { position: 1, artist: 'Alpha', songTitle: 'Clean Song', album: 'A' },
        { position: 2, artist: 'Beta', songTitle: 'Miss One (w/ Guest)', album: 'B' },
        { position: 3, artist: 'Gamma', songTitle: 'Miss Two (w/ Guest)', album: 'C' },
      ],
    }]);
    const budgetRes = await runIncrementalSongLinksCron({
      db: budgetDb, apiKey: 'yt-key', maxExternalFetches: 5, maxRecheck: 0,
      fetchImpl: vi.fn(async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/search')) {
          const q = u.searchParams.get('q');
          if (q === 'Alpha Clean Song') return jsonRes({ items: [{ id: { videoId: 'v-a' }, snippet: { title: 'Clean Song', channelTitle: 'Alpha - Topic' } }] });
          if (q === 'Beta Miss One') return jsonRes({ items: [{ id: { videoId: 'v-b' }, snippet: { title: 'Miss One', channelTitle: 'Beta - Topic' } }] });
          return jsonRes({ items: [] });
        }
        return jsonRes({ items: u.searchParams.get('id').split(',').map((id) => ytItem(id)) });
      }),
    });
    expect(budgetRes).toMatchObject({ resolvedCount: 2, unmatchedCount: 0, externalFetches: 5, stoppedEarlyReason: 'max_external_fetches' });
    expect(budgetDb.sqlite.prepare("SELECT song_key FROM song_links ORDER BY song_key").all().map((r) => r.song_key))
      .toEqual(['alpha|||clean song', 'beta|||miss one (w/ guest)']);

    const errDb = await trackDb();
    await upsertEpisodesIntoD1(errDb, [{
      id: 'ep-e', airDate: '2026-11-18', title: 'Show E',
      songs: [{ position: 1, artist: 'Beta', songTitle: 'Long Broken Title Without Hit', album: 'A' }],
    }]);
    let callIdx = 0;
    const errRes = await runIncrementalSongLinksCron({
      db: errDb, apiKey: 'yt-key', maxRecheck: 0,
      fetchImpl: vi.fn(async () => (++callIdx === 1 ? jsonRes({ items: [] }) : jsonRes({ error: { message: 'Rate limited' } }, 429))),
    });
    expect(errRes).toMatchObject({ resolvedCount: 0, unmatchedCount: 0, externalFetches: 2, stoppedEarlyReason: 'http_429', changesMade: false });
    expect(errDb.sqlite.prepare('SELECT COUNT(1) AS c FROM song_links').get().c).toBe(0);
  });
});
