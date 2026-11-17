#!/usr/bin/env python3
"""Album-first multi-source metadata discovery runner writing incremental checkpoints."""
import argparse
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.dont_write_bytecode = True

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from song_meta_clients import (
    CATALOG_INPUT_PATH,
    CHECKPOINT_PATH,
    LOG_PATH,
    MetadataStatusWriter,
    SqliteHttpCache,
    build_clients,
    load_merged_checkpoints,
    utc_now_iso,
)
from song_meta_discogs import (
    extract_dc_song_from_album,
    fetch_dc_album_bundle,
    fetch_dc_track_fallback,
)
from song_meta_mb import (
    extract_mb_song_from_album,
    fetch_mb_album_bundle,
    fetch_mb_track_fallback,
)
from song_meta_shs import fetch_shs_artist_bundle, fetch_shs_song
from song_meta_wiki import fetch_artist_profile


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Discover TTC song metadata locally.")
    parser.add_argument("--pass", dest="pass_mode", choices=["all", "multi", "single"], default="all")
    parser.add_argument("--sources", default="mb,discogs,wiki", help="Comma list: mb,discogs,wiki,shs")
    parser.add_argument("--limit-albums", type=int, default=0, help="Max Album bundles to process (0 = all)")
    parser.add_argument("--limit-songs", type=int, default=0, help="Max Songs to checkpoint (0 = all)")
    parser.add_argument("--workers", type=int, default=2, help="Concurrent workers (1-4)")
    parser.add_argument("--input", default=str(CATALOG_INPUT_PATH))
    parser.add_argument("--checkpoint", default=str(CHECKPOINT_PATH))
    parser.add_argument("--force", action="store_true", help="Re-query already-checkpointed sources")
    return parser.parse_args(argv)


class DiscoveryRunner:
    """Thread-safe coordinator executing Album-first lookups and single fallbacks."""

    def __init__(self, args, catalog, existing_records, clients, auth_modes):
        self.args = args
        self.sources = {s.strip().lower() for s in args.sources.split(",") if s.strip()}
        self.catalog = catalog
        self.existing = existing_records
        self.clients = clients
        self.auth_modes = auth_modes
        self.checkpoint_path = Path(args.checkpoint)
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path = LOG_PATH
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

        self._write_lock = threading.Lock()
        self._artist_lock = threading.Lock()
        self._artist_profiles = {}
        self._shs_artists = {}
        self._counters = {
            "albumsProcessed": 0,
            "songsWritten": 0,
            "mbHits": 0,
            "discogsHits": 0,
            "wikiHits": 0,
            "shsHits": 0,
            "errorCount": 0,
            "currentItem": "",
        }
        self.status_writer = MetadataStatusWriter()

    def log(self, message):
        line = f"[{utc_now_iso()}] {message}\n"
        with self._write_lock:
            with self.log_path.open("a", encoding="utf-8") as fh:
                fh.write(line)

    def _get_artist_profile(self, artist):
        if "wiki" not in self.sources:
            return None
        with self._artist_lock:
            if artist in self._artist_profiles:
                return self._artist_profiles[artist]
        prof = fetch_artist_profile(self.clients["mb"], self.clients["wiki"], artist)
        with self._artist_lock:
            self._artist_profiles[artist] = prof
        return prof

    def _get_shs_artist(self, artist):
        if "shs" not in self.sources:
            return None
        with self._artist_lock:
            if artist in self._shs_artists:
                return self._shs_artists[artist]
        bundle = fetch_shs_artist_bundle(self.clients["shs"], artist)
        with self._artist_lock:
            self._shs_artists[artist] = bundle
        return bundle

    def _append_checkpoint(self, record):
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            with self.checkpoint_path.open("a", encoding="utf-8") as fh:
                fh.write(encoded + "\n")
                fh.flush()
            self._counters["songsWritten"] += 1
            if (record.get("mb") or {}).get("found"):
                self._counters["mbHits"] += 1
            if (record.get("discogs") or {}).get("found"):
                self._counters["discogsHits"] += 1
            if (record.get("artist_profile") or {}).get("wiki_summary"):
                self._counters["wikiHits"] += 1
            if (record.get("shs") or {}).get("found"):
                self._counters["shsHits"] += 1

    def _emit_status(self, phase, total_albums, total_songs):
        rate_stats = {name: dict(client.stats) for name, client in self.clients.items()}
        error_sum = sum(v.get("errors", 0) for v in rate_stats.values())
        with self._write_lock:
            payload = {
                "phase": phase,
                "passFilter": self.args.pass_mode,
                "sources": sorted(self.sources),
                "authModes": self.auth_modes,
                "totalAlbumsTarget": total_albums,
                "totalSongsTarget": total_songs,
                "albumsProcessed": self._counters["albumsProcessed"],
                "songsWritten": self._counters["songsWritten"],
                "mbHits": self._counters["mbHits"],
                "discogsHits": self._counters["discogsHits"],
                "wikiHits": self._counters["wikiHits"],
                "shsHits": self._counters["shsHits"],
                "errorCount": error_sum,
                "currentItem": self._counters["currentItem"],
                "rateStats": rate_stats,
            }
        self.status_writer.write(payload)

    def _process_album_group(self, album_obj, pending_songs):
        artist = album_obj["artist"]
        album = album_obj["album"]
        with self._write_lock:
            self._counters["currentItem"] = f"{artist} — {album} ({len(pending_songs)} songs)"

        need_mb = "mb" in self.sources and any(
            self.args.force or "mb" not in (self.existing.get(s["song_key"], {}).get("sources_checked") or [])
            for s in pending_songs
        )
        need_dc = "discogs" in self.sources and any(
            self.args.force or "discogs" not in (self.existing.get(s["song_key"], {}).get("sources_checked") or [])
            for s in pending_songs
        )

        mb_bundle = fetch_mb_album_bundle(self.clients["mb"], artist, album) if need_mb else None
        dc_bundle = fetch_dc_album_bundle(self.clients["discogs"], artist, album) if need_dc else None
        artist_prof = self._get_artist_profile(artist)
        shs_bundle = self._get_shs_artist(artist)

        for song in pending_songs:
            prev = self.existing.get(song["song_key"]) or {}
            prev_srcs = set(prev.get("sources_checked") or [])
            rec = {
                "song_key": song["song_key"],
                "artist": song["artist"],
                "song_title": song["song_title"],
                "album": song.get("album") or "",
                "album_key": song.get("album_key"),
                "checked_at": utc_now_iso(),
                "sources_checked": sorted(prev_srcs | self.sources),
            }
            if "mb" in self.sources and (self.args.force or "mb" not in prev_srcs):
                mb_song = extract_mb_song_from_album(self.clients["mb"], mb_bundle, song["song_title"])
                if not mb_song and int(song.get("totalPlays") or 0) >= 2:
                    mb_song = fetch_mb_track_fallback(self.clients["mb"], artist, song["song_title"])
                rec["mb"] = mb_song or {"found": False}
            elif prev.get("mb"):
                rec["mb"] = prev["mb"]

            if "discogs" in self.sources and (self.args.force or "discogs" not in prev_srcs):
                dc_song = extract_dc_song_from_album(dc_bundle, song["song_title"])
                if not dc_song and int(song.get("totalPlays") or 0) >= 2:
                    dc_song = fetch_dc_track_fallback(self.clients["discogs"], artist, song["song_title"])
                rec["discogs"] = dc_song or {"found": False}
            elif prev.get("discogs"):
                rec["discogs"] = prev["discogs"]

            if artist_prof:
                rec["artist_profile"] = artist_prof
            elif prev.get("artist_profile"):
                rec["artist_profile"] = prev["artist_profile"]

            if "shs" in self.sources and (self.args.force or "shs" not in prev_srcs):
                shs_song = fetch_shs_song(self.clients["shs"], artist, song["song_title"], artist_bundle=shs_bundle)
                rec["shs"] = shs_song or {"found": False}
                if shs_bundle:
                    rec["shs_artist_uri"] = shs_bundle.get("shs_artist_uri")
            elif prev.get("shs"):
                rec["shs"] = prev["shs"]

            self._append_checkpoint(rec)

        with self._write_lock:
            self._counters["albumsProcessed"] += 1

    def _process_single_song(self, song):
        artist = song["artist"]
        with self._write_lock:
            self._counters["currentItem"] = f"{artist} — {song['song_title']} (single)"
        prev = self.existing.get(song["song_key"]) or {}
        prev_srcs = set(prev.get("sources_checked") or [])
        rec = {
            "song_key": song["song_key"],
            "artist": song["artist"],
            "song_title": song["song_title"],
            "album": song.get("album") or "",
            "album_key": None,
            "checked_at": utc_now_iso(),
            "sources_checked": sorted(prev_srcs | self.sources),
        }
        if "mb" in self.sources and (self.args.force or "mb" not in prev_srcs):
            rec["mb"] = fetch_mb_track_fallback(self.clients["mb"], artist, song["song_title"]) or {"found": False}
        elif prev.get("mb"):
            rec["mb"] = prev["mb"]
        if "discogs" in self.sources and (self.args.force or "discogs" not in prev_srcs):
            rec["discogs"] = fetch_dc_track_fallback(self.clients["discogs"], artist, song["song_title"]) or {"found": False}
        elif prev.get("discogs"):
            rec["discogs"] = prev["discogs"]
        artist_prof = self._get_artist_profile(artist)
        if artist_prof:
            rec["artist_profile"] = artist_prof
        if "shs" in self.sources and (self.args.force or "shs" not in prev_srcs):
            shs_bundle = self._get_shs_artist(artist)
            rec["shs"] = fetch_shs_song(self.clients["shs"], artist, song["song_title"], artist_bundle=shs_bundle) or {"found": False}
        self._append_checkpoint(rec)

    def run(self):
        songs_by_key = {s["song_key"]: s for s in self.catalog.get("songs") or []}

        def needs_work(song):
            if self.args.pass_mode == "multi" and song.get("pass_tier") != "multi":
                return False
            if self.args.pass_mode == "single" and song.get("pass_tier") != "single":
                return False
            if self.args.force:
                return True
            done_srcs = set((self.existing.get(song["song_key"]) or {}).get("sources_checked") or [])
            return not self.sources.issubset(done_srcs)

        album_batches = []
        album_song_count = 0
        for alb in self.catalog.get("albums") or []:
            pending = [songs_by_key[k] for k in alb.get("songKeys") or [] if k in songs_by_key and needs_work(songs_by_key[k])]
            if not pending:
                continue
            if self.args.limit_songs and album_song_count + len(pending) > self.args.limit_songs:
                remaining = self.args.limit_songs - album_song_count
                if remaining <= 0:
                    break
                pending = pending[:remaining]
            album_batches.append((alb, pending))
            album_song_count += len(pending)
            if self.args.limit_albums and len(album_batches) >= self.args.limit_albums:
                break

        single_pending = []
        if not self.args.limit_albums:
            for song in self.catalog.get("songs") or []:
                if not song.get("is_single") or not needs_work(song):
                    continue
                if self.args.limit_songs and album_song_count + len(single_pending) >= self.args.limit_songs:
                    break
                single_pending.append(song)

        total_albums = len(album_batches)
        total_songs = album_song_count + len(single_pending)
        self.log(f"Starting discovery pass={self.args.pass_mode} sources={','.join(sorted(self.sources))} albums={total_albums} songs={total_songs}")
        self._emit_status("running", total_albums, total_songs)

        workers = max(1, min(4, self.args.workers))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(self._process_album_group, alb, pending) for alb, pending in album_batches]
            for fut in as_completed(futures):
                fut.result()
                self._emit_status("running", total_albums, total_songs)

            single_futs = [pool.submit(self._process_single_song, s) for s in single_pending]
            for fut in as_completed(single_futs):
                fut.result()
                self._emit_status("running", total_albums, total_songs)

        self._emit_status("completed", total_albums, total_songs)
        self.log(f"Completed discovery: {self._counters['songsWritten']} songs written across {self._counters['albumsProcessed']} albums")


def main():
    args = parse_args()
    catalog_path = Path(args.input)
    if not catalog_path.exists():
        raise SystemExit(f"Missing catalog input: {catalog_path} (run npm run song-metadata:prepare first)")
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    existing = load_merged_checkpoints(args.checkpoint)
    cache = SqliteHttpCache()
    try:
        runner_ref = []

        def _log(msg):
            if runner_ref:
                runner_ref[0].log(msg)

        clients, auth_modes = build_clients(cache, logger=_log)
        runner = DiscoveryRunner(args, catalog, existing, clients, auth_modes)
        runner_ref.append(runner)
        try:
            runner.run()
        except KeyboardInterrupt:
            runner._emit_status("stopped", 0, 0)
            raise SystemExit(130)
    finally:
        cache.close()


if __name__ == "__main__":
    main()
