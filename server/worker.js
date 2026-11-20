// Cloudflare Worker HTTP API, Edge Cache, R2 snapshot tier, D1 fallback, SPA asset fallback, and Cron entrypoint.
import { isCatchupCron, shouldSkipCatchupCron } from './broadcastSchedule.js';
import { ingestBloggerToD1 } from './d1Schema.js';
import { getD1ArtistProfile } from './d1ArtistProfile.js';
import { getD1RandomPlaylist } from './d1Playlist.js';
import {
  clearD1Cache, getD1ArtistSongs, getD1Artists, getD1EpisodeById, getD1Episodes,
  getD1Overview, getD1Search, getD1Songs, getD1YearSpins,
} from './d1Queries.js';
import { runIncrementalSongLinksCron } from './d1SongLinksCron.js';
import { drawRandomPlaylist, parsePlaylistQuery } from './playlistBuilder.js';
import {
  PUBLIC_API_CACHE_CONTROL, bumpWorkerCacheEpoch, getR2ManifestVersion,
  readR2SongLinksSnapshot, resolveAtlasFallback, safeDecodeUri, tryServeFromR2, withEdgeCache,
} from './workerSnapshots.js';
import { getR2SyncStatus, syncR2AfterIngest } from './workerSnapshotSync.js';

const DEFAULT_BLOG_ID = '3469042462299367694';
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };
const RATE_WINDOW_MS = 60_000;
const READ_RATE_LIMIT = 180;
const INGEST_RATE_LIMIT = 5;
const MAX_RATE_BUCKETS = 5000;
const MAX_INGEST_BODY_BYTES = 16_384;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const ALLOWED_ORIGINS = new Set([
  'https://idleamericana.com',
  'https://www.idleamericana.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5176',
  'http://127.0.0.1:5176',
  'http://localhost:4173',
]);

const rateBuckets = new Map();
export function resetWorkerRateLimits() {
  rateBuckets.clear();
  bumpWorkerCacheEpoch();
}

function buildJsonHeaders(corsHeaders = {}, extraHeaders = {}) {
  return {
    ...SECURITY_HEADERS,
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
}

function withHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v !== undefined && v !== null) headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(data, status = 200, corsHeaders = {}, extraHeaders = {}) {
  const defaultCache = status >= 400 ? NO_STORE_HEADERS : {};
  return new Response(JSON.stringify(data), {
    status,
    headers: buildJsonHeaders(corsHeaders, { ...defaultCache, ...extraHeaders }),
  });
}

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function checkRateLimit(key, limit, now = Date.now()) {
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [k, entry] of rateBuckets) {
      if (now >= entry.resetAt) rateBuckets.delete(k);
    }
    while (rateBuckets.size > MAX_RATE_BUCKETS) rateBuckets.delete(rateBuckets.keys().next().value);
  }
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

async function constantTimeEquals(expected, provided) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    globalThis.crypto.subtle.digest('SHA-256', enc.encode(String(expected))),
    globalThis.crypto.subtle.digest('SHA-256', enc.encode(String(provided))),
  ]);
  const bufA = new Uint8Array(a);
  const bufB = new Uint8Array(b);
  let diff = bufA.length ^ bufB.length;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

// Strip Bearer tokens and query-string credentials from upstream fetch URLs before writing caught errors to Worker logs.
function redactSecrets(message) {
  return String(message ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:key|token|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
}

function logWorkerError(label, err) {
  console.error(label, redactSecrets(err?.stack || err?.message || err));
}

async function runIngestAndSync(env, incremental, ctx = null, deferSync = false, options = {}) {
  const result = await ingestBloggerToD1({
    db: env?.DB,
    blogId: env?.BLOGGER_BLOG_ID || DEFAULT_BLOG_ID,
    apiKey: env?.BLOGGER_API_KEY || '',
    incremental,
  });
  if (result?.episodesUpserted > 0) {
    clearD1Cache(env?.DB);
    bumpWorkerCacheEpoch();
  }

  let linkResolution = null;
  const shouldResolveLinks = options?.resolveLinks === true || (options?.resolveLinks === 'on-new-episodes' && result?.episodesUpserted > 0);
  if (shouldResolveLinks) {
    try {
      linkResolution = await runIncrementalSongLinksCron({
        db: env?.DB,
        apiKey: env?.YOUTUBE_API_KEY,
      });
    } catch (err) {
      logWorkerError('Worker song_links cron error:', err);
      linkResolution = { error: 'Song link refresh failed', changesMade: false };
    }
    if (linkResolution?.changesMade) {
      clearD1Cache(env?.DB);
      bumpWorkerCacheEpoch();
    }
  }

  let r2Sync = { mode: 'skipped', archiveDrift: false };
  if (env?.SNAPSHOT_BUCKET) {
    const runSync = () =>
      syncR2AfterIngest({
        db: env.DB,
        bucket: env.SNAPSHOT_BUCKET,
        episodesUpserted: result?.episodesUpserted || 0,
        linkChangesMade: Boolean(linkResolution?.changesMade),
        forceSync: options?.forceSync === true,
      }).then((syncRes) => {
        if (syncRes.mode !== 'skipped') bumpWorkerCacheEpoch();
        return syncRes;
      });
    if (deferSync && ctx?.waitUntil) {
      ctx.waitUntil(runSync().catch((err) => logWorkerError('Worker R2 snapshot sync error:', err)));
      r2Sync = { deferred: true };
    } else {
      try {
        r2Sync = await runSync();
      } catch (err) {
        logWorkerError('Worker R2 snapshot sync error:', err);
        throw err;
      }
    }
  }

  return {
    ...result,
    ...(linkResolution ? { linkResolution } : {}),
    ...(env?.SNAPSHOT_BUCKET ? { r2Sync } : {}),
  };
}

async function handleIngest(request, env, corsHeaders, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  if (!String(env?.INGEST_SECRET || '').trim()) return jsonResponse({ error: 'Service unavailable' }, 503, corsHeaders);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  if (!token || !(await constantTimeEquals(env.INGEST_SECRET, token))) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_INGEST_BODY_BYTES) {
    return jsonResponse({ error: 'Request body too large' }, 413, corsHeaders);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_INGEST_BODY_BYTES) {
    return jsonResponse({ error: 'Request body too large' }, 413, corsHeaders);
  }

  let body = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }
  }
  if (!env?.DB) return jsonResponse({ error: 'Service unavailable' }, 503, corsHeaders);
  const payload = await runIngestAndSync(env, body?.incremental !== false, ctx, body?.awaitSync !== true, {
    resolveLinks: body?.resolveLinks === true,
    forceSync: body?.forceSync === true,
  });
  return jsonResponse(payload, 200, corsHeaders, NO_STORE_HEADERS);
}

const READ_EXACT_ROUTES = new Set(['/api/overview', '/api/years', '/api/atlas', '/api/episodes', '/api/artists', '/api/songs', '/api/search']);

async function handleReadRoutes(apiPath, url, env) {
  const query = Object.fromEntries(url.searchParams.entries());
  const epMatch = apiPath.match(/^\/api\/episodes\/([^/]+)$/);
  const profileMatch = apiPath.match(/^\/api\/artists\/([^/]+)\/profile$/);
  const artistMatch = apiPath.match(/^\/api\/artists\/([^/]+)\/songs$/);
  if (!READ_EXACT_ROUTES.has(apiPath) && !epMatch && !profileMatch && !artistMatch) {
    return { status: 404, data: { error: 'Not found' } };
  }
  const epDec = epMatch ? safeDecodeUri(epMatch[1]) : null;
  const profDec = profileMatch ? safeDecodeUri(profileMatch[1]) : null;
  const artDec = artistMatch ? safeDecodeUri(artistMatch[1]) : null;
  if (epDec && !epDec.ok) return { status: 400, data: { error: 'Invalid episode id' } };
  if (profDec && !profDec.ok) return { status: 400, data: { error: 'Invalid artist name' } };
  if (profDec && !profDec.value.trim()) return { status: 400, data: { error: 'Artist name is required' } };
  if (artDec && !artDec.ok) return { status: 400, data: { error: 'Invalid artist name' } };
  if (apiPath === '/api/atlas') return await resolveAtlasFallback(url, env);
  if (!env?.DB) return { status: 503, data: { error: 'Service unavailable' } };

  if (apiPath === '/api/overview') return { status: 200, data: await getD1Overview(env.DB) };
  if (apiPath === '/api/years') return { status: 200, data: await getD1YearSpins(env.DB, query) };
  if (apiPath === '/api/episodes') return { status: 200, data: await getD1Episodes(env.DB, query) };
  if (epDec) {
    const ep = await getD1EpisodeById(env.DB, epDec.value, query);
    return ep ? { status: 200, data: ep } : { status: 404, data: { error: 'Episode not found' } };
  }
  if (apiPath === '/api/artists') return { status: 200, data: await getD1Artists(env.DB, query) };
  if (profDec) {
    const profile = await getD1ArtistProfile(env.DB, profDec.value);
    return profile ? { status: 200, data: profile } : { status: 404, data: { error: 'Artist not found' } };
  }
  if (artDec) return { status: 200, data: await getD1ArtistSongs(env.DB, artDec.value) };
  if (apiPath === '/api/songs') return { status: 200, data: await getD1Songs(env.DB, query) };
  return { status: 200, data: await getD1Search(env.DB, query) };
}

async function handlePlaylistRandom(request, env, url, corsHeaders) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Not found' }, 404, corsHeaders, NO_STORE_HEADERS);
  }
  const parsed = parsePlaylistQuery(url.searchParams);
  if (parsed.error) {
    return jsonResponse({ error: parsed.error }, parsed.status || 400, corsHeaders, NO_STORE_HEADERS);
  }
  if (env?.SNAPSHOT_BUCKET) {
    const r2Pool = await readR2SongLinksSnapshot(env);
    if (r2Pool !== null) {
      return jsonResponse(
        drawRandomPlaylist(r2Pool, url.searchParams, { assumedPlayable: true }),
        200,
        corsHeaders,
        NO_STORE_HEADERS,
      );
    }
  }
  if (env?.DB) {
    const result = await getD1RandomPlaylist(env.DB, url.searchParams);
    if (result?.error) {
      return jsonResponse({ error: result.error }, result.status || 400, corsHeaders, NO_STORE_HEADERS);
    }
    return jsonResponse(result, 200, corsHeaders, NO_STORE_HEADERS);
  }
  return jsonResponse({ error: 'Service unavailable' }, 503, corsHeaders, NO_STORE_HEADERS);
}

async function handleApi(request, env, apiPath, url, ctx) {
  const corsHeaders = buildCorsHeaders(request);
  if (request.method === 'OPTIONS') return withHeaders(new Response(null, { status: 204 }), corsHeaders);

  const isNoStoreRoute = apiPath === '/api/playlist/random' || apiPath === '/api/ingest';
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const isIngestPost = apiPath === '/api/ingest' && request.method === 'POST';
  const allowed = checkRateLimit(isIngestPost ? `ingest:${ip}` : `read:${ip}`, isIngestPost ? INGEST_RATE_LIMIT : READ_RATE_LIMIT);
  if (!allowed) {
    return jsonResponse(
      { error: 'Too many requests' },
      429,
      corsHeaders,
      isNoStoreRoute ? { 'Retry-After': '60', ...NO_STORE_HEADERS } : { 'Retry-After': '60' },
    );
  }

  try {
    if (apiPath === '/api/health' && request.method === 'GET') {
      return jsonResponse({
        status: 'ok',
        runtime: 'cloudflare-worker',
        database: env?.DB ? 'd1' : 'unconfigured',
        snapshots: env?.SNAPSHOT_BUCKET ? 'r2' : 'disabled',
        timestamp: new Date().toISOString(),
      }, 200, corsHeaders);
    }
    if (apiPath === '/api/ingest') return await handleIngest(request, env, corsHeaders, ctx);
    if (apiPath === '/api/playlist/random') return await handlePlaylistRandom(request, env, url, corsHeaders);
    const hasAtlasAssets = apiPath === '/api/atlas' && Boolean(env?.ASSETS);
    if (!env?.DB && !env?.SNAPSHOT_BUCKET && !hasAtlasAssets) return jsonResponse({ error: 'Service unavailable' }, 503, corsHeaders);
    if (request.method !== 'GET') return jsonResponse({ error: 'Not found' }, 404, corsHeaders);

    const cacheVersion = await getR2ManifestVersion(env);
    return await withEdgeCache(
      request,
      apiPath,
      url,
      ctx,
      (status, extraHeaders = {}) =>
        buildJsonHeaders(corsHeaders, {
          ...(status === 200 ? { 'Cache-Control': PUBLIC_API_CACHE_CONTROL } : status >= 400 ? NO_STORE_HEADERS : {}),
          ...extraHeaders,
        }),
      async () => {
        const query = Object.fromEntries(url.searchParams.entries());
        if (env?.SNAPSHOT_BUCKET) {
          try {
            const r2Hit = await tryServeFromR2(apiPath, query, env, ctx);
            if (r2Hit) return r2Hit;
          } catch (err) {
            if (!env?.DB && !hasAtlasAssets) throw err;
            logWorkerError('Worker R2 snapshot read failed, falling back to D1:', err);
          }
        }
        return await handleReadRoutes(apiPath, url, env);
      },
      cacheVersion,
    );
  } catch (err) {
    logWorkerError('Worker API error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders, isNoStoreRoute ? NO_STORE_HEADERS : {});
  }
}

async function handleAssets(request, env, url) {
  if (!env?.ASSETS) return withHeaders(new Response('Not Found', { status: 404 }));
  const subpath = url.pathname.replace(/^\/through-the-cracks(?=\/|$)/, '') || '/';
  const targetPath = subpath === '/' ? '/index.html' : subpath;
  const init = { method: request.method, headers: request.headers };
  const targetUrl = new URL(request.url);
  targetUrl.pathname = targetPath.replace(/^\/{2,}/, '/');
  let response = await env.ASSETS.fetch(new Request(targetUrl, init));

  const canFallback =
    response.status === 404 &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    !subpath.startsWith('/assets/') && !subpath.startsWith('/data/') && !subpath.includes('.');
  if (canFallback) {
    const fallbackUrl = new URL(request.url);
    fallbackUrl.pathname = '/index.html';
    response = await env.ASSETS.fetch(new Request(fallbackUrl, init));
  }
  return withHeaders(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/') ||
      url.pathname === '/through-the-cracks/api' || url.pathname.startsWith('/through-the-cracks/api/');
    if (isApi) return handleApi(request, env, url.pathname.replace(/^\/through-the-cracks(?=\/api(?:\/|$))/, ''), url, ctx);
    return handleAssets(request, env, url);
  },

  async scheduled(controller, env, ctx) {
    const task = (async () => {
      const skip = await shouldSkipCatchupCron(controller, env, getR2SyncStatus);
      if (skip) return skip;
      return runIngestAndSync(env, true, ctx, false, {
        resolveLinks: isCatchupCron(controller) ? 'on-new-episodes' : true,
      });
    })();
    ctx?.waitUntil?.(task);
    return await task;
  },
};
