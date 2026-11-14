// Unit tests for Pass 1 archive normalization: artist credits, album sentinels, aliases, glued lines, and episode metadata.
import { describe, expect, it } from 'vitest';
import {
  extractArtistCredit,
  isEditorialLine,
  normalizeAlbum,
  normalizeEpisodeMeta,
  normalizeSpinLine,
  splitGluedRawLine,
} from '../scripts/archive-normalizer.js';
import { resolveCanonicalArtist } from '../scripts/artist-aliases.js';

describe('Pass 1 Archive Normalization (scripts/archive-normalizer.js & artist-aliases.js)', () => {
  it('extractArtistCredit splits feat./(feat.)/w//(w/)/with attributions and leaves protected artists intact', () => {
    expect(extractArtistCredit('Todd Snider feat. Jason Isbell')).toMatchObject({
      mainArtist: 'Todd Snider',
      featuredArtist: 'Jason Isbell',
    });
    expect(extractArtistCredit('Todd Snider (feat. Elizabeth Cook)')).toMatchObject({
      mainArtist: 'Todd Snider',
      featuredArtist: 'Elizabeth Cook',
    });
    expect(extractArtistCredit('John Prine w/ Iris DeMent')).toMatchObject({
      mainArtist: 'John Prine',
      featuredArtist: 'Iris DeMent',
    });
    expect(extractArtistCredit('Darrell Scott (w/ John Cowan)')).toMatchObject({
      mainArtist: 'Darrell Scott',
      featuredArtist: 'John Cowan',
    });
    expect(extractArtistCredit('Emmylou Harris with Rodney Crowell')).toMatchObject({
      mainArtist: 'Emmylou Harris',
      featuredArtist: 'Rodney Crowell',
    });

    for (const protectedArtist of [
      'Little Feat',
      "I'm With Her",
      'Songwriting With Soldiers',
      "I'm With Her & Iron & Wine",
      'Will Kimbrough & Songwriting With Soldiers',
    ]) {
      expect(extractArtistCredit(protectedArtist)).toMatchObject({
        mainArtist: protectedArtist,
        featuredArtist: null,
      });
    }

    expect(extractArtistCredit('Todd Snider feat. Jason Isbell', 'none')).toMatchObject({
      mainArtist: 'Todd Snider feat. Jason Isbell',
      featuredArtist: null,
    });
  });

  it('normalizeAlbum collapses non-album sentinels, strips suffixes, and preserves real album titles verbatim', () => {
    for (const sentinel of ['single', '[Single / Track]', '[single]', '(single)', '']) {
      expect(normalizeAlbum(sentinel, false)).toMatchObject({
        album: '',
        releaseKind: 'single',
        isSentinel: true,
      });
    }

    expect(normalizeAlbum('single', true)).toMatchObject({
      album: '',
      releaseKind: 'interlude',
      isSentinel: true,
    });
    expect(normalizeAlbum('', true)).toMatchObject({
      album: '',
      releaseKind: 'interlude',
      isSentinel: true,
    });
    expect(normalizeAlbum('Instrumental Interlude')).toMatchObject({
      album: '',
      releaseKind: 'interlude',
      isSentinel: true,
    });

    for (const unknown of ['?', 'unknown', 'n/a', 'none', 'tba', 'Unknown', 'N/A', 'TBA']) {
      expect(normalizeAlbum(unknown)).toMatchObject({
        album: '',
        releaseKind: 'unknown',
        isSentinel: true,
      });
    }

    expect(normalizeAlbum('Midnight Run (EP)')).toMatchObject({
      album: 'Midnight Run',
      releaseKind: 'ep',
      isSentinel: false,
    });
    expect(normalizeAlbum('Midnight Run [EP]')).toMatchObject({
      album: 'Midnight Run',
      releaseKind: 'ep',
      isSentinel: false,
    });
    expect(normalizeAlbum('East Nashville Skyline (new)')).toMatchObject({
      album: 'East Nashville Skyline',
      releaseKind: 'album',
      isSentinel: false,
    });
    expect(normalizeAlbum('Green Onions (Instrumental Interlude)')).toMatchObject({
      album: 'Green Onions',
      releaseKind: 'interlude',
      isSentinel: false,
    });
    expect(normalizeAlbum('Live Set (12th Annual Thanksgiving Saturday Show)')).toMatchObject({
      album: 'Live Set',
      releaseKind: 'album',
      isSentinel: false,
    });

    for (const realAlbum of [
      'Gatlinburg (single)',
      'The Essential Sun Singles',
      'Boy Crazy And Single(s)',
      'Purple Version',
      '1988',
    ]) {
      expect(normalizeAlbum(realAlbum)).toMatchObject({
        album: realAlbum,
        releaseKind: 'album',
        isSentinel: false,
      });
    }
  });

  it('resolveCanonicalArtist maps approved aliases/stylings and keeps holdout pairs distinct', () => {
    expect(resolveCanonicalArtist('cory brannan')).toBe('Cory Branan');
    expect(resolveCanonicalArtist('ani difranco')).toBe('Ani DiFranco');
    expect(resolveCanonicalArtist('jayhawks')).toBe('The Jayhawks');
    expect(resolveCanonicalArtist('case/ lang/ veirs')).toBe('case/lang/veirs');
    expect(resolveCanonicalArtist('nrbq')).toBe('NRBQ');
    expect(resolveCanonicalArtist('k.d. lang')).toBe('k.d. lang');

    const canty = resolveCanonicalArtist('Caitlin Canty');
    const cary = resolveCanonicalArtist('Caitlin Cary');
    expect(canty).toBe('Caitlin Canty');
    expect(cary).toBe('Caitlin Cary');
    expect(canty).not.toBe(cary);
  });

  it('splitGluedRawLine splits concatenated spins while preserving 3-part lines and surname prefixes', () => {
    expect(splitGluedRawLine('Todd Snider - Alright Guy - Songs for the Daily Planet')).toEqual([
      'Todd Snider - Alright Guy - Songs for the Daily Planet',
    ]);
    expect(splitGluedRawLine('Artist One - Song One - Album OneArtist Two - Song Two - Album Two')).toEqual([
      'Artist One - Song One - Album One',
      'Artist Two - Song Two - Album Two',
    ]);
    expect(splitGluedRawLine('Artist One - Song One - Live (2015)Artist Two - Song Two - Album Two')).toEqual([
      'Artist One - Song One - Live (2015)',
      'Artist Two - Song Two - Album Two',
    ]);
    expect(splitGluedRawLine('Bobby Bare - Ballad of Ira Hayes - Tribute to John MacArthur - LP')).toEqual([
      'Bobby Bare - Ballad of Ira Hayes - Tribute to John MacArthur - LP',
    ]);
  });

  it('isEditorialLine detects non-spin announcements, banners, studio headers, and band credits', () => {
    expect(isEditorialLine('Thanks to everyone who pledged today!', 'Thanks to everyone who pledged today!', '')).toBe(
      'pledge-announcement',
    );
    expect(isEditorialLine('Support WEVL at wevl.org or 901-528-1990', 'Support WEVL', '')).toBe(
      'pledge-announcement',
    );
    expect(isEditorialLine('Some Favorites 2024', 'Some Favorites 2024', '')).toBe('episode-banner');
    expect(isEditorialLine('A Tribute to John Prine', 'A Tribute to John Prine', '')).toBe('episode-banner');
    expect(isEditorialLine('#842', '#842', '')).toBe('episode-banner');
    expect(isEditorialLine('Guest - Live In The WEVL Studio', 'Guest', 'Live In The WEVL Studio')).toBe(
      'in-studio-header',
    );
    expect(isEditorialLine('- John Doe - acoustic guitar, vocals', 'John Doe', 'acoustic guitar, vocals')).toBe(
      'band-credit',
    );
    expect(isEditorialLine('Todd Snider - Play A Train Song - East Nashville Skyline', 'Todd Snider', 'Play A Train Song')).toBeNull();
  });

  it('normalizeEpisodeMeta recovers missing weekdays, expands 2-digit years, and handles year-typo/rollover dates', () => {
    const missingWeekday = normalizeEpisodeMeta({
      title: "Playlist for WEVL's Through The Cracks, 7/1/2026",
      airDate: '2026-07-01',
      dayOfWeek: null,
    });
    expect(missingWeekday).toMatchObject({
      airDate: '2026-07-01',
      dayOfWeek: 'Wednesday',
      repaired: true,
    });
    expect(missingWeekday.reasons).toContain('day-recovered');

    const twoDigitYear = normalizeEpisodeMeta({
      title: "Playlist for WEVL's Through The Cracks, Saturday 8/8/26",
      airDate: '',
      dayOfWeek: null,
    });
    expect(twoDigitYear).toMatchObject({
      airDate: '2026-08-08',
      dayOfWeek: 'Saturday',
      repaired: true,
    });
    expect(twoDigitYear.reasons).toContain('two-digit-year');

    const typoTwoDigit = normalizeEpisodeMeta({
      title: "Playlist for WEVL's Through The Cracks Saturday 10/12/12",
      airDate: '2012-10-12',
      dayOfWeek: 'Saturday',
      publishedAt: '2013-10-14T10:00:00-07:00',
    });
    expect(typoTwoDigit).toMatchObject({
      airDate: '2013-10-12',
      dayOfWeek: 'Saturday',
      repaired: true,
    });
    expect(typoTwoDigit.reasons).toEqual(expect.arrayContaining(['year-typo', 'two-digit-year']));

    const typoFourDigit = normalizeEpisodeMeta({
      title: "Playlist for WEVL's Through The Cracks, Saturday 1/3/2025",
      airDate: '2025-01-03',
      dayOfWeek: 'Saturday',
      publishedAt: '2026-01-03T18:00:00Z',
    });
    expect(typoFourDigit).toMatchObject({
      airDate: '2026-01-03',
      dayOfWeek: 'Saturday',
      airDateChanged: true,
      repaired: true,
    });
    expect(typoFourDigit.reasons).toContain('year-typo');

    const yearEndRollover = normalizeEpisodeMeta({
      title: "Playlist for WEVL's Through The Cracks, Saturday 12/31/2016",
      airDate: '2016-12-31',
      dayOfWeek: 'Saturday',
      publishedAt: '2017-01-01T10:00:00-08:00',
    });
    expect(yearEndRollover).toMatchObject({
      airDate: '2016-12-31',
      dayOfWeek: 'Saturday',
      airDateChanged: false,
      repaired: false,
    });
  });

  it('normalizeSpinLine integrates alias resolution, featured artist extraction, and album normalization', () => {
    expect(normalizeSpinLine('cory brannan feat. Jason Isbell - The Corner - Adios [EP]', 3)).toEqual({
      position: 3,
      rawLine: 'cory brannan feat. Jason Isbell - The Corner - Adios [EP]',
      artist: 'Cory Branan',
      featuredArtist: 'Jason Isbell',
      songTitle: 'The Corner',
      album: 'Adios',
      releaseKind: 'ep',
    });
    expect(normalizeSpinLine('instrumental interlude: - Buddy Emmons - Bluemoons')).toMatchObject({
      artist: 'Buddy Emmons',
      songTitle: 'Bluemoons',
      album: '',
      releaseKind: 'interlude',
    });
    expect(normalizeSpinLine('instrumental interlude: Bill Keith, Tony Trishka, Bela Fleck - Salt Creek')).toMatchObject({
      artist: 'Bill Keith, Tony Trishka & Bela Fleck',
      songTitle: 'Salt Creek',
      album: '',
      releaseKind: 'interlude',
    });
    expect(normalizeSpinLine('Thanks to everyone who pledged at wevl.org', 1)).toBeNull();
  });
});
