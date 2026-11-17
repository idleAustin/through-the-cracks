#!/usr/bin/env python3
"""Reconcile discovery checkpoints into SQLite staging database and summary JSON."""
import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from song_meta_clients import (
    CATALOG_INPUT_PATH,
    CHECKPOINT_PATH,
    SQLITE_PATH,
    SUMMARY_PATH,
    load_merged_checkpoints,
    utc_now_iso,
)
from song_meta_rules import reconcile_song

SCHEMA_DDL = """
CREATE TABLE artists_meta (
    artist_key TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    total_plays INTEGER NOT NULL,
    origin_city TEXT,
    origin_state TEXT,
    origin_country TEXT,
    start_year INTEGER,
    wiki_summary TEXT,
    wiki_url TEXT,
    mbid TEXT,
    shs_uri TEXT
);
CREATE TABLE songs_meta (
    song_key TEXT PRIMARY KEY,
    artist TEXT NOT NULL,
    artist_key TEXT NOT NULL,
    song_title TEXT NOT NULL,
    album TEXT,
    album_key TEXT,
    total_plays INTEGER NOT NULL,
    pass_tier TEXT NOT NULL,
    release_year INTEGER,
    album_year INTEGER,
    original_year INTEGER,
    is_cover INTEGER NOT NULL,
    original_artist TEXT,
    original_title TEXT,
    shs_cover_count INTEGER,
    primary_studio TEXT,
    label TEXT,
    genres_json TEXT NOT NULL,
    styles_json TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE song_writers (
    song_key TEXT NOT NULL,
    writer_name TEXT NOT NULL,
    role TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (song_key, writer_name, source)
);
CREATE TABLE song_personnel (
    song_key TEXT NOT NULL,
    person_name TEXT NOT NULL,
    role TEXT NOT NULL,
    instrument TEXT,
    source TEXT NOT NULL,
    PRIMARY KEY (song_key, person_name, role)
);
CREATE TABLE song_studios (
    song_key TEXT NOT NULL,
    studio_name TEXT NOT NULL,
    role TEXT NOT NULL,
    city TEXT,
    state TEXT,
    country TEXT,
    lat REAL,
    lon REAL,
    source TEXT NOT NULL,
    PRIMARY KEY (song_key, studio_name, role)
);
CREATE TABLE song_facts (
    song_key TEXT NOT NULL,
    fact_type TEXT NOT NULL,
    fact_text TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence TEXT NOT NULL,
    PRIMARY KEY (song_key, fact_type, fact_text)
);
CREATE TABLE reconcile_runs (
    run_at TEXT PRIMARY KEY,
    total_catalog_songs INTEGER NOT NULL,
    discovered_songs INTEGER NOT NULL,
    matched_year INTEGER NOT NULL,
    matched_writers INTEGER NOT NULL,
    matched_personnel INTEGER NOT NULL,
    matched_studios INTEGER NOT NULL,
    matched_covers INTEGER NOT NULL,
    matched_artist_bio INTEGER NOT NULL
);
CREATE INDEX idx_songs_meta_artist ON songs_meta (artist_key);
CREATE INDEX idx_songs_meta_year ON songs_meta (release_year);
CREATE INDEX idx_writers_name ON song_writers (writer_name);
CREATE INDEX idx_studios_name ON song_studios (studio_name);
"""


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Reconcile checkpoint.jsonl into SQLite staging DB.")
    parser.add_argument("--input", default=str(CATALOG_INPUT_PATH))
    parser.add_argument("--checkpoint", default=str(CHECKPOINT_PATH))
    parser.add_argument("--db", default=str(SQLITE_PATH))
    parser.add_argument("--summary", default=str(SUMMARY_PATH))
    return parser.parse_args(argv)


def _pct(count, total):
    return round((count / total) * 100.0, 1) if total else 0.0


def build_sqlite_and_summary(catalog, checkpoints, db_path, summary_path):
    now = utc_now_iso()
    db_file = Path(db_path)
    tmp_db = db_file.with_suffix(".sqlite.tmp")
    db_file.parent.mkdir(parents=True, exist_ok=True)
    if tmp_db.exists():
        tmp_db.unlink()

    conn = sqlite3.connect(str(tmp_db))
    conn.executescript(SCHEMA_DDL)

    artist_rows = {}
    metrics = {
        "discovered": 0,
        "year": 0,
        "writers": 0,
        "personnel": 0,
        "studios": 0,
        "covers": 0,
        "artist_bio": 0,
        "uncleaned_suffix": 0,
    }
    writer_counts = Counter()
    studio_counts = Counter()
    producer_counts = Counter()
    samples = []

    songs_list = catalog.get("songs") or []
    for song in songs_list:
        raw = checkpoints.get(song["song_key"])
        if not raw:
            continue
        metrics["discovered"] += 1
        rec = reconcile_song(song, raw, raw.get("artist_profile"))
        sm = rec["song_meta"]
        am = rec["artist_meta"]

        prev_am = artist_rows.get(am["artist_key"])
        if not prev_am or (am.get("wiki_summary") and not prev_am.get("wiki_summary")):
            artist_rows[am["artist_key"]] = am

        conn.execute(
            """
            INSERT OR REPLACE INTO songs_meta (
                song_key, artist, artist_key, song_title, album, album_key,
                total_plays, pass_tier, release_year, album_year, original_year,
                is_cover, original_artist, original_title, shs_cover_count,
                primary_studio, label, genres_json, styles_json, sources_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sm["song_key"], sm["artist"], sm["artist_key"], sm["song_title"], sm["album"], sm["album_key"],
                sm["total_plays"], sm["pass_tier"], sm["release_year"], sm["album_year"], sm["original_year"],
                sm["is_cover"], sm["original_artist"], sm["original_title"], sm["shs_cover_count"],
                sm["primary_studio"], sm["label"],
                json.dumps(sm["genres"]), json.dumps(sm["styles"]), json.dumps(sm["sources_used"]), now,
            ),
        )

        if sm["release_year"]:
            metrics["year"] += 1
        if rec["writers"]:
            metrics["writers"] += 1
        if rec["personnel"]:
            metrics["personnel"] += 1
        if rec["studios"]:
            metrics["studios"] += 1
        if sm["is_cover"]:
            metrics["covers"] += 1
        if am.get("wiki_summary"):
            metrics["artist_bio"] += 1

        for w in rec["writers"]:
            if re.search(r"\(\d+\)$", w["writer_name"]):
                metrics["uncleaned_suffix"] += 1
            writer_counts[w["writer_name"]] += 1
            conn.execute(
                "INSERT OR IGNORE INTO song_writers (song_key, writer_name, role, source) VALUES (?, ?, ?, ?)",
                (sm["song_key"], w["writer_name"], w["role"], w["source"]),
            )

        for p in rec["personnel"]:
            if re.search(r"\(\d+\)$", p["person_name"]):
                metrics["uncleaned_suffix"] += 1
            if p["role"] == "producer":
                producer_counts[p["person_name"]] += 1
            conn.execute(
                "INSERT OR IGNORE INTO song_personnel (song_key, person_name, role, instrument, source) VALUES (?, ?, ?, ?, ?)",
                (sm["song_key"], p["person_name"], p["role"], p["instrument"], p["source"]),
            )

        for st in rec["studios"]:
            studio_counts[st["studio_name"]] += 1
            conn.execute(
                """
                INSERT OR IGNORE INTO song_studios (
                    song_key, studio_name, role, city, state, country, lat, lon, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (sm["song_key"], st["studio_name"], st["role"], st["city"], st["state"], st["country"], st["lat"], st["lon"], st["source"]),
            )

        for fct in rec["facts"]:
            conn.execute(
                "INSERT OR IGNORE INTO song_facts (song_key, fact_type, fact_text, source, confidence) VALUES (?, ?, ?, ?, ?)",
                (sm["song_key"], fct["fact_type"], fct["fact_text"], fct["source"], fct["confidence"]),
            )

        if len(samples) < 20:
            samples.append({
                "song_key": sm["song_key"],
                "artist": sm["artist"],
                "song_title": sm["song_title"],
                "album": sm["album"],
                "totalPlays": sm["total_plays"],
                "release_year": sm["release_year"],
                "writers": [w["writer_name"] for w in rec["writers"][:4]],
                "primary_studio": sm["primary_studio"],
                "sources": sm["sources_used"],
                "facts": [f["fact_text"] for f in rec["facts"]],
            })

    for am in artist_rows.values():
        conn.execute(
            """
            INSERT OR REPLACE INTO artists_meta (
                artist_key, artist_name, total_plays, origin_city, origin_state,
                origin_country, start_year, wiki_summary, wiki_url, mbid, shs_uri
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                am["artist_key"], am["artist_name"], am["total_plays"], am["origin_city"], am["origin_state"],
                am["origin_country"], am["start_year"], am["wiki_summary"], am["wiki_url"], am["mbid"], am["shs_uri"],
            ),
        )

    disc = metrics["discovered"]
    conn.execute(
        """
        INSERT OR REPLACE INTO reconcile_runs (
            run_at, total_catalog_songs, discovered_songs, matched_year, matched_writers,
            matched_personnel, matched_studios, matched_covers, matched_artist_bio
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (now, len(songs_list), disc, metrics["year"], metrics["writers"], metrics["personnel"], metrics["studios"], metrics["covers"], metrics["artist_bio"]),
    )
    conn.commit()
    conn.close()
    os.replace(tmp_db, db_file)

    summary = {
        "generatedAt": now,
        "catalogTotalSongs": len(songs_list),
        "discoveredSongs": disc,
        "artistRows": len(artist_rows),
        "uncleanedSuffixCount": metrics["uncleaned_suffix"],
        "coverage": {
            "releaseYearCount": metrics["year"],
            "releaseYearPct": _pct(metrics["year"], disc),
            "writersCount": metrics["writers"],
            "writersPct": _pct(metrics["writers"], disc),
            "personnelCount": metrics["personnel"],
            "personnelPct": _pct(metrics["personnel"], disc),
            "studiosCount": metrics["studios"],
            "studiosPct": _pct(metrics["studios"], disc),
            "coversCount": metrics["covers"],
            "artistBioCount": metrics["artist_bio"],
            "artistBioPct": _pct(metrics["artist_bio"], disc),
        },
        "topWriters": [{"name": k, "count": v} for k, v in writer_counts.most_common(12)],
        "topStudios": [{"name": k, "count": v} for k, v in studio_counts.most_common(12)],
        "topProducers": [{"name": k, "count": v} for k, v in producer_counts.most_common(12)],
        "sampleSongs": samples,
    }
    sum_file = Path(summary_path)
    tmp_sum = sum_file.with_suffix(".json.tmp")
    tmp_sum.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp_sum, sum_file)
    return summary


def main():
    args = parse_args()
    catalog_path = Path(args.input)
    if not catalog_path.exists():
        raise SystemExit(f"Missing catalog input: {catalog_path}")
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    checkpoints = load_merged_checkpoints(args.checkpoint)
    summary = build_sqlite_and_summary(catalog, checkpoints, args.db, args.summary)
    cov = summary["coverage"]
    print(
        f"Reconciled {summary['discoveredSongs']} songs -> {args.db} | "
        f"Year {cov['releaseYearPct']}% | Writers {cov['writersPct']}% | "
        f"Personnel {cov['personnelPct']}% | Studios {cov['studiosPct']}% | "
        f"Bio {cov['artistBioPct']}% | UncleanedSuffix={summary['uncleanedSuffixCount']}"
    )


if __name__ == "__main__":
    main()
