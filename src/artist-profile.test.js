// Unit tests for pure Artist profile builder helpers and profile contract (TDD RED before server/artistProfileBuilder.js).
import { describe, expect, it } from 'vitest';
import {
  buildArtistProfile,
  computeArtistRank,
  encodeArtistProfileKey,
  normalizeArtistKey,
  pickArtistDisplayName,
} from '../server/artistProfileBuilder.js';

const makeRow = (overrides = {}) => ({
  artist: 'Cory Branan',
  airDate: '2021-03-01',
  episodeId: 'ep-1',
  episodeNumber: 501,
  position: 1,
  episodeSongCount: 11,
  songTitle: 'Sour Mash',
  album: 'No-Hit Wonder',
  ...overrides,
});

const makeArchive = (overrides = {}) => ({
  totalSpins: 1200,
  totalEpisodes: 120,
  dateRange: { earliest: '2019-01-01', latest: '2021-07-09' },
  years: [
    { year: 2019, spins: 350 },
    { year: 2020, spins: 400 },
    { year: 2021, spins: 450 },
  ],
  ...overrides,
});

describe('Artist profile key, display name, and rank helpers', () => {
  it('normalizeArtistKey applies trimmed lowercase semantics safely', () => {
    expect(normalizeArtistKey('  Cory Branan  ')).toBe('cory branan');
    expect(normalizeArtistKey('Ani DiFranco')).toBe('ani difranco');
    expect(normalizeArtistKey('case/ lang/ veirs')).toBe('case/ lang/ veirs');
    expect(normalizeArtistKey('')).toBe('');
    expect(normalizeArtistKey(null)).toBe('');
  });

  it('pickArtistDisplayName selects highest Spin count, then earliest airDate, then code-point ascending', () => {
    expect(
      pickArtistDisplayName([
        { name: 'cory branan', spins: 1, airDate: '2014-01-01' },
        { name: 'Cory Branan', spins: 4, airDate: '2016-02-01' },
      ]),
    ).toBe('Cory Branan');

    expect(
      pickArtistDisplayName([
        { name: 'CORY BRANAN', spins: 3, airDate: '2016-01-01' },
        { name: 'Cory Branan', spins: 3, airDate: '2015-01-01' },
      ]),
    ).toBe('Cory Branan');

    expect(
      pickArtistDisplayName([
        { name: 'ani difranco', spins: 2, airDate: '2014-05-01' },
        { name: 'Ani DiFranco', spins: 2, airDate: '2014-05-01' },
      ]),
    ).toBe('Ani DiFranco');
  });

  it('computeArtistRank returns 1 + count(other > artistSpins) and totalArtists', () => {
    const counts = [40, 25, 25, 10, 1];
    expect(computeArtistRank(40, counts)).toEqual({ rank: 1, totalArtists: 5 });
    expect(computeArtistRank(25, counts)).toEqual({ rank: 2, totalArtists: 5 });
    expect(computeArtistRank(1, counts)).toEqual({ rank: 5, totalArtists: 5 });
  });

  it('encodeArtistProfileKey emits filesystem- and APFS-safe <slug>-<fnv1a-64> keys', () => {
    expect(encodeArtistProfileKey('  Cory Branan  ')).toBe('cory-branan-01af93a3bca8ea0e');

    const mixedCaseKey = encodeArtistProfileKey('Ani DiFranco');
    const lowerKey = encodeArtistProfileKey('  ani difranco  ');
    expect(mixedCaseKey).toBe(lowerKey);
    expect(mixedCaseKey).toMatch(/^ani-difranco-[0-9a-f]{16}$/);

    const slashedKey = encodeArtistProfileKey('case/ lang/ veirs');
    expect(slashedKey).toMatch(/^case-lang-veirs-[0-9a-f]{16}$/);
    expect(slashedKey).not.toContain('/');
    expect(encodeURIComponent(slashedKey)).toBe(slashedKey);

    expect(encodeArtistProfileKey('A/B')).not.toBe(encodeArtistProfileKey('A-B'));

    for (const unicodeName of ['Sigur Rós', 'Björk']) {
      const encoded = encodeArtistProfileKey(unicodeName);
      expect(encoded).toMatch(/^[a-z0-9-]+-[0-9a-f]{16}$/);
      expect(encodeURIComponent(encoded)).toBe(encoded);
    }
    expect(encodeArtistProfileKey('Sigur Rós')).not.toBe(encodeArtistProfileKey('Sigur Ros'));
  });
});

describe('buildArtistProfile', () => {
  it('handles a single airing with null avgGapDays, zero longestSilence, and single-Song Episode guard', () => {
    const profile = buildArtistProfile({
      rows: [
        makeRow({
          artist: 'Solo Artist',
          airDate: '2022-05-14',
          episodeId: 'ep-10',
          episodeNumber: null,
          position: 1,
          episodeSongCount: 1,
          songTitle: 'Lone Song',
          album: 'Solo Album',
        }),
      ],
      coOccurrences: [],
      rank: 50,
      totalArtists: 200,
      archive: makeArchive({
        totalSpins: 500,
        totalEpisodes: 50,
        dateRange: { earliest: '2021-01-01', latest: '2022-05-24' },
        years: [
          { year: 2021, spins: 200 },
          { year: 2022, spins: 300 },
        ],
      }),
    });

    expect(profile.artist).toBe('Solo Artist');
    expect(profile.rank).toBe(50);
    expect(profile.totalArtists).toBe(200);
    expect(profile.summary).toMatchObject({
      totalPlays: 1, episodeCount: 1, uniqueSongs: 1, uniqueAlbums: 1,
      firstAppearance: '2022-05-14', lastAppearance: '2022-05-14', oneSpinSongs: 1, daysSinceLast: 10,
    });
    expect(profile.summary.shareOfSpins).toBeCloseTo(0.002, 4);
    expect(profile.rotation).toEqual({
      avgGapDays: null,
      longestSilence: { days: 0, from: null, to: null },
      openers: 1, closers: 1, avgSlot: 0, doubledUp: 0,
    });
    expect(profile.airings).toEqual([{
      airDate: '2022-05-14', episodeId: 'ep-10', episodeNumber: null,
      position: 1, episodeSongCount: 1, songTitle: 'Lone Song', album: 'Solo Album',
    }]);
    expect(profile.months).toEqual([{ month: '2022-05', spins: 1 }]);
  });

  it('merges case variants, deduplicates Episode dates for gaps/silence, and computes rotation & airings', () => {
    const profile = buildArtistProfile({
      rows: [
        makeRow({ artist: '  cory branan  ', airDate: '2021-03-01', episodeId: 'ep-1', episodeNumber: 501, position: 1, episodeSongCount: 11, songTitle: 'Sour Mash', album: 'No-Hit Wonder' }),
        makeRow({ artist: 'Cory Branan', airDate: '2021-03-01', episodeId: 'ep-1', episodeNumber: 501, position: 6, episodeSongCount: 11, songTitle: 'The Corner', album: 'Mutt' }),
        makeRow({ artist: 'Cory Branan', airDate: '2021-03-11', episodeId: 'ep-2', episodeNumber: 502, position: 11, episodeSongCount: 11, songTitle: 'sour mash', album: 'No-Hit Wonder' }),
        makeRow({ artist: 'Cory Branan', airDate: '2021-06-09', episodeId: 'ep-3', episodeNumber: 515, position: 3, episodeSongCount: 5, songTitle: 'Skateland', album: 'Adios' }),
        makeRow({ artist: 'CORY BRANAN', airDate: '2021-06-29', episodeId: 'ep-4', episodeNumber: 518, position: 1, episodeSongCount: 11, songTitle: 'Prettiest Waitress', album: 'The Hell You Say' }),
        makeRow({ artist: 'Cory Branan', airDate: '2021-06-29', episodeId: 'ep-4', episodeNumber: 518, position: 11, episodeSongCount: 11, songTitle: 'Sour Mash', album: 'No-Hit Wonder' }),
      ],
      coOccurrences: [],
      rank: 40,
      totalArtists: 1917,
      archive: makeArchive(),
    });

    expect(profile.artist).toBe('Cory Branan');
    expect(profile.summary).toMatchObject({
      totalPlays: 6,
      episodeCount: 4,
      uniqueSongs: 4,
      uniqueAlbums: 4,
      firstAppearance: '2021-03-01',
      lastAppearance: '2021-06-29',
      oneSpinSongs: 3,
      daysSinceLast: 10,
    });
    expect(profile.summary.shareOfSpins).toBeCloseTo(0.005, 4);
    expect(profile.rotation.avgGapDays).toBe(40);
    expect(profile.rotation.longestSilence).toEqual({ days: 90, from: '2021-03-11', to: '2021-06-09' });
    expect(profile.rotation.openers).toBe(2);
    expect(profile.rotation.closers).toBe(2);
    expect(profile.rotation.avgSlot).toBeCloseTo(0.5, 4);
    expect(profile.rotation.doubledUp).toBe(2);

    expect(profile.months).toEqual([
      { month: '2021-03', spins: 3 },
      { month: '2021-06', spins: 3 },
    ]);
    expect(profile.airings.map((a) => `${a.airDate}#${a.position}`)).toEqual([
      '2021-06-29#1',
      '2021-06-29#11',
      '2021-06-09#3',
      '2021-03-11#11',
      '2021-03-01#1',
      '2021-03-01#6',
    ]);
  });

  it('zero-fills archive years and breaks peakYear ties deterministically to earliest year', () => {
    const profile = buildArtistProfile({
      rows: [
        makeRow({ airDate: '2019-02-01', episodeId: 'e1' }),
        makeRow({ airDate: '2019-11-01', episodeId: 'e2' }),
        makeRow({ airDate: '2020-05-01', episodeId: 'e3' }),
        makeRow({ airDate: '2022-03-01', episodeId: 'e4' }),
        makeRow({ airDate: '2022-08-01', episodeId: 'e5' }),
      ],
      coOccurrences: [],
      rank: 10,
      totalArtists: 100,
      archive: makeArchive({
        years: [
          { year: 2018, spins: 100 },
          { year: 2019, spins: 200 },
          { year: 2020, spins: 250 },
          { year: 2021, spins: 300 },
          { year: 2022, spins: 350 },
        ],
      }),
    });

    expect(profile.years).toEqual([
      { year: 2018, spins: 0, archiveSpins: 100 },
      { year: 2019, spins: 2, archiveSpins: 200 },
      { year: 2020, spins: 1, archiveSpins: 250 },
      { year: 2021, spins: 0, archiveSpins: 300 },
      { year: 2022, spins: 2, archiveSpins: 350 },
    ]);
    expect(profile.peakYear).toEqual({ year: 2019, spins: 2 });
  });

  it('truncates topSongs, topAlbums, and playedAlongside to 10 with deterministic tie-breaks and self exclusion', () => {
    const add = (rows, count, songTitle, album, startDay) => {
      for (let i = 0; i < count; i++) {
        const day = String(startDay + i).padStart(2, '0');
        rows.push(makeRow({ airDate: `2021-01-${day}`, episodeId: `ep-${songTitle}-${i}`, songTitle, album }));
      }
    };
    const rows = [];
    add(rows, 3, 'Anchor', 'Album A', 1);
    add(rows, 2, 'zeta', 'Zebra Album', 4);
    add(rows, 2, 'Alpha', 'Amber Album', 6);
    add(rows, 2, 'beta', 'Beacon Album', 8);
    for (let i = 1; i <= 8; i++) add(rows, 1, `Tune 0${i}`, `Wax 0${i}`, 10 + i);

    const coOccurrences = [
      { name: 'Cory Branan', sharedEpisodes: 99, rank: 40 },
      { name: '  cory branan  ', sharedEpisodes: 88, rank: 40 },
      { name: 'First Neighbor', sharedEpisodes: 8, rank: 5 },
      { name: 'zulu', sharedEpisodes: 5, rank: 20 },
      { name: 'Abby', sharedEpisodes: 5, rank: 12 },
      { name: 'bravo', sharedEpisodes: 5, rank: 30 },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `Peer 0${i + 1}`, sharedEpisodes: 2, rank: 50 + i })),
    ];

    const profile = buildArtistProfile({
      rows,
      coOccurrences,
      rank: 40,
      totalArtists: 500,
      archive: makeArchive(),
    });

    expect(profile.topSongs).toHaveLength(10);
    expect(profile.topSongs.slice(0, 5)).toEqual([
      { songTitle: 'Anchor', album: 'Album A', totalPlays: 3 },
      { songTitle: 'Alpha', album: 'Amber Album', totalPlays: 2 },
      { songTitle: 'beta', album: 'Beacon Album', totalPlays: 2 },
      { songTitle: 'zeta', album: 'Zebra Album', totalPlays: 2 },
      { songTitle: 'Tune 01', album: 'Wax 01', totalPlays: 1 },
    ]);

    expect(profile.topAlbums).toHaveLength(10);
    expect(profile.topAlbums.slice(0, 4)).toEqual([
      { album: 'Album A', totalPlays: 3, uniqueSongs: 1, firstAppearance: '2021-01-01' },
      { album: 'Amber Album', totalPlays: 2, uniqueSongs: 1, firstAppearance: '2021-01-06' },
      { album: 'Beacon Album', totalPlays: 2, uniqueSongs: 1, firstAppearance: '2021-01-08' },
      { album: 'Zebra Album', totalPlays: 2, uniqueSongs: 1, firstAppearance: '2021-01-04' },
    ]);

    expect(profile.playedAlongside).toHaveLength(10);
    expect(profile.playedAlongside.some((p) => normalizeArtistKey(p.name) === 'cory branan')).toBe(false);
    expect(profile.playedAlongside.slice(0, 5)).toEqual([
      { name: 'First Neighbor', sharedEpisodes: 8, rank: 5 },
      { name: 'Abby', sharedEpisodes: 5, rank: 12 },
      { name: 'bravo', sharedEpisodes: 5, rank: 30 },
      { name: 'zulu', sharedEpisodes: 5, rank: 20 },
      { name: 'Peer 01', sharedEpisodes: 2, rank: 50 },
    ]);
  });
});
