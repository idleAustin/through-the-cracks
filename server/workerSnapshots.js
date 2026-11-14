// Cloudflare Worker Edge Cache, optional R2 snapshot reader, and cache-epoch helpers.
import { encodeArtistProfileKey, normalizeArtistKey } from './artistProfileBuilder.js';
import { mapEpisodeRow, stripControlChars } from './d1Rollups.js';
import { computeCappedPagination, parseCapParam, parsePageParams, parseSortParam } from './routes/queryUtils.js';

export { syncR2SnapshotsFromD1 } from './workerSnapshotSync.js';

export const PUBLIC_API_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

const DEFAULT_YEARS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const R2_MANIFEST_TTL_MS = 60_000;
const R2_MANIFEST_KEY = 'v1/manifest.json';
const JSON_CT = 'application/json; charset=utf-8';

let cacheEpoch = 1;
const bucketCache = new WeakMap();

export function bumpWorkerCacheEpoch() {
  cacheEpoch += 1;
  return cacheEpoch;
}

const cmpAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpText = (a, b) => cmpAsc(String(a || '').toLowerCase(), String(b || '').toLowerCase());
const songAlbumsList = (s) => (Array.isArray(s.albums) ? s.albums : s.album ? [s.album] : []);

export function safeDecodeUri(value) {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false, value: '' };
  }
}

export async function withEdgeCache(request, apiPath, url, ctx, makeHeaders, loader) {
  const isCacheable = request.method === 'GET' && apiPath !== '/api/health' && apiPath !== '/api/ingest';
  const cache = isCacheable ? globalThis.caches?.default : null;
  let cacheReq = null;
  if (cache) {
    const entries = Array.from(url.searchParams.entries()).sort(([ak, av], [bk, bv]) => cmpAsc(ak, bk) || cmpAsc(av, bv));
    const qs = new URLSearchParams(entries).toString();
    cacheReq = new Request(`https://edge-cache.through-the-cracks.internal/v${cacheEpoch}${apiPath}${qs ? `?${qs}` : ''}`, { method: 'GET' });
    const hit = await cache.match(cacheReq);
    if (hit) {
      const fresh = typeof hit.clone === 'function' ? hit.clone() : hit;
      const status = fresh.status || 200;
      return new Response(fresh.body, { status, headers: makeHeaders(status) });
    }
  }
  const outcome = await loader();
  const status = outcome?.status ?? 200;
  const body = JSON.stringify(outcome?.data ?? null);
  if (cache && cacheReq && status === 200) {
    const cacheRes = new Response(body, { status: 200, headers: { 'Content-Type': JSON_CT, 'Cache-Control': PUBLIC_API_CACHE_CONTROL } });
    const putTask = Promise.resolve(cache.put(cacheReq, cacheRes)).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(putTask);
    else await putTask;
  }
  return new Response(body, { status, headers: makeHeaders(status, outcome?.extraHeaders) });
}

async function readR2JsonRaw(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return typeof obj.json === 'function' ? obj.json() : JSON.parse(await obj.text());
}

async function getR2State(bucket) {
  let state = bucketCache.get(bucket);
  if (!state || state.epoch !== cacheEpoch) {
    state = { epoch: cacheEpoch, manifest: null, checkedAt: 0, objects: new Map() };
    bucketCache.set(bucket, state);
  }
  const now = Date.now();
  if (state.checkedAt === 0 || now - state.checkedAt >= R2_MANIFEST_TTL_MS) {
    const next = await readR2JsonRaw(bucket, R2_MANIFEST_KEY);
    const prev = state.manifest;
    if (
      !next || !prev || next.updatedAt !== prev.updatedAt || next.totalEpisodes !== prev.totalEpisodes ||
      next.totalSongPlays !== prev.totalSongPlays || next.latestEpisodeId !== prev.latestEpisodeId
    ) {
      state.objects.clear();
    }
    state.manifest = next;
    state.checkedAt = now;
  }
  return state.manifest ? state : null;
}

async function loadR2Shared(bucket, state, key) {
  if (state.objects.has(key)) return state.objects.get(key);
  const data = await readR2JsonRaw(bucket, key);
  if (data !== null) state.objects.set(key, data);
  return data;
}

function findCaseInsensitive(record, targetKey) {
  if (!record || !targetKey) return null;
  if (Object.prototype.hasOwnProperty.call(record, targetKey)) return record[targetKey];
  const needle = targetKey.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === needle) return v;
  }
  return null;
}

const normalizeR2Episode = (ep) => mapEpisodeRow({
  id: ep.id, air_date: ep.air_date ?? ep.airDate ?? '', song_count: ep.song_count ?? ep.songCount ?? 0, url: ep.url || null,
});

function formatOverview(ov) {
  return {
    totalEpisodes: Number(ov.totalEpisodes ?? 0),
    totalSongPlays: Number(ov.totalSongPlays ?? 0),
    uniqueArtists: Number(ov.uniqueArtists ?? 0),
    uniqueAlbums: Number(ov.uniqueAlbums ?? 0),
    uniqueSongs: Number(ov.uniqueSongs ?? 0),
    latestEpisodeId: ov.latestEpisodeId ? String(ov.latestEpisodeId) : null,
    oneSpinArtists: Number(ov.oneSpinArtists ?? 0),
    oneSpinSongs: Number(ov.oneSpinSongs ?? 0),
    dateRange: { earliest: ov.dateRange?.earliest ?? null, latest: ov.dateRange?.latest ?? null },
    topArtists: (ov.topArtists || []).map((r) => ({ name: r.name, plays: Number(r.plays) })),
    topSongs: (ov.topSongs || []).map((r) => ({ artist: r.artist, song: r.song, album: r.album || '', plays: Number(r.plays) })),
  };
}

function serveYearSpinsFromR2(payload, query) {
  const artist = typeof query.artist === 'string' ? query.artist.trim() : '';
  const song = typeof query.song === 'string' ? query.song.trim() : '';
  const years = Array.isArray(payload.years) && payload.years.length > 0 ? payload.years : DEFAULT_YEARS;
  const align = (series) => years.map((_, i) => Number(series?.[i] || 0));
  if (!song && !artist) return { years, spins: align(payload.archive), scope: 'archive', artist: null, song: null };
  if (!song) return { years, spins: align(findCaseInsensitive(payload.artists, artist)), scope: 'artist', artist, song: null };

  let series = artist ? findCaseInsensitive(payload.songs || {}, `${song}\t${artist}`) : null;
  if (!artist) {
    const needle = song.toLowerCase();
    const summed = years.map(() => 0);
    let matched = false;
    for (const [key, counts] of Object.entries(payload.songs || {})) {
      const tab = key.indexOf('\t');
      if ((tab === -1 ? key : key.slice(0, tab)).toLowerCase() === needle && Array.isArray(counts)) {
        matched = true;
        for (let i = 0; i < years.length; i += 1) summed[i] += Number(counts[i] || 0);
      }
    }
    if (matched) series = summed;
  }
  return { years, spins: align(series), scope: 'song', artist: artist || null, song };
}

function serveEpisodesFromR2(indexJson, query) {
  const { page, limit, offset } = parsePageParams(query);
  const year = typeof query.year === 'string' && /^\d{4}$/.test(query.year.trim()) ? query.year.trim() : '';
  const song = typeof query.song === 'string' ? query.song.trim().toLowerCase() : '';
  const artist = typeof query.artist === 'string' ? query.artist.trim().toLowerCase() : '';

  let filtered = indexJson.episodes || [];
  if (song || artist) {
    const matches = new Set();
    const map = indexJson.songEpisodes || {};
    if (song && artist) {
      for (const id of map[`${song}\t${artist}`] || []) matches.add(String(id));
    } else {
      for (const [key, epIds] of Object.entries(map)) {
        const tab = key.indexOf('\t');
        const ks = tab === -1 ? key : key.slice(0, tab);
        const ka = tab === -1 ? '' : key.slice(tab + 1);
        if ((!song || ks === song) && (!artist || ka === artist)) {
          for (const id of epIds) matches.add(String(id));
        }
      }
    }
    filtered = filtered.filter((ep) => matches.has(String(ep.id)));
  }
  if (year) filtered = filtered.filter((ep) => String(ep.air_date ?? ep.airDate ?? '').startsWith(year));
  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit).map(normalizeR2Episode);
  return { items, episodes: items, total, page, limit, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

function paginateCatalog(list, query, { matches, compare, mapItem, resultKey }) {
  const search = stripControlChars(typeof query.search === 'string' ? query.search : '').trim().toLowerCase();
  const sort = parseSortParam(query.sort);
  const cap = parseCapParam(query.cap);
  const { page, limit } = parsePageParams(query);
  const filtered = search ? list.filter((item) => matches(item, search)) : list;
  const sorted = [...filtered].sort((a, b) => {
    const pa = Number(a.totalPlays || 0);
    const pb = Number(b.totalPlays || 0);
    return (sort === 'obscure' ? pa - pb : pb - pa) || compare(a, b, sort);
  });
  const { total, effectiveLimit, offset, totalPages } = computeCappedPagination({ rawTotal: sorted.length, cap, page, limit });
  const items = (effectiveLimit > 0 ? sorted.slice(offset, offset + effectiveLimit) : []).map(mapItem);
  return { items, [resultKey]: items, total, unboundedTotal: sorted.length, page, limit, pagination: { page, limit, total, totalPages } };
}

function serveArtistSongsFromR2(songs, albumsJson, artistName) {
  const needle = normalizeArtistKey(artistName);
  const mappedSongs = songs
    .filter((s) => normalizeArtistKey(s.artist) === needle)
    .map((s) => {
      const songAlbums = [...new Set(songAlbumsList(s).map((x) => String(x || '').trim()).filter(Boolean))];
      return {
        songTitle: s.songTitle,
        album: s.album || songAlbums[0] || '',
        albums: songAlbums,
        totalPlays: Number(s.totalPlays || 0),
        firstPlayed: s.firstPlayed ?? s.firstAppearance ?? '',
        lastPlayed: s.lastPlayed ?? s.lastAppearance ?? '',
      };
    })
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpText(a.songTitle, b.songTitle));

  const albums = albumsJson
    .filter((al) => normalizeArtistKey(al.artist) === needle && al.album)
    .sort((a, b) => (Number(b.totalPlays || 0) - Number(a.totalPlays || 0)) || cmpText(a.album, b.album))
    .map((al) => al.album);

  let firstAppearance = '';
  let lastAppearance = '';
  let totalPlays = 0;
  for (const s of mappedSongs) {
    totalPlays += s.totalPlays;
    if (s.firstPlayed && (!firstAppearance || s.firstPlayed < firstAppearance)) firstAppearance = s.firstPlayed;
    if (s.lastPlayed && (!lastAppearance || s.lastPlayed > lastAppearance)) lastAppearance = s.lastPlayed;
  }
  return { artist: artistName, summary: { totalPlays, uniqueSongs: mappedSongs.length, uniqueAlbums: albums.length, firstAppearance, lastAppearance }, albums, songs: mappedSongs };
}

function serveSearchFromR2(artists, songs, albums, q) {
  return {
    artists: artists.filter((a) => String(a.name || '').toLowerCase().includes(q))
      .sort((a, b) => (Number(b.totalPlays || 0) - Number(a.totalPlays || 0)) || cmpText(a.name, b.name)).slice(0, 10)
      .map((a) => ({ name: a.name, plays: Number(a.totalPlays || 0), uniqueSongs: Number(a.uniqueSongs ?? 0) })),
    songs: songs.filter((s) => String(s.songTitle || '').toLowerCase().includes(q) || (Array.isArray(s.featuredArtists) && s.featuredArtists.some((fa) => String(fa ?? '').toLowerCase().includes(q))))
      .sort((a, b) => (Number(b.totalPlays || 0) - Number(a.totalPlays || 0)) || cmpText(a.songTitle, b.songTitle) || cmpText(a.artist, b.artist)).slice(0, 10)
      .map((s) => ({ artist: s.artist, songTitle: s.songTitle, album: s.album || s.albums?.[0] || '', plays: Number(s.totalPlays || 0) })),
    albums: albums.filter((al) => String(al.album || '').toLowerCase().includes(q))
      .sort((a, b) => (Number(b.totalPlays || 0) - Number(a.totalPlays || 0)) || cmpText(a.artist, b.artist) || cmpText(a.album, b.album)).slice(0, 10)
      .map((al) => ({ artist: al.artist, album: al.album, plays: Number(al.totalPlays || 0) })),
  };
}

export async function tryServeFromR2(apiPath, query = {}, env = {}, _ctx = null) {
  const bucket = env?.SNAPSHOT_BUCKET;
  if (!bucket) return null;

  const epMatch = apiPath.match(/^\/api\/episodes\/([^/]+)$/);
  const profileMatch = apiPath.match(/^\/api\/artists\/([^/]+)\/profile$/);
  const artistMatch = apiPath.match(/^\/api\/artists\/([^/]+)\/songs$/);
  const epDec = epMatch ? safeDecodeUri(epMatch[1]) : null;
  const profDec = profileMatch ? safeDecodeUri(profileMatch[1]) : null;
  const artDec = artistMatch ? safeDecodeUri(artistMatch[1]) : null;
  if (epDec && !epDec.ok) return { status: 400, data: { error: 'Invalid episode id' } };
  if (profDec && !profDec.ok) return { status: 400, data: { error: 'Invalid artist name' } };
  if (profDec && !profDec.value.trim()) return { status: 400, data: { error: 'Artist name is required' } };
  if (artDec && !artDec.ok) return { status: 400, data: { error: 'Invalid artist name' } };

  const state = await getR2State(bucket);
  if (!state) return null;

  if (apiPath === '/api/overview') {
    const ov = await loadR2Shared(bucket, state, 'v1/overview.json');
    return ov ? { status: 200, data: formatOverview(ov) } : null;
  }
  if (apiPath === '/api/years') {
    const ys = await loadR2Shared(bucket, state, 'v1/year-spins.json');
    return ys ? { status: 200, data: serveYearSpinsFromR2(ys, query) } : null;
  }
  if (apiPath === '/api/episodes') {
    const idx = await loadR2Shared(bucket, state, 'v1/episodes-index.json');
    return idx ? { status: 200, data: serveEpisodesFromR2(idx, query) } : null;
  }
  if (epDec) {
    const idx = await loadR2Shared(bucket, state, 'v1/episodes-index.json');
    if (!idx) return null;
    const summary = (idx.episodes || []).find((ep) => String(ep.id) === epDec.value);
    if (!summary) return { status: 404, data: { error: 'Episode not found' } };
    const year = String(summary.air_date ?? summary.airDate ?? '').slice(0, 4);
    const shard = /^\d{4}$/.test(year) ? await loadR2Shared(bucket, state, `v1/playlists/${year}.json`) : null;
    if (!shard) return null;
    const playlist = (shard[epDec.value] || []).map((s, i) => {
      const title = s.songTitle ?? s.song_title ?? s.song ?? '';
      const feat = s.featuredArtist || s.featured_artist || '';
      const kind = s.releaseKind || s.release_kind || '';
      return {
        position: Number(s.position ?? i + 1), song: s.song ?? title, songTitle: title, artist: s.artist || '',
        ...(feat ? { featuredArtist: feat } : {}), album: s.album || '', ...(kind && kind !== 'album' ? { releaseKind: kind } : {}),
      };
    });
    return { status: 200, data: { ...normalizeR2Episode(summary), playlist, songs: playlist } };
  }
  if (apiPath === '/api/artists') {
    const artists = await loadR2Shared(bucket, state, 'v1/artists.json');
    return artists ? { status: 200, data: paginateCatalog(artists, query, {
      resultKey: 'artists',
      matches: (a, q) => String(a.name || '').toLowerCase().includes(q),
      compare: (a, b, s) => (s === 'obscure' ? cmpAsc(a.firstAppearance || '', b.firstAppearance || '') : 0) || cmpText(a.name, b.name),
      mapItem: (a) => ({ name: a.name, totalPlays: Number(a.totalPlays ?? 0), uniqueSongs: Number(a.uniqueSongs ?? 0), uniqueAlbums: Number(a.uniqueAlbums ?? 0), firstAppearance: a.firstAppearance || '', lastAppearance: a.lastAppearance || '' }),
    }) } : null;
  }
  if (apiPath === '/api/songs') {
    const songs = await loadR2Shared(bucket, state, 'v1/songs.json');
    return songs ? { status: 200, data: paginateCatalog(songs, query, {
      resultKey: 'songs',
      matches: (s, q) => String(s.songTitle || '').toLowerCase().includes(q) || String(s.artist || '').toLowerCase().includes(q) || (Array.isArray(s.featuredArtists) && s.featuredArtists.some((fa) => String(fa ?? '').toLowerCase().includes(q))) || songAlbumsList(s).some((alb) => String(alb || '').toLowerCase().includes(q)),
      compare: (a, b, s) => (s === 'obscure' ? cmpAsc(a.firstPlayed ?? a.firstAppearance ?? '', b.firstPlayed ?? b.firstAppearance ?? '') : 0) || cmpText(a.songTitle, b.songTitle) || cmpText(a.artist, b.artist),
      mapItem: (s) => ({ artist: s.artist, songTitle: s.songTitle, album: s.album || s.albums?.[0] || '', totalPlays: Number(s.totalPlays || 0), firstPlayed: s.firstPlayed ?? s.firstAppearance ?? '', lastPlayed: s.lastPlayed ?? s.lastAppearance ?? '' }),
    }) } : null;
  }
  if (artDec) {
    const [songs, albums] = await Promise.all([loadR2Shared(bucket, state, 'v1/songs.json'), loadR2Shared(bucket, state, 'v1/albums.json')]);
    return songs && albums ? { status: 200, data: serveArtistSongsFromR2(songs, albums, artDec.value) } : null;
  }
  if (profDec) {
    const profile = await readR2JsonRaw(bucket, `v1/artist-profiles/${encodeArtistProfileKey(profDec.value)}.json`);
    if (profile) {
      const fresh = profile.archive?.totalSpins === state.manifest.totalSongPlays && profile.archive?.totalEpisodes === state.manifest.totalEpisodes;
      return fresh || !env?.DB ? { status: 200, data: profile } : null;
    }
    if (!env?.DB) return { status: 404, data: { error: 'Artist not found' } };
    const artists = await loadR2Shared(bucket, state, 'v1/artists.json');
    if (!artists) return null;
    const needle = normalizeArtistKey(profDec.value);
    return artists.some((a) => normalizeArtistKey(a.name) === needle) ? null : { status: 404, data: { error: 'Artist not found' } };
  }
  if (apiPath === '/api/search') {
    const q = stripControlChars(typeof query.q === 'string' ? query.q : '').trim().slice(0, 120).toLowerCase();
    if (!q || q.length < 2) return { status: 200, data: { artists: [], songs: [], albums: [] } };
    const [artists, songs, albums] = await Promise.all([
      loadR2Shared(bucket, state, 'v1/artists.json'), loadR2Shared(bucket, state, 'v1/songs.json'), loadR2Shared(bucket, state, 'v1/albums.json'),
    ]);
    return artists && songs && albums ? { status: 200, data: serveSearchFromR2(artists, songs, albums, q) } : null;
  }
  return null;
}
