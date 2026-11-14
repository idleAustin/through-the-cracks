// Dynamic expected values read from refreshed public/data/*.json snapshots for Playwright browser assertions.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'public', 'data');
const readJson = (rel) => JSON.parse(readFileSync(path.join(DATA_DIR, rel), 'utf8'));

const overview = readJson('overview.json');
const episodesIndex = readJson('episodes-index.json');
const yearSpins = readJson('year-spins.json');
const artists = readJson('artists.json');
const songs = readJson('songs.json');
const coryBranan = artists.find((a) => a.name === 'Cory Branan');
const coryBrananRank = coryBranan ? 1 + artists.filter((a) => a.totalPlays > coryBranan.totalPlays).length : 34;

const latestAirDate = overview.dateRange?.latest || '';
const latestYear = latestAirDate.slice(0, 4);
const playlists = latestYear ? readJson(`playlists/${latestYear}.json`) : {};
const latestEpisodeId = String(overview.latestEpisodeId || '');
const indexEntry = (episodesIndex.episodes || []).find((ep) => String(ep.id) === latestEpisodeId);
const firstTrack = (playlists[latestEpisodeId] || [])[0] || {};
const topSong0 = songs[0] || {};

export const EXPECTED = {
  totalEpisodesFmt: Number(overview.totalEpisodes || 0).toLocaleString('en-US'),
  totalSpinsFmt: Number(overview.totalSongPlays || 0).toLocaleString('en-US'),
  uniqueArtistsFmt: Number(overview.uniqueArtists || 0).toLocaleString('en-US'),
  uniqueSongsFmt: Number(overview.uniqueSongs || 0).toLocaleString('en-US'),
  latestEpisodeId,
  latestAirDateShort: latestAirDate
    ? new Date(`${latestAirDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—',
  latestSongCount: Number(indexEntry?.song_count ?? (playlists[latestEpisodeId] || []).length),
  latestFirstTrack: {
    position: '01',
    songTitle: firstTrack.songTitle || firstTrack.song || '',
    artist: firstTrack.artist || '',
    album: firstTrack.album || '',
  },
  topSong: {
    songTitle: topSong0.songTitle || '',
    artist: topSong0.artist || '',
  },
  yearCount: (yearSpins.years || []).length,
  yearRangeLabel: `${yearSpins.years[0]}–${yearSpins.years[yearSpins.years.length - 1]}`,
  toddSniderPeakSpins: String(Math.max(...(yearSpins.artists?.['Todd Snider'] || [0]))),
  coryBrananRank,
};
