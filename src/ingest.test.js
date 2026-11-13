// Unit tests for Ticket 08 Blogger Atom feed normalization, post parsing, incremental merge, and static snapshot generation.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeIncrementalEpisodes, normalizeAtomFeedEntry, parsePost } from '../scripts/blogger-parser.js';
import { writeStaticSnapshots } from '../scripts/static-snapshots.js';

const tempDirs = [];
const createTempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ttc-ingest-test-'));
  tempDirs.push(dir);
  return dir;
};
const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('Ticket 08 Blogger Atom ingestion & snapshot generation', () => {
  it('normalizeAtomFeedEntry strips Blogger tag id and upgrades alternate link to https', () => {
    const normalized = normalizeAtomFeedEntry({
      id: 'tag:blogger.com,1999:blog-3469042462299367694.post-492815995999333864',
      title: "Playlist for WEVL's Through The Cracks, Saturday 8/8/2026",
      content: '<p>Jonathan Byrd - Prairie Girl - The Law & The Lonesome</p>',
      published: '2026-08-08T11:03:13-07:00',
      updated: '2026-08-08T12:00:00-07:00',
      link: [
        { rel: 'self', href: 'https://www.blogger.com/feeds/3469042462299367694/posts/default/492815995999333864' },
        { rel: 'alternate', href: 'http://eddirmeyer.blogspot.com/2026/08/sample-playlist.html' },
      ],
    });
    expect(normalized).toEqual({
      id: '492815995999333864',
      title: "Playlist for WEVL's Through The Cracks, Saturday 8/8/2026",
      content: '<p>Jonathan Byrd - Prairie Girl - The Law & The Lonesome</p>',
      published: '2026-08-08T11:03:13-07:00',
      updated: '2026-08-08T12:00:00-07:00',
      url: 'https://eddirmeyer.blogspot.com/2026/08/sample-playlist.html',
    });
  });

  it('parsePost handles standard, missing-weekday, and themed interlude posts cleanly', () => {
    const standard = parsePost({
      id: '101',
      title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
      content: '<p>Artist One - Song Alpha - Album One<br />Artist Two - Song Beta - Album Two</p><p>842</p>',
      published: '2026-11-11T18:00:00-06:00',
      url: 'https://eddirmeyer.blogspot.com/2026/11/101.html',
    });
    expect(standard.episode.airDate).toBe('2026-11-11');
    expect(standard.episode.dayOfWeek).toBe('Wednesday');
    expect(standard.episode.episodeNumber).toBe(842);
    expect(standard.songs).toHaveLength(2);
    expect(standard.songs.map((s) => s.songTitle)).toEqual(['Song Alpha', 'Song Beta']);

    const noWeekday = parsePost({
      id: '102',
      title: "Playlist for WEVL's Through The Cracks, 7/1/2026",
      content: '<div>Artist Three - Tune Three - Record Three</div><div>#20</div>',
      published: '2026-07-01T18:00:00-06:00',
      url: 'https://eddirmeyer.blogspot.com/2026/07/102.html',
    });
    expect(noWeekday.episode.airDate).toBe('2026-07-01');
    expect(noWeekday.episode.dayOfWeek).toBeNull();
    expect(noWeekday.episode.episodeNumber).toBe(20);
    expect(noWeekday.songs).toHaveLength(1);
    expect(noWeekday.songs[0].artist).toBe('Artist Three');

    const themed = parsePost({
      id: '103',
      title: "Playlist for WEVL's Through The Cracks, Saturday 10/31/2026: Happy Halloween!",
      content: '<p>instrumental interlude: Booker T - Green Onions - Green Onions</p>',
      published: '2026-10-31T18:00:00-06:00',
      url: 'https://eddirmeyer.blogspot.com/2026/10/103.html',
    });
    expect(themed.episode.airDate).toBe('2026-10-31');
    expect(themed.songs).toHaveLength(1);
    expect(themed.songs[0].album).toBe('Green Onions (Instrumental Interlude)');
  });

  it('mergeIncrementalEpisodes upserts edited episodes by String(id) and sorts airDate DESC, id DESC', () => {
    const existing = [
      {
        id: '200',
        title: "Playlist for WEVL's Through The Cracks, Saturday 11/07/2026",
        airDate: '2026-11-07',
        dayOfWeek: 'Saturday',
        episodeNumber: 840,
        publishedAt: '2026-11-07T12:00:00-06:00',
        url: 'https://eddirmeyer.blogspot.com/2026/11/200.html',
        songCount: 1,
        songs: [{ position: 1, artist: 'Old Artist', songTitle: 'Old Song', album: 'Old Album', rawLine: 'Old Artist - Old Song - Old Album' }],
      },
      {
        id: '150',
        title: "Playlist for WEVL's Through The Cracks, Saturday 12/20/2025",
        airDate: '2025-12-20',
        dayOfWeek: 'Saturday',
        episodeNumber: 790,
        publishedAt: '2025-12-20T12:00:00-06:00',
        url: 'https://eddirmeyer.blogspot.com/2025/12/150.html',
        songCount: 1,
        songs: [{ position: 1, artist: 'Year 2025 Artist', songTitle: 'Winter Tune', album: 'Frost', rawLine: 'Year 2025 Artist - Winter Tune - Frost' }],
      },
    ];

    const edited = parsePost({
      id: 200,
      title: "Playlist for WEVL's Through The Cracks, Saturday 11/07/2026",
      content: '<p>Edited Artist - Edited Song - Edited Album<br />Second Artist - Second Song - Second Album</p>',
      published: '2026-11-07T12:00:00-06:00',
      url: 'https://eddirmeyer.blogspot.com/2026/11/200.html',
    });
    const addedSameDayLowerId = parsePost({
      id: '300',
      title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
      content: '<p>New Artist - New Song - New Album</p>',
      published: '2026-11-11T12:00:00-06:00',
      url: 'https://eddirmeyer.blogspot.com/2026/11/300.html',
    });
    const addedSameDayHigherId = parsePost({
      id: '900',
      title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
      content: '<p>Late Artist - Late Song - Late Album</p>',
      published: '2026-11-11T13:00:00-06:00',
      url: 'https://eddirmeyer.blogspot.com/2026/11/900.html',
    });

    const merged = mergeIncrementalEpisodes(existing, [edited, addedSameDayLowerId, addedSameDayHigherId]);

    expect(merged.map((ep) => ep.id)).toEqual(['900', '300', '200', '150']);
    expect(merged[2].songCount).toBe(2);
    expect(merged[2].songs[0].artist).toBe('Edited Artist');
  });

  it('writeStaticSnapshots writes all 9 artifact sets with consistent totals and cleans up cleanly', () => {
    const dir = createTempDir();
    const episodesData = [
      {
        id: '301',
        title: "Playlist for WEVL's Through The Cracks, Wednesday 11/11/2026",
        airDate: '2026-11-11',
        dayOfWeek: 'Wednesday',
        episodeNumber: 842,
        publishedAt: '2026-11-11T18:00:00-06:00',
        url: 'https://eddirmeyer.blogspot.com/2026/11/301.html',
        songCount: 2,
        songs: [
          { position: 1, artist: 'Todd Snider', songTitle: 'Handsome John', album: 'East Nashville Skyline', rawLine: 'Todd Snider - Handsome John - East Nashville Skyline' },
          { position: 2, artist: 'Carrie Rodriguez', songTitle: '50s French Movie', album: 'Seven Angels On A Bicycle', rawLine: 'Carrie Rodriguez - 50s French Movie - Seven Angels On A Bicycle' },
        ],
      },
      {
        id: '205',
        title: "Playlist for WEVL's Through The Cracks, Saturday 12/20/2025",
        airDate: '2025-12-20',
        dayOfWeek: 'Saturday',
        episodeNumber: 790,
        publishedAt: '2025-12-20T18:00:00-06:00',
        url: 'https://eddirmeyer.blogspot.com/2025/12/205.html',
        songCount: 1,
        songs: [
          { position: 1, artist: 'Todd Snider', songTitle: 'Handsome John', album: 'East Nashville Skyline', rawLine: 'Todd Snider - Handsome John - East Nashville Skyline' },
        ],
      },
    ];

    writeStaticSnapshots(episodesData, dir, { writeEpisodesFile: true });

    for (const rel of [
      'episodes.json',
      'episodes-index.json',
      'playlists/2025.json',
      'playlists/2026.json',
      'year-spins.json',
      'artists.json',
      'albums.json',
      'songs.json',
      'years.json',
      'overview.json',
    ]) {
      expect(existsSync(path.join(dir, rel)), `missing ${rel}`).toBe(true);
    }

    const episodes = readJson(path.join(dir, 'episodes.json'));
    const index = readJson(path.join(dir, 'episodes-index.json'));
    const playlist2026 = readJson(path.join(dir, 'playlists/2026.json'));
    const yearSpins = readJson(path.join(dir, 'year-spins.json'));
    const artists = readJson(path.join(dir, 'artists.json'));
    const albums = readJson(path.join(dir, 'albums.json'));
    const songs = readJson(path.join(dir, 'songs.json'));
    const years = readJson(path.join(dir, 'years.json'));
    const overview = readJson(path.join(dir, 'overview.json'));

    expect(episodes).toHaveLength(2);
    expect(index.episodes.map((e) => e.id)).toEqual(['301', '205']);
    expect(playlist2026['301']).toHaveLength(2);
    expect(yearSpins.archive.reduce((sum, n) => sum + n, 0)).toBe(3);
    expect(artists.find((a) => a.name === 'Todd Snider')?.totalPlays).toBe(2);
    expect(albums).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artist: 'Todd Snider', album: 'East Nashville Skyline', totalPlays: 2 }),
        expect.objectContaining({ artist: 'Carrie Rodriguez', album: 'Seven Angels On A Bicycle', totalPlays: 1 }),
      ]),
    );
    expect(songs.find((s) => s.songTitle === 'Handsome John')?.totalPlays).toBe(2);
    expect(years).toEqual([
      { year: '2025', episodeCount: 1, songCount: 1, uniqueArtists: 1 },
      { year: '2026', episodeCount: 1, songCount: 2, uniqueArtists: 2 },
    ]);
    expect(overview.totalEpisodes).toBe(2);
    expect(overview.totalSongPlays).toBe(3);
    expect(overview.latestEpisodeId).toBe('301');
    expect(overview.dateRange.latest).toBe('2026-11-11');
  });
});
