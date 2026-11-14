// Generates .cache/d1-seed.sql from server/schema.sql and public/data/episodes.json for remote D1 seeding.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const BATCH_SIZE = 50;

function sqlLit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function appendBatchedInserts(out, table, columns, rows) {
  const header = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES\n`;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    out.push(`${header}${chunk.join(',\n')};\n`);
  }
}

function main() {
  const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8').trim();
  const episodes = JSON.parse(readFileSync(path.join(ROOT, 'public', 'data', 'episodes.json'), 'utf8'));
  const now = new Date().toISOString();

  const episodeValues = [];
  const songValues = [];

  for (const ep of episodes) {
    if (!ep || !/^\d{4}-\d{2}-\d{2}$/.test(ep.airDate || '')) continue;
    const epId = String(ep.id);
    const songs = ep.songs || [];
    episodeValues.push(
      `  (${[
        sqlLit(epId),
        sqlLit(ep.title || ''),
        sqlLit(ep.airDate),
        sqlLit(ep.dayOfWeek ?? null),
        sqlLit(ep.episodeNumber ?? null),
        sqlLit(ep.publishedAt || null),
        sqlLit(ep.url || null),
        sqlLit(songs.length),
        sqlLit(now),
      ].join(', ')})`,
    );

    for (const s of songs) {
      const pos = Number(s.position);
      songValues.push(
        `  (${[
          sqlLit(`${epId}_${pos}`),
          sqlLit(epId),
          sqlLit(ep.airDate),
          sqlLit(pos),
          sqlLit(s.artist || ''),
          sqlLit(s.featuredArtist || ''),
          sqlLit(s.songTitle || s.song || ''),
          sqlLit(s.album || ''),
          sqlLit(s.releaseKind || 'album'),
          sqlLit(s.rawLine || ''),
          sqlLit(now),
        ].join(', ')})`,
      );
    }
  }

  const lines = [
    'DROP TABLE IF EXISTS song_plays;',
    'DROP TABLE IF EXISTS episodes;',
    '',
    schemaSql,
    '',
  ];

  appendBatchedInserts(
    lines,
    'episodes',
    ['id', 'title', 'air_date', 'day_of_week', 'episode_number', 'published_at', 'url', 'song_count', 'ingested_at'],
    episodeValues,
  );
  appendBatchedInserts(
    lines,
    'song_plays',
    ['id', 'episode_id', 'air_date', 'position', 'artist', 'featured_artist', 'song_title', 'album', 'release_kind', 'raw_line', 'ingested_at'],
    songValues,
  );

  const cacheDir = path.join(ROOT, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, 'd1-seed.sql');
  writeFileSync(outPath, `${lines.join('\n')}\n`);
  console.log(`✓ Generated ${outPath} (${episodeValues.length} episodes, ${songValues.length} song_plays)`);
}

main();
