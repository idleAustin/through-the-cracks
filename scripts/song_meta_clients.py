#!/usr/bin/env python3
"""Rate-limited HTTP clients, SQLite response cache, and live status writer."""
import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CACHE_DIR = REPO_ROOT / ".cache" / "song-metadata"
HTTP_CACHE_DB = CACHE_DIR / "http-cache.sqlite"
CATALOG_INPUT_PATH = CACHE_DIR / "catalog-input.json"
CHECKPOINT_PATH = CACHE_DIR / "checkpoint.jsonl"
STATUS_PATH = CACHE_DIR / "discovery-status.json"
LOG_PATH = CACHE_DIR / "discovery.log"
SUMMARY_PATH = CACHE_DIR / "summary.json"
SQLITE_PATH = CACHE_DIR / "song-metadata.sqlite"

RETRYABLE_CODES = {403, 420, 429, 500, 502, 503, 504}


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_merged_checkpoints(path):
    """Load checkpoint.jsonl and fold sequential patches per song_key into unified records."""
    records = {}
    p = Path(path)
    if not p.exists():
        return records
    with p.open("r", encoding="utf-8") as fh:
        for line in fh:
            raw = line.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            key = rec.get("song_key")
            if not key:
                continue
            prev = records.get(key)
            if not prev:
                records[key] = rec
                continue
            for field in ("mb", "discogs", "shs", "artist_profile", "shs_artist_uri"):
                if rec.get(field):
                    prev[field] = rec[field]
            merged_sources = sorted(set(prev.get("sources_checked") or []) | set(rec.get("sources_checked") or []))
            prev["sources_checked"] = merged_sources
            prev["checked_at"] = rec.get("checked_at") or prev.get("checked_at")
    return records


class SqliteHttpCache:
    """Thread-safe persistent SQLite cache storing valid upstream JSON payloads."""

    def __init__(self, db_path=HTTP_CACHE_DB):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), timeout=30.0, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS http_cache (
                cache_key TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                source TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        self._conn.commit()

    def get(self, cache_key):
        with self._lock:
            row = self._conn.execute(
                "SELECT payload FROM http_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
        if not row:
            return None
        try:
            return json.loads(row[0])
        except json.JSONDecodeError:
            return None

    def put(self, cache_key, url, source, payload):
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO http_cache (cache_key, url, source, fetched_at, payload)
                VALUES (?, ?, ?, ?, ?)
                """,
                (cache_key, url, source, utc_now_iso(), encoded),
            )
            self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()


class RateClient:
    """Paced JSON HTTP client backed by SqliteHttpCache with safe retry and 401 fallback."""

    def __init__(self, name, min_interval, headers, cache, timeout=20.0, logger=None):
        self.name = name
        self.min_interval = float(min_interval)
        self.headers = dict(headers or {})
        self.cache = cache
        self.timeout = float(timeout)
        self.logger = logger
        self._pace_lock = threading.Lock()
        self._last_request_at = 0.0
        self.stats = {"requests": 0, "cache_hits": 0, "errors": 0, "rate_limits": 0}

    def _log(self, message):
        if self.logger:
            self.logger(message)

    def _build_url(self, base_url, params=None):
        if not params:
            return base_url
        clean = {k: v for k, v in params.items() if v is not None and v != ""}
        if not clean:
            return base_url
        qs = urllib.parse.urlencode(sorted(clean.items()))
        sep = "&" if "?" in base_url else "?"
        return f"{base_url}{sep}{qs}"

    def _cache_key(self, full_url):
        digest = hashlib.sha256(full_url.encode("utf-8")).hexdigest()[:24]
        return f"{self.name}:{digest}"

    def _wait_turn(self):
        with self._pace_lock:
            now = time.monotonic()
            elapsed = now - self._last_request_at
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
            self._last_request_at = time.monotonic()

    def get_json(self, base_url, params=None, extra_headers=None, allow_not_found=False):
        full_url = self._build_url(base_url, params)
        cache_key = self._cache_key(full_url)
        cached = self.cache.get(cache_key)
        if cached is not None:
            self.stats["cache_hits"] += 1
            if isinstance(cached, dict) and cached.get("_not_found"):
                return None
            return cached

        req_headers = dict(self.headers)
        if extra_headers:
            req_headers.update(extra_headers)

        for attempt in range(4):
            self._wait_turn()
            self.stats["requests"] += 1
            req = urllib.request.Request(full_url, headers=req_headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                data = json.loads(raw)
                self.cache.put(cache_key, full_url, self.name, data)
                return data
            except urllib.error.HTTPError as exc:
                code = exc.code
                if code == 404 and allow_not_found:
                    self.cache.put(cache_key, full_url, self.name, {"_not_found": True})
                    return None
                if code == 401 and self.name == "shs" and "X-API-Key" in req_headers:
                    req_headers.pop("X-API-Key", None)
                    self.headers.pop("X-API-Key", None)
                    self.min_interval = max(self.min_interval, 3.35)
                    self._log("SHS API returned HTTP 401; stripped X-API-Key and dropped to 3.35s spacing")
                    continue
                if code in RETRYABLE_CODES and attempt < 3:
                    self.stats["rate_limits"] += 1
                    retry_after = exc.headers.get("Retry-After") if exc.headers else None
                    delay = float(retry_after) if retry_after and retry_after.isdigit() else 2.5 * (2**attempt)
                    time.sleep(min(30.0, delay))
                    continue
                self.stats["errors"] += 1
                self._log(f"[{self.name}] HTTP {code} on {full_url}")
                return None
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                if attempt < 3:
                    time.sleep(min(15.0, 2.0 * (attempt + 1)))
                    continue
                self.stats["errors"] += 1
                self._log(f"[{self.name}] Request failed ({type(exc).__name__}): {full_url}")
                return None
        return None


def build_clients(cache, logger=None):
    """Instantiate configured MB, Discogs, Wiki/Wikidata, and SecondHandSongs clients."""
    ua = "ThroughTheCracksArchive/1.0 (https://idleamericana.com/through-the-cracks)"
    mb_client = RateClient(
        name="mb",
        min_interval=1.60,
        headers={"User-Agent": ua, "Accept": "application/json"},
        cache=cache,
        logger=logger,
    )

    dc_headers = {"User-Agent": ua, "Accept": "application/json"}
    dc_token = (os.environ.get("DISCOGS_TOKEN") or "").strip()
    dc_key = (os.environ.get("DISCOGS_CONSUMER_KEY") or "").strip()
    dc_secret = (os.environ.get("DISCOGS_CONSUMER_SECRET") or "").strip()
    if dc_token:
        dc_headers["Authorization"] = f"Discogs token={dc_token}"
        dc_interval = 1.08
        dc_auth_mode = "personal_token"
    elif dc_key and dc_secret:
        dc_headers["Authorization"] = f"Discogs key={dc_key}, secret={dc_secret}"
        dc_interval = 1.08
        dc_auth_mode = "consumer_key_secret"
    else:
        dc_interval = 2.60
        dc_auth_mode = "unauthenticated"

    dc_client = RateClient(
        name="discogs",
        min_interval=dc_interval,
        headers=dc_headers,
        cache=cache,
        logger=logger,
    )

    wiki_client = RateClient(
        name="wiki",
        min_interval=0.25,
        headers={"User-Agent": ua, "Accept": "application/json"},
        cache=cache,
        logger=logger,
    )

    shs_headers = {"User-Agent": ua, "Accept": "application/json"}
    shs_key = (os.environ.get("SHS_API_KEY") or "").strip()
    if shs_key:
        shs_headers["X-API-Key"] = shs_key
        shs_interval = 1.10
        shs_auth_mode = "api_key"
    else:
        shs_interval = 3.35
        shs_auth_mode = "unauthenticated"

    shs_client = RateClient(
        name="shs",
        min_interval=shs_interval,
        headers=shs_headers,
        cache=cache,
        logger=logger,
    )

    auth_modes = {
        "discogs": dc_auth_mode,
        "shs": shs_auth_mode,
        "mb": "user_agent",
        "wiki": "user_agent",
    }
    return {"mb": mb_client, "discogs": dc_client, "wiki": wiki_client, "shs": shs_client}, auth_modes


class MetadataStatusWriter:
    """Atomic status writer reporting discovery progress to discovery-status.json."""

    def __init__(self, status_path=STATUS_PATH):
        self.status_path = Path(status_path)
        self.status_path.parent.mkdir(parents=True, exist_ok=True)
        self.started_at = utc_now_iso()

    def write(self, payload):
        doc = {
            "pid": os.getpid(),
            "startedAt": self.started_at,
            "updatedAt": utc_now_iso(),
            **payload,
        }
        tmp = self.status_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.status_path)
