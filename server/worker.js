// Cloudflare Worker HTTP API, D1 ingestion, SPA asset fallback, and Cron entrypoint.
import { ingestBloggerToD1 } from './d1Schema.js';
import { getD1ArtistProfile } from './d1ArtistProfile.js';
import {
  clearD1Cache, getD1ArtistSongs, getD1Artists, getD1EpisodeById, getD1Episodes,
  getD1Overview, getD1Search, getD1Songs, getD1YearSpins,
} from './d1Queries.js';

const DEFAULT_BLOG_ID = '3469042462299367694';
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
  return withHeaders(
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }),
    { ...corsHeaders, ...extraHeaders },
  );
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

function safeDecode(value) {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false, value: '' };
  }
}

async function handleIngest(request, env, corsHeaders) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  if (!env?.INGEST_SECRET) return jsonResponse({ error: 'Service unavailable' }, 503, corsHeaders);

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
  }
  if (!env?.DB) return jsonResponse({ error: 'Service unavailable' }, 503, corsHeaders);

  const result = await ingestBloggerToD1({
    db: env.DB,
    blogId: env.BLOGGER_BLOG_ID || DEFAULT_BLOG_ID,
    apiKey: env.BLOGGER_API_KEY || '',
    incremental: body?.incremental !== false,
  });
  clearD1Cache(env.DB);
  return jsonResponse(result, 200, corsHeaders);
}

async function handleReadRoutes(apiPath, url, env, corsHeaders) {
  const query = Object.fromEntries(url.searchParams.entries());
  if (apiPath === '/api/overview') return jsonResponse(await getD1Overview(env.DB), 200, corsHeaders);
  if (apiPath === '/api/years') return jsonResponse(await getD1YearSpins(env.DB, query), 200, corsHeaders);
  if (apiPath === '/api/episodes') return jsonResponse(await getD1Episodes(env.DB, query), 200, corsHeaders);

  const epMatch = apiPath.match(/^\/api\/episodes\/([^/]+)$/);
  if (epMatch) {
    const decoded = safeDecode(epMatch[1]);
    if (!decoded.ok) return jsonResponse({ error: 'Invalid episode id' }, 400, corsHeaders);
    const ep = await getD1EpisodeById(env.DB, decoded.value);
    return ep ? jsonResponse(ep, 200, corsHeaders) : jsonResponse({ error: 'Episode not found' }, 404, corsHeaders);
  }

  if (apiPath === '/api/artists') return jsonResponse(await getD1Artists(env.DB, query), 200, corsHeaders);
  const profileMatch = apiPath.match(/^\/api\/artists\/([^/]+)\/profile$/);
  if (profileMatch) {
    const decoded = safeDecode(profileMatch[1]);
    if (!decoded.ok) return jsonResponse({ error: 'Invalid artist name' }, 400, corsHeaders);
    if (!decoded.value.trim()) return jsonResponse({ error: 'Artist name is required' }, 400, corsHeaders);
    const profile = await getD1ArtistProfile(env.DB, decoded.value);
    if (!profile) return jsonResponse({ error: 'Artist not found' }, 404, corsHeaders);
    return jsonResponse(profile, 200, corsHeaders);
  }
  const artistMatch = apiPath.match(/^\/api\/artists\/([^/]+)\/songs$/);
  if (artistMatch) {
    const decoded = safeDecode(artistMatch[1]);
    if (!decoded.ok) return jsonResponse({ error: 'Invalid artist name' }, 400, corsHeaders);
    return jsonResponse(await getD1ArtistSongs(env.DB, decoded.value), 200, corsHeaders);
  }

  if (apiPath === '/api/songs') return jsonResponse(await getD1Songs(env.DB, query), 200, corsHeaders);
  if (apiPath === '/api/search') return jsonResponse(await getD1Search(env.DB, query), 200, corsHeaders);
  return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
}

async function handleApi(request, env, apiPath, url) {
  const corsHeaders = buildCorsHeaders(request);
  if (request.method === 'OPTIONS') return withHeaders(new Response(null, { status: 204 }), corsHeaders);

  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const isIngestPost = apiPath === '/api/ingest' && request.method === 'POST';
  const allowed = checkRateLimit(isIngestPost ? `ingest:${ip}` : `read:${ip}`, isIngestPost ? INGEST_RATE_LIMIT : READ_RATE_LIMIT);
  if (!allowed) return jsonResponse({ error: 'Too many requests' }, 429, corsHeaders, { 'Retry-After': '60' });

  try {
    if (apiPath === '/api/health' && request.method === 'GET') {
      return jsonResponse({
        status: 'ok',
        runtime: 'cloudflare-worker',
        database: env?.DB ? 'd1' : 'unconfigured',
        timestamp: new Date().toISOString(),
      }, 200, corsHeaders);
    }
    if (apiPath === '/api/ingest') return await handleIngest(request, env, corsHeaders);
    if (!env?.DB) return jsonResponse({ error: 'Service unavailable' }, 503, corsHeaders);
    if (request.method !== 'GET') return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
    return await handleReadRoutes(apiPath, url, env, corsHeaders);
  } catch (err) {
    console.error('Worker API error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/') ||
      url.pathname === '/through-the-cracks/api' || url.pathname.startsWith('/through-the-cracks/api/');
    if (isApi) return handleApi(request, env, url.pathname.replace(/^\/through-the-cracks(?=\/api(?:\/|$))/, ''), url);
    return handleAssets(request, env, url);
  },

  async scheduled(_controller, env, ctx) {
    const task = (async () => {
      const res = await ingestBloggerToD1({
        db: env?.DB,
        blogId: env?.BLOGGER_BLOG_ID || DEFAULT_BLOG_ID,
        apiKey: env?.BLOGGER_API_KEY || '',
        incremental: true,
      });
      clearD1Cache(env?.DB);
      return res;
    })();
    ctx?.waitUntil?.(task);
    return await task;
  },
};
