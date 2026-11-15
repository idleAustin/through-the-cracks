// Pure Web-API R2 snapshot handlers for episode listing (year/song/artist/day/q) and Episode DNA provenance detail.
import { normalizeArtistKey } from './artistProfileBuilder.js';
import { mapEpisodeRow, stripControlChars } from './d1Rollups.js';
import { buildEnrichedEpisodeDetail, getBroadcastDayOfWeek, parseBroadcastDayParam } from './episodeDetailBuilder.js';
import { buildSongKey, buildSqliteSongKey, isValidVideoId } from './playlistBuilder.js';
import { parsePageParams } from './routes/queryUtils.js';

export const normalizeR2Episode = (ep) => mapEpisodeRow({
  id: ep.id, air_date: ep.air_date ?? ep.airDate ?? '', song_count: ep.song_count ?? ep.songCount ?? 0, url: ep.url || null,
});

const toArray = (val, altKey) => (Array.isArray(val) ? val : (Array.isArray(val?.[altKey]) ? val[altKey] : []));
const isFalsyFlag = (v) => v === 0 || v === false || v === '0';
const cmpEpOrder = (aAir, aId, bAir, bId) => (aAir !== bAir ? (aAir < bAir ? -1 : 1) : (aId !== bId ? (aId < bId ? -1 : 1) : 0));

function collectSongArtistEpisodeIds(songEpisodes, song, artist) {
  const matches = new Set();
  if (song && artist) {
    const sk = `${song}\t${artist}`;
    const list = Object.hasOwn(songEpisodes, sk) ? songEpisodes[sk] : [];
    for (const id of list || []) matches.add(String(id));
    return matches;
  }
  for (const [key, epIds] of Object.entries(songEpisodes)) {
    const tab = key.indexOf('\t');
    const ks = tab === -1 ? key : key.slice(0, tab);
    const ka = tab === -1 ? '' : key.slice(tab + 1);
    if ((!song || ks === song) && (!artist || ka === artist)) {
      for (const id of epIds || []) matches.add(String(id));
    }
  }
  return matches;
}

async function collectSearchEpisodeIds(indexJson, songsJson, q, loadShared, allowedIds) {
  const songEpisodes = indexJson.songEpisodes || {};
  const matchedIds = new Set();
  for (const [key, epIds] of Object.entries(songEpisodes)) {
    if (key.toLowerCase().includes(q)) for (const id of epIds || []) matchedIds.add(String(id));
  }

  const candidatesByEp = new Map();
  for (const s of toArray(songsJson, 'songs')) {
    if (!s) continue;
    const title = String(s.songTitle ?? s.song_title ?? s.song ?? '');
    const artist = String(s.artist || '');
    const sk = `${title.trim().toLowerCase()}\t${artist.trim().toLowerCase()}`;
    const epIds = Object.hasOwn(songEpisodes, sk) ? (songEpisodes[sk] || []) : [];
    if (title.toLowerCase().includes(q) || artist.toLowerCase().includes(q)) {
      for (const id of epIds) matchedIds.add(String(id));
      continue;
    }
    const albums = [...(Array.isArray(s.albums) ? s.albums : []), ...(s.album ? [s.album] : [])];
    const feats = [...(Array.isArray(s.featuredArtists) ? s.featuredArtists : []), ...(s.featuredArtist ? [s.featuredArtist] : [])];
    const metaHit = albums.some((a) => String(a || '').toLowerCase().includes(q)) ||
      feats.some((a) => String(a || '').toLowerCase().includes(q));
    if (!metaHit) continue;
    for (const rawId of epIds) {
      const epId = String(rawId);
      if (matchedIds.has(epId) || (allowedIds && !allowedIds.has(epId))) continue;
      let keys = candidatesByEp.get(epId);
      if (!keys) { keys = new Set(); candidatesByEp.set(epId, keys); }
      keys.add(sk);
    }
  }

  if (candidatesByEp.size === 0 || typeof loadShared !== 'function') return matchedIds;
  const epYearById = new Map();
  for (const ep of indexJson.episodes || []) {
    const yr = String(ep.air_date ?? ep.airDate ?? '').slice(0, 4);
    if (/^\d{4}$/.test(yr)) epYearById.set(String(ep.id), yr);
  }
  const years = [...new Set([...candidatesByEp.keys()].map((id) => epYearById.get(id)).filter(Boolean))];
  const shardByYear = new Map(await Promise.all(years.map(async (yr) => [yr, await loadShared(`v1/playlists/${yr}.json`)])));

  for (const [epId, candidateKeys] of candidatesByEp.entries()) {
    const yr = epYearById.get(epId);
    const shard = yr ? shardByYear.get(yr) : null;
    if (!shard || typeof shard !== 'object') continue;
    const rawTracks = Object.hasOwn(shard, epId) && Array.isArray(shard[epId]) ? shard[epId] : [];
    const verified = rawTracks.some((t) => {
      if (!t || typeof t !== 'object') return false;
      const spinKey = `${String(t.songTitle ?? t.song_title ?? t.song ?? '').trim().toLowerCase()}\t${String(t.artist ?? '').trim().toLowerCase()}`;
      if (!candidateKeys.has(spinKey)) return false;
      const alb = String(t.album || '').toLowerCase();
      const feat = String(t.featuredArtist ?? t.featured_artist ?? '').toLowerCase();
      return alb.includes(q) || feat.includes(q);
    });
    if (verified) matchedIds.add(epId);
  }
  return matchedIds;
}

export async function serveEpisodesFromR2(indexJson, query = {}, loadShared = null) {
  const { page, limit, offset } = parsePageParams(query);
  const year = typeof query.year === 'string' && /^\d{4}$/.test(query.year.trim()) ? query.year.trim() : '';
  const song = typeof query.song === 'string' ? query.song.trim().toLowerCase() : '';
  const artist = typeof query.artist === 'string' ? query.artist.trim().toLowerCase() : '';
  const day = parseBroadcastDayParam(query.day);
  const q = stripControlChars(typeof query.q === 'string' ? query.q : '').trim().slice(0, 120).toLowerCase();

  let filtered = indexJson.episodes || [];
  const songEpisodes = indexJson.songEpisodes || {};
  if (song || artist) {
    const matches = collectSongArtistEpisodeIds(songEpisodes, song, artist);
    filtered = filtered.filter((ep) => matches.has(String(ep.id)));
  }
  if (year) filtered = filtered.filter((ep) => String(ep.air_date ?? ep.airDate ?? '').startsWith(year));
  if (day) filtered = filtered.filter((ep) => getBroadcastDayOfWeek(ep.air_date ?? ep.airDate) === day.name);
  if (q) {
    const songsJson = typeof loadShared === 'function' ? await loadShared('v1/songs.json') : null;
    const allowedIds = new Set(
      filtered.filter((ep) => !String(ep.air_date ?? ep.airDate ?? '').toLowerCase().includes(q)).map((ep) => String(ep.id)),
    );
    const qMatches = await collectSearchEpisodeIds(indexJson, songsJson, q, loadShared, allowedIds);
    filtered = filtered.filter((ep) => String(ep.air_date ?? ep.airDate ?? '').toLowerCase().includes(q) || qMatches.has(String(ep.id)));
  }

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit).map(normalizeR2Episode);
  return { items, episodes: items, total, page, limit, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

function findNeighborEpisodeIds(episodes, current) {
  const curAir = String(current.air_date ?? current.airDate ?? '');
  const curId = String(current.id ?? '');
  let prevEp = null;
  let nextEp = null;
  for (const ep of episodes) {
    const epAir = String(ep.air_date ?? ep.airDate ?? '');
    const idStr = String(ep.id ?? '');
    if (!idStr) continue;
    const cmp = cmpEpOrder(epAir, idStr, curAir, curId);
    if (cmp > 0 && (!prevEp || cmpEpOrder(epAir, idStr, prevEp.airDate, prevEp.id) < 0)) prevEp = { airDate: epAir, id: idStr };
    else if (cmp < 0 && (!nextEp || cmpEpOrder(epAir, idStr, nextEp.airDate, nextEp.id) > 0)) nextEp = { airDate: epAir, id: idStr };
  }
  return { prevEpisodeId: prevEp?.id ?? null, nextEpisodeId: nextEp?.id ?? null };
}

function buildR2SongStatsMap(songsJson) {
  const songStatsByKey = new Map();
  for (const s of toArray(songsJson, 'songs')) {
    if (!s) continue;
    const artist = String(s.artist ?? '');
    const title = String(s.songTitle ?? s.song_title ?? s.song ?? '');
    const stat = {
      totalPlays: Number(s.totalPlays ?? s.total_plays ?? 1),
      firstPlayed: String(s.firstPlayed ?? s.first_played ?? s.firstAppearance ?? ''),
      lastPlayed: String(s.lastPlayed ?? s.last_played ?? s.lastAppearance ?? ''),
    };
    const sqliteKey = buildSqliteSongKey(artist, title);
    const canonKey = buildSongKey(artist, title);
    if (sqliteKey) songStatsByKey.set(sqliteKey, stat);
    if (canonKey && !songStatsByKey.has(canonKey)) songStatsByKey.set(canonKey, stat);
  }
  return songStatsByKey;
}

function buildR2ArtistFirstMap(artistsJson) {
  const artistFirstByKey = new Map();
  for (const a of toArray(artistsJson, 'artists')) {
    if (!a) continue;
    const first = String(a.firstAppearance ?? a.first_appearance ?? '');
    if (!first) continue;
    const normKey = normalizeArtistKey(a.name);
    const lowerKey = String(a.name || '').trim().toLowerCase();
    for (const k of normKey === lowerKey ? [normKey] : [normKey, lowerKey]) {
      if (!k) continue;
      const prev = artistFirstByKey.get(k);
      if (prev === undefined || first < prev) artistFirstByKey.set(k, first);
    }
  }
  return artistFirstByKey;
}

export function buildPlayableLinksByKey(songLinksJson) {
  const playableLinksByKey = new Map();
  for (const s of toArray(songLinksJson, 'songs')) {
    if (!s || typeof s !== 'object') continue;
    if (isFalsyFlag(s.is_embeddable ?? s.isEmbeddable) || isFalsyFlag(s.us_playable ?? s.usPlayable)) continue;
    const vid = s.videoId ?? s.video_id;
    if (!isValidVideoId(vid)) continue;
    const entry = { videoId: vid.trim(), durationSeconds: s.durationSeconds ?? s.duration_seconds ?? null };
    const explicitKey = String(s.songKey ?? s.song_key ?? '').trim();
    if (explicitKey && !playableLinksByKey.has(explicitKey)) playableLinksByKey.set(explicitKey, entry);
    const artist = String(s.artist ?? '');
    const title = String(s.songTitle ?? s.song_title ?? s.song ?? '');
    if (artist || title) {
      const canonKey = buildSongKey(artist, title);
      const sqliteKey = buildSqliteSongKey(artist, title);
      if (canonKey && !playableLinksByKey.has(canonKey)) playableLinksByKey.set(canonKey, entry);
      if (sqliteKey && !playableLinksByKey.has(sqliteKey)) playableLinksByKey.set(sqliteKey, entry);
    }
  }
  return playableLinksByKey;
}

export async function serveEpisodeDetailFromR2(episodeId, options = {}) {
  const { loadShared, readSongLinks = null, query = {} } =
    typeof options === 'function' ? { loadShared: options } : (options || {});
  const idx = await loadShared('v1/episodes-index.json');
  if (!idx) return null;
  const episodes = idx.episodes || [];
  const epId = String(episodeId ?? '');
  const summary = episodes.find((ep) => String(ep.id) === epId);
  if (!summary) return { status: 404, data: { error: 'Episode not found' } };

  const year = String(summary.air_date ?? summary.airDate ?? '').slice(0, 4);
  const shard = /^\d{4}$/.test(year) ? await loadShared(`v1/playlists/${year}.json`) : null;
  if (!shard) return null;
  const rawTracks = Object.hasOwn(shard, epId) && Array.isArray(shard[epId]) ? shard[epId] : [];
  const playlist = rawTracks.map((s, i) => {
    const title = s.songTitle ?? s.song_title ?? s.song ?? '';
    const feat = s.featuredArtist || s.featured_artist || '';
    const kind = s.releaseKind || s.release_kind || '';
    return {
      position: Number(s.position ?? i + 1),
      song: s.song ?? title,
      songTitle: title,
      artist: s.artist || '',
      ...(feat ? { featuredArtist: feat } : {}),
      album: s.album || '',
      ...(kind && kind !== 'album' ? { releaseKind: kind } : {}),
    };
  });

  const withProvenance = query?.provenance === '1' || query?.provenance === true;
  if (!withProvenance) {
    return { status: 200, data: { ...normalizeR2Episode(summary), playlist, songs: playlist } };
  }

  const [songsJson, artistsJson, songLinksJson] = await Promise.all([
    loadShared('v1/songs.json'),
    loadShared('v1/artists.json'),
    readSongLinks ? readSongLinks() : null,
  ]);
  const { prevEpisodeId, nextEpisodeId } = findNeighborEpisodeIds(episodes, summary);

  return {
    status: 200,
    data: buildEnrichedEpisodeDetail({
      episode: normalizeR2Episode(summary),
      tracks: playlist,
      songStatsByKey: buildR2SongStatsMap(songsJson),
      artistFirstByKey: buildR2ArtistFirstMap(artistsJson),
      playableLinksByKey: buildPlayableLinksByKey(songLinksJson),
      prevEpisodeId,
      nextEpisodeId,
    }),
  };
}
