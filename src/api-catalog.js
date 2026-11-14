// Static JSON fallback helpers, sorting, depth caps, and pagination for Artists, Songs, and Search.
import { encodeArtistProfileKey, normalizeArtistKey } from '../server/artistProfileBuilder.js';
import { fetchStaticJson, fetchStaticJsonAllow404 } from './api-static.js';

export function parseCatalogOptions(optionsOrSearch = '', maybePage = 1, maybeLimit = 25) {
  if (typeof optionsOrSearch === 'object' && optionsOrSearch !== null) {
    const rawCap = optionsOrSearch.cap;
    const capNum = rawCap !== undefined && rawCap !== null && rawCap !== '' && rawCap !== 'all'
      ? Number(rawCap)
      : null;
    return {
      search: String(optionsOrSearch.search || '').trim(),
      sort: optionsOrSearch.sort === 'obscure' ? 'obscure' : 'top',
      cap: Number.isInteger(capNum) && capNum > 0 ? capNum : null,
      page: Math.max(1, parseInt(optionsOrSearch.page ?? 1, 10) || 1),
      limit: Math.max(1, parseInt(optionsOrSearch.limit ?? 25, 10) || 25),
    };
  }
  return {
    search: String(optionsOrSearch || '').trim(),
    sort: 'top',
    cap: null,
    page: Math.max(1, parseInt(maybePage ?? 1, 10) || 1),
    limit: Math.max(1, parseInt(maybeLimit ?? 25, 10) || 25),
  };
}

function compareDateAsc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return String(a).localeCompare(String(b));
}

function sortArtists(list, sort) {
  return [...list].sort((a, b) => {
    const playsA = Number(a.totalPlays || 0);
    const playsB = Number(b.totalPlays || 0);
    if (sort === 'obscure') {
      return (
        playsA - playsB
        || compareDateAsc(a.firstAppearance, b.firstAppearance)
        || String(a.name || '').localeCompare(String(b.name || ''))
      );
    }
    return playsB - playsA || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

export function sortSongs(list, sort) {
  return [...list].sort((a, b) => {
    const playsA = Number(a.totalPlays || 0);
    const playsB = Number(b.totalPlays || 0);
    const firstA = a.firstPlayed || a.firstAppearance || '';
    const firstB = b.firstPlayed || b.firstAppearance || '';
    if (sort === 'obscure') {
      return (
        playsA - playsB
        || compareDateAsc(firstA, firstB)
        || String(a.songTitle || '').localeCompare(String(b.songTitle || ''))
        || String(a.artist || '').localeCompare(String(b.artist || ''))
      );
    }
    return (
      playsB - playsA
      || String(a.songTitle || '').localeCompare(String(b.songTitle || ''))
      || String(a.artist || '').localeCompare(String(b.artist || ''))
    );
  });
}

function paginateCapped(sortedItems, cap, page, limit) {
  const unboundedTotal = sortedItems.length;
  const cappedItems = cap ? sortedItems.slice(0, cap) : sortedItems;
  const total = cappedItems.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const items = cappedItems.slice(offset, offset + limit);
  return {
    items,
    total,
    unboundedTotal,
    page,
    limit,
    pagination: { page, limit, total, totalPages },
  };
}

export async function getStaticArtists({ search, sort, cap, page, limit }) {
  const allArtists = await fetchStaticJson('/data/artists.json');
  const q = search.toLowerCase();
  const filtered = q
    ? allArtists.filter((a) => String(a.name || '').toLowerCase().includes(q))
    : allArtists;
  const sorted = sortArtists(filtered, sort);
  const paged = paginateCapped(sorted, cap, page, limit);
  return { ...paged, artists: paged.items };
}

export async function getStaticSongs({ search, sort, cap, page, limit }) {
  const allSongs = await fetchStaticJson('/data/songs.json');
  const q = search.toLowerCase();
  const filtered = q
    ? allSongs.filter((s) => {
      if (String(s.songTitle || '').toLowerCase().includes(q)) return true;
      if (String(s.artist || '').toLowerCase().includes(q)) return true;
      if (Array.isArray(s.featuredArtists) && s.featuredArtists.some((fa) => String(fa ?? '').toLowerCase().includes(q))) {
        return true;
      }
      const albumList = Array.isArray(s.albums) ? s.albums : (s.album ? [s.album] : []);
      return albumList.some((alb) => String(alb || '').toLowerCase().includes(q));
    })
    : allSongs;

  const sorted = sortSongs(filtered, sort);
  const paged = paginateCapped(sorted, cap, page, limit);
  const items = paged.items.map((s) => ({
    artist: s.artist,
    songTitle: s.songTitle,
    album: s.album || s.albums?.[0] || '',
    albums: Array.isArray(s.albums) ? s.albums : (s.album ? [s.album] : []),
    totalPlays: Number(s.totalPlays || 0),
    firstPlayed: s.firstPlayed || s.firstAppearance || '',
    lastPlayed: s.lastPlayed || s.lastAppearance || '',
  }));
  return { ...paged, items, songs: items };
}

export async function getStaticArtistSongs(artistName) {
  const allSongs = await fetchStaticJson('/data/songs.json');
  const artistSongs = allSongs.filter((s) => s.artist === artistName);
  const albumCounts = new Map();

  const songs = sortSongs(artistSongs, 'top').map((s) => {
    const songAlbums = [
      ...new Set(
        (Array.isArray(s.albums) ? s.albums : (s.album ? [s.album] : []))
          .map((a) => String(a || '').trim())
          .filter(Boolean),
      ),
    ];
    for (const alb of songAlbums) {
      albumCounts.set(alb, (albumCounts.get(alb) || 0) + Number(s.totalPlays || 1));
    }
    return {
      songTitle: s.songTitle,
      album: s.album || songAlbums[0] || '',
      albums: songAlbums,
      totalPlays: Number(s.totalPlays || 0),
      firstPlayed: s.firstPlayed || s.firstAppearance || '',
      lastPlayed: s.lastPlayed || s.lastAppearance || '',
    };
  });

  const albums = [...albumCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  const firstDates = songs.map((s) => s.firstPlayed).filter(Boolean).sort();
  const lastDates = songs.map((s) => s.lastPlayed || s.firstPlayed).filter(Boolean).sort();

  return {
    artist: artistName,
    summary: {
      totalPlays: songs.reduce((sum, s) => sum + s.totalPlays, 0),
      uniqueSongs: songs.length,
      uniqueAlbums: albums.length,
      firstAppearance: firstDates[0] || '',
      lastAppearance: lastDates[lastDates.length - 1] || '',
    },
    albums,
    songs,
  };
}

export async function getStaticArtistProfile(artistName) {
  if (!normalizeArtistKey(artistName)) {
    return { data: null, source: 'static-json', mode: 'static' };
  }
  const key = encodeArtistProfileKey(artistName);
  const data = await fetchStaticJsonAllow404(`/data/artist-profiles/${key}.json`);
  return { data, source: 'static-json', mode: 'static' };
}

export async function getStaticSearchAll(query) {
  const [artistsRes, songsRes, albumsRes] = await Promise.all([
    fetchStaticJson('data/artists.json'),
    fetchStaticJson('data/songs.json'),
    fetchStaticJson('data/albums.json'),
  ]);

  const term = query.toLowerCase();
  const matchedArtists = artistsRes.filter((a) => a.name.toLowerCase().includes(term)).slice(0, 10);
  const matchedSongs = songsRes
    .filter((s) => (
      String(s.songTitle || '').toLowerCase().includes(term)
      || String(s.artist || '').toLowerCase().includes(term)
      || (Array.isArray(s.featuredArtists) && s.featuredArtists.some((fa) => String(fa ?? '').toLowerCase().includes(term)))
    ))
    .slice(0, 10);
  const matchedAlbums = albumsRes
    .filter((a) => a.album.toLowerCase().includes(term) || a.artist.toLowerCase().includes(term))
    .slice(0, 10);

  return {
    artists: matchedArtists.map((a) => ({
      name: a.name,
      plays: a.totalPlays,
      uniqueSongs: Number(a.uniqueSongs ?? 0),
    })),
    songs: matchedSongs.map((s) => ({
      artist: s.artist,
      songTitle: s.songTitle,
      album: s.album || s.albums?.[0] || '',
      plays: s.totalPlays,
    })),
    albums: matchedAlbums.map((a) => ({
      artist: a.artist,
      album: a.album,
      plays: a.totalPlays,
    })),
  };
}
