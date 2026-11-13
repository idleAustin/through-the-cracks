/**
 * Through the Cracks — Client Data Access Layer
 * 
 * Tries the Express API server (http://localhost:3001) first.
 * If the API is offline or unreachable, seamlessly falls back to pre-computed JSON files in /data/
 */

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001/api' : '/api');

function getStaticPath(relativePath) {
  const base = import.meta.env.BASE_URL || '/';
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return base.endsWith('/') ? `${base}${cleanPath}` : `${base}/${cleanPath}`;
}

async function fetchWithFallback(apiEndpoint, staticJsonPath) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 sec timeout for API check
    const response = await fetch(`${API_BASE}${apiEndpoint}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      return { data, source: 'express-api' };
    }
  } catch {
    // API server unreachable or timed out -> fallback to static JSON
  }

  // Fallback to static JSON file
  const fullStaticPath = getStaticPath(staticJsonPath);
  const jsonResponse = await fetch(fullStaticPath);
  if (!jsonResponse.ok) throw new Error(`Failed to load data from ${fullStaticPath}`);
  const data = await jsonResponse.json();
  return { data, source: 'static-json' };
}

export async function getOverview() {
  const result = await fetchWithFallback('/overview', '/data/overview.json');
  return result;
}

export async function getEpisodes(page = 1, limit = 20) {
  try {
    const result = await fetchWithFallback(`/episodes?page=${page}&limit=${limit}`, '/data/episodes.json');
    if (result.source === 'express-api') {
      return result;
    }
    // Static fallback: slice the full episodes list
    const allEpisodes = result.data;
    const offset = (page - 1) * limit;
    const paginated = allEpisodes.slice(offset, offset + limit);
    return {
      data: {
        episodes: paginated,
        pagination: {
          page,
          limit,
          total: allEpisodes.length,
          totalPages: Math.ceil(allEpisodes.length / limit)
        }
      },
      source: 'static-json'
    };
  } catch (err) {
    console.error('Error fetching episodes:', err);
    throw err;
  }
}

export async function getEpisodeById(id) {
  try {
    const result = await fetchWithFallback(`/episodes/${id}`, '/data/episodes.json');
    if (result.source === 'express-api') {
      return result;
    }
    const allEpisodes = result.data;
    const match = allEpisodes.find(e => e.id === id);
    if (!match) throw new Error('Episode not found');
    return { data: match, source: 'static-json' };
  } catch (err) {
    console.error('Error fetching episode details:', err);
    throw err;
  }
}

export async function getArtists(search = '', page = 1, limit = 20) {
  try {
    const searchParam = encodeURIComponent(search);
    const result = await fetchWithFallback(`/artists?search=${searchParam}&page=${page}&limit=${limit}`, '/data/artists.json');
    if (result.source === 'express-api') {
      return result;
    }
    let allArtists = result.data;
    if (search) {
      const q = search.toLowerCase();
      allArtists = allArtists.filter(a => a.name.toLowerCase().includes(q));
    }
    const offset = (page - 1) * limit;
    const paginated = allArtists.slice(offset, offset + limit);
    return {
      data: {
        artists: paginated,
        pagination: {
          page,
          limit,
          total: allArtists.length,
          totalPages: Math.ceil(allArtists.length / limit)
        }
      },
      source: 'static-json'
    };
  } catch (err) {
    console.error('Error fetching artists:', err);
    throw err;
  }
}

export async function searchAll(query) {
  if (!query || query.trim().length < 2) return { data: { artists: [], songs: [], albums: [] }, source: 'static-json' };
  try {
    const q = encodeURIComponent(query.trim());
    const result = await fetchWithFallback(`/search?q=${q}`, '/data/artists.json');
    if (result.source === 'express-api') {
      return result;
    }
    
    // Fallback: query local JSON files in parallel
    const [artistsRes, songsRes, albumsRes] = await Promise.all([
      fetch(getStaticPath('data/artists.json')).then(r => r.json()),
      fetch(getStaticPath('data/songs.json')).then(r => r.json()),
      fetch(getStaticPath('data/albums.json')).then(r => r.json())
    ]);

    const term = query.toLowerCase();
    const matchedArtists = artistsRes.filter(a => a.name.toLowerCase().includes(term)).slice(0, 10);
    const matchedSongs = songsRes.filter(s => s.songTitle.toLowerCase().includes(term) || s.artist.toLowerCase().includes(term)).slice(0, 10);
    const matchedAlbums = albumsRes.filter(a => a.album.toLowerCase().includes(term) || a.artist.toLowerCase().includes(term)).slice(0, 10);

    return {
      data: {
        artists: matchedArtists.map(a => ({ name: a.name, plays: a.totalPlays })),
        songs: matchedSongs.map(s => ({ artist: s.artist, songTitle: s.songTitle, album: s.albums?.[0] || '', plays: s.totalPlays })),
        albums: matchedAlbums.map(a => ({ artist: a.artist, album: a.album, plays: a.totalPlays }))
      },
      source: 'static-json'
    };
  } catch (err) {
    console.error('Search error:', err);
    return { data: { artists: [], songs: [], albums: [] }, source: 'static-json' };
  }
}

export async function getSongs(search = '', page = 1, limit = 20) {
  try {
    const searchParam = encodeURIComponent(search);
    const result = await fetchWithFallback(`/songs?search=${searchParam}&page=${page}&limit=${limit}`, '/data/songs.json');
    if (result.source === 'express-api') {
      return result;
    }
    // Static fallback: filter and paginate from full songs.json
    let allSongs = result.data;
    if (search) {
      const q = search.toLowerCase();
      allSongs = allSongs.filter(s =>
        s.artist.toLowerCase().includes(q) ||
        s.songTitle.toLowerCase().includes(q)
      );
    }
    const offset = (page - 1) * limit;
    const paginated = allSongs.slice(offset, offset + limit);
    return {
      data: {
        songs: paginated.map(s => ({
          artist: s.artist,
          songTitle: s.songTitle,
          album: s.albums?.[0] || '',
          totalPlays: s.totalPlays,
          firstPlayed: s.firstAppearance || '',
          lastPlayed: '',
        })),
        pagination: {
          page,
          limit,
          total: allSongs.length,
          totalPages: Math.ceil(allSongs.length / limit)
        }
      },
      source: 'static-json'
    };
  } catch (err) {
    console.error('Error fetching songs:', err);
    throw err;
  }
}

export async function getArtistSongs(artistName) {
  try {
    const encoded = encodeURIComponent(artistName);
    const result = await fetchWithFallback(`/artists/${encoded}/songs`, '/data/songs.json');
    if (result.source === 'express-api') {
      return result;
    }
    // Static fallback: filter songs.json by artist
    const allSongs = result.data;
    const artistSongs = allSongs.filter(s => s.artist === artistName);
    const totalPlays = artistSongs.reduce((sum, s) => sum + s.totalPlays, 0);
    const albums = new Set(artistSongs.flatMap(s => s.albums || []));
    return {
      data: {
        artist: artistName,
        summary: {
          totalPlays,
          uniqueSongs: artistSongs.length,
          uniqueAlbums: albums.size,
          firstAppearance: artistSongs[artistSongs.length - 1]?.firstAppearance || '',
          lastAppearance: artistSongs[0]?.firstAppearance || '',
        },
        songs: artistSongs.map(s => ({
          songTitle: s.songTitle,
          album: s.albums?.[0] || '',
          totalPlays: s.totalPlays,
          firstPlayed: s.firstAppearance || '',
          lastPlayed: '',
        }))
      },
      source: 'static-json'
    };
  } catch (err) {
    console.error('Error fetching artist songs:', err);
    throw err;
  }
}

