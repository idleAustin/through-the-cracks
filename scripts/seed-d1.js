// Generates .cache/d1-seed.sql from server/schema.sql and public/data/episodes.json for remote D1 seeding.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLLUP_REBUILD_SQL } from '../server/d1Rollups.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const BATCH_SIZE = 50;

function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const wrap = (sql, bound = []) => ({
    _sql: sql,
    bind(...args) {
      return wrap(sql, args);
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...bound) };
    },
    async first() {
      return sqlite.prepare(sql).get(...bound) ?? null;
    },
    async run() {
      sqlite.prepare(sql).run(...bound);
      return { success: true };
    },
  });

  return {
    sqlite,
    prepare(sql) {
      return wrap(sql);
    },
    async batch(stmts) {
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) {
          results.push(/^\s*SELECT\b/i.test(s._sql) ? await s.all() : await s.run());
        }
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
      return results;
    },
  };
}

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

async function buildCacheBlobRows(episodes, now) {
  const db = createSqliteD1();
  try {
    await ensureD1Schema(db);
    await upsertEpisodesIntoD1(db, episodes, { now, batchSize: 400 });
    const { results } = await db
      .prepare('SELECT blob_key, chunk_index, payload, updated_at FROM cache_blobs ORDER BY blob_key ASC, chunk_index ASC')
      .all();
    return (results || []).map(
      (r) => `  (${[sqlLit(r.blob_key), sqlLit(Number(r.chunk_index)), sqlLit(r.payload), sqlLit(r.updated_at)].join(', ')})`,
    );
  } finally {
    db.sqlite.close();
  }
}

async function main() {
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

  const blobValues = await buildCacheBlobRows(episodes, now);

  const lines = [
    'DROP TABLE IF EXISTS cache_blobs;',
    'DROP TABLE IF EXISTS album_rollups;',
    'DROP TABLE IF EXISTS song_rollups;',
    'DROP TABLE IF EXISTS artist_rollups;',
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

  for (const sql of ROLLUP_REBUILD_SQL) {
    lines.push(`${sql.trim().replace(/;+$/, '')};`);
  }
  lines.push('');

  appendBatchedInserts(
    lines,
    'cache_blobs',
    ['blob_key', 'chunk_index', 'payload', 'updated_at'],
    blobValues,
  );

  const cacheDir = path.join(ROOT, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, 'd1-seed.sql');
  writeFileSync(outPath, `${lines.join('\n')}\n`);
  console.log(`✓ Generated ${outPath} (${episodeValues.length} episodes, ${songValues.length} song_plays, ${blobValues.length} cache_blobs)`);
}

main().catch((err) => {
  console.error('❌ Failed to generate D1 seed SQL:', err);
  process.exit(1);
});
