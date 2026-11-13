// Fetches, normalizes, parses, and merges Through the Cracks Blogger playlists.

const DEFAULT_BLOG_ID = '3469042462299367694';
const DEFAULT_BLOG_URL = 'https://eddirmeyer.blogspot.com';
const TITLE_DATE_RE =
  /Playlist for WEVL's Through The Cracks,\s*(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+)?(\d{1,2}\/\d{1,2}\/\d{4})/i;

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#176;/g, '\u00B0')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8239;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function htmlToLines(html) {
  const withBreaks = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n');
  const stripped = decodeHtmlEntities(withBreaks.replace(/<[^>]*>/g, ''));
  return stripped
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseEpisodeMetadata(post, lines = htmlToLines(post?.content || '')) {
  const title = post?.title || '';
  const content = post?.content || '';
  const titleMatch = title.match(TITLE_DATE_RE);

  let dayOfWeek = null;
  let airDate = post?.published ? String(post.published).slice(0, 10) : null;
  if (titleMatch) {
    dayOfWeek = titleMatch[1] || null;
    const [month, day, year] = titleMatch[2].split('/');
    airDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const epDivMatch = content.match(/<div>#(\d+)<\/div>/);
  const epInlineMatch = !epDivMatch
    ? content.match(/(?:^|\n|<br\s*\/?>|<p[^>]*>)\s*#(\d+)\s*(?:<|$)/i)
    : null;
  const epTrailingMatch =
    !epDivMatch && !epInlineMatch ? lines.at(-1)?.match(/^#?(\d{1,4})$/) : null;
  const epNumMatch = epDivMatch || epInlineMatch || epTrailingMatch;

  return {
    id: String(post?.id ?? ''),
    title,
    airDate,
    dayOfWeek,
    episodeNumber: epNumMatch ? parseInt(epNumMatch[1], 10) : null,
    publishedAt: post?.published || null,
    url: post?.url || null,
  };
}

export function parseSongLine(rawLine, position) {
  let cleaned = String(rawLine || '').replace(/^[-•*]\s*/, '').trim();
  let isInstrumental = false;
  if (/^(?:instrumental\s+|intrumental\s+)?interlude:\s*/i.test(cleaned)) {
    isInstrumental = true;
    cleaned = cleaned.replace(/^(?:instrumental\s+|intrumental\s+)?interlude:\s*/i, '').trim();
  }

  const normalized = cleaned.replace(/\s+-\s+|\s+-|-\s+/g, ' |~| ');
  const parts = normalized.split(' |~| ').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const artist = parts[0];
  let songTitle;
  let album;
  if (parts.length >= 3) {
    album = parts[parts.length - 1];
    songTitle = parts.slice(1, -1).join(' - ');
  } else {
    songTitle = parts[1];
    album = isInstrumental ? 'Instrumental Interlude' : '[Single / Track]';
  }

  if (isInstrumental && parts.length >= 3 && !album.toLowerCase().includes('interlude')) {
    album = `${album} (Instrumental Interlude)`;
  }

  const artistLower = artist.toLowerCase();
  if (
    artistLower.includes('playlist for') ||
    artist.startsWith('#') ||
    artistLower.includes('thanksgiving saturday') ||
    artistLower.includes('anniversary special')
  ) {
    return null;
  }

  return { position, rawLine, artist, songTitle, album };
}

export function parsePost(post) {
  const lines = htmlToLines(post?.content || '');
  const episode = parseEpisodeMetadata(post, lines);
  const songLines = lines.filter(
    (line) => !/^#\d+/.test(line) && !/^\d+$/.test(line) && !/^playlist for/i.test(line),
  );

  const songs = [];
  for (const line of songLines) {
    const parsed = parseSongLine(line, songs.length + 1);
    if (parsed) songs.push(parsed);
  }
  return { episode, songs };
}

const readText = (v) => (typeof v === 'string' ? v : v?.$t ?? '');

export function normalizeAtomFeedEntry(entry) {
  const rawHref = (entry?.link || []).find((l) => l.rel === 'alternate')?.href || null;
  const url = rawHref
    ? rawHref.replace(/^http:\/\/eddirmeyer\.blogspot\.com/i, 'https://eddirmeyer.blogspot.com')
    : null;
  return {
    id: String(readText(entry?.id)).split('post-').pop(),
    title: readText(entry?.title),
    content: readText(entry?.content),
    published: readText(entry?.published),
    updated: readText(entry?.updated),
    url,
  };
}

export function computeIncrementalStartDate(episodes, lookbackDays = 14) {
  let maxAirDate = '';
  for (const ep of episodes || []) {
    if (ep?.airDate && /^\d{4}-\d{2}-\d{2}$/.test(ep.airDate) && ep.airDate > maxAirDate) {
      maxAirDate = ep.airDate;
    }
  }
  if (!maxAirDate) return null;
  const cutoffMs = Date.parse(`${maxAirDate}T00:00:00.000Z`) - lookbackDays * 86_400_000;
  return new Date(cutoffMs).toISOString();
}

export function mergeIncrementalEpisodes(existingEpisodes, parsedPosts) {
  const byId = new Map();
  for (const ep of existingEpisodes || []) {
    if (ep?.id !== undefined && ep?.id !== null) {
      byId.set(String(ep.id), { ...ep, id: String(ep.id) });
    }
  }
  for (const item of parsedPosts || []) {
    const ep = item.episode ?? item;
    const id = String(ep.id);
    const songs = item.songs || ep.songs || [];
    byId.set(id, { ...ep, id, songCount: songs.length, songs });
  }
  return Array.from(byId.values()).sort(
    (a, b) => (b.airDate || '').localeCompare(a.airDate || '') || b.id.localeCompare(a.id),
  );
}

async function fetchViaBloggerApi(blogId, apiKey, startDateIso) {
  const baseUrl = `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`;
  const posts = [];
  let pageToken = null;
  while (true) {
    const params = new URLSearchParams({
      key: apiKey,
      maxResults: '50',
      fields: 'items(id,title,content,published,updated,url),nextPageToken',
      orderBy: 'published',
    });
    if (startDateIso) params.set('startDate', startDateIso);
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(`${baseUrl}?${params}`);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Blogger API HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    posts.push(...(data.items || []));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    await new Promise((r) => setTimeout(r, 100));
  }
  return posts;
}

async function fetchViaAtomFeed(blogUrl, startDateIso) {
  const posts = [];
  let startIndex = 1;
  while (true) {
    const params = new URLSearchParams({
      alt: 'json',
      'max-results': '150',
      'start-index': String(startIndex),
    });
    if (startDateIso) params.set('published-min', startDateIso);

    const response = await fetch(`${blogUrl}/feeds/posts/default?${params}`);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Blogger Atom feed HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    const entries = data.feed?.entry || [];
    for (const entry of entries) posts.push(normalizeAtomFeedEntry(entry));

    const totalResults = Number(data.feed?.openSearch$totalResults?.$t ?? 0);
    startIndex += entries.length;
    if (entries.length < 150 || (totalResults > 0 && startIndex > totalResults)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return posts;
}

export async function fetchBloggerPosts({
  blogId = DEFAULT_BLOG_ID,
  apiKey = '',
  startDateIso = null,
  blogUrl = DEFAULT_BLOG_URL,
} = {}) {
  if (apiKey) {
    try {
      return await fetchViaBloggerApi(blogId, apiKey, startDateIso);
    } catch (err) {
      console.warn(`⚠️  Blogger API v3 unavailable (${err.message}); falling back to Atom feed...`);
    }
  }
  return fetchViaAtomFeed(blogUrl, startDateIso);
}
