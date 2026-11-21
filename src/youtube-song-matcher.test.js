// Unit tests for YouTube snippet scoring, Topic channel stripping, ISO-8601 duration parsing, playability evaluation, and failure classification.
import { describe, expect, it } from 'vitest';
import {
  buildFallbackSearchQueries,
  classifyYouTubeFailure,
  decodeBasicHtmlEntities,
  evaluateYouTubeVideoItem,
  isTopicChannel,
  isUsPlayableRegion,
  parseIsoDuration,
  pickBestSearchCandidate,
  scoreSearchCandidate,
  stripSearchQueryNoise,
  stripTopicSuffix,
} from '../server/youtubeSongMatcher.js';

const ytSearchItem = (videoId, title, channelTitle) => ({
  id: { videoId },
  snippet: { title, channelTitle },
});

const ytVideoItem = (id, {
  privacyStatus = 'public',
  uploadStatus = 'processed',
  embeddable = true,
  duration = 'PT3M42S',
  regionRestriction = undefined,
} = {}) => ({
  id,
  status: { privacyStatus, uploadStatus, embeddable },
  contentDetails: {
    duration,
    ...(regionRestriction ? { regionRestriction } : {}),
  },
});

describe('youtubeSongMatcher', () => {
  it('strips " - Topic" channel suffixes, awards +20 official authority bonus, and sets result_type', () => {
    expect(isTopicChannel('Todd Snider - Topic')).toBe(true);
    expect(isTopicChannel('The Band - topic')).toBe(true);
    expect(isTopicChannel('Todd Snider Official')).toBe(false);
    expect(stripTopicSuffix('Todd Snider - Topic')).toBe('Todd Snider');
    expect(stripTopicSuffix('  Crosby, Stills & Nash - Topic  ')).toBe('Crosby, Stills & Nash');

    const song = { artist: 'Todd Snider', song_title: 'Alright Guy' };

    const topicCandidate = scoreSearchCandidate(
      song,
      ytSearchItem('vid-topic', 'Alright Guy', 'Todd Snider - Topic'),
    );
    expect(topicCandidate).toMatchObject({
      videoId: 'vid-topic',
      ytArtist: 'Todd Snider',
      resultType: 'song',
      isTopicChannel: true,
      authorityPts: 20,
      score: 90,
      matchTier: 'high',
      rejected: null,
    });

    const officialVideoCandidate = scoreSearchCandidate(
      song,
      ytSearchItem('vid-official', 'Todd Snider - Alright Guy', 'Todd Snider Official'),
    );
    expect(officialVideoCandidate).toMatchObject({
      videoId: 'vid-official',
      ytArtist: 'Todd Snider Official',
      resultType: 'video',
      isTopicChannel: false,
      authorityPts: 20,
      score: 90,
      matchTier: 'high',
      rejected: null,
    });

    const unofficialCandidate = scoreSearchCandidate(
      song,
      ytSearchItem('vid-fan', 'Todd Snider - Alright Guy', 'Random Americana Uploads'),
    );
    expect(unofficialCandidate).toMatchObject({
      videoId: 'vid-fan',
      resultType: 'video',
      isTopicChannel: false,
      authorityPts: 5,
      score: 70,
      matchTier: 'medium',
      rejected: null,
    });
  });

  it('picks best candidate while penalizing disqualifiers, unmatched variants, and out-of-range durations', () => {
    expect(decodeBasicHtmlEntities('Rock &amp; Roll &#39;74 &quot;Live&quot;')).toBe("Rock & Roll '74 \"Live\"");

    const song = { artist: 'Gillian Welch', song_title: 'Look at Miss Ohio' };
    const cover = ytSearchItem('vid-cover', 'Gillian Welch - Look at Miss Ohio (Cover)', 'Acoustic Covers');
    const live = ytSearchItem('vid-live', 'Gillian Welch - Look at Miss Ohio (Live)', 'Gillian Welch');
    const topic = ytSearchItem('vid-topic', 'Look at Miss Ohio', 'Gillian Welch - Topic');
    const mismatch = ytSearchItem('vid-wrong', 'Completely Different Track', 'Other Artist');

    expect(scoreSearchCandidate(song, cover).score).toBeLessThan(65);
    expect(scoreSearchCandidate(song, live).score).toBe(75);
    expect(scoreSearchCandidate(song, mismatch).rejected).toBe('title_mismatch');
    expect(scoreSearchCandidate(song, ytSearchItem('vid-bad-art', 'Look at Miss Ohio', 'Unrelated Channel')).rejected).toBe('artist_mismatch');
    expect(scoreSearchCandidate(song, { snippet: { title: 'Look at Miss Ohio' } }).rejected).toBe('missing_video_id');

    const shortDuration = scoreSearchCandidate(song, topic, { durationSeconds: 30 });
    expect(shortDuration.score).toBe(65);

    const best = pickBestSearchCandidate(song, [cover, live, mismatch, topic]);
    expect(best).toMatchObject({
      videoId: 'vid-topic',
      resultType: 'song',
      score: 90,
      matchTier: 'high',
    });

    const liveArchiveSong = { artist: 'Gillian Welch', song_title: 'Look at Miss Ohio (Live)' };
    expect(scoreSearchCandidate(liveArchiveSong, live).score).toBe(90);
  });

  it('parses ISO-8601 durations including PT3M42S, PT1H2M5S, and returns null for invalid inputs', () => {
    expect(parseIsoDuration('PT3M42S')).toBe(222);
    expect(parseIsoDuration('PT1H2M5S')).toBe(3725);
    expect(parseIsoDuration('P1DT0H0M10S')).toBe(86410);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration(' pt2m3s ')).toBe(123);

    for (const invalid of ['PT', 'P', '', 'invalid', '3:42', null, undefined, 222, {}]) {
      expect(parseIsoDuration(invalid)).toBeNull();
    }
  });

  it('evaluates US region rules and public/processed/embeddable video compatibility', () => {
    expect(isUsPlayableRegion(null)).toBe(true);
    expect(isUsPlayableRegion({})).toBe(true);
    expect(isUsPlayableRegion({ blocked: ['CA', 'GB'] })).toBe(true);
    expect(isUsPlayableRegion({ blocked: ['US', 'CA'] })).toBe(false);
    expect(isUsPlayableRegion({ allowed: ['US', 'CA'] })).toBe(true);
    expect(isUsPlayableRegion({ allowed: ['CA', 'GB'] })).toBe(false);
    expect(isUsPlayableRegion({ allowed: ['US'], blocked: ['US'] })).toBe(false);

    expect(evaluateYouTubeVideoItem(null)).toEqual({
      durationSeconds: null,
      isEmbeddable: 0,
      usPlayable: 0,
      statusReason: 'video_missing',
    });

    expect(evaluateYouTubeVideoItem(ytVideoItem('ok-1', { duration: 'PT3M42S' }))).toEqual({
      durationSeconds: 222,
      isEmbeddable: 1,
      usPlayable: 1,
      statusReason: 'ok',
    });

    expect(evaluateYouTubeVideoItem(ytVideoItem('priv-1', { privacyStatus: 'private' }))).toMatchObject({
      isEmbeddable: 0,
      usPlayable: 0,
      statusReason: 'privacy:private/upload:processed',
    });

    expect(evaluateYouTubeVideoItem(ytVideoItem('proc-1', { uploadStatus: 'uploaded' }))).toMatchObject({
      isEmbeddable: 0,
      usPlayable: 0,
      statusReason: 'privacy:public/upload:uploaded',
    });

    expect(evaluateYouTubeVideoItem(ytVideoItem('noemb-1', { embeddable: false }))).toMatchObject({
      isEmbeddable: 0,
      usPlayable: 1,
      statusReason: 'not_embeddable',
    });

    expect(evaluateYouTubeVideoItem(ytVideoItem('geo-block', { regionRestriction: { blocked: ['US'] } }))).toMatchObject({
      isEmbeddable: 1,
      usPlayable: 0,
      statusReason: 'us_blocked',
    });

    expect(evaluateYouTubeVideoItem(ytVideoItem('geo-allow', { regionRestriction: { allowed: ['CA'] } }))).toMatchObject({
      isEmbeddable: 1,
      usPlayable: 0,
      statusReason: 'us_blocked',
    });
  });

  it('classifies YouTube HTTP, quota, network, and API errors accurately', () => {
    expect(classifyYouTubeFailure(null, null, new Error('ECONNRESET'))).toBe('network_error');
    expect(classifyYouTubeFailure({ ok: false, status: 403 }, {
      error: { errors: [{ reason: 'quotaExceeded' }], message: 'Quota exceeded' },
    })).toBe('quota_exceeded');
    expect(classifyYouTubeFailure({ ok: false, status: 403 }, {
      error: { errors: [{ reason: 'forbidden' }], message: 'Forbidden' },
    })).toBe('http_403');
    expect(classifyYouTubeFailure({ ok: false, status: 429 }, {})).toBe('http_429');
    expect(classifyYouTubeFailure({ ok: false, status: 500 }, {})).toBe('http_500');
    expect(classifyYouTubeFailure({ ok: false, status: 503 }, {})).toBe('http_503');
    expect(classifyYouTubeFailure({ ok: true, status: 200 }, { error: { message: 'Bad' } })).toBe('youtube_api_error');
    expect(classifyYouTubeFailure({ ok: true, status: 200 }, { items: [] })).toBeNull();
  });

  it('builds deduplicated stripped, quoted, and split fallback search queries', () => {
    expect(stripSearchQueryNoise('Stepping Outside (w/ Tyler Childers)')).toBe('Stepping Outside');
    expect(stripSearchQueryNoise('Song Title feat. Guest Artist [Live]')).toBe('Song Title');
    expect(stripSearchQueryNoise('Rock &amp; Roll w/ Band')).toBe('Rock & Roll');

    expect(buildFallbackSearchQueries(
      { artist: 'Star & Micey', song_title: "Can't Keep Running Back (w/ Kait Lawson)" },
      { pass1Empty: false },
    )).toEqual(["Star & Micey Can't Keep Running Back", "\"Star & Micey\" Can't Keep Running Back"]);

    expect(buildFallbackSearchQueries(
      { artist: 'Artist', song_title: 'Track Name feat. Somebody' },
      { maxQueries: 1 },
    )).toEqual(['Artist Track Name']);

    expect(buildFallbackSearchQueries(
      { artist: 'Circle Birds', song_title: 'Evolution' },
      { pass1Empty: false },
    )).toEqual(['"Circle Birds" Evolution']);

    expect(buildFallbackSearchQueries(
      { artist: 'Margo Cilker', song_title: 'Mayhill Peaches, Goodnoe Pairs' },
      { pass1Empty: true },
    )).toEqual(['Margo Cilker Goodnoe Pairs', 'Margo Cilker Mayhill Peaches']);

    expect(buildFallbackSearchQueries(
      { artist: 'Todd Snider', song_title: 'One Two Three Four' },
      { pass1Empty: true },
    )).toEqual(['Todd Snider Three Four', 'Todd Snider One Two']);

    expect(buildFallbackSearchQueries({ artist: 'Circle Birds', song_title: 'Evolution' }, { pass1Empty: true })).toEqual([]);
    expect(buildFallbackSearchQueries({ artist: '', song_title: 'Evolution' })).toEqual([]);
  });
});
