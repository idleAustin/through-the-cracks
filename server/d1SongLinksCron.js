// Pure Web-API-only incremental YouTube song_links discovery and rotating health recheck for Worker Cron.
import { upsertSongLink } from './d1Playlist.js';
import { clearD1Cache, qAll, qFirst } from './d1Rollups.js';
import { buildSongKey } from './playlistBuilder.js';
import { buildFallbackSearchQueries, classifyYouTubeFailure, evaluateYouTubeVideoItem, pickBestSearchCandidate } from './youtubeSongMatcher.js';

export const DEFAULT_MAX_NEW_SONGS = 25;
export const DEFAULT_MAX_RECHECK = 250;
export const DEFAULT_MAX_EXTERNAL_FETCHES = 31;
export const VIDEOS_BATCH_SIZE = 50;
export const SEARCH_QUOTA_UNITS = 100;
export const VIDEOS_QUOTA_UNITS = 1;

export const SELECT_UNRESOLVED_ROLLUPS_SQL = `SELECT
  (sr.artist_key || '|||' || sr.song_key) AS song_key,
  sr.artist, sr.song_title, sr.total_plays
FROM song_rollups sr
LEFT JOIN song_links sl ON sl.song_key = (sr.artist_key || '|||' || sr.song_key)
WHERE sl.song_key IS NULL AND LENGTH(TRIM(sr.artist)) > 0 AND LENGTH(TRIM(sr.song_title)) > 0
ORDER BY sr.total_plays DESC, sr.song_key ASC, sr.artist_key ASC
LIMIT ? OFFSET ?`;

export const SELECT_UNRESOLVED_PLAYS_SQL = `WITH grouped_songs AS (
  SELECT (LOWER(TRIM(sp.artist)) || '|||' || LOWER(TRIM(sp.song_title))) AS song_key,
    MIN(TRIM(sp.artist)) AS artist, MIN(TRIM(sp.song_title)) AS song_title, COUNT(*) AS total_plays
  FROM song_plays sp
  WHERE LENGTH(TRIM(sp.artist)) > 0 AND LENGTH(TRIM(sp.song_title)) > 0
  GROUP BY LOWER(TRIM(sp.artist)), LOWER(TRIM(sp.song_title))
)
SELECT gs.song_key, gs.artist, gs.song_title, gs.total_plays
FROM grouped_songs gs
LEFT JOIN song_links sl ON sl.song_key = gs.song_key
WHERE sl.song_key IS NULL
ORDER BY gs.total_plays DESC, gs.song_key ASC
LIMIT ? OFFSET ?`;

export const SELECT_RECHECK_ROWS_SQL = `SELECT song_key, video_id, is_embeddable, us_playable, status_reason, match_tier, checked_at
FROM song_links
WHERE video_id IS NOT NULL AND TRIM(video_id) != ''
ORDER BY checked_at ASC, song_key ASC
LIMIT ?`;

export const UPDATE_RECHECK_PLAYABILITY_SQL = `UPDATE song_links
SET is_embeddable = ?, us_playable = ?, status_reason = ?, checked_at = ?, updated_at = ?
WHERE song_key = ?`;

export const UPDATE_RECHECK_TIMESTAMP_ONLY_SQL =
  'UPDATE song_links SET checked_at = ?, updated_at = ? WHERE song_key = ?';

function parseLimitOption(val, fallback) {
  if (val === undefined || val === null) return fallback;
  const num = Number(val);
  return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : fallback;
}

function emptyResult(skipped = null) {
  return {
    skipped, resolvedCount: 0, unmatchedCount: 0, recheckedCount: 0,
    playabilityChangedCount: 0, externalFetches: 0, quotaUnits: 0,
    stoppedEarlyReason: null, changesMade: false,
  };
}

async function hasPopulatedSongRollups(db) {
  try {
    return Boolean(await qFirst(db, 'SELECT 1 AS ok FROM song_rollups LIMIT 1'));
  } catch (err) {
    if (/no such table/i.test(String(err?.message ?? err))) return false;
    throw err;
  }
}

async function fetchExistingCanonicalKeys(db, keys) {
  const existing = new Set();
  for (const chunk of chunkIds(keys, VIDEOS_BATCH_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await qAll(db, `SELECT song_key FROM song_links WHERE song_key IN (${placeholders})`, chunk);
    for (const row of rows) {
      if (row?.song_key) existing.add(String(row.song_key));
    }
  }
  return existing;
}

export async function selectUnresolvedSongs(db, limit = DEFAULT_MAX_NEW_SONGS) {
  const safeLimit = parseLimitOption(limit, DEFAULT_MAX_NEW_SONGS);
  if (!db || safeLimit <= 0) return [];
  const useRollups = await hasPopulatedSongRollups(db);
  const sql = useRollups ? SELECT_UNRESOLVED_ROLLUPS_SQL : SELECT_UNRESOLVED_PLAYS_SQL;
  const pageSize = Math.max(safeLimit, DEFAULT_MAX_NEW_SONGS);
  const selected = [];
  const seenCanonicalKeys = new Set();
  let offset = 0;

  while (selected.length < safeLimit) {
    const page = await qAll(db, sql, [pageSize, offset]);
    if (page.length === 0) break;

    const mismatchKeys = new Set();
    const normalizedPage = page.map((row) => {
      const canonicalKey = buildSongKey(row.artist, row.song_title);
      if (canonicalKey && canonicalKey !== row.song_key) mismatchKeys.add(canonicalKey);
      return { row, canonicalKey };
    });

    const existingCanonicalKeys =
      mismatchKeys.size > 0 ? await fetchExistingCanonicalKeys(db, [...mismatchKeys]) : new Set();

    for (const { row, canonicalKey } of normalizedPage) {
      if (selected.length >= safeLimit) break;
      if (!canonicalKey || existingCanonicalKeys.has(canonicalKey) || seenCanonicalKeys.has(canonicalKey)) {
        continue;
      }
      seenCanonicalKeys.add(canonicalKey);
      selected.push({ ...row, song_key: canonicalKey });
    }

    if (page.length < pageSize) break;
    offset += page.length;
  }

  return selected;
}

export async function selectRecheckRows(db, limit = DEFAULT_MAX_RECHECK, excludeKeys = null) {
  const safeLimit = parseLimitOption(limit, DEFAULT_MAX_RECHECK);
  if (!db || safeLimit <= 0) return [];
  const excludeSet = excludeKeys instanceof Set ? excludeKeys : new Set(excludeKeys || []);
  const rows = await qAll(db, SELECT_RECHECK_ROWS_SQL, [safeLimit + excludeSet.size]);
  return excludeSet.size === 0 ? rows.slice(0, safeLimit) : rows.filter((r) => !excludeSet.has(r.song_key)).slice(0, safeLimit);
}

export function buildSearchUrl(song, apiKey, queryOverride = null) {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('maxResults', '5');
  const q = typeof queryOverride === 'string' && queryOverride.trim()
    ? queryOverride.trim()
    : `${String(song?.artist || '').trim()} ${String(song?.song_title || song?.songTitle || '').trim()}`.trim();
  url.searchParams.set('q', q);
  url.searchParams.set('key', String(apiKey || '').trim());
  return url.toString();
}

export function buildVideosUrl(videoIds, apiKey) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'status,contentDetails');
  url.searchParams.set('id', (videoIds || []).map((id) => String(id).trim()).filter(Boolean).join(','));
  url.searchParams.set('key', String(apiKey || '').trim());
  return url.toString();
}

async function fetchYouTubeJson(url, callFetch) {
  let response;
  try {
    response = await callFetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (err) {
    return { ok: false, reason: classifyYouTubeFailure(null, null, err), data: null };
  }
  if (!response || typeof response !== 'object') return { ok: false, reason: 'network_error', data: null };

  let body = null;
  if (typeof response.json === 'function') {
    body = await response.json().catch(() => null);
  } else if (typeof response.text === 'function') {
    const rawText = await response.text().catch(() => '');
    try { body = rawText ? JSON.parse(rawText) : null; } catch { body = rawText ? { error: { message: rawText } } : null; }
  }

  const failureReason = classifyYouTubeFailure(response, body);
  if (failureReason) return { ok: false, reason: failureReason, data: body };
  if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_json', data: null };
  return { ok: true, reason: null, data: body };
}

function chunkIds(ids, size = VIDEOS_BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

function groupRecheckBatches(rows, maxIdsPerBatch = VIDEOS_BATCH_SIZE) {
  const batches = [];
  let currentRows = [];
  let currentIds = new Set();
  for (const row of rows) {
    const vid = String(row?.video_id || '').trim();
    if (!vid) continue;
    if (!currentIds.has(vid) && currentIds.size >= maxIdsPerBatch) {
      batches.push({ rows: currentRows, ids: [...currentIds] });
      currentRows = [];
      currentIds = new Set();
    }
    currentRows.push(row);
    currentIds.add(vid);
  }
  if (currentRows.length > 0) batches.push({ rows: currentRows, ids: [...currentIds] });
  return batches;
}

async function persistDiscoveryResults({ db, candidateQueue, unmatchedQueue, verifiedVideoMap, getNowIso, verifiedThisRun }) {
  const saveRow = async (song, patch) => {
    const ts = getNowIso();
    const songKey = buildSongKey(song.artist, song.song_title) || song.song_key;
    await upsertSongLink(db, {
      song_key: songKey, artist: song.artist, song_title: song.song_title,
      yt_album: null, checked_at: ts, updated_at: ts, ...patch,
    });
    verifiedThisRun.add(songKey);
  };
  for (const { song, best } of candidateQueue) {
    const compat = evaluateYouTubeVideoItem(verifiedVideoMap.get(best.videoId) ?? null);
    await saveRow(song, {
      video_id: best.videoId, yt_title: best.ytTitle, yt_artist: best.ytArtist,
      result_type: best.resultType, duration_seconds: compat.durationSeconds,
      confidence_score: best.score, match_tier: best.matchTier,
      is_embeddable: compat.isEmbeddable, us_playable: compat.usPlayable, status_reason: compat.statusReason,
    });
  }
  for (const { song, statusReason } of unmatchedQueue) {
    await saveRow(song, {
      video_id: null, yt_title: null, yt_artist: null, result_type: null, duration_seconds: null,
      confidence_score: 0, match_tier: 'unmatched', is_embeddable: 0, us_playable: 0, status_reason: statusReason,
    });
  }
  return { resolvedCount: candidateQueue.length, unmatchedCount: unmatchedQueue.length };
}

async function fetchVideosBatchIntoMap(ids, cleanKey, callFetch, maxExternalFetches, state, itemMap) {
  if (state.externalFetches >= maxExternalFetches) { state.stoppedEarlyReason = 'max_external_fetches'; return false; }
  state.externalFetches += 1;
  const vidRes = await fetchYouTubeJson(buildVideosUrl(ids, cleanKey), callFetch);
  if (!vidRes.ok) { state.stoppedEarlyReason = vidRes.reason; return false; }
  state.quotaUnits += VIDEOS_QUOTA_UNITS;
  for (const item of vidRes.data?.items || []) {
    if (item?.id) itemMap.set(String(item.id), item);
  }
  return true;
}

async function searchSongCandidate({
  song, queryOverride = null, cleanKey, callFetch, maxExternalFetches, uniqueCandidateIds, state,
}) {
  const projectedVerifyCalls = Math.ceil((uniqueCandidateIds.size + 1) / VIDEOS_BATCH_SIZE);
  if (state.externalFetches + 1 + projectedVerifyCalls > maxExternalFetches) {
    return { budgetExceeded: true, best: null, statusReason: null };
  }
  state.externalFetches += 1;
  const searchRes = await fetchYouTubeJson(buildSearchUrl(song, cleanKey, queryOverride), callFetch);
  if (!searchRes.ok) {
    state.stoppedEarlyReason = searchRes.reason;
    return { budgetExceeded: false, best: null, statusReason: null };
  }
  state.quotaUnits += SEARCH_QUOTA_UNITS;
  const items = Array.isArray(searchRes.data?.items) ? searchRes.data.items : [];
  return {
    budgetExceeded: false,
    best: pickBestSearchCandidate(song, items),
    statusReason: items.length === 0 ? 'no_search_results' : 'no_confident_match',
  };
}

async function discoverUnresolvedSongs({ db, cleanKey, callFetch, maxNewSongs, maxExternalFetches, state }) {
  const searchBudget = Math.min(maxNewSongs, Math.max(0, maxExternalFetches - 1));
  const unresolvedSongs = searchBudget > 0 ? await selectUnresolvedSongs(db, searchBudget) : [];
  const candidateQueue = [];
  const unmatchedQueue = [];
  const pass1Misses = [];
  const uniqueCandidateIds = new Set();

  for (const song of unresolvedSongs) {
    const step = await searchSongCandidate({
      song, cleanKey, callFetch, maxExternalFetches, uniqueCandidateIds, state,
    });
    if (step.budgetExceeded) { state.stoppedEarlyReason = 'max_external_fetches'; break; }
    if (state.stoppedEarlyReason) break;
    if (step.best) { candidateQueue.push({ song, best: step.best }); uniqueCandidateIds.add(step.best.videoId); }
    else pass1Misses.push({ song, statusReason: step.statusReason });
  }

  if (state.stoppedEarlyReason) {
    unmatchedQueue.push(...pass1Misses);
    return { candidateQueue, unmatchedQueue, uniqueCandidateIds };
  }

  for (const miss of pass1Misses) {
    let matched = null;
    let latestReason = miss.statusReason;
    let interrupted = false;
    const fallbacks = buildFallbackSearchQueries(miss.song, { pass1Empty: miss.statusReason === 'no_search_results' });
    for (const fallbackQuery of fallbacks) {
      const step = await searchSongCandidate({
        song: miss.song, queryOverride: fallbackQuery, cleanKey, callFetch, maxExternalFetches, uniqueCandidateIds, state,
      });
      if (step.budgetExceeded) { state.pass2BudgetExhausted = true; interrupted = true; break; }
      if (state.stoppedEarlyReason) { interrupted = true; break; }
      if (step.best) { matched = step.best; break; }
      if (step.statusReason === 'no_confident_match') latestReason = 'no_confident_match';
    }
    if (matched) { candidateQueue.push({ song: miss.song, best: matched }); uniqueCandidateIds.add(matched.videoId); }
    else if (!interrupted) unmatchedQueue.push({ song: miss.song, statusReason: latestReason });
    if (state.stoppedEarlyReason || state.pass2BudgetExhausted) break;
  }
  return { candidateQueue, unmatchedQueue, uniqueCandidateIds };
}

export async function runIncrementalSongLinksCron({
  db,
  apiKey,
  fetchImpl = globalThis.fetch,
  maxNewSongs = DEFAULT_MAX_NEW_SONGS,
  maxRecheck = DEFAULT_MAX_RECHECK,
  maxExternalFetches = DEFAULT_MAX_EXTERNAL_FETCHES,
  now = () => new Date().toISOString(),
} = {}) {
  if (!db) return emptyResult('missing_db');
  const cleanKey = String(apiKey ?? '').trim();
  if (!cleanKey) return emptyResult('missing_youtube_api_key');

  const safeMaxNewSongs = parseLimitOption(maxNewSongs, DEFAULT_MAX_NEW_SONGS);
  const safeMaxRecheck = parseLimitOption(maxRecheck, DEFAULT_MAX_RECHECK);
  const safeMaxExternalFetches = parseLimitOption(maxExternalFetches, DEFAULT_MAX_EXTERNAL_FETCHES);
  const getNowIso = () => (typeof now === 'function' ? String(now()) : String(now || new Date().toISOString()));
  const rawFetch = fetchImpl ?? globalThis.fetch;
  const callFetch = (url, init) => (rawFetch === globalThis.fetch ? globalThis.fetch(url, init) : rawFetch(url, init));

  let recheckedCount = 0;
  let playabilityChangedCount = 0;
  const state = { externalFetches: 0, quotaUnits: 0, stoppedEarlyReason: null, pass2BudgetExhausted: false };
  const verifiedThisRun = new Set();

  // Step A: Two-pass discovery (Pass 1 raw query, Pass 2 stripped/fallback queries; reserves >= 1 fetch for videos.list).
  const { candidateQueue, unmatchedQueue, uniqueCandidateIds } = await discoverUnresolvedSongs({
    db, cleanKey, callFetch, maxNewSongs: safeMaxNewSongs, maxExternalFetches: safeMaxExternalFetches, state,
  });

  let videosFailed = false;
  const verifiedVideoMap = new Map();
  if (!state.stoppedEarlyReason && uniqueCandidateIds.size > 0) {
    for (const batchIds of chunkIds([...uniqueCandidateIds], VIDEOS_BATCH_SIZE)) {
      if (!(await fetchVideosBatchIntoMap(batchIds, cleanKey, callFetch, safeMaxExternalFetches, state, verifiedVideoMap))) {
        videosFailed = true;
        break;
      }
    }
  }

  const { resolvedCount, unmatchedCount } = videosFailed
    ? { resolvedCount: 0, unmatchedCount: 0 }
    : await persistDiscoveryResults({
      db, candidateQueue: state.stoppedEarlyReason ? [] : candidateQueue,
      unmatchedQueue, verifiedVideoMap, getNowIso, verifiedThisRun,
    });
  if (state.pass2BudgetExhausted && !state.stoppedEarlyReason) state.stoppedEarlyReason = 'max_external_fetches';

  // Step B: Rotating Health Recheck (<= 250 rows ordered by checked_at ASC; preserves manual choices/scores).
  if (!state.stoppedEarlyReason && safeMaxRecheck > 0) {
    const recheckRows = await selectRecheckRows(db, safeMaxRecheck, verifiedThisRun);
    for (const batch of groupRecheckBatches(recheckRows, VIDEOS_BATCH_SIZE)) {
      const itemMap = new Map();
      if (!(await fetchVideosBatchIntoMap(batch.ids, cleanKey, callFetch, safeMaxExternalFetches, state, itemMap))) break;
      const ts = getNowIso();
      const stmts = [];
      for (const row of batch.rows) {
        const compat = evaluateYouTubeVideoItem(itemMap.get(String(row.video_id || '').trim()) ?? null);
        const playChanged =
          Number(row.is_embeddable) !== compat.isEmbeddable || Number(row.us_playable) !== compat.usPlayable;
        const statusChanged = playChanged || String(row.status_reason || '') !== compat.statusReason;
        if (playChanged) playabilityChangedCount += 1;
        recheckedCount += 1;
        stmts.push(
          statusChanged
            ? db.prepare(UPDATE_RECHECK_PLAYABILITY_SQL).bind(compat.isEmbeddable, compat.usPlayable, compat.statusReason, ts, ts, row.song_key)
            : db.prepare(UPDATE_RECHECK_TIMESTAMP_ONLY_SQL).bind(ts, ts, row.song_key),
        );
      }
      if (stmts.length > 0) await db.batch(stmts);
    }
  }

  const changesMade = resolvedCount > 0 || unmatchedCount > 0 || playabilityChangedCount > 0;
  if (changesMade) clearD1Cache(db);

  return {
    skipped: null, resolvedCount, unmatchedCount, recheckedCount, playabilityChangedCount,
    externalFetches: state.externalFetches, quotaUnits: state.quotaUnits,
    stoppedEarlyReason: state.stoppedEarlyReason, changesMade,
  };
}
