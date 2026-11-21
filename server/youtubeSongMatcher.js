// Pure Web-API-only YouTube Data API v3 snippet scorer, ISO-8601 duration parser, and playability evaluator.

export const DISQUALIFIERS = [
  'cover', 'karaoke', 'instrumental', 'tribute', 'reaction', 'lesson',
  'tutorial', 'guitar tab', 'bass cover', 'nightcore', 'slowed',
  'skit', 'interlude', 'intro', 'outro',
];

export const VARIANT_KEYWORDS = ['live', 'acoustic', 'demo', 'remix', 'session', 'tiny desk', 'kexp'];

const TOPIC_SUFFIX_RE = /\s*-\s*Topic$/i;
const ISO_DURATION_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;
const OFFICIAL_CHANNEL_TAG_RE = /\b(?:official|music|channel|vevo)\b/gi;
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsOf = (v) => String(v ?? '').split(/\s+/).filter(Boolean);

export function decodeBasicHtmlEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (Object.hasOwn(HTML_ENTITIES, lower)) return HTML_ENTITIES[lower];
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

export const isTopicChannel = (channelTitle) => TOPIC_SUFFIX_RE.test(String(channelTitle ?? '').trim());
export const stripTopicSuffix = (channelTitle) => String(channelTitle ?? '').trim().replace(TOPIC_SUFFIX_RE, '').trim();

export function normalizeMatchText(text) {
  return decodeBasicHtmlEntities(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip parenthetical/bracketed suffixes and featuring clauses for looser YouTube fallback search queries.
 */
export function stripSearchQueryNoise(text) {
  return decodeBasicHtmlEntities(text)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    .replace(/\bw\/.*$/i, ' ')
    .replace(/["“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build bounded, deduplicated fallback YouTube search queries when the primary artist+title query misses.
 */
export function buildFallbackSearchQueries(song, { pass1Empty = false, maxQueries = 2 } = {}) {
  const limit = Math.max(0, Math.trunc(Number(maxQueries) || 0));
  if (limit === 0) return [];
  const rawArtist = String(song?.artist ?? '').trim();
  const rawTitle = String(song?.song_title ?? song?.songTitle ?? '').trim();
  const rawQuery = `${rawArtist} ${rawTitle}`.replace(/\s+/g, ' ').trim();
  const stripQuotes = (v) => decodeBasicHtmlEntities(v).replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanArtist = stripSearchQueryNoise(rawArtist) || stripQuotes(rawArtist);
  const cleanTitle = stripSearchQueryNoise(rawTitle) || stripQuotes(rawTitle);
  if (!cleanArtist || !cleanTitle) return [];

  const queries = [];
  const seen = new Set([rawQuery.toLowerCase()]);
  const add = (candidate) => {
    if (queries.length >= limit) return;
    const normalized = String(candidate || '').replace(/\s+/g, ' ').trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    queries.push(normalized);
  };

  add(`${cleanArtist} ${cleanTitle}`);
  if (pass1Empty) {
    const clauses = cleanTitle.split(/\s*[,;:/]\s*/).map((s) => s.trim()).filter(Boolean);
    if (clauses.length >= 2) {
      add(`${cleanArtist} ${clauses[clauses.length - 1]}`);
      add(`${cleanArtist} ${clauses[0]}`);
    } else {
      const words = cleanTitle.replace(/[,;:/]+/g, ' ').split(/\s+/).filter(Boolean);
      if (words.length >= 3) {
        const mid = Math.floor(words.length / 2);
        add(`${cleanArtist} ${words.slice(mid).join(' ')}`);
        add(`${cleanArtist} ${words.slice(0, mid).join(' ')}`);
      }
    }
  } else {
    add(`"${cleanArtist}" ${cleanTitle}`);
  }
  return queries;
}

export function levenshteinSimilarity(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  if (!s1 && !s2) return 100;
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 100;

  const m = s1.length;
  const n = s2.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return (1 - prev[n] / Math.max(m, n)) * 100;
}

export function diceSimilarity(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  if (!s1 && !s2) return 100;
  if (s1 === s2) return 100;
  if (s1.length < 2 || s2.length < 2) return 0;

  const counts = new Map();
  for (let i = 0; i < s1.length - 1; i += 1) {
    const bg = s1.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < s2.length - 1; i += 1) {
    const bg = s2.slice(i, i + 2);
    const n = counts.get(bg) || 0;
    if (n > 0) {
      overlap += 1;
      counts.set(bg, n - 1);
    }
  }
  return (2 * overlap * 100) / (s1.length + s2.length - 2);
}

export function tokenSortSimilarity(a, b) {
  const sa = wordsOf(a).sort().join(' ');
  const sb = wordsOf(b).sort().join(' ');
  return Math.max(levenshteinSimilarity(sa, sb), diceSimilarity(sa, sb));
}

export function tokenSetSimilarity(a, b) {
  const tokA = new Set(wordsOf(a));
  const tokB = new Set(wordsOf(b));
  if (tokA.size === 0 && tokB.size === 0) return 100;
  if (tokA.size === 0 || tokB.size === 0) return 0;

  const inter = [...tokA].filter((t) => tokB.has(t)).sort();
  if (inter.length === 0) return tokenSortSimilarity(a, b);
  const diffA = [...tokA].filter((t) => !tokB.has(t)).sort();
  const diffB = [...tokB].filter((t) => !tokA.has(t)).sort();
  const sect = inter.join(' ');
  const combA = [...inter, ...diffA].join(' ');
  const combB = [...inter, ...diffB].join(' ');
  return Math.max(levenshteinSimilarity(sect, combA), levenshteinSimilarity(sect, combB), levenshteinSimilarity(combA, combB));
}

export function tierForScore(score, videoId) {
  if (!videoId || score <= 0) return 'unmatched';
  if (score >= 85) return 'high';
  if (score >= 65) return 'medium';
  return 'low';
}

export function parseIsoDuration(iso) {
  if (typeof iso !== 'string') return null;
  const trimmed = iso.trim();
  const match = trimmed ? trimmed.match(ISO_DURATION_RE) : null;
  if (!match) return null;
  const [, d, h, m, s] = match;
  if (d === undefined && h === undefined && m === undefined && s === undefined) return null;
  const total = Number(d || 0) * 86_400 + Number(h || 0) * 3_600 + Number(m || 0) * 60 + Number(s || 0);
  return Number.isFinite(total) ? Math.trunc(total) : null;
}

export function isUsPlayableRegion(regionRestriction) {
  if (!regionRestriction || typeof regionRestriction !== 'object') return true;
  const { allowed, blocked } = regionRestriction;
  if (Array.isArray(blocked) && blocked.includes('US')) return false;
  if (Array.isArray(allowed) && !allowed.includes('US')) return false;
  return true;
}

function buildTitleCandidates(rawYtTitle, normYtTitle, normArchArtist) {
  const candidates = new Set();
  if (normYtTitle) candidates.add(normYtTitle);
  if (normArchArtist) {
    const stripped = normYtTitle
      .replace(new RegExp(`\\b${escapeRegex(normArchArtist)}\\b`, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^the\s+/, '')
      .trim();
    if (stripped) candidates.add(stripped);
  }
  for (const part of String(rawYtTitle).split(/\s+[-–—|·]\s+/)) {
    const normPart = normalizeMatchText(part);
    if (normPart && normPart !== normArchArtist) candidates.add(normPart);
  }
  return [...candidates];
}

function scoreTitleSimilarity(normArchTitle, candidates) {
  if (!normArchTitle) return { sim: 0, exact: false };
  let best = 0;
  for (const cand of candidates) {
    if (cand === normArchTitle) return { sim: 100, exact: true };
    const sim = Math.max(
      levenshteinSimilarity(normArchTitle, cand),
      tokenSortSimilarity(normArchTitle, cand),
      diceSimilarity(normArchTitle, cand) * 0.9,
    );
    if (sim > best) best = sim;
  }
  return { sim: best, exact: false };
}

function scoreChannelArtist(strippedChannel, normArchArtist) {
  if (!strippedChannel || !normArchArtist) return { strictSim: 0, broadSim: 0, exact: false };
  const normChan = normalizeMatchText(strippedChannel);
  if (!normChan) return { strictSim: 0, broadSim: 0, exact: false };

  const chanCore = normChan.replace(OFFICIAL_CHANNEL_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
  const compactArch = normArchArtist.replace(/\s+/g, '');
  const compactChan = (chanCore || normChan).replace(/\s+/g, '').replace(/(?:vevo|official)$/i, '');
  if (normChan === normArchArtist || chanCore === normArchArtist || compactChan === compactArch) {
    return { strictSim: 100, broadSim: 100, exact: true };
  }
  const target = chanCore || normChan;
  const strictSim = Math.max(levenshteinSimilarity(normArchArtist, target), tokenSortSimilarity(normArchArtist, target));
  return { strictSim, broadSim: Math.max(strictSim, tokenSetSimilarity(normArchArtist, normChan)), exact: false };
}

function scoreTitleArtist(rawYtTitle, normYtTitle, normArchArtist) {
  if (!normArchArtist) return 0;
  let best = 0;
  for (const part of String(rawYtTitle).split(/\s+[-–—|·]\s+/)) {
    const normPart = normalizeMatchText(part);
    if (!normPart) continue;
    if (normPart === normArchArtist) return 95;
    best = Math.max(best, tokenSortSimilarity(normArchArtist, normPart));
  }
  if (new RegExp(`\\b${escapeRegex(normArchArtist)}\\b`).test(normYtTitle)) best = Math.max(best, 90);
  return best;
}

export function scoreSearchCandidate(song, item, options = {}) {
  const archTitle = String(song?.song_title ?? song?.songTitle ?? '').trim();
  const archArtist = String(song?.artist ?? '').trim();
  const videoId = String(item?.id?.videoId ?? item?.videoId ?? '').trim();
  if (!videoId) return { score: 0, rejected: 'missing_video_id', matchTier: 'unmatched' };

  const rawYtTitle = decodeBasicHtmlEntities(item?.snippet?.title ?? '').trim();
  const rawChannel = decodeBasicHtmlEntities(item?.snippet?.channelTitle ?? '').trim();
  const topic = isTopicChannel(rawChannel);
  const strippedChannel = stripTopicSuffix(rawChannel);
  const resultType = topic ? 'song' : 'video';

  const normArchTitle = normalizeMatchText(archTitle);
  const normArchArtist = normalizeMatchText(archArtist);
  const normYtTitle = normalizeMatchText(rawYtTitle);
  const titleMatch = scoreTitleSimilarity(normArchTitle, buildTitleCandidates(rawYtTitle, normYtTitle, normArchArtist));

  const titlePts = titleMatch.exact ? 35 : titleMatch.sim >= 90 ? 30 : titleMatch.sim >= 80 ? 24 : titleMatch.sim >= 70 ? 16 : titleMatch.sim >= 60 ? 8 : 0;
  if (titlePts === 0) {
    return { score: 0, rejected: 'title_mismatch', videoId, ytTitle: rawYtTitle, ytArtist: strippedChannel || null, resultType, matchTier: 'unmatched', authorityPts: 0 };
  }

  const chanScore = scoreChannelArtist(strippedChannel, normArchArtist);
  const titleArtistSim = scoreTitleArtist(rawYtTitle, normYtTitle, normArchArtist);
  const bestArtistSim = Math.max(chanScore.broadSim, titleArtistSim);

  const artistPts = chanScore.exact || chanScore.strictSim >= 92 ? 35 : chanScore.broadSim >= 85 || titleArtistSim >= 85 ? 30 : bestArtistSim >= 65 ? 18 : 0;
  if (artistPts === 0) {
    return { score: 0, rejected: 'artist_mismatch', videoId, ytTitle: rawYtTitle, ytArtist: strippedChannel || null, resultType, matchTier: 'unmatched', authorityPts: 0 };
  }

  const officialChannelMatch = chanScore.exact || chanScore.strictSim >= 85;
  const hasOfficialTag = /\bofficial\b|\bvevo\b/i.test(rawChannel) || /\bofficial\b/i.test(rawYtTitle);
  const authorityPts = officialChannelMatch ? 20 : topic ? 15 : hasOfficialTag ? 10 : 5;

  let penalty = 0;
  const archContext = archTitle.toLowerCase();
  const ytLower = rawYtTitle.toLowerCase();
  for (const kw of DISQUALIFIERS) {
    if (new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i').test(ytLower) && !archContext.includes(kw)) { penalty -= 40; break; }
  }
  for (const kw of VARIANT_KEYWORDS) {
    if (new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i').test(ytLower) && !archContext.includes(kw)) { penalty -= 15; break; }
  }
  const durationSeconds = options?.durationSeconds ?? null;
  if (Number.isFinite(durationSeconds) && (durationSeconds < 60 || durationSeconds > 720)) penalty -= 25;

  const score = Math.max(0, Math.min(100, Math.round(titlePts + artistPts + authorityPts + penalty)));
  return {
    score,
    rejected: null,
    videoId,
    ytTitle: rawYtTitle,
    ytArtist: strippedChannel || null,
    resultType,
    matchTier: tierForScore(score, videoId),
    authorityPts,
    isTopicChannel: topic,
  };
}

export function pickBestSearchCandidate(song, items, options = {}) {
  let best = null;
  for (const item of items || []) {
    const scored = scoreSearchCandidate(song, item, options);
    if (scored.rejected || scored.score <= 0) continue;
    if (!best || scored.score > best.score || (scored.score === best.score && scored.authorityPts > best.authorityPts)) {
      best = scored;
    }
  }
  return best;
}

export function evaluateYouTubeVideoItem(videoItem) {
  if (!videoItem) return { durationSeconds: null, isEmbeddable: 0, usPlayable: 0, statusReason: 'video_missing' };

  const status = videoItem.status || {};
  const contentDetails = videoItem.contentDetails || {};
  const isPublicAndProcessed = status.privacyStatus === 'public' && status.uploadStatus === 'processed';
  const embeddable = status.embeddable === true;
  const usAllowed = isUsPlayableRegion(contentDetails.regionRestriction);
  const durationSeconds = parseIsoDuration(contentDetails.duration);

  let statusReason = 'ok';
  if (!isPublicAndProcessed) statusReason = `privacy:${status.privacyStatus || 'unknown'}/upload:${status.uploadStatus || 'unknown'}`;
  else if (!embeddable) statusReason = 'not_embeddable';
  else if (!usAllowed) statusReason = 'us_blocked';

  return {
    durationSeconds,
    isEmbeddable: isPublicAndProcessed && embeddable ? 1 : 0,
    usPlayable: isPublicAndProcessed && usAllowed ? 1 : 0,
    statusReason,
  };
}

export function classifyYouTubeFailure(response, body = null, err = null) {
  if (err || !response || typeof response !== 'object') return 'network_error';
  const errorObj = body?.error;
  const reasons = Array.isArray(errorObj?.errors) ? errorObj.errors.map((e) => String(e?.reason || '').toLowerCase()) : [];
  const message = String(errorObj?.message || '').toLowerCase();

  if (reasons.some((r) => r.includes('quota') || r === 'dailylimitexceeded') || message.includes('quota')) return 'quota_exceeded';
  if (reasons.some((r) => r.includes('ratelimit'))) return 'http_429';

  const status = Number(response.status);
  const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
  if (!ok) {
    if (status === 429) return 'http_429';
    if (status === 403) return 'http_403';
    if (status >= 500) return `http_${status}`;
    return Number.isFinite(status) && status > 0 ? `http_${status}` : 'http_error';
  }
  return errorObj ? 'youtube_api_error' : null;
}
