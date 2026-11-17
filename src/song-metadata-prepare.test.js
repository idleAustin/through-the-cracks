import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  isSingleOrBlankAlbum,
  normalizeGroupingToken,
  parsePrepareArgs,
  prepareMetadataCatalog,
  writeMetadataInputFile,
} from '../scripts/prepare-song-metadata-input.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ttc-meta-prep-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('isSingleOrBlankAlbum', () => {
  it('detects blank and explicit single labels while preserving real album names', () => {
    expect(isSingleOrBlankAlbum('')).toBe(true);
    expect(isSingleOrBlankAlbum('   ')).toBe(true);
    expect(isSingleOrBlankAlbum(null)).toBe(true);
    expect(isSingleOrBlankAlbum('Single')).toBe(true);
    expect(isSingleOrBlankAlbum('(Single)')).toBe(true);
    expect(isSingleOrBlankAlbum('[Single]')).toBe(true);
    expect(isSingleOrBlankAlbum('Non-Album')).toBe(true);
    expect(isSingleOrBlankAlbum('Unknown Album')).toBe(true);
    expect(isSingleOrBlankAlbum('Single: Holiday 7"')).toBe(true);
    expect(isSingleOrBlankAlbum('Midnight Train (Single)')).toBe(true);

    expect(isSingleOrBlankAlbum('Single Again')).toBe(false);
    expect(isSingleOrBlankAlbum('East Nashville Skyline')).toBe(false);
    expect(isSingleOrBlankAlbum('Single Girl, Married Girl')).toBe(false);
  });
});

describe('normalizeGroupingToken', () => {
  it('folds curly quotes, dashes, spaces, and casing', () => {
    expect(normalizeGroupingToken('  It’s   Midnight — Live  ')).toBe("it's midnight - live");
  });
});

describe('prepareMetadataCatalog', () => {
  it('groups shared artist-album songs, resolves canonical aliases, and orders by spin count', () => {
    const result = prepareMetadataCatalog({
      artists: [
        { name: 'Arlo Guthrie', totalPlays: 40 },
        { name: 'Todd Snider', totalPlays: 308 },
      ],
      songs: [
        {
          artist: 'Alro Guthrie',
          songTitle: "Alice's Restaurant",
          album: "Alice's Restaurant",
          albums: ["Alice's Restaurant"],
          totalPlays: 4,
          firstAppearance: '2014-01-05',
          lastAppearance: '2020-02-02',
        },
        {
          artist: 'Arlo Guthrie',
          songTitle: 'Chilling Of The Evening',
          album: "Alice's Restaurant",
          albums: ["Alice's Restaurant"],
          totalPlays: 1,
          firstAppearance: '2016-05-01',
          lastAppearance: '2016-05-01',
        },
        {
          artist: 'Todd Snider',
          songTitle: 'Tension',
          album: 'Single',
          albums: ['Single', 'East Nashville Skyline'],
          totalPlays: 12,
          firstAppearance: '2013-09-04',
          lastAppearance: '2026-01-01',
        },
        {
          artist: 'Todd Snider',
          songTitle: 'Loose Ends',
          album: '',
          albums: [],
          totalPlays: 1,
          firstAppearance: '2018-04-04',
          lastAppearance: '2018-04-04',
        },
      ],
    });

    expect(result.stats.totalSongs).toBe(4);
    expect(result.stats.albumGroupCount).toBe(2);
    expect(result.stats.albumCoveredSongs).toBe(3);
    expect(result.stats.singleSongs).toBe(1);
    expect(result.stats.multiSpinSongs).toBe(2);
    expect(result.stats.highSpinSongs).toBe(1);

    expect(result.albums[0].albumKey).toBe('todd snider|||east nashville skyline');
    expect(result.albums[0].totalPlays).toBe(12);
    expect(result.albums[1].albumKey).toBe("arlo guthrie|||alice's restaurant");
    expect(result.albums[1].songCount).toBe(2);
    expect(result.albums[1].multiSpinCount).toBe(1);

    expect(result.songs[0].song_key).toBe('todd snider|||tension');
    expect(result.songs[0].is_single).toBe(false);
    expect(result.songs[0].album).toBe('East Nashville Skyline');
    expect(result.songs[0].pass_tier).toBe('multi');

    const singleSong = result.songs.find((s) => s.song_title === 'Loose Ends');
    expect(singleSong.is_single).toBe(true);
    expect(singleSong.album_key).toBeNull();
    expect(singleSong.pass_tier).toBe('single');
  });

  it('merges duplicate song keys deterministically', () => {
    const result = prepareMetadataCatalog({
      artists: [{ name: 'Arlo Guthrie', totalPlays: 20 }],
      songs: [
        {
          artist: 'Alro Guthrie',
          songTitle: 'City of New Orleans',
          album: 'Single',
          albums: ['Single'],
          totalPlays: 1,
          firstAppearance: '2015-03-01',
          lastAppearance: '2015-03-01',
        },
        {
          artist: 'Arlo Guthrie',
          songTitle: 'City Of New Orleans',
          album: 'Hobo’s Lullaby',
          albums: ['Hobo’s Lullaby'],
          totalPlays: 3,
          firstAppearance: '2014-01-01',
          lastAppearance: '2021-07-04',
        },
      ],
    });

    expect(result.stats.totalSongs).toBe(1);
    expect(result.songs[0].totalPlays).toBe(4);
    expect(result.songs[0].is_single).toBe(false);
    expect(result.songs[0].album).toBe("Hobo's Lullaby");
    expect(result.songs[0].firstAppearance).toBe('2014-01-01');
    expect(result.songs[0].lastAppearance).toBe('2021-07-04');
  });
});

describe('parsePrepareArgs and writeMetadataInputFile', () => {
  it('parses CLI overrides and writes catalog JSON atomically', () => {
    const dir = makeTempDir();
    const songsPath = path.join(dir, 'songs.json');
    const artistsPath = path.join(dir, 'artists.json');
    const outputPath = path.join(dir, 'out', 'catalog-input.json');

    writeFileSync(
      songsPath,
      JSON.stringify([
        {
          artist: 'Hayes Carll',
          songTitle: 'Stomp And Holler',
          album: 'KMAG YOYO',
          albums: ['KMAG YOYO'],
          totalPlays: 9,
          firstAppearance: '2014-01-01',
          lastAppearance: '2025-10-01',
        },
      ]),
    );
    writeFileSync(artistsPath, JSON.stringify([{ name: 'Hayes Carll', totalPlays: 95 }]));

    const parsed = parsePrepareArgs([`--songs=${songsPath}`, `--artists=${artistsPath}`, `--out=${outputPath}`]);
    expect(parsed.songsPath).toBe(songsPath);
    expect(parsed.artistsPath).toBe(artistsPath);
    expect(parsed.outputPath).toBe(outputPath);

    const written = writeMetadataInputFile(parsed);
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(`${outputPath}.tmp`)).toBe(false);
    expect(written.stats.totalSongs).toBe(1);

    const onDisk = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect(onDisk.albums[0].albumKey).toBe('hayes carll|||kmag yoyo');
  });
});

