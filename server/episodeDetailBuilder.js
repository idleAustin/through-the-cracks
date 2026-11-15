// Pure Web-API-only Episode DNA, broadcast weekday, lookup key, and provenance detail builder.
import { normalizeArtistKey } from './artistProfileBuilder.js';
import { buildSongKey, buildSqliteSongKey, isValidVideoId } from './playlistBuilder.js';

export const BROADCAST_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const BROADCAST_DAYS = {
  saturday: { name: 'Saturday', shortName: 'SAT', utcDay: 6, sqliteDow: '6', bqDow: 7 },
  wednesday: { name: 'Wednesday', shortName: 'WED', utcDay: 3, sqliteDow: '3', bqDow: 4 },
};

const unwrapValue = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

function readLookup(store, key) {
  if (!store || !key) return undefined;
  if (store instanceof Map) return store.get(key);
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined;
}

const extractVideoId = (entry) => (typeof entry === 'string' ? entry : (entry?.videoId ?? entry?.video_id ?? ''));

export function getBroadcastDayOfWeek(airDate) {
  const match = String(unwrapValue(airDate) ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return '';
  const ymd = match[1];
  const dt = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== ymd) return '';
  return BROADCAST_WEEKDAYS[dt.getUTCDay()] || '';
}

export function parseBroadcastDayParam(rawDay) {
  if (typeof rawDay !== 'string') return null;
  const norm = rawDay.trim().toLowerCase();
  if (norm === 'saturday' || norm === 'sat' || norm === '6') return { ...BROADCAST_DAYS.saturday };
  if (norm === 'wednesday' || norm === 'wed' || norm === '3') return { ...BROADCAST_DAYS.wednesday };
  return null;
}

export function buildEpisodeLookupKeys(tracks = []) {
  const artistKeys = [];
  const artistSeen = new Set();
  const songPairs = [];
  const songPairSeen = new Set();
  const songLinkKeys = [];
  const songLinkSeen = new Set();

  for (const track of tracks || []) {
    const artist = String(track?.artist ?? '').trim();
    const songTitle = String(track?.songTitle ?? track?.song_title ?? track?.song ?? '').trim();
    const artistKey = normalizeArtistKey(artist);
    if (artistKey && !artistSeen.has(artistKey)) {
      artistSeen.add(artistKey);
      artistKeys.push(artistKey);
    }
    if (artist && songTitle) {
      const sqliteKey = buildSqliteSongKey(artist, songTitle);
      if (sqliteKey && !songPairSeen.has(sqliteKey)) {
        songPairSeen.add(sqliteKey);
        songPairs.push(sqliteKey);
      }
      for (const linkKey of [buildSongKey(artist, songTitle), sqliteKey]) {
        if (linkKey && !songLinkSeen.has(linkKey)) {
          songLinkSeen.add(linkKey);
          songLinkKeys.push(linkKey);
        }
      }
    }
  }
  return { artistKeys, songPairs, songLinkKeys };
}

export function buildEnrichedEpisodeDetail({
  episode, tracks = [], songStatsByKey, artistFirstByKey, playableLinksByKey, prevEpisodeId = null, nextEpisodeId = null,
}) {
  const trackList = Array.isArray(tracks) ? tracks : [];
  const airDate = String(unwrapValue(episode?.airDate ?? episode?.air_date) ?? '');
  const rawCount = episode?.songCount ?? episode?.song_count;
  const parsedCount = rawCount !== undefined && rawCount !== null ? Number(rawCount) : NaN;
  const songCount = Number.isFinite(parsedCount) ? parsedCount : trackList.length;
  const baseEpisode = {
    id: String(episode?.id ?? ''), air_date: airDate, airDate, song_count: songCount, songCount, url: episode?.url || null,
  };

  const seenDebutSongKeys = new Set();
  const debutArtistSeen = new Set();
  const debutArtists = [];
  const artistCounts = new Map();
  let debutSongCount = 0;
  let artistDebutSpinCount = 0;
  let onlySpinCount = 0;
  let stapleCount = 0;
  let playableCount = 0;
  let topStaplePlayCount = 0;

  const enrichedTracks = trackList.map((track, idx) => {
    const artist = String(track?.artist ?? '');
    const songTitle = String(track?.songTitle ?? track?.song_title ?? track?.song ?? '');
    const featuredArtist = track?.featuredArtist ?? track?.featured_artist ?? '';
    const releaseKind = track?.releaseKind ?? track?.release_kind ?? '';
    const sqliteSongKey = buildSqliteSongKey(artist, songTitle);
    const canonicalLinkKey = buildSongKey(artist, songTitle);

    const stat = readLookup(songStatsByKey, sqliteSongKey) ?? readLookup(songStatsByKey, canonicalLinkKey);
    const rawPlays = Number(stat?.totalPlays ?? stat?.total_plays ?? 1);
    const totalPlays = Number.isFinite(rawPlays) ? Math.max(1, rawPlays) : 1;
    const firstPlayed = String(unwrapValue(stat?.firstPlayed ?? stat?.first_played ?? stat?.firstAppearance) ?? (airDate || ''));
    const lastPlayed = String(unwrapValue(stat?.lastPlayed ?? stat?.last_played ?? stat?.lastAppearance) ?? (airDate || ''));

    const canonicalSongKey = sqliteSongKey;
    const isSongDebut = Boolean(airDate && firstPlayed && airDate === firstPlayed && !seenDebutSongKeys.has(canonicalSongKey));
    if (isSongDebut) {
      seenDebutSongKeys.add(canonicalSongKey);
      debutSongCount += 1;
    }

    const artistKey = normalizeArtistKey(artist);
    const artistEntry = readLookup(artistFirstByKey, artistKey) ?? readLookup(artistFirstByKey, String(artist || '').trim().toLowerCase());
    const artistFirst = String(unwrapValue(artistEntry?.firstAppearance ?? artistEntry?.first_appearance ?? artistEntry) ?? '');
    const isArtistDebut = Boolean(airDate && artistFirst && airDate === artistFirst);
    const displayArtist = artist.trim() || artist;
    if (isArtistDebut) {
      artistDebutSpinCount += 1;
      if (artistKey && !debutArtistSeen.has(artistKey)) {
        debutArtistSeen.add(artistKey);
        debutArtists.push(displayArtist);
      }
    }
    if (artistKey) {
      const entry = artistCounts.get(artistKey);
      if (entry) entry.count += 1;
      else artistCounts.set(artistKey, { display: displayArtist, count: 1 });
    }

    const primaryLink = readLookup(playableLinksByKey, canonicalLinkKey);
    const secondaryLink = sqliteSongKey !== canonicalLinkKey ? readLookup(playableLinksByKey, sqliteSongKey) : undefined;
    const link = primaryLink && isValidVideoId(extractVideoId(primaryLink)) ? primaryLink : (secondaryLink ?? primaryLink);
    const rawVid = extractVideoId(link);
    const videoId = isValidVideoId(rawVid) ? rawVid.trim() : null;
    const rawDur = link && typeof link === 'object' ? (link.durationSeconds ?? link.duration_seconds) : undefined;
    const durationSeconds =
      rawDur !== null && rawDur !== undefined && rawDur !== '' && typeof rawDur !== 'boolean' && Number.isFinite(Number(rawDur)) && Number(rawDur) > 0
        ? Number(rawDur)
        : null;

    const isOnlySpin = totalPlays === 1;
    const isStaple = totalPlays >= 5;
    if (isOnlySpin) onlySpinCount += 1;
    if (isStaple) stapleCount += 1;
    if (videoId) playableCount += 1;
    if (totalPlays > topStaplePlayCount) topStaplePlayCount = totalPlays;

    return {
      position: Number(track?.position ?? idx + 1),
      song: String(track?.song ?? songTitle),
      songTitle,
      artist,
      ...(featuredArtist ? { featuredArtist } : {}),
      album: track?.album || '',
      ...(releaseKind && releaseKind !== 'album' ? { releaseKind } : {}),
      totalPlays,
      firstPlayed,
      lastPlayed,
      isSongDebut,
      isArtistDebut,
      isOnlySpin,
      isStaple,
      videoId,
      durationSeconds,
    };
  });

  const doubledArtists = [];
  for (const entry of artistCounts.values()) {
    if (entry.count >= 2) doubledArtists.push(entry.display);
  }
  const opener = enrichedTracks.length > 0 ? { artist: enrichedTracks[0].artist, songTitle: enrichedTracks[0].songTitle } : null;
  const closer = enrichedTracks.length > 0
    ? { artist: enrichedTracks[enrichedTracks.length - 1].artist, songTitle: enrichedTracks[enrichedTracks.length - 1].songTitle }
    : null;

  return {
    ...baseEpisode,
    dna: { debutSongCount, debutArtistCount: debutArtists.length, artistDebutSpinCount, onlySpinCount, stapleCount, playableCount },
    debutArtists,
    doubledArtists,
    topStaplePlayCount,
    opener,
    closer,
    prevEpisodeId: prevEpisodeId != null && prevEpisodeId !== '' ? String(prevEpisodeId) : null,
    nextEpisodeId: nextEpisodeId != null && nextEpisodeId !== '' ? String(nextEpisodeId) : null,
    playlist: enrichedTracks,
    songs: enrichedTracks,
  };
}
