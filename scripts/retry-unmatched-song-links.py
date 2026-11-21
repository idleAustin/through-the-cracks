#!/usr/bin/env python3
"""Multi-pass resumable ytmusicapi retry runner for unmatched song_links tracks."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any, Callable, Sequence

_SCRIPTS_DIR = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from song_links_pacing import AdaptivePacer, DiscoveryStatusWriter, utc_now_iso  # noqa: E402
from song_links_scorer import (  # noqa: E402
    build_fallback_queries, score_candidate, song_title_of, tier_for,
)


def _load_discover_module() -> Any:
    spec = importlib.util.spec_from_file_location("discover_song_links", _SCRIPTS_DIR / "discover-song-links.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


_DISCOVER = _load_discover_module()
DiscoveryRetryExhaustedError = _DISCOVER.DiscoveryRetryExhaustedError
SHORT_CIRCUIT_SCORE = _DISCOVER.SHORT_CIRCUIT_SCORE
_search_with_retry = _DISCOVER._search_with_retry
filter_songs_by_pass = _DISCOVER.filter_songs_by_pass
load_checkpoint_state = _DISCOVER.load_checkpoint_state
parse_retry_delays = _DISCOVER.parse_retry_delays

CACHE_DIR = _SCRIPTS_DIR.parent / ".cache" / "song-links"
DEFAULT_VERIFIED_PATH = CACHE_DIR / "verified.jsonl"
DEFAULT_INPUT_PATH = CACHE_DIR / "catalog-input.json"
DEFAULT_CHECKPOINT_PATH = CACHE_DIR / "retry-unmatched.jsonl"
DEFAULT_STATUS_PATH = CACHE_DIR / "retry-status.json"
DEFAULT_LOG_PATH = CACHE_DIR / "retry.log"
DEFAULT_RETRY_DELAYS = (30.0, 120.0, 300.0)
MIN_ACCEPT_SCORE = 65


def load_unmatched_songs(verified_path: Path, catalog_path: Path) -> list[dict[str, Any]]:
    """Load unmatched songs from verified.jsonl enriched with catalog metadata, sorted by plays DESC."""
    catalog_by_key: dict[str, dict[str, Any]] = {}
    if Path(catalog_path).exists():
        raw_cat = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
        items = raw_cat if isinstance(raw_cat, list) else raw_cat.get("songs", [])
        for row in items:
            if isinstance(row, dict) and row.get("song_key"):
                catalog_by_key[str(row["song_key"])] = row

    latest_by_key: dict[str, dict[str, Any]] = {}
    for line in Path(verified_path).read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            rec = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and rec.get("song_key"):
            latest_by_key[str(rec["song_key"])] = rec

    unmatched: list[dict[str, Any]] = []
    for key, rec in latest_by_key.items():
        vid = str(rec.get("video_id") or "").strip()
        if vid and rec.get("match_tier") != "unmatched":
            continue
        cat = catalog_by_key.get(key, {})
        total_plays = int(cat.get("totalPlays") or cat.get("total_plays") or rec.get("totalPlays") or 0)
        unmatched.append({
            "song_key": key,
            "artist": str(cat.get("artist") or rec.get("artist") or "").strip(),
            "song_title": song_title_of(cat) or song_title_of(rec),
            "album": str(cat.get("album") or rec.get("album") or ""),
            "albums": list(cat.get("albums") or rec.get("albums") or []),
            "totalPlays": total_plays,
        })
    unmatched.sort(key=lambda s: (-int(s["totalPlays"]), s["song_key"]))
    return unmatched


def retry_song(
    song: dict[str, Any], ytm: Any, *, retry_delays: Sequence[float] = DEFAULT_RETRY_DELAYS,
    rng: random.Random | None = None, sleep_fn: Callable[[float], None] = time.sleep,
    on_before_retry: Callable[[], None] | None = None, has_prior_request: bool = False,
    pacer: AdaptivePacer | None = None, on_retry_event: Callable[[dict[str, Any]], None] | None = None,
    log_fn: Callable[[str], None] | None = None, ytm_factory: Callable[[], Any] | None = None,
    on_ytm_rotated: Callable[[Any], None] | None = None,
) -> tuple[dict[str, Any], bool]:
    """Run ordered fallback queries against ytmusicapi for one previously unmatched song."""
    rng_obj = rng or random
    active_pacer = pacer if pacer is not None else AdaptivePacer(min_jitter=2.0, max_jitter=4.0)
    active_client = [ytm]
    made_request = has_prior_request
    best_entry: dict[str, Any] | None = None
    best_label: str | None = None

    def _rotate(new_client: Any) -> None:
        active_client[0] = new_client
        if on_ytm_rotated is not None:
            on_ytm_rotated(new_client)

    for label, query, search_filter in build_fallback_queries(song):
        if made_request and active_pacer.max_jitter > 0:
            sleep_fn(active_pacer.next_delay(rng_obj))
        made_request = True
        hits = _search_with_retry(
            active_client[0], query, search_filter, retry_delays, sleep_fn, on_before_retry,
            limit=10, ytm_factory=ytm_factory, on_ytm_rotated=_rotate,
            pacer=active_pacer, on_retry_event=on_retry_event, log_fn=log_fn,
        )
        for hit in hits:
            if hit.get("isAvailable") is False:
                continue
            rt = hit.get("resultType")
            if (rt not in ("song", "video")) if search_filter is None else (rt is not None and rt not in ("song", "video")):
                continue
            vid = hit.get("videoId")
            if not vid:
                continue
            scored = score_candidate(song, hit)
            if scored["rejected"] or scored["score"] <= 0:
                continue
            if best_entry is None or scored["score"] > best_entry["confidence_score"]:
                yt_artists = [a.get("name", "") for a in (hit.get("artists") or []) if a.get("name")]
                yt_album = (hit.get("album") or {}).get("name", "") if isinstance(hit.get("album"), dict) else ""
                best_label = label
                best_entry = {
                    "video_id": vid, "yt_title": hit.get("title", ""), "yt_artist": ", ".join(yt_artists),
                    "yt_album": yt_album, "duration_seconds": scored.get("duration_seconds"),
                    "result_type": rt or ("song" if search_filter == "songs" else "video"),
                    "confidence_score": int(scored["score"]),
                }
        best_score = best_entry["confidence_score"] if best_entry else 0
        if best_score >= SHORT_CIRCUIT_SCORE or (search_filter in ("songs", "videos") and best_score >= 65):
            break

    if best_entry and best_entry["confidence_score"] < MIN_ACCEPT_SCORE:
        best_entry = None
        best_label = None

    score = best_entry["confidence_score"] if best_entry else 0
    video_id = best_entry["video_id"] if best_entry else None
    record = {
        "song_key": song["song_key"], "artist": str(song.get("artist") or "").strip(),
        "song_title": song_title_of(song), "album": str(song.get("album") or ""),
        "totalPlays": int(song.get("totalPlays") or 0), "video_id": video_id,
        "yt_title": best_entry["yt_title"] if best_entry else None,
        "yt_artist": best_entry["yt_artist"] if best_entry else None,
        "yt_album": best_entry["yt_album"] if best_entry else None,
        "result_type": best_entry["result_type"] if best_entry else None,
        "duration_seconds": best_entry["duration_seconds"] if best_entry else None,
        "confidence_score": score, "match_tier": tier_for(score, video_id),
        "matched_via": best_label if video_id else None, "checked_at": utc_now_iso(),
    }
    return record, made_request


def run_retry_unmatched(
    *, verified_path: Path = DEFAULT_VERIFIED_PATH, input_path: Path = DEFAULT_INPUT_PATH,
    checkpoint_path: Path = DEFAULT_CHECKPOINT_PATH, status_path: Path | None = None,
    log_path: Path | None = None, pass_mode: str = "all", limit: int | None = None,
    retry_delays: Sequence[float] = DEFAULT_RETRY_DELAYS, min_jitter: float = 2.0,
    max_jitter: float = 4.0, batch_size: int = 60, cooldown_min: float = 90.0,
    cooldown_max: float = 150.0, max_run_retries: int = 15, ytm: Any = None,
    ytm_factory: Callable[[], Any] | None = None, sleep_fn: Callable[[float], None] = time.sleep,
    rng: random.Random | None = None,
) -> dict[str, Any]:
    """Run resumable multi-pass fallback discovery across unmatched tracks."""
    batch_size = max(0, int(batch_size))
    cooldown_min, cooldown_max = max(0.0, float(cooldown_min)), max(0.0, float(cooldown_max))
    if cooldown_min > 0 and cooldown_max < cooldown_min:
        cooldown_max = cooldown_min
    max_run_retries = max(0, int(max_run_retries))
    rng_obj = rng or random
    resolved_status = status_path if status_path is not None else Path(checkpoint_path).parent / "retry-status.json"
    resolved_log = log_path if log_path is not None else Path(checkpoint_path).parent / "retry.log"

    selected = filter_songs_by_pass(load_unmatched_songs(verified_path, input_path), pass_mode)
    completed_keys, needs_newline = load_checkpoint_state(checkpoint_path)
    pending_all = [s for s in selected if s["song_key"] not in completed_keys]
    skipped_count = len(selected) - len(pending_all)
    pending = pending_all[:limit] if limit is not None and limit >= 0 else pending_all
    summary: dict[str, Any] = {
        "totalInPass": len(selected), "skippedCompleted": skipped_count, "processed": 0,
        "tiers": {"high": 0, "medium": 0, "low": 0, "unmatched": 0}, "matchedVia": {},
    }
    if not pending:
        return summary

    factory = ytm_factory
    if ytm is None and factory is None:
        from ytmusicapi import YTMusic
        factory = YTMusic

    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    pacer = AdaptivePacer(min_jitter=min_jitter, max_jitter=max_jitter)
    status = DiscoveryStatusWriter(
        resolved_status, resolved_log, pass_mode=pass_mode, search_mode="multi-pass-retry",
        total_in_pass=len(selected), skipped_completed=skipped_count, pending_total=len(pending),
        batch_size=batch_size, min_jitter=pacer.min_jitter, max_jitter=pacer.max_jitter,
        cooldown_min=cooldown_min, cooldown_max=cooldown_max, initial_cooldown=0.0,
    )
    has_prior_request = False
    with checkpoint_path.open("a", encoding="utf-8") as fh:
        if needs_newline:
            fh.write("\n")
            fh.flush()

        def flush_ckpt() -> None:
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                pass

        status.append_log(f"[retry:{pass_mode}] Starting: pending={len(pending)}, skipped={skipped_count}, jitter={pacer.min_jitter:g}-{pacer.max_jitter:g}s, batch={batch_size}")
        ytm_box = [ytm if ytm is not None else factory()]

        def _on_retry(evt: dict[str, Any]) -> None:
            status.record_retry_event(**evt)
            if max_run_retries > 0 and status.state["retryCount"] >= max_run_retries:
                raise DiscoveryRetryExhaustedError(f"Run retry circuit breaker tripped ({max_run_retries}): {evt['error']}")

        for idx, song in enumerate(pending, start=1):
            batch_index = ((idx - 1) // batch_size) + 1 if batch_size > 0 else 1
            batch_processed = (idx - 1) % batch_size if batch_size > 0 else idx - 1
            status.start_song(artist=song["artist"], song_title=song["song_title"], song_key=song["song_key"], batch_index=batch_index, batch_processed=batch_processed, pacer=pacer)
            try:
                record, has_prior_request = retry_song(
                    song, ytm_box[0], retry_delays=retry_delays, rng=rng_obj, sleep_fn=sleep_fn,
                    on_before_retry=flush_ckpt, has_prior_request=has_prior_request, pacer=pacer,
                    on_retry_event=_on_retry, log_fn=lambda msg: status.append_log(msg, is_error=True),
                    ytm_factory=factory, on_ytm_rotated=lambda c: ytm_box.__setitem__(0, c),
                )
            except DiscoveryRetryExhaustedError as exc:
                flush_ckpt()
                status.finish(phase="error", pacer=pacer)
                status.append_log(f"ERROR: {exc}", is_error=True)
                raise

            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            fh.flush()
            summary["processed"] += 1
            summary["tiers"][record["match_tier"]] += 1
            if record.get("matched_via"):
                via = str(record["matched_via"])
                summary["matchedVia"][via] = summary["matchedVia"].get(via, 0) + 1
            done_in_batch = ((idx - 1) % batch_size) + 1 if batch_size > 0 else idx
            status.record_song_done(record, processed_in_run=idx, batch_processed=done_in_batch, pacer=pacer)
            if idx % 25 == 0 or (batch_size > 0 and idx % batch_size == 0) or idx == len(pending):
                status.append_log(f"[retry:{pass_mode}] {idx}/{len(pending)} | tiers={summary['tiers']} | via={summary['matchedVia']} | pace={pacer.multiplier:.2f}x")
            if batch_size > 0 and idx % batch_size == 0 and idx < len(pending):
                flush_ckpt()
                if cooldown_max > 0:
                    cd = rng_obj.uniform(cooldown_min, cooldown_max)
                    status.start_cooldown("batch_cooldown", cd, batch_index=batch_index, batch_processed=done_in_batch, pace_multiplier=pacer.multiplier, clean_streak=pacer.clean_streak)
                    status.append_log(f"[retry:{pass_mode}] Batch {batch_index}/{status.state['totalBatches']} complete ({idx}/{len(pending)}); cooling {cd:.1f}s...")
                    sleep_fn(cd)
                pacer.reset()
                if factory is not None:
                    ytm_box[0] = factory()
                has_prior_request = False

        flush_ckpt()
        status.finish(phase="completed", pacer=pacer)
        status.append_log(f"Done (retry:{pass_mode}): processed={summary['processed']}, skipped={summary['skippedCompleted']}, tiers={summary['tiers']}, via={summary['matchedVia']}")
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Multi-pass ytmusicapi retry runner for unmatched song_links.")
    parser.add_argument("--pass", dest="pass_mode", choices=("multi", "single", "all"), default="all")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--verified", type=Path, default=DEFAULT_VERIFIED_PATH)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT_PATH)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT_PATH)
    parser.add_argument("--status", type=Path, default=None)
    parser.add_argument("--log", type=Path, default=None)
    parser.add_argument("--min-jitter", type=float, default=2.0)
    parser.add_argument("--max-jitter", type=float, default=4.0)
    parser.add_argument("--batch-size", type=int, default=60)
    parser.add_argument("--cooldown-min", type=float, default=90.0)
    parser.add_argument("--cooldown-max", type=float, default=150.0)
    parser.add_argument("--retry-delays", default=",".join(str(int(d)) for d in DEFAULT_RETRY_DELAYS))
    parser.add_argument("--max-run-retries", type=int, default=15)
    args = parser.parse_args(argv)
    try:
        summary = run_retry_unmatched(
            verified_path=args.verified, input_path=args.input, checkpoint_path=args.checkpoint,
            status_path=args.status, log_path=args.log, pass_mode=args.pass_mode, limit=args.limit,
            retry_delays=parse_retry_delays(args.retry_delays), min_jitter=args.min_jitter,
            max_jitter=args.max_jitter, batch_size=args.batch_size, cooldown_min=args.cooldown_min,
            cooldown_max=args.cooldown_max, max_run_retries=args.max_run_retries,
        )
    except DiscoveryRetryExhaustedError:
        return 1
    if summary["processed"] == 0:
        print(f"Done (retry:{args.pass_mode}): processed=0, skipped={summary['skippedCompleted']}, tiers={summary['tiers']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
