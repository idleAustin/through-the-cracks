-- Cloudflare D1 (SQLite) schema for Through the Cracks episodes, song plays, rollups, and cache blobs.

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
  featured_artist TEXT NOT NULL DEFAULT '',
  song_title TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  release_kind TEXT NOT NULL DEFAULT 'album',
  raw_line TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_blobs (
  blob_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (blob_key, chunk_index)
);

CREATE TABLE IF NOT EXISTS artist_rollups (
  artist_key TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  profile_name TEXT NOT NULL DEFAULT '',
  total_plays INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 1,
  unique_songs INTEGER NOT NULL DEFAULT 0,
  unique_albums INTEGER NOT NULL DEFAULT 0,
  first_appearance TEXT NOT NULL DEFAULT '',
  last_appearance TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS song_rollups (
  artist_key TEXT NOT NULL,
  song_key TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  song_title TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  total_plays INTEGER NOT NULL DEFAULT 0,
  first_played TEXT NOT NULL DEFAULT '',
  last_played TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  song_search_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (artist_key, song_key)
);

CREATE TABLE IF NOT EXISTS album_rollups (
  artist_key TEXT NOT NULL,
  album_key TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  total_plays INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artist_key, album_key)
);

CREATE TABLE IF NOT EXISTS song_links (
  song_key TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  song_title TEXT NOT NULL,
  video_id TEXT,
  yt_title TEXT,
  yt_artist TEXT,
  yt_album TEXT,
  result_type TEXT,
  duration_seconds INTEGER,
  confidence_score INTEGER NOT NULL DEFAULT 0,
  match_tier TEXT NOT NULL DEFAULT 'unmatched',
  is_embeddable INTEGER NOT NULL DEFAULT 0,
  us_playable INTEGER NOT NULL DEFAULT 0,
  status_reason TEXT NOT NULL DEFAULT 'unchecked',
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_air_date ON episodes(air_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_song_plays_episode_pos ON song_plays(episode_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_song_plays_air_date ON song_plays(air_date);
CREATE INDEX IF NOT EXISTS idx_song_plays_artist ON song_plays(artist);
CREATE INDEX IF NOT EXISTS idx_song_plays_artist_lower ON song_plays(LOWER(TRIM(artist)));
CREATE INDEX IF NOT EXISTS idx_song_plays_featured_lower ON song_plays(LOWER(featured_artist));
CREATE INDEX IF NOT EXISTS idx_song_plays_song_lower ON song_plays(LOWER(TRIM(song_title)));
CREATE INDEX IF NOT EXISTS idx_song_plays_album_lower ON song_plays(LOWER(TRIM(album)));
CREATE INDEX IF NOT EXISTS idx_artist_rollups_top ON artist_rollups(total_plays DESC, LOWER(name) ASC);
CREATE INDEX IF NOT EXISTS idx_artist_rollups_obscure ON artist_rollups(total_plays ASC, first_appearance ASC, LOWER(name) ASC);
CREATE INDEX IF NOT EXISTS idx_song_rollups_top ON song_rollups(total_plays DESC, LOWER(song_title) ASC, LOWER(artist) ASC);
CREATE INDEX IF NOT EXISTS idx_song_rollups_obscure ON song_rollups(total_plays ASC, first_played ASC, LOWER(song_title) ASC, LOWER(artist) ASC);
CREATE INDEX IF NOT EXISTS idx_album_rollups_plays ON album_rollups(total_plays DESC, LOWER(artist) ASC, LOWER(album) ASC);
CREATE INDEX IF NOT EXISTS idx_song_links_random_pool ON song_links(is_embeddable, us_playable, confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_song_links_tier ON song_links(match_tier);
