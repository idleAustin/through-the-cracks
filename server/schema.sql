-- Cloudflare D1 (SQLite) schema for Through the Cracks episodes and song plays.

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  air_date TEXT NOT NULL,
  day_of_week TEXT,
  episode_number INTEGER,
  published_at TEXT,
  url TEXT,
  song_count INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS song_plays (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  air_date TEXT NOT NULL,
  position INTEGER NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  song_title TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  raw_line TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_air_date ON episodes(air_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_song_plays_episode_pos ON song_plays(episode_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_song_plays_air_date ON song_plays(air_date);
CREATE INDEX IF NOT EXISTS idx_song_plays_artist ON song_plays(artist);
CREATE INDEX IF NOT EXISTS idx_song_plays_artist_lower ON song_plays(LOWER(TRIM(artist)));
CREATE INDEX IF NOT EXISTS idx_song_plays_song_lower ON song_plays(LOWER(TRIM(song_title)));
CREATE INDEX IF NOT EXISTS idx_song_plays_album_lower ON song_plays(LOWER(TRIM(album)));
