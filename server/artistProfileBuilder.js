// Pure, Web-API-only Artist profile builder shared across Worker/D1, Express/BigQuery, and static snapshots.

const FNV1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const MS_PER_DAY = 86_400_000;
const textEncoder = new TextEncoder();

const cmpAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpText = (a, b) => cmpAsc(String(a).toLowerCase(), String(b).toLowerCase()) || cmpAsc(String(a), String(b));
const unwrapValue = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const readLookup = (lookup, key) => (!lookup ? undefined : lookup instanceof Map ? lookup.get(key) : lookup[key]);

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) ? Math.round((tb - ta) / MS_PER_DAY) : null;
}

export function addArtistVariant(variantMap, rawName, airDate = '', spins = 1) {
  const name = String(rawName ?? '').trim();
  if (!name) return;
  const rawDate = unwrapValue(airDate);
  const date = rawDate ? String(rawDate) : '';
  const prev = variantMap.get(name);
  if (!prev) variantMap.set(name, { name, spins, airDate: date });
  else {
    prev.spins += spins;
    if (date && (!prev.airDate || date < prev.airDate)) prev.airDate = date;
  }
}

export function normalizeArtistKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

export function pickArtistDisplayName(variants) {
  const merged = new Map();
  for (const v of variants || []) {
    addArtistVariant(merged, v?.name, v?.airDate, v?.spins == null ? 1 : Number(v.spins));
  }
  let best = null;
  for (const c of merged.values()) {
    if (!best) { best = c; continue; }
    if (c.spins !== best.spins) { if (c.spins > best.spins) best = c; continue; }
    if (c.airDate !== best.airDate) {
      if (c.airDate && (!best.airDate || c.airDate < best.airDate)) best = c;
      continue;
    }
    if (cmpAsc(c.name, best.name) < 0) best = c;
  }
  return best ? best.name : '';
}

export function encodeArtistProfileKey(artistName) {
  const key = normalizeArtistKey(artistName);
  let hash = FNV1A_64_OFFSET;
  for (const byte of textEncoder.encode(key)) {
    hash = ((hash ^ BigInt(byte)) * FNV1A_64_PRIME) & MASK_64;
  }
  const slug =
    key.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '') || 'artist';
  return `${slug}-${hash.toString(16).padStart(16, '0')}`;
}

export function computeArtistRank(artistSpins, allArtistSpinCounts) {
  const spins = Number(artistSpins ?? 0);
  let higher = 0;
  let totalArtists = 0;
  for (const rawCount of allArtistSpinCounts || []) {
    totalArtists += 1;
    if (Number(rawCount) > spins) higher += 1;
  }
  return { rank: 1 + higher, totalArtists };
}

export function buildRankMap(countByKey) {
  const entries = countByKey instanceof Map
    ? Array.from(countByKey.entries())
    : Array.isArray(countByKey)
      ? countByKey
      : Object.entries(countByKey || {});
  const sorted = entries
    .map(([key, count]) => {
      const n = Number(count ?? 0);
      return [key, Number.isFinite(n) ? n : 0];
    })
    .sort((a, b) => b[1] - a[1]);
  const rankByKey = new Map();
  let prevCount = null;
  let currentRank = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const [key, count] = sorted[i];
    if (i === 0 || count !== prevCount) {
      currentRank = i + 1;
      prevCount = count;
    }
    rankByKey.set(key, currentRank);
  }
  return rankByKey;
}

export function buildArchiveYearAxis(yearRows, yearField = 'year', dateRange = null) {
  let minYear = 2013;
  let maxYear = 2026;
  const counts = new Map();
  for (const row of yearRows || []) {
    const rawYear = unwrapValue(row?.[yearField]);
    const yr = typeof rawYear === 'number' ? rawYear : Number(String(rawYear ?? '').slice(0, 4));
    if (!Number.isFinite(yr) || yr < 2000) continue;
    if (yr < minYear) minYear = yr;
    if (yr > maxYear) maxYear = yr;
    counts.set(yr, (counts.get(yr) ?? 0) + Number(row?.spins ?? 0));
  }
  const ey = Number(String(unwrapValue(dateRange?.earliest) ?? '').slice(0, 4));
  const ly = Number(String(unwrapValue(dateRange?.latest) ?? '').slice(0, 4));
  if (Number.isFinite(ey) && ey >= 2000 && ey < minYear) minYear = ey;
  if (Number.isFinite(ly) && ly > maxYear) maxYear = ly;
  return Array.from({ length: maxYear - minYear + 1 }, (_, i) => ({
    year: minYear + i,
    spins: counts.get(minYear + i) ?? 0,
  }));
}

export function buildCoOccurrences(coRows, displayNameByKey, rankByKey) {
  if (!coRows) return [];
  const fallbackRank = rankByKey instanceof Map ? rankByKey.size : Object.keys(rankByKey || {}).length;
  if (coRows instanceof Map) {
    const out = [];
    for (const [key, sharedEpisodes] of coRows.entries()) {
      const shared = Number(sharedEpisodes ?? 0);
      const name = readLookup(displayNameByKey, key) || '';
      if (!key || !name || shared <= 0) continue;
      out.push({ name, sharedEpisodes: shared, rank: readLookup(rankByKey, key) ?? fallbackRank });
    }
    return out;
  }

  const neighborMap = new Map();
  for (const row of coRows) {
    const rawKey = row?.neighbor_key ?? row?.neighborKey ?? row?.ak ?? row?.key;
    const key = rawKey != null ? String(rawKey).trim() : normalizeArtistKey(row?.name);
    const shared = Number(row?.shared_episodes ?? row?.sharedEpisodes ?? 0);
    if (!key || shared <= 0) continue;
    let entry = neighborMap.get(key);
    if (!entry) {
      entry = { sharedEpisodes: shared, variants: new Map() };
      neighborMap.set(key, entry);
    }
    if (row?.name != null) {
      addArtistVariant(
        entry.variants,
        row.name,
        row.airDate ?? row.air_date ?? '',
        row.spins == null ? 1 : Number(row.spins),
      );
    }
  }

  const out = [];
  for (const [key, entry] of neighborMap.entries()) {
    const name = readLookup(displayNameByKey, key) || pickArtistDisplayName(entry.variants.values());
    if (!name) continue;
    out.push({ name, sharedEpisodes: entry.sharedEpisodes, rank: readLookup(rankByKey, key) ?? fallbackRank });
  }
  return out;
}

export function mapProfileSpinRow(row = {}) {
  const rawAirDate = unwrapValue(row.airDate ?? row.air_date);
  const rawEpNum = row.episodeNumber ?? row.episode_number;
  const rawSongCount = row.episodeSongCount ?? row.episode_song_count;
  const rawSong = row.song ?? row.songTitle ?? row.song_title;
  return {
    episodeId: String(row.episodeId ?? row.episode_id ?? ''),
    airDate: rawAirDate == null ? '' : String(rawAirDate),
    episodeNumber: rawEpNum == null ? null : Number(rawEpNum),
    episodeSongCount: Number(rawSongCount ?? 0),
    position: Number(row.position ?? 0),
    artist: String(row.artist ?? ''),
    song: String(rawSong ?? ''),
    album: String(row.album ?? ''),
  };
}

function buildRotationStats(airDates, airings, episodeCount) {
  const dates = Array.from(airDates).sort();
  let longestSilence = { days: 0, from: null, to: null };
  let gapSum = 0;
  for (let i = 1; i < dates.length; i += 1) {
    const gap = daysBetween(dates[i - 1], dates[i]);
    if (gap === null) continue;
    gapSum += gap;
    if (gap > longestSilence.days) longestSilence = { days: gap, from: dates[i - 1], to: dates[i] };
  }
  let openers = 0;
  let closers = 0;
  let slotSum = 0;
  for (const a of airings) {
    if (a.position === 1) openers += 1;
    if (a.episodeSongCount > 0 && a.position === a.episodeSongCount) closers += 1;
    const rawSlot = a.episodeSongCount > 1 ? (a.position - 1) / (a.episodeSongCount - 1) : 0;
    slotSum += Math.max(0, Math.min(1, rawSlot));
  }
  return {
    avgGapDays: dates.length > 1 ? Math.round(gapSum / (dates.length - 1)) : null,
    longestSilence,
    openers,
    closers,
    avgSlot: airings.length > 0 ? slotSum / airings.length : 0,
    doubledUp: airings.length - episodeCount,
  };
}

function buildPlayedAlongside(coOccurrences, selfKey) {
  const grouped = new Map();
  for (const item of coOccurrences || []) {
    const key = normalizeArtistKey(item?.name);
    const shared = Number(item?.sharedEpisodes ?? 0);
    if (!key || key === selfKey || shared <= 0) continue;
    const rank = Number(item?.rank ?? 0);
    let entry = grouped.get(key);
    if (!entry) { entry = { sharedEpisodes: 0, rank, variants: new Map() }; grouped.set(key, entry); }
    entry.sharedEpisodes += shared;
    if (rank > 0 && (entry.rank <= 0 || rank < entry.rank)) entry.rank = rank;
    addArtistVariant(entry.variants, item?.name, '', shared);
  }
  return Array.from(grouped.values())
    .map((e) => ({ name: pickArtistDisplayName(e.variants.values()), sharedEpisodes: e.sharedEpisodes, rank: e.rank }))
    .sort((a, b) => (b.sharedEpisodes - a.sharedEpisodes) || cmpText(a.name, b.name))
    .slice(0, 10);
}

function resolveDisplayMap(groupMap) {
  const display = new Map();
  for (const [k, entry] of groupMap.entries()) display.set(k, pickArtistDisplayName(entry.variants.values()));
  return display;
}

export function buildArtistProfile({ rows = [], coOccurrences = [], rank = 1, totalArtists = 0, archive = {} } = {}) {
  if (!rows || rows.length === 0) return null;

  const artistVariants = new Map();
  const songMap = new Map();
  const albumMap = new Map();
  const episodeIds = new Set();
  const airDates = new Set();
  const yearCounts = new Map();
  const monthCounts = new Map();
  const parsedRows = [];

  for (const row of rows) {
    const airDate = String(row.airDate ?? '').trim();
    const episodeId = String(row.episodeId ?? '');
    const rawSong = String(row.songTitle ?? row.song ?? '').trim();
    const rawAlbum = String(row.album ?? '').trim();
    const songKey = normalizeArtistKey(rawSong);
    const albumKey = normalizeArtistKey(rawAlbum);

    addArtistVariant(artistVariants, row.artist, airDate);
    if (episodeId) episodeIds.add(episodeId);
    if (airDate) {
      airDates.add(airDate);
      const yr = Number(airDate.slice(0, 4));
      if (Number.isFinite(yr)) yearCounts.set(yr, (yearCounts.get(yr) ?? 0) + 1);
      if (airDate.length >= 7) {
        const mo = airDate.slice(0, 7);
        monthCounts.set(mo, (monthCounts.get(mo) ?? 0) + 1);
      }
    }

    let songEntry = songMap.get(songKey);
    if (!songEntry) { songEntry = { variants: new Map(), totalPlays: 0, albumCounts: new Map() }; songMap.set(songKey, songEntry); }
    songEntry.totalPlays += 1;
    addArtistVariant(songEntry.variants, rawSong, airDate);

    if (albumKey) {
      songEntry.albumCounts.set(albumKey, (songEntry.albumCounts.get(albumKey) ?? 0) + 1);
      let albumEntry = albumMap.get(albumKey);
      if (!albumEntry) { albumEntry = { variants: new Map(), totalPlays: 0, uniqueSongs: new Set(), firstAppearance: airDate }; albumMap.set(albumKey, albumEntry); }
      albumEntry.totalPlays += 1;
      albumEntry.uniqueSongs.add(songKey);
      if (airDate && (!albumEntry.firstAppearance || airDate < albumEntry.firstAppearance)) albumEntry.firstAppearance = airDate;
      addArtistVariant(albumEntry.variants, rawAlbum, airDate);
    }

    parsedRows.push({
      airDate, episodeId,
      episodeNumber: row.episodeNumber == null ? null : Number(row.episodeNumber),
      position: Number(row.position ?? 0),
      episodeSongCount: Number(row.episodeSongCount ?? 0),
      songKey, albumKey, rawSong, rawAlbum,
    });
  }

  const artist = pickArtistDisplayName(artistVariants.values());
  const songDisplay = resolveDisplayMap(songMap);
  const albumDisplay = resolveDisplayMap(albumMap);

  const airings = parsedRows
    .map((r) => ({
      airDate: r.airDate, episodeId: r.episodeId, episodeNumber: r.episodeNumber,
      position: r.position, episodeSongCount: r.episodeSongCount,
      songTitle: songDisplay.get(r.songKey) || r.rawSong,
      album: r.albumKey ? (albumDisplay.get(r.albumKey) || r.rawAlbum) : '',
    }))
    .sort((a, b) => cmpAsc(b.airDate, a.airDate) || cmpAsc(b.episodeId, a.episodeId) || (a.position - b.position));

  const sortedDates = Array.from(airDates).sort();
  const firstAppearance = sortedDates[0] ?? '';
  const lastAppearance = sortedDates[sortedDates.length - 1] ?? '';
  const archiveYearEntries = [...(archive?.years || [])]
    .map((y) => ({ year: Number(y.year), spins: Number(y.spins ?? 0) }))
    .filter((y) => Number.isFinite(y.year))
    .sort((a, b) => a.year - b.year);
  const archiveTotalSpins = Number(
    archive?.totalSpins ?? archive?.totalSongPlays ?? archiveYearEntries.reduce((sum, y) => sum + y.spins, 0),
  );
  const archiveLatest = archive?.dateRange?.latest ?? null;
  const rawSinceLast = archiveLatest && lastAppearance ? daysBetween(lastAppearance, archiveLatest) : null;

  let oneSpinSongs = 0;
  const topSongs = Array.from(songMap.entries()).map(([sk, entry]) => {
    if (entry.totalPlays === 1) oneSpinSongs += 1;
    const albums = Array.from(entry.albumCounts.entries())
      .map(([ak, cnt]) => [albumDisplay.get(ak) || ak, cnt])
      .sort((a, b) => (b[1] - a[1]) || cmpText(a[0], b[0]));
    return { songTitle: songDisplay.get(sk) || '', album: albums[0]?.[0] || '', totalPlays: entry.totalPlays };
  }).sort((a, b) => (b.totalPlays - a.totalPlays) || cmpText(a.songTitle, b.songTitle)).slice(0, 10);

  const topAlbums = Array.from(albumMap.entries())
    .map(([ak, entry]) => ({
      album: albumDisplay.get(ak) || '', totalPlays: entry.totalPlays,
      uniqueSongs: entry.uniqueSongs.size, firstAppearance: entry.firstAppearance,
    }))
    .sort((a, b) => (b.totalPlays - a.totalPlays) || cmpText(a.album, b.album))
    .slice(0, 10);

  const years = archiveYearEntries.map((y) => ({ year: y.year, spins: yearCounts.get(y.year) ?? 0, archiveSpins: y.spins }));
  let peakYear = null;
  for (const y of years) if (!peakYear || y.spins > peakYear.spins) peakYear = { year: y.year, spins: y.spins };
  const months = Array.from(monthCounts.entries()).sort((a, b) => cmpAsc(a[0], b[0])).map(([month, spins]) => ({ month, spins }));

  return {
    artist, rank: Number(rank ?? 1), totalArtists: Number(totalArtists ?? 0),
    summary: {
      totalPlays: airings.length, episodeCount: episodeIds.size, uniqueSongs: songMap.size, uniqueAlbums: albumMap.size,
      firstAppearance, lastAppearance, shareOfSpins: archiveTotalSpins > 0 ? airings.length / archiveTotalSpins : 0,
      oneSpinSongs, daysSinceLast: rawSinceLast === null ? null : Math.max(0, rawSinceLast),
    },
    rotation: buildRotationStats(airDates, airings, episodeIds.size),
    years, peakYear, months, airings, topSongs, topAlbums,
    playedAlongside: buildPlayedAlongside(coOccurrences, normalizeArtistKey(artist || rows[0]?.artist)),
    archive: {
      totalSpins: archiveTotalSpins, totalEpisodes: Number(archive?.totalEpisodes ?? 0),
      dateRange: { earliest: archive?.dateRange?.earliest ?? null, latest: archiveLatest },
    },
  };
}
