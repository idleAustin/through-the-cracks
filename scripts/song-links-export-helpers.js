// Pure helpers for Stage 3 YouTube compatibility gating and Stage 4 D1 SQL + snapshot export.
import { buildSongKey } from '../server/playlistBuilder.js';

export const DEFAULT_CHUNK_SIZE = 500;
export const MAX_CHUNK_SIZE = 1000;

const ISO_DURATION_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

export function parseIsoDuration(iso) {
  if (typeof iso !== 'string') return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const match = trimmed.match(ISO_DURATION_RE);
  if (!match) return null;
  const [, d, h, m, s] = match;
  if (d === undefined && h === undefined && m === undefined && s === undefined) return null;
  const total =
    Number(d || 0) * 86_400 +
    Number(h || 0) * 3_600 +
    Number(m || 0) * 60 +
    Number(s || 0);
  return Number.isFinite(total) ? Math.trunc(total) : null;
}

export function isUsPlayableRegion(regionRestriction) {
  if (!regionRestriction || typeof regionRestriction !== 'object') return true;
  const { allowed, blocked } = regionRestriction;
  if (Array.isArray(blocked) && blocked.includes('US')) return false;
  if (Array.isArray(allowed) && !allowed.includes('US')) return false;
  return true;
}

function toNullableInt(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function normalizeYtArtist(record) {
  if (record.yt_artist !== undefined && record.yt_artist !== null) return String(record.yt_artist);
  if (record.ytArtist !== undefined && record.ytArtist !== null) return String(record.ytArtist);
  if (Array.isArray(record.yt_artists)) return record.yt_artists.join(', ');
  if (Array.isArray(record.ytArtists)) return record.ytArtists.join(', ');
  return null;
}

export function evaluateVideoCompatibility(record, videoItem, { now = new Date().toISOString() } = {}) {
  const artist = String(record?.artist ?? '').trim();
  const songTitle = String(record?.song_title ?? record?.songTitle ?? '').trim();
  const rawKey = String(record?.song_key ?? record?.songKey ?? '').trim();
  const songKey = rawKey || buildSongKey(artist, songTitle);
  const videoId = String(record?.video_id ?? record?.videoId ?? '').trim() || null;
  const checkedAt = String(record?.checked_at ?? record?.checkedAt ?? now);
  const baseDuration = toNullableInt(record?.duration_seconds ?? record?.durationSeconds);
  const rawScore = Number(record?.confidence_score ?? record?.confidenceScore ?? 0);
  const confidenceScore = Number.isFinite(rawScore) ? Math.trunc(rawScore) : 0;
  const matchTier = String(record?.match_tier ?? record?.matchTier ?? (videoId ? 'low' : 'unmatched'));

  const base = {
    song_key: songKey,
    artist,
    song_title: songTitle,
    album: String(record?.album ?? ''),
    totalPlays: toNullableInt(record?.totalPlays ?? record?.total_plays) ?? 0,
    video_id: videoId,
    yt_title: videoId ? (record?.yt_title ?? record?.ytTitle ?? null) : null,
    yt_artist: videoId ? normalizeYtArtist(record) : null,
    yt_album: videoId ? (record?.yt_album ?? record?.ytAlbum ?? null) : null,
    result_type: videoId ? (record?.result_type ?? record?.resultType ?? null) : null,
    duration_seconds: videoId ? baseDuration : null,
    confidence_score: videoId ? confidenceScore : 0,
    match_tier: videoId ? matchTier : 'unmatched',
    checked_at: checkedAt,
    updated_at: now,
  };

  if (!videoId) {
    return { ...base, is_embeddable: 0, us_playable: 0, status_reason: 'unmatched' };
  }
  if (!videoItem) {
    return { ...base, is_embeddable: 0, us_playable: 0, status_reason: 'missing_or_deleted' };
  }

  const status = videoItem.status || {};
  const contentDetails = videoItem.contentDetails || {};
  const privacyStatus = status.privacyStatus;
  const uploadStatus = status.uploadStatus;
  const isPublicAndProcessed = privacyStatus === 'public' && uploadStatus === 'processed';
  const embeddable = status.embeddable === true;
  const usAllowed = isUsPlayableRegion(contentDetails.regionRestriction);
  const parsedDuration = parseIsoDuration(contentDetails.duration);

  const isEmbeddable = isPublicAndProcessed && embeddable ? 1 : 0;
  const usPlayable = isPublicAndProcessed && usAllowed ? 1 : 0;

  let statusReason = 'ok';
  if (!isPublicAndProcessed) {
    statusReason = `privacy:${privacyStatus || 'unknown'}/upload:${uploadStatus || 'unknown'}`;
  } else if (!embeddable) {
    statusReason = 'not_embeddable';
  } else if (!usAllowed) {
    statusReason = 'us_blocked';
  }

  return {
    ...base,
    duration_seconds: parsedDuration ?? baseDuration,
    is_embeddable: isEmbeddable,
    us_playable: usPlayable,
    status_reason: statusReason,
  };
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : 'NULL';
  return `'${String(value).replace(/\0/g, '').replace(/'/g, "''")}'`;
}

export function formatUpsertSongLinkStatement(row) {
  const vals = [
    sqlLiteral(row.song_key),
    sqlLiteral(row.artist || ''),
    sqlLiteral(row.song_title || ''),
    sqlLiteral(row.video_id ?? null),
    sqlLiteral(row.yt_title ?? null),
    sqlLiteral(row.yt_artist ?? null),
    sqlLiteral(row.yt_album ?? null),
    sqlLiteral(row.result_type ?? null),
    sqlLiteral(toNullableInt(row.duration_seconds)),
    sqlLiteral(toNullableInt(row.confidence_score) ?? 0),
    sqlLiteral(row.match_tier || 'unmatched'),
    sqlLiteral(row.is_embeddable === 1 ? 1 : 0),
    sqlLiteral(row.us_playable === 1 ? 1 : 0),
    sqlLiteral(row.status_reason || 'unchecked'),
    sqlLiteral(row.checked_at),
    sqlLiteral(row.updated_at),
  ];

  return `INSERT INTO song_links (
  song_key, artist, song_title, video_id, yt_title, yt_artist, yt_album,
  result_type, duration_seconds, confidence_score, match_tier,
  is_embeddable, us_playable, status_reason, checked_at, updated_at
) VALUES (${vals.join(', ')})
ON CONFLICT(song_key) DO UPDATE SET
  artist = excluded.artist,
  song_title = excluded.song_title,
  video_id = excluded.video_id,
  yt_title = excluded.yt_title,
  yt_artist = excluded.yt_artist,
  yt_album = excluded.yt_album,
  result_type = excluded.result_type,
  duration_seconds = excluded.duration_seconds,
  confidence_score = excluded.confidence_score,
  match_tier = excluded.match_tier,
  is_embeddable = excluded.is_embeddable,
  us_playable = excluded.us_playable,
  status_reason = excluded.status_reason,
  checked_at = excluded.checked_at,
  updated_at = excluded.updated_at
WHERE song_links.match_tier != 'manual'
  AND (
    song_links.artist IS NOT excluded.artist
    OR song_links.song_title IS NOT excluded.song_title
    OR song_links.video_id IS NOT excluded.video_id
    OR song_links.yt_title IS NOT excluded.yt_title
    OR song_links.yt_artist IS NOT excluded.yt_artist
    OR song_links.yt_album IS NOT excluded.yt_album
    OR song_links.result_type IS NOT excluded.result_type
    OR song_links.duration_seconds IS NOT excluded.duration_seconds
    OR song_links.confidence_score IS NOT excluded.confidence_score
    OR song_links.match_tier IS NOT excluded.match_tier
    OR song_links.is_embeddable IS NOT excluded.is_embeddable
    OR song_links.us_playable IS NOT excluded.us_playable
    OR song_links.status_reason IS NOT excluded.status_reason
  );`;
}

export function buildUpsertSqlChunks(rows, chunkSize = DEFAULT_CHUNK_SIZE) {
  const safeSize = Math.min(MAX_CHUNK_SIZE, Math.max(1, Math.trunc(Number(chunkSize) || DEFAULT_CHUNK_SIZE)));
  const statements = (rows || []).map(formatUpsertSongLinkStatement);
  const chunks = [];
  for (let i = 0; i < statements.length; i += safeSize) {
    const slice = statements.slice(i, i + safeSize);
    const chunkIndex = chunks.length + 1;
    const fileName = `chunk-${String(chunkIndex).padStart(3, '0')}.sql`;
    chunks.push({ fileName, count: slice.length, sql: `${slice.join('\n\n')}\n` });
  }
  return chunks;
}

export function buildStaticSongLinksSnapshot(verifiedRows, catalogSongs = []) {
  const catalogByKey = new Map();
  for (const song of catalogSongs || []) {
    if (!song) continue;
    const key = String(song.song_key ?? song.songKey ?? '').trim() ||
      buildSongKey(song.artist || '', song.songTitle ?? song.song_title ?? '');
    if (!catalogByKey.has(key)) {
      catalogByKey.set(key, {
        album: String(song.album ?? ''),
        totalPlays: toNullableInt(song.totalPlays ?? song.total_plays) ?? 0,
      });
    }
  }

  const byKey = new Map();
  for (const row of verifiedRows || []) {
    if (!row || Number(row.is_embeddable) !== 1 || Number(row.us_playable) !== 1) continue;
    const videoId = String(row.video_id ?? row.videoId ?? '').trim();
    if (!videoId) continue;

    const artist = String(row.artist ?? '').trim();
    const songTitle = String(row.song_title ?? row.songTitle ?? '').trim();
    const songKey = String(row.song_key ?? row.songKey ?? '').trim() || buildSongKey(artist, songTitle);
    const meta = catalogByKey.get(songKey);

    byKey.set(songKey, {
      songKey,
      artist,
      songTitle,
      album: String(meta?.album ?? row.album ?? ''),
      totalPlays: meta?.totalPlays ?? toNullableInt(row.totalPlays ?? row.total_plays) ?? 0,
      videoId,
      ytTitle: String(row.yt_title ?? row.ytTitle ?? ''),
      ytArtist: String(row.yt_artist ?? row.ytArtist ?? ''),
      durationSeconds: toNullableInt(row.duration_seconds ?? row.durationSeconds),
      confidenceScore: toNullableInt(row.confidence_score ?? row.confidenceScore) ?? 0,
      matchTier: String(row.match_tier ?? row.matchTier ?? 'low'),
    });
  }

  const items = Array.from(byKey.values());
  items.sort(
    (a, b) =>
      b.totalPlays - a.totalPlays ||
      (a.songKey < b.songKey ? -1 : a.songKey > b.songKey ? 1 : 0),
  );
  return items;
}
