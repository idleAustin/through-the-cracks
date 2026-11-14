// Generates .cache/d1-seed.sql from server/schema.sql and public/data/episodes.json for remote D1 seeding.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLLUP_REBUILD_SQL } from '../server/d1Rollups.js';
import { ensureD1Schema, upsertEpisodesIntoD1 } from '../server/d1Schema.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const BATCH_SIZE = 50;

// General archive reseeds MUST NEVER drop song_links (preserves backfill links and manual overrides).
export const ARCHIVE_DROP_TABLES = Object.freeze([
  'cache_blobs',
  'album_rollups',
  'song_rollups',
  'artist_rollups',
  'song_plays',
  'episodes',
]);

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

export async function buildArchiveSeedSql({ schemaSql, episodes, now = new Date().toISOString() }) {
  if (ARCHIVE_DROP_TABLES.includes('song_links')) {
    throw new Error('ARCHIVE_DROP_TABLES must never include song_links');
  }

  const episodeValues = [];
  const songValues = [];

  for (const ep of episodes || []) {
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

  const blobValues = await buildCacheBlobRows(episodes || [], now);
  const dropLines = ARCHIVE_DROP_TABLES.map((tbl) => `DROP TABLE IF EXISTS ${tbl};`);
  if (dropLines.some((line) => /\bsong_links\b/i.test(line))) {
    throw new Error('Archive seed SQL must never emit DROP TABLE IF EXISTS song_links');
  }

  const lines = [
    ...dropLines,
    '',
    String(schemaSql || '').trim(),
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

  return {
    sql: `${lines.join('\n')}\n`,
    counts: { episodes: episodeValues.length, songPlays: songValues.length, cacheBlobs: blobValues.length },
  };
}

async function main() {
  const schemaSql = readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8').trim();
  const episodes = JSON.parse(readFileSync(path.join(ROOT, 'public', 'data', 'episodes.json'), 'utf8'));
  const { sql, counts } = await buildArchiveSeedSql({ schemaSql, episodes });

  const cacheDir = path.join(ROOT, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, 'd1-seed.sql');
  writeFileSync(outPath, sql);
  console.log(`✓ Generated ${outPath} (${counts.episodes} episodes, ${counts.songPlays} song_plays, ${counts.cacheBlobs} cache_blobs)`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('❌ Failed to generate D1 seed SQL:', err);
    process.exit(1);
  });
}
