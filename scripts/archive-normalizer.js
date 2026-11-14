// Pure Pass 1 Archive Normalization engine for Through the Cracks (Web-API-only, zero node:* imports).
import { ARTIST_ALIASES, resolveCanonicalArtist } from './artist-aliases.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_FIX = { wednesay: 'Wednesday', wed: 'Wednesday', thurs: 'Thursday' };
const TITLE_DATE_RESILIENT_RE =
  /(?:(Monday|Tuesday|Wednesday|Wednesay|Wed|Thursday|Thurs|Friday|Saturday|Sunday)\.?,?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4})|(?=\s*&\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\/\d{1,2}\/(\d{2,4})))/i;
const SURNAME_PREFIX_RE = /(?:Mc|Mac|De|Di|Du|La|Le|Lo|Van|Von|Fitz|St\.?|O'|d')$/i;
const GLUED_SPLIT_RE =
  /([a-z0-9)\]"'])([A-Z][a-z]{2,}(?:\s+[A-Z][\w'.-]*)*(?:\s+(?:&|w\/)\s+[A-Z][\w'.-]*)*\s*-\s*)/g;
const PROTECTED_FEAT_ARTISTS = new Set(['little feat']);
const PROTECTED_WITH_ARTISTS = new Set(["i'm with her", 'songwriting with soldiers']);
const INSTRUMENTS_RE =
  /^(?:(?:electric|acoustic|slide|pedal steel|steel|lead|rhythm|upright)\s+)*(?:guitar|vocals|drums|percussion|fiddle|mandolin|banjo|bass|keys|keyboards|piano|organ|harmonica|saxophone|horns)(?:\s*(?:&|and|,)\s*(?:(?:electric|acoustic|slide|pedal steel|steel|lead|rhythm|upright)\s+)?(?:guitar|vocals|drums|percussion|fiddle|mandolin|banjo|bass|keys|keyboards|piano|organ|harmonica|saxophone|horns))*$/i;

const MISSING_DASH_FIXES = new Map([
  ["Jorma Kaukonen  Ain't In No Hurry - Ain't In No Hurry", "Jorma Kaukonen - Ain't In No Hurry - Ain't In No Hurry"],
  ["Marlee MacLeod  I'm Gonna Leave You - Drive Too Fast", "Marlee MacLeod - I'm Gonna Leave You - Drive Too Fast"],
  ['Luka Bloom - Holy Ground  Salty Heaven', 'Luka Bloom - Holy Ground - Salty Heaven'],
  ['The Kinks Waterloo Sunset - Something Else From The Kinks', 'The Kinks - Waterloo Sunset - Something Else From The Kinks'],
  ['Darrell Scott - Cumberland Plateau (w/ John Cowan) Old Cane Back Rocker', 'Darrell Scott - Cumberland Plateau (w/ John Cowan) - Old Cane Back Rocker'],
  ['Wintery Songs In Eleventy Part Harmony (w/ Valerie Thompson, Rose Cousins, et al.) Holly And The Ivy/ Life Is Good Jig - Hark', 'Wintery Songs In Eleventy Part Harmony (w/ Valerie Thompson, Rose Cousins, et al.) - Holly And The Ivy/ Life Is Good Jig - Hark'],
]);

const SEP_WS_RE = /\s+-\s+/y;
const SEP_RIGHT_TIGHT_RE = /\s+-(?=\S)/y;
const SEP_LEFT_TIGHT_RE = /-\s+/y;

export function mechanicalClean(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u2018\u2019\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0\u2000-\u200B\u202F\uFEFF\t]/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\bw\/\s*([^\s)])/gi, 'w/ $1')
    .replace(/\(\s+w\//gi, '(w/')
    .replace(/ ?\/ /g, '/ ')
    .trim();
}

export function nameKey(text) {
  return mechanicalClean(text).toLowerCase();
}

export function isProperMixedCase(str) {
  return Boolean(str && /[A-Z]/.test(str) && /[a-z]/.test(str));
}

export function pickCanonicalDisplay(spellingsMap, explicitDisplay = null) {
  if (explicitDisplay) return explicitDisplay;
  const entries = [...spellingsMap.entries()].map(([name, meta]) => ({
    name, count: meta.count || 0, earliest: meta.earliest || '9999-99-99',
    rank: isProperMixedCase(name) ? 2 : /^[A-Z0-9.&]{2,5}$/.test(name) ? 1 : 0,
  }));
  entries.sort((a, b) =>
    (b.rank - a.rank) || (b.count - a.count) || a.earliest.localeCompare(b.earliest) || a.name.localeCompare(b.name),
  );
  return entries[0]?.name || '';
}

function isoWeekday(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : WEEKDAYS[d.getUTCDay()];
}

export function normalizeEpisodeMeta(ep) {
  const title = String(ep?.title || '');
  const m = title.match(TITLE_DATE_RESILIENT_RE);
  const oldAirDate = ep?.airDate || '';
  const oldDow = ep?.dayOfWeek ?? null;
  const pubAt = ep?.publishedAt || ep?.published || null;

  if (!m) {
    return {
      airDate: oldAirDate, dayOfWeek: oldDow || (oldAirDate ? isoWeekday(oldAirDate) : null),
      repaired: false, airDateChanged: false, dowMismatch: false, statedDow: null, reasons: [],
    };
  }

  const rawDow = m[1] ? m[1].toLowerCase() : null;
  const statedDow = rawDow ? WEEKDAY_FIX[rawDow] || rawDow[0].toUpperCase() + rawDow.slice(1) : null;
  const month = m[2].padStart(2, '0');
  const day = m[3].padStart(2, '0');
  const rawYr = m[4] || m[5];
  const year = rawYr.length === 2 ? `20${rawYr}` : rawYr;
  let airDate = `${year}-${month}-${day}`;
  const reasons = [];

  if (pubAt) {
    const pubMs = Date.parse(pubAt);
    const parsedMs = Date.parse(`${airDate}T12:00:00Z`);
    if (Number.isFinite(pubMs) && Number.isFinite(parsedMs) && pubMs - parsedMs > 300 * 86_400_000) {
      const candidate = `${String(pubAt).slice(0, 4)}-${month}-${day}`;
      if (statedDow && isoWeekday(candidate) === statedDow) { airDate = candidate; reasons.push('year-typo'); }
    }
  }

  const calendarDow = isoWeekday(airDate);
  const dowMismatch = Boolean(statedDow && calendarDow && statedDow !== calendarDow);
  if (dowMismatch) reasons.push('weekday-mismatch');
  if (airDate !== oldAirDate) reasons.push('airdate-fixed');
  if (rawYr.length === 2) reasons.push('two-digit-year');
  if (oldDow === null && calendarDow) reasons.push('day-recovered');
  if (!reasons.length && !/WEVL's Through The Cracks,\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*\d{1,2}\/\d{1,2}\/\d{4}/i.test(title)) {
    reasons.push('title-format');
  }

  const dayOfWeek = calendarDow || statedDow || oldDow;
  return {
    airDate, dayOfWeek,
    repaired: airDate !== oldAirDate || oldDow !== (calendarDow || statedDow) || dowMismatch || reasons.length > 0,
    airDateChanged: airDate !== oldAirDate, dowMismatch, statedDow, reasons,
  };
}

function splitAtDepthZero(str) {
  const parts = [];
  const trackP = (str.match(/\(/g) || []).length === (str.match(/\)/g) || []).length;
  const trackB = (str.match(/\[/g) || []).length === (str.match(/\]/g) || []).length;
  let p = 0; let b = 0; let start = 0;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (trackP && ch === '(') p += 1;
    else if (trackP && ch === ')' && p > 0) p -= 1;
    else if (trackB && ch === '[') b += 1;
    else if (trackB && ch === ']' && b > 0) b -= 1;

    if (p === 0 && b === 0 && i > 0) {
      let sep = null;
      if (/\s/.test(ch) && (i === 1 || !/\s/.test(str[i - 1]))) {
        SEP_WS_RE.lastIndex = i;
        sep = SEP_WS_RE.exec(str);
        if (!sep) { SEP_RIGHT_TIGHT_RE.lastIndex = i; sep = SEP_RIGHT_TIGHT_RE.exec(str); }
      } else if (ch === '-' && /\S/.test(str[i - 1])) {
        SEP_LEFT_TIGHT_RE.lastIndex = i;
        sep = SEP_LEFT_TIGHT_RE.exec(str);
      }
      if (sep) { parts.push(str.slice(start, i).trim()); i += sep[0].length - 1; start = i + 1; }
    }
  }
  parts.push(str.slice(start).trim());
  return parts.filter(Boolean);
}

export function splitGluedRawLine(rawLine) {
  const raw = String(rawLine || '');
  if (splitAtDepthZero(raw).length < 4) return [raw];
  const firstSepIdx = raw.indexOf(' - ');
  if (firstSepIdx === -1) return [raw];

  GLUED_SPLIT_RE.lastIndex = 0;
  let m;
  while ((m = GLUED_SPLIT_RE.exec(raw)) !== null) {
    if (m.index <= firstSepIdx + 6) continue;
    const beforeCtx = raw.slice(Math.max(0, m.index - 15), m.index + 1);
    if (SURNAME_PREFIX_RE.test(beforeCtx)) continue;
    const tail = raw.slice(m.index + 1);
    if (splitAtDepthZero(tail).length >= 2) return [raw.slice(0, m.index + 1).trim(), tail.trim()];
  }
  return [raw];
}

export function isEditorialLine(rawLine, artist, songTitle) {
  const raw = String(rawLine || '').trim();
  const art = String(artist || '').trim();
  const artLower = art.toLowerCase();
  const song = String(songTitle || '').trim();

  if (/^thanks to\b/i.test(raw) || /wevl\.org|901-528-1990/i.test(raw)) return 'pledge-announcement';
  if (
    /^(?:some favorites\s+\d{4}|a tribute to\b)/i.test(art) ||
    artLower.includes('playlist for') ||
    art.startsWith('#') ||
    artLower.includes('thanksgiving saturday') ||
    artLower.includes('anniversary special')
  ) {
    return 'episode-banner';
  }
  if (
    /^(?:live\s+)?in[- ]?(?:the\s+)?(?:wevl\s+)?studio(?:\s+(?:performance|interview).*|\s*)?[:.]*$/i.test(song) ||
    /^live\s+in[- ]?(?:the\s+)?studio\b/i.test(song)
  ) {
    return 'in-studio-header';
  }
  if (/^-\s+/.test(raw) && INSTRUMENTS_RE.test(song)) return 'band-credit';
  return null;
}

export function reparseSpinLine(rawLine) {
  const overridden = MISSING_DASH_FIXES.get(String(rawLine || '').trim());
  const sourceLine = overridden || String(rawLine || '');
  let cleaned = sourceLine.replace(/^[-•*]\s*/, '').replace(/\s+-\s*$/, '').trim();
  let isInstrumental = false;
  let fixKind = overridden ? 'missing-dash' : null;

  const interludeRe = /^(?:instrumental\s+|intrumental\s+)?interlude(?:\s*:\s*|\s+-\s+)/i;
  if (interludeRe.test(cleaned)) {
    const hadDash = /^(?:instrumental\s+|intrumental\s+)?interlude\s+-\s+/i.test(cleaned);
    isInstrumental = true;
    cleaned = cleaned.replace(interludeRe, '').replace(/^[-•*]\s*/, '').trim();
    if (hadDash) fixKind = fixKind || 'interlude-dash';
  }

  let parts = splitAtDepthZero(cleaned);
  if (parts.length === 1 && isInstrumental && parts[0].includes(':')) {
    const idx = parts[0].indexOf(':');
    parts = [parts[0].slice(0, idx).trim(), parts[0].slice(idx + 1).trim()];
  }
  if (parts.length < 2) return null;

  const naiveParts = cleaned.replace(/\s+-\s+|\s+-|-\s+/g, ' |~| ').split(' |~| ').map((p) => p.trim()).filter(Boolean);
  if (!fixKind && naiveParts.length !== parts.length) fixKind = 'paren-dash';

  let releaseYear = null;
  let releaseKind = isInstrumental ? 'interlude' : 'album';
  const artist = parts[0];
  let songTitle;
  let album;

  if (parts.length >= 4) {
    const w = [...parts];
    if (/\bannual thanksgiving saturday\b/i.test(w.at(-1))) { w.pop(); fixKind ||= 'broadcast-note'; }
    if (w.length >= 4 && /^(?:19\d\d|20\d\d)$/.test(w.at(-1)) && !/\b(?:19\d\d|20\d\d)\s*$/.test(w.at(-2))) {
      releaseYear = w.pop(); fixKind ||= 'year-suffix';
    }
    if (w.length >= 4 && /^e\.?p\.?$/i.test(w.at(-1))) { w.pop(); releaseKind = 'ep'; fixKind ||= 'ep-suffix'; }
    if (/^john hartford$/i.test(w[0]) && w.length === 4 && /^aereo$/i.test(w[2]) && /^plain|plane$/i.test(w[3])) {
      songTitle = w[1]; album = `${w[2]}-${w[3]}`; fixKind ||= 'compound-album';
    } else if (w.length === 4 && (/^you know$/i.test(w[1]) || /^blow$/i.test(w[1]))) {
      songTitle = `${w[1]} - ${w[2]}`; album = w[3];
    } else if (w.length >= 3) {
      songTitle = w[1]; album = w.slice(2).join(' - ');
    } else {
      songTitle = w[1]; album = isInstrumental ? 'Instrumental Interlude' : '[Single / Track]';
    }
  } else {
    songTitle = parts[1];
    album = parts.length === 3 ? parts[2] : (isInstrumental ? 'Instrumental Interlude' : '[Single / Track]');
  }

  return { artist, songTitle, album, isInstrumental, releaseYear, releaseKind, fixKind };
}

export function normalizeAlbum(rawAlbum, isInstrumental = false, initialKind = 'album') {
  let album = mechanicalClean(rawAlbum);
  let releaseKind = initialKind;
  let changed = false;

  if (/\s*\(Instrumental Interlude\)$/i.test(album)) {
    album = album.replace(/\s*\(Instrumental Interlude\)$/i, '').trim();
    releaseKind = 'interlude'; changed = true;
  }
  if (/\s*\(\s*new\s*\)$/i.test(album)) { album = album.replace(/\s*\(\s*new\s*\)$/i, '').trim(); changed = true; }
  if (/\s*\(\d+(?:st|nd|rd|th)\s+Annual Thanksgiving Saturday[^)]*\)$/i.test(album)) {
    album = album.replace(/\s*\(\d+(?:st|nd|rd|th)\s+Annual Thanksgiving Saturday[^)]*\)$/i, '').trim(); changed = true;
  }
  const epBracketRe = /\s*(?:\(\s*EP\s*\)|\[\s*EP\s*\])$/i;
  if (epBracketRe.test(album)) {
    album = album.replace(epBracketRe, '').trim();
    if (releaseKind === 'album') releaseKind = 'ep';
    changed = true;
  }

  const lower = album.toLowerCase();
  if (!album || /^\[?\s*single\s*\/\s*track\s*\]?$/.test(lower) || lower === 'single' || lower === '[single]' || lower === '(single)') {
    return { album: '', releaseKind: isInstrumental ? 'interlude' : 'single', isSentinel: true, changed: true };
  }
  if (lower === 'instrumental interlude') return { album: '', releaseKind: 'interlude', isSentinel: true, changed: true };
  if (lower === '?' || lower === 'unknown' || lower === 'n/a' || lower === 'none' || lower === 'tba') {
    return { album: '', releaseKind: 'unknown', isSentinel: true, changed: true };
  }
  return { album, releaseKind, isSentinel: false, changed: changed || album !== String(rawAlbum || '') };
}

export function extractArtistCredit(cleanedArtist, policy = 'feat+w') {
  const artist = mechanicalClean(cleanedArtist);
  const lower = artist.toLowerCase();
  if (policy === 'none') return { mainArtist: artist, featuredArtist: null, attributionType: null };

  const parenWithMatch = artist.match(/^(.+?)\s+\(w\/\s+([^)]+)\)$/i);
  if (parenWithMatch && policy === 'feat') {
    return { mainArtist: `${parenWithMatch[1].trim()} w/ ${parenWithMatch[2].trim()}`, featuredArtist: null, attributionType: 'w-paren-normalized' };
  }

  if (!PROTECTED_FEAT_ARTISTS.has(lower)) {
    const featParen = artist.match(/^(.+?)\s*\(\s*(?:feat\.?|ft\.?|featuring)\s+([^)]+)\)\s*$/i);
    if (featParen && featParen[1].trim().toLowerCase() !== 'little') {
      return { mainArtist: featParen[1].trim(), featuredArtist: featParen[2].trim(), attributionType: 'feat' };
    }
    const featPlain = artist.match(/^(.+?)\s+\b(?:feat\.?|ft\.?|featuring)\s+(.+)$/i);
    if (featPlain && featPlain[1].trim().toLowerCase() !== 'little') {
      return { mainArtist: featPlain[1].trim(), featuredArtist: featPlain[2].trim(), attributionType: 'feat' };
    }
  }

  if (policy === 'feat+w' && !PROTECTED_WITH_ARTISTS.has(lower)) {
    const wParen = artist.match(/^(.+?)\s*\(\s*w\/\s+([^)]+)\)\s*$/i);
    if (wParen) return { mainArtist: wParen[1].trim(), featuredArtist: wParen[2].trim(), attributionType: 'w/' };
    const wSlash = artist.match(/^(.+?)\s+w\/\s+(.+)$/i);
    if (wSlash) return { mainArtist: wSlash[1].trim(), featuredArtist: wSlash[2].trim(), attributionType: 'w/' };
    const withWord = artist.match(/^(.+?)\s+\bwith\s+(.+)$/i);
    if (withWord && !/^i'm$/i.test(withWord[1].trim()) && !/soldiers/i.test(withWord[2])) {
      return { mainArtist: withWord[1].trim(), featuredArtist: withWord[2].trim(), attributionType: 'with' };
    }
  }
  return { mainArtist: artist, featuredArtist: null, attributionType: null };
}

export function normalizeSpinLine(rawLine, position = 1) {
  const parsed = reparseSpinLine(rawLine);
  if (!parsed || isEditorialLine(rawLine, parsed.artist, parsed.songTitle)) return null;
  const credit = extractArtistCredit(mechanicalClean(parsed.artist), 'feat+w');
  const artist = resolveCanonicalArtist(credit.mainArtist);
  const featuredArtist = credit.featuredArtist ? resolveCanonicalArtist(mechanicalClean(credit.featuredArtist)) : '';
  const songTitle = mechanicalClean(parsed.songTitle);
  if (!artist || !songTitle) return null;
  const albNorm = normalizeAlbum(parsed.album, parsed.isInstrumental, parsed.releaseKind);
  return { position, rawLine: String(rawLine || '').trim(), artist, featuredArtist, songTitle, album: albNorm.album, releaseKind: albNorm.releaseKind };
}

function addSpelling(map, key, display, airDate) {
  if (!map.has(key)) map.set(key, new Map());
  const spellings = map.get(key);
  const entry = spellings.get(display) || { count: 0, earliest: airDate || '9999-99-99' };
  entry.count += 1;
  if (airDate && airDate < entry.earliest) entry.earliest = airDate;
  spellings.set(display, entry);
}

export function normalizeArchiveEpisodes(episodes) {
  const artistSpellings = new Map();
  const songSpellings = new Map();
  const albumSpellings = new Map();
  const staged = [];

  for (const ep of episodes || []) {
    if (!ep || ep.id === undefined || ep.id === null) continue;
    const meta = normalizeEpisodeMeta(ep);
    const airDate = meta.airDate || ep.airDate || '';
    const spins = [];

    for (const s of ep.songs || []) {
      const raw = s.rawLine || `${s.artist || ''} - ${s.songTitle || s.song || ''}${s.album ? ` - ${s.album}` : ''}`;
      for (const line of splitGluedRawLine(raw)) {
        const spin = normalizeSpinLine(line, spins.length + 1);
        if (!spin) continue;
        const artistKey = nameKey(spin.artist);
        const albumKey = spin.album ? nameKey(spin.album) : '';
        addSpelling(artistSpellings, artistKey, spin.artist, airDate);
        addSpelling(songSpellings, `${artistKey}\t${nameKey(spin.songTitle)}`, spin.songTitle, airDate);
        if (albumKey) addSpelling(albumSpellings, `${artistKey}|||${albumKey}`, spin.album, airDate);
        spins.push(spin);
      }
    }

    if (spins.length === 0) continue;
    staged.push({
      id: String(ep.id), title: ep.title || '', airDate,
      dayOfWeek: meta.dayOfWeek ?? null, episodeNumber: ep.episodeNumber ?? null,
      publishedAt: ep.publishedAt || null, url: ep.url || null, spins,
    });
  }

  return staged
    .map((ep) => {
      const songs = ep.spins.map((spin, idx) => {
        const artistKey = nameKey(spin.artist);
        const songKey = `${artistKey}\t${nameKey(spin.songTitle)}`;
        const albumKey = spin.album ? `${artistKey}|||${nameKey(spin.album)}` : '';
        return {
          position: idx + 1, rawLine: spin.rawLine,
          artist: ARTIST_ALIASES.get(artistKey) || pickCanonicalDisplay(artistSpellings.get(artistKey)),
          featuredArtist: spin.featuredArtist,
          songTitle: pickCanonicalDisplay(songSpellings.get(songKey)),
          album: albumKey ? pickCanonicalDisplay(albumSpellings.get(albumKey)) : '',
          releaseKind: spin.releaseKind,
        };
      });
      return {
        id: ep.id, title: ep.title, airDate: ep.airDate, dayOfWeek: ep.dayOfWeek,
        episodeNumber: ep.episodeNumber, publishedAt: ep.publishedAt, url: ep.url,
        songCount: songs.length, songs,
      };
    })
    .sort((a, b) => (b.airDate || '').localeCompare(a.airDate || '') || String(b.id).localeCompare(String(a.id)));
}
