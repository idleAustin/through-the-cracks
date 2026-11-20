#!/usr/bin/env node
// Fast CI preflight check: skips scheduled workflow builds unless Blogger, prod, or Atlas need refreshing.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getExpectedLatestBroadcastDate,
  isArchiveUpToDate,
  isPrimaryMaintenanceWindow,
} from '../server/broadcastSchedule.js';
import { normalizeAtomFeedEntry, parseEpisodeMetadata } from './blogger-parser.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const DEFAULT_API_BASE = 'https://idleamericana.com/through-the-cracks/api';
export const DEFAULT_BLOG_URL = 'https://eddirmeyer.blogspot.com';
const FETCH_TIMEOUT_MS = 8000;

async function fetchJsonSafe(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res?.ok) return { ok: false, status: res?.status ?? 0, data: null };
    const data = await res.json().catch(() => null);
    return { ok: data !== null && typeof data === 'object', status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

const validIsoDate = (val) => (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : '');

function findLatestBloggerPost(feedJson) {
  const entries = Array.isArray(feedJson?.feed?.entry) ? feedJson.feed.entry : [];
  let latestDate = '';
  let latestId = '';
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    try {
      const safeEntry = Array.isArray(rawEntry.link) ? rawEntry : { ...rawEntry, link: [] };
      const post = normalizeAtomFeedEntry(safeEntry);
      if (typeof post?.title !== 'string' || !post.title.toLowerCase().includes('through the cracks')) continue;
      const meta = parseEpisodeMetadata(post);
      const airDate = validIsoDate(meta?.airDate);
      const postId = String(post.id || '');
      if (!airDate) continue;
      if (airDate > latestDate || (airDate === latestDate && postId > latestId)) {
        latestDate = airDate;
        latestId = postId;
      }
    } catch {
      continue;
    }
  }
  return { latestDate, latestId };
}

function isNewerEpisode(candidateDate, candidateId, baselineDate, baselineId) {
  if (!candidateDate) return false;
  if (!baselineDate) return true;
  if (candidateDate > baselineDate) return true;
  return Boolean(
    candidateDate === baselineDate && candidateId && baselineId && candidateId !== baselineId,
  );
}

/**
 * Determine whether a scheduled CI run needs to execute ingest, metadata enrichment, and Worker deploy.
 */
export async function evaluateRefreshNeeded({
  snapshotOverview = null,
  now = new Date(),
  apiBase = DEFAULT_API_BASE,
  blogUrl = DEFAULT_BLOG_URL,
  fetchImpl = globalThis.fetch,
  forcePrimaryFailOpen = true,
} = {}) {
  const expectedBroadcastDate = getExpectedLatestBroadcastDate(now);
  const snapshotLatestDate = validIsoDate(snapshotOverview?.dateRange?.latest);
  const snapshotLatestId = String(snapshotOverview?.latestEpisodeId || '');

  const [ovRes, atlasRes] = await Promise.all([
    fetchJsonSafe(`${apiBase}/overview`, fetchImpl),
    fetchJsonSafe(`${apiBase}/atlas`, fetchImpl),
  ]);
  const prodLatestDate = validIsoDate(ovRes.data?.dateRange?.latest);
  const prodLatestId = String(ovRes.data?.latestEpisodeId || '');
  const atlasOk = Boolean(atlasRes.ok && Number(atlasRes.data?.summary?.totalSongs ?? 0) > 0);

  const out = (shouldRun, reason, bloggerLatestDate = null) => ({
    shouldRun,
    reason,
    expectedBroadcastDate,
    snapshotLatestDate: snapshotLatestDate || null,
    prodLatestDate: prodLatestDate || null,
    bloggerLatestDate,
    atlasOk,
  });

  if (!atlasOk) return out(true, 'atlas_unhealthy');
  if (snapshotLatestDate && (!prodLatestDate || prodLatestDate < snapshotLatestDate)) {
    return out(true, 'prod_behind_snapshot');
  }

  const blogRes = await fetchJsonSafe(`${blogUrl}/feeds/posts/default?alt=json&max-results=5`, fetchImpl);
  if (!blogRes.ok) {
    const primaryFailOpen = Boolean(forcePrimaryFailOpen && isPrimaryMaintenanceWindow(now));
    return out(primaryFailOpen, primaryFailOpen ? 'blogger_check_failed_primary_window' : 'blogger_check_failed_retry_later');
  }

  const { latestDate: bloggerLatestDate, latestId: bloggerLatestId } = findLatestBloggerPost(blogRes.data);
  if (isNewerEpisode(bloggerLatestDate, bloggerLatestId, snapshotLatestDate, snapshotLatestId)) {
    return out(true, 'new_blog_post_detected', bloggerLatestDate || null);
  }
  if (isNewerEpisode(bloggerLatestDate, bloggerLatestId, prodLatestDate, prodLatestId)) {
    return out(true, 'prod_behind_blogger', bloggerLatestDate || null);
  }
  if (isArchiveUpToDate(snapshotLatestDate, now)) {
    return out(false, 'up_to_date', bloggerLatestDate || null);
  }
  return out(false, 'no_new_blog_post_yet', bloggerLatestDate || null);
}

function readSnapshotOverview(argv) {
  if (argv.includes('--stdin-snapshot')) {
    try {
      const raw = readFileSync(0, 'utf8').trim();
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  const arg = argv.find((a) => a.startsWith('--snapshot='));
  const filePath = arg ? path.resolve(arg.slice('--snapshot='.length)) : path.join(ROOT, 'public', 'data', 'overview.json');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const snapshotOverview = readSnapshotOverview(process.argv.slice(2));
  const result = await evaluateRefreshNeeded({ snapshotOverview });
  console.log(JSON.stringify(result));
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('Refresh check error:', err?.message || err);
    process.exit(1);
  });
}
