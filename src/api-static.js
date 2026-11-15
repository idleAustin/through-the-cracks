// Static JSON snapshot facade, re-exporting static fetch/episode helpers and serving static year-spins series.
import { fetchStaticJson } from './api-runtime.js';

export { fetchStaticJson, fetchStaticJsonAllow404, getStaticPath } from './api-runtime.js';
export {
  getStaticEpisodeById,
  getStaticEpisodes,
  normalizeEpisodeDetail,
  normalizeEpisodeSummary,
  normalizeTrack,
} from './api-episodes-static.js';

const DEFAULT_YEAR_SPINS_YEARS = [
  2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
];

let cachedYearSpins = null;
let inFlightYearSpins = null;

async function loadYearSpins() {
  if (cachedYearSpins) return cachedYearSpins;
  if (inFlightYearSpins) return inFlightYearSpins;

  inFlightYearSpins = fetchStaticJson('/data/year-spins.json')
    .then((json) => {
      cachedYearSpins = json;
      return json;
    })
    .finally(() => {
      inFlightYearSpins = null;
    });

  return inFlightYearSpins;
}

function findEntryCaseInsensitive(record, targetKey) {
  if (!record || !targetKey) return null;
  if (Object.prototype.hasOwnProperty.call(record, targetKey)) {
    return record[targetKey];
  }
  const needle = targetKey.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === needle) return value;
  }
  return null;
}

export async function getStaticYearSpins({ artist = '', song = '' } = {}) {
  const payload = await loadYearSpins();
  const years = Array.isArray(payload?.years) && payload.years.length > 0
    ? payload.years
    : DEFAULT_YEAR_SPINS_YEARS;
  const align = (series) => years.map((_, i) => Number(series?.[i] || 0));

  const cleanArtist = String(artist || '').trim();
  const cleanSong = String(song || '').trim();

  if (cleanSong) {
    let series = null;
    const songsMap = payload?.songs || {};
    if (cleanArtist) {
      series = findEntryCaseInsensitive(songsMap, `${cleanSong}\t${cleanArtist}`);
    } else {
      const needle = cleanSong.toLowerCase();
      const summed = years.map(() => 0);
      let matched = false;
      for (const [key, counts] of Object.entries(songsMap)) {
        const tab = key.indexOf('\t');
        const keySong = tab === -1 ? key : key.slice(0, tab);
        if (keySong.toLowerCase() === needle && Array.isArray(counts)) {
          matched = true;
          for (let i = 0; i < years.length; i += 1) {
            summed[i] += Number(counts[i] || 0);
          }
        }
      }
      if (matched) series = summed;
    }
    return {
      years,
      spins: align(series),
      scope: 'song',
      artist: cleanArtist || null,
      song: cleanSong,
    };
  }

  if (cleanArtist) {
    const series = findEntryCaseInsensitive(payload?.artists || {}, cleanArtist);
    return {
      years,
      spins: align(series),
      scope: 'artist',
      artist: cleanArtist,
      song: null,
    };
  }

  return {
    years,
    spins: align(payload?.archive),
    scope: 'archive',
    artist: null,
    song: null,
  };
}
