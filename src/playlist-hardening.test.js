// Regression unit and D1 integration tests for videoId allowlist, secret redaction, seed NUL stripping, and Unicode rollups.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildArchiveSeedSql } from '../scripts/seed-d1.js';
import { fetchVideosMetadataBatch, sanitizeErrorMessage } from '../scripts/verify-and-export-song-links.js';
import { getD1RandomPlaylist, loadD1PlaylistPool, upsertSongLink } from '../server/d1Playlist.js';
import { clearD1Cache } from '../server/d1Rollups.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';
import { runIncrementalSongLinksCron, selectUnresolvedSongs } from '../server/d1SongLinksCron.js';
import {
  buildSongKey,
  drawRandomPlaylist,
  isValidVideoId,
  toPlaylistSongItem,
} from '../server/playlistBuilder.js';
import {
  buildYouTubeQueueUrl,
  isValidVideoId as isClientValidVideoId,
} from './utils/playlist-helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('videoId allowlist hardening', () => {
  it('accepts only strict 1..64 char YouTube IDs in server and client validators', () => {
    for (const valid of ['aYdxQ05nOSo', '  vid_01-AZ  ', 'A'.repeat(64)]) {
      expect(isValidVideoId(valid)).toBe(true);
      expect(isClientValidVideoId(valid)).toBe(true);
    }
    const malformed = [
      '', '   ', null, undefined, 123, {}, 'abc&autoplay=1', 'abc?list=PL1',
      '../watch?v=123', 'foo/bar', 'bad id', '<script>alert(1)</script>', 'abc#frag', 'a'.repeat(65),
    ];
    for (const bad of malformed) {
      expect(isValidVideoId(bad)).toBe(false);
      expect(isClientValidVideoId(bad)).toBe(false);
    }
  });

  it('strips malformed videoIds in toPlaylistSongItem, drawRandomPlaylist, and buildYouTubeQueueUrl', () => {
    expect(toPlaylistSongItem({ artist: 'A', songTitle: 'S', videoId: '  aYdxQ05nOSo  ' }).videoId).toBe('aYdxQ05nOSo');
    expect(toPlaylistSongItem({ artist: 'A', songTitle: 'S', videoId: 'bad&autoplay=1' }).videoId).toBe('');
    expect(toPlaylistSongItem({ artist: 'A', songTitle: 'S', video_id: 'x'.repeat(65) }).videoId).toBe('');
    expect(toPlaylistSongItem({ artist: 'A', songTitle: 'S', videoId: null }).videoId).toBe('');

    const mixedRows = [
      { artist: 'Good 1', songTitle: 'One', totalPlays: 4, confidenceScore: 95, videoId: 'valid_id-01', isEmbeddable: 1, usPlayable: 1 },
      { artist: 'Bad 1', songTitle: 'Two', totalPlays: 5, confidenceScore: 98, videoId: 'bad?v=1&autoplay=1', isEmbeddable: 1, usPlayable: 1 },
      { artist: 'Bad 2', songTitle: 'Three', totalPlays: 5, confidenceScore: 98, videoId: '../etc/passwd', isEmbeddable: 1, usPlayable: 1 },
      { artist: 'Bad 3', songTitle: 'Four', totalPlays: 5, confidenceScore: 98, videoId: '<svg>', isEmbeddable: 1, usPlayable: 1 },
      { artist: 'Bad 4', songTitle: 'Five', totalPlays: 5, confidenceScore: 98, videoId: 'z'.repeat(65), isEmbeddable: 1, usPlayable: 1 },
      { artist: 'Good 2', songTitle: 'Six', totalPlays: 2, confidenceScore: 90, videoId: 'valid_id-02', isEmbeddable: 1, usPlayable: 1 },
    ];

    const strictDraw = drawRandomPlaylist(mixedRows, { count: 10 }, { assumedPlayable: false });
    const snapshotDraw = drawRandomPlaylist({ songs: mixedRows }, { count: 10 }, { assumedPlayable: true });
    expect(strictDraw.poolSize).toBe(2);
    expect(snapshotDraw.poolSize).toBe(2);
    expect(strictDraw.songs.map((s) => s.videoId).sort()).toEqual(['valid_id-01', 'valid_id-02']);
    expect(snapshotDraw.songs.map((s) => s.videoId).sort()).toEqual(['valid_id-01', 'valid_id-02']);
    expect(buildYouTubeQueueUrl(mixedRows)).toBe('https://www.youtube.com/watch_videos?video_ids=valid_id-01,valid_id-02');
    expect(buildYouTubeQueueUrl([{ videoId: 'bad?id=1' }])).toBe('');
  });
});

describe('YouTube verification error redaction', () => {
  it('redacts ?key=, &token=, and &secret= query parameters in sanitizeErrorMessage', () => {
    const raw = 'GET https://www.googleapis.com/youtube/v3/videos?key=AIzaKey99&part=status&token=Tok_123&secret=Sec_456&keep=ok';
    const clean = sanitizeErrorMessage(raw);
    expect(clean).toBe('GET https://www.googleapis.com/youtube/v3/videos?key=[REDACTED]&part=status&token=[REDACTED]&secret=[REDACTED]&keep=ok');
    expect(sanitizeErrorMessage(new Error('failed at ?TOKEN=ABC&Secret=XYZ&Key=123'))).toBe('failed at ?TOKEN=[REDACTED]&Secret=[REDACTED]&Key=[REDACTED]');
  });

  it('redacts ?key=, &token=, and &secret= on fetch throw and non-OK response in fetchVideosMetadataBatch', async () => {
    const netErr = new TypeError('connect failed for https://www.googleapis.com/youtube/v3/videos?part=status&key=SUPER_KEY&token=TOK_1&secret=SEC_2');
    await expect(fetchVideosMetadataBatch(['aYdxQ05nOSo'], 'SUPER_KEY', vi.fn().mockRejectedValue(netErr)))
      .rejects.toMatchObject({
        name: 'TypeError',
        message: 'connect failed for https://www.googleapis.com/youtube/v3/videos?part=status&key=[REDACTED]&token=[REDACTED]&secret=[REDACTED]',
      });

    const httpFetch = vi.fn().mockResolvedValue(
      new Response('upstream error https://example.test/api?key=BODY_KEY&token=BODY_TOK&secret=BODY_SEC', { status: 403 }),
    );
    let thrown = null;
    try {
      await fetchVideosMetadataBatch(['aYdxQ05nOSo'], 'BODY_KEY', httpFetch);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('YouTube videos.list failed (403):');
    expect(thrown.message).toContain('?key=[REDACTED]&token=[REDACTED]&secret=[REDACTED]');
    expect(thrown.message).not.toMatch(/BODY_KEY|BODY_TOK|BODY_SEC/);
  });
});

describe('buildArchiveSeedSql NUL-byte sanitization', () => {
  it('strips NUL bytes cleanly across episodes, song_plays, and cache_blobs SQL', async () => {
    const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
    const episodes = [
      {
        id: 'ep-nul-1',
        title: "Through the Cracks\0 — Sinéad O'Connor Special",
        airDate: '2026-11-01',
        dayOfWeek: 'Sunday',
        episodeNumber: 401,
        publishedAt: '2026-11-01T18:00:00Z',
        url: 'https://example.test/\0ep-1',
        songs: [
          {
            position: 1,
            artist: "Sinéad\0 O'Connor",
            featuredArtist: 'Guest\0 Artist',
            songTitle: 'Nothing\0 Compares',
            album: 'I Do Not\0 Want',
            releaseKind: 'album',
            rawLine: "Sinéad\0 O'Connor - Nothing\0 Compares",
          },
        ],
      },
    ];

    const { sql, counts } = await buildArchiveSeedSql({ schemaSql, episodes, now: '2026-11-14T00:00:00.000Z' });
    expect(sql.includes('\0')).toBe(false);
    expect(sql).toContain("Sinéad O''Connor");
    expect(sql).not.toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+song_links/i);
    expect(counts).toEqual({ episodes: 1, songPlays: 1, cacheBlobs: 2 });

    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(sql);
      expect(sqlite.prepare('SELECT title, url FROM episodes WHERE id = ?').get('ep-nul-1')).toEqual({
        title: "Through the Cracks — Sinéad O'Connor Special",
        url: 'https://example.test/ep-1',
      });
      expect(sqlite.prepare('SELECT artist, featured_artist, song_title, album FROM song_plays WHERE episode_id = ?').get('ep-nul-1')).toEqual({
        artist: "Sinéad O'Connor",
        featured_artist: 'Guest Artist',
        song_title: 'Nothing Compares',
        album: 'I Do Not Want',
      });
    } finally {
      sqlite.close();
    }
  });
});

describe('D1 Unicode key hydration and Cron deduplication', () => {
  const dbs = [];
  const createDb = async () => {
    const db = createSqliteD1();
    dbs.push(db);
    await ensureD1Schema(db);
    return db;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    while (dbs.length) dbs.pop().sqlite.close();
  });

  const seedUnicodeCatalog = async (db, { includeUnresolved = false } = {}) => {
    const episodes = [
      {
        id: 'ep-u1',
        airDate: '2026-10-01',
        title: 'Through the Cracks #1',
        songs: [{ position: 1, artist: 'Susan McKeown & The Chanting House', songTitle: 'Cé Leis É?', album: 'Bones' }],
      },
      {
        id: 'ep-u2',
        airDate: '2026-10-08',
        title: 'Through the Cracks #2',
        songs: [
          { position: 1, artist: 'Susan McKeown & The Chanting House', songTitle: 'Cé Leis É?', album: 'Bones' },
          ...(includeUnresolved
            ? [{ position: 2, artist: 'Éire Óg', songTitle: 'Óró Sé Do Bheatha Bhaile', album: 'Live' }]
            : []),
        ],
      },
    ];
    await upsertEpisodesIntoD1(db, episodes, { batchSize: 100 });
    await upsertSongLink(db, {
      artist: 'Susan McKeown & The Chanting House',
      songTitle: 'Cé Leis É?',
      videoId: 'vid-ce-leis-e',
      confidenceScore: 96,
      matchTier: 'high',
      isEmbeddable: 1,
      usPlayable: 1,
      statusReason: 'ok',
      checkedAt: '2026-11-10T00:00:00.000Z',
    });
  };

  it('hydrates Susan McKeown & The Chanting House — Cé Leis É? totalPlays=2 for deep_cuts across rollup and fallback modes', async () => {
    const db = await createDb();
    await seedUnicodeCatalog(db);

    const rollupRow = db.sqlite
      .prepare("SELECT artist_key, song_key, total_plays FROM song_rollups WHERE artist_key = 'susan mckeown & the chanting house'")
      .get();
    const linkRow = db.sqlite.prepare('SELECT song_key FROM song_links').get();
    expect(rollupRow).toEqual({
      artist_key: 'susan mckeown & the chanting house',
      song_key: 'cé leis É?',
      total_plays: 2,
    });
    expect(linkRow.song_key).toBe('susan mckeown & the chanting house|||cé leis é?');

    const pool = await loadD1PlaylistPool(db);
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({
      songKey: 'susan mckeown & the chanting house|||cé leis é?',
      artist: 'Susan McKeown & The Chanting House',
      songTitle: 'Cé Leis É?',
      album: 'Bones',
      totalPlays: 2,
      videoId: 'vid-ce-leis-e',
    });
    const deepCuts = await getD1RandomPlaylist(db, { mode: 'deep_cuts', count: 10 });
    expect(deepCuts.songs.map((s) => s.songTitle)).toEqual(['Cé Leis É?']);

    db.sqlite.exec('DELETE FROM song_rollups');
    clearD1Cache(db);
    const fallbackPool = await loadD1PlaylistPool(db);
    expect(fallbackPool[0].totalPlays).toBe(2);
    const fallbackDeepCuts = await getD1RandomPlaylist(db, { mode: 'deep_cuts', count: 10 });
    expect(fallbackDeepCuts.songs.map((s) => s.songTitle)).toEqual(['Cé Leis É?']);
  });

  it('skips already-linked Cé Leis É? in rollup & plays fallback and persists unresolved Unicode titles via buildSongKey', async () => {
    const db = await createDb();
    await seedUnicodeCatalog(db, { includeUnresolved: true });

    const expectedUnresolvedKey = buildSongKey('Éire Óg', 'Óró Sé Do Bheatha Bhaile');
    expect(expectedUnresolvedKey).toBe('éire óg|||óró sé do bheatha bhaile');

    const rollupUnresolved = await selectUnresolvedSongs(db, 10);
    expect(rollupUnresolved.map((r) => r.song_key)).toEqual([expectedUnresolvedKey]);

    db.sqlite.exec('DELETE FROM song_rollups');
    const playsFallbackUnresolved = await selectUnresolvedSongs(db, 10);
    expect(playsFallbackUnresolved.map((r) => r.song_key)).toEqual([expectedUnresolvedKey]);

    const searchQueries = [];
    const fetchImpl = vi.fn(async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/search')) {
        searchQueries.push(u.searchParams.get('q'));
        return jsonRes({
          items: [{ id: { videoId: 'vid-eire-og' }, snippet: { title: 'Óró Sé Do Bheatha Bhaile', channelTitle: 'Éire Óg - Topic' } }],
        });
      }
      return jsonRes({
        items: [{
          id: 'vid-eire-og',
          status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true },
          contentDetails: { duration: 'PT3M15S' },
        }],
      });
    });

    const cronRes = await runIncrementalSongLinksCron({
      db,
      apiKey: 'yt-key',
      fetchImpl,
      maxRecheck: 0,
      now: () => '2026-11-14T06:00:00.000Z',
    });
    expect(cronRes).toMatchObject({ resolvedCount: 1, unmatchedCount: 0, externalFetches: 2, changesMade: true });
    expect(searchQueries).toEqual(['Éire Óg Óró Sé Do Bheatha Bhaile']);
    expect(await selectUnresolvedSongs(db, 10)).toEqual([]);

    const persisted = db.sqlite.prepare('SELECT song_key, video_id FROM song_links ORDER BY song_key').all();
    expect(persisted).toEqual([
      { song_key: 'susan mckeown & the chanting house|||cé leis é?', video_id: 'vid-ce-leis-e' },
      { song_key: expectedUnresolvedKey, video_id: 'vid-eire-og' },
    ]);
  });
});
