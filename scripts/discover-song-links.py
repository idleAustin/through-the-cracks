#!/usr/bin/env python3
"""Stage 2 backfill: single-threaded, resumable ytmusicapi discovery with backoff safety."""

from __future__ import annotations

import argparse
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
from song_links_scorer import normalize_text, parse_duration_seconds, score_candidate, song_title_of, tier_for  # noqa: E402

REPO_ROOT = _SCRIPTS_DIR.parent
DEFAULT_INPUT_PATH = REPO_ROOT / ".cache" / "song-links" / "catalog-input.json"
DEFAULT_CHECKPOINT_PATH = REPO_ROOT / ".cache" / "song-links" / "checkpoint.jsonl"
DEFAULT_RETRY_DELAYS = (30.0, 120.0, 600.0)
SHORT_CIRCUIT_SCORE = 85

__all__ = [
    "AdaptivePacer", "DiscoveryRetryExhaustedError", "DiscoveryStatusWriter",
    "discover_song", "filter_songs_by_pass", "load_checkpoint_state",
    "normalize_text", "parse_duration_seconds", "parse_retry_delays",
    "run_discovery", "score_candidate", "tier_for",
]


class DiscoveryRetryExhaustedError(RuntimeError):
    """Raised when rate-limit/network retries exhaust without poisoning checkpoints."""


def _validate_search_mode(search_mode: str) -> str:
    if search_mode not in ("unified", "split"):
        raise ValueError(f"Unsupported --search-mode value: {search_mode}")
    return search_mode


def filter_songs_by_pass(songs: list[dict[str, Any]], pass_mode: str) -> list[dict[str, Any]]:
    """Select multi-spin, single-spin, or all songs for discovery."""
    if pass_mode == "multi":
        return [s for s in songs if int(s.get("totalPlays") or 0) >= 2]
    if pass_mode == "single":
        return [s for s in songs if int(s.get("totalPlays") or 0) == 1]
    if pass_mode == "all":
        return list(songs)
    raise ValueError(f"Unsupported --pass value: {pass_mode}")


def load_checkpoint_state(checkpoint_path: Path) -> tuple[set[str], bool]:
    """Read existing JSONL checkpoint safely, skipping malformed lines."""
    if not checkpoint_path.exists():
        return set(), False
    raw_bytes = checkpoint_path.read_bytes()
    if not raw_bytes:
        return set(), False
    completed: set[str] = set()
    for line_no, raw_line in enumerate(raw_bytes.decode("utf-8", errors="replace").splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped:
            continue
        try:
            rec = json.loads(stripped)
        except json.JSONDecodeError as exc:
            print(f"Warning: ignoring malformed checkpoint line {line_no} in {checkpoint_path}: {exc}", file=sys.stderr)
            continue
        if isinstance(rec, dict) and rec.get("song_key"):
            completed.add(str(rec["song_key"]))
    return completed, not raw_bytes.endswith(b"\n")


def _search_with_retry(
    ytm: Any, query: str, search_filter: str | None, retry_delays: Sequence[float],
    sleep_fn: Callable[[float], None], on_before_retry: Callable[[], None] | None,
    *, limit: int = 5, ytm_factory: Callable[[], Any] | None = None,
    on_ytm_rotated: Callable[[Any], None] | None = None,
    pacer: AdaptivePacer | None = None,
    on_retry_event: Callable[[dict[str, Any]], None] | None = None,
    log_fn: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    current_ytm = ytm
    filter_label = search_filter if search_filter is not None else "unified"
    for attempt in range(len(retry_delays) + 1):
        try:
            hits = current_ytm.search(query, filter=search_filter, limit=limit) or []
            if pacer:
                pacer.record_success()
            return hits
        except Exception as exc:  # noqa: BLE001
            if on_before_retry:
                on_before_retry()
            if pacer:
                pacer.record_retry()
            backoff = float(retry_delays[attempt]) if attempt < len(retry_delays) else 0.0
            if on_retry_event:
                on_retry_event({
                    "query": query, "search_filter": filter_label, "attempt": attempt + 1,
                    "max_retries": len(retry_delays), "backoff_seconds": backoff,
                    "pace_multiplier": pacer.multiplier if pacer else 1.0, "error": str(exc),
                })
            if attempt >= len(retry_delays):
                raise DiscoveryRetryExhaustedError(
                    f"Exhausted retries ({len(retry_delays)}) during {filter_label} search for {query!r}: {exc}"
                ) from exc
            pace_note = f" [pace={pacer.multiplier:.2f}x]" if pacer else ""
            msg = (
                f"Rate-limit/network error on {filter_label} search for {query!r}: {exc}. "
                f"Backing off {backoff:g}s (retry {attempt + 1}/{len(retry_delays)})...{pace_note}"
            )
            log_fn(msg) if log_fn else print(msg, file=sys.stderr)
            if backoff > 0:
                sleep_fn(backoff)
            if ytm_factory is not None:
                current_ytm = ytm_factory()
                if on_ytm_rotated is not None:
                    on_ytm_rotated(current_ytm)
    return []


def discover_song(
    song: dict[str, Any], ytm: Any, *, retry_delays: Sequence[float] = DEFAULT_RETRY_DELAYS,
    min_jitter: float = 0.25, max_jitter: float = 0.55, rng: random.Random | None = None,
    sleep_fn: Callable[[float], None] = time.sleep, on_before_retry: Callable[[], None] | None = None,
    has_prior_request: bool = False, pacer: AdaptivePacer | None = None,
    on_retry_event: Callable[[dict[str, Any]], None] | None = None,
    log_fn: Callable[[str], None] | None = None, search_mode: str = "unified",
    ytm_factory: Callable[[], Any] | None = None,
    on_ytm_rotated: Callable[[Any], None] | None = None,
) -> tuple[dict[str, Any], bool]:
    """Discover best YouTube Music match for one normalized song."""
    _validate_search_mode(search_mode)
    rng_obj = rng or random
    active_pacer = pacer if pacer is not None else AdaptivePacer(min_jitter=min_jitter, max_jitter=max_jitter)
    title = song_title_of(song)
    artist = str(song.get("artist") or "").strip()
    query = f"{artist} {title}".strip()
    best_entry: dict[str, Any] | None = None
    made_request = has_prior_request
    active_client = [ytm]

    def _handle_rotation(new_client: Any) -> None:
        active_client[0] = new_client
        if on_ytm_rotated is not None:
            on_ytm_rotated(new_client)

    search_passes: tuple[tuple[str | None, int], ...] = ((None, 10),) if search_mode == "unified" else (("songs", 5), ("videos", 5))
    for search_filter, search_limit in search_passes:
        if best_entry and best_entry["confidence_score"] >= SHORT_CIRCUIT_SCORE:
            break
        if made_request and active_pacer.max_jitter > 0:
            sleep_fn(active_pacer.next_delay(rng_obj))
        made_request = True
        hits = _search_with_retry(
            active_client[0], query, search_filter, retry_delays, sleep_fn, on_before_retry,
            limit=search_limit, ytm_factory=ytm_factory, on_ytm_rotated=_handle_rotation,
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
                best_entry = {
                    "video_id": vid, "yt_title": hit.get("title", ""), "yt_artist": ", ".join(yt_artists),
                    "yt_album": yt_album, "duration_seconds": scored.get("duration_seconds"),
                    "result_type": rt or ("song" if search_filter == "songs" else "video"),
                    "confidence_score": int(scored["score"]),
                }

    score = best_entry["confidence_score"] if best_entry else 0
    video_id = best_entry["video_id"] if best_entry else None
    record = {
        "song_key": song["song_key"], "artist": artist, "song_title": title,
        "album": str(song.get("album") or ""), "totalPlays": int(song.get("totalPlays") or 0),
        "video_id": video_id, "yt_title": best_entry["yt_title"] if best_entry else None,
        "yt_artist": best_entry["yt_artist"] if best_entry else None,
        "yt_album": best_entry["yt_album"] if best_entry else None,
        "result_type": best_entry["result_type"] if best_entry else None,
        "duration_seconds": best_entry["duration_seconds"] if best_entry else None,
        "confidence_score": score, "match_tier": tier_for(score, video_id), "checked_at": utc_now_iso(),
    }
    return record, made_request


def run_discovery(
    *, input_path: Path = DEFAULT_INPUT_PATH, checkpoint_path: Path = DEFAULT_CHECKPOINT_PATH,
    pass_mode: str = "all", search_mode: str = "unified", limit: int | None = None,
    retry_delays: Sequence[float] = DEFAULT_RETRY_DELAYS,
    min_jitter: float = 0.25, max_jitter: float = 0.55,
    batch_size: int = 0, cooldown_min: float = 0.0, cooldown_max: float = 0.0,
    initial_cooldown: float = 0.0, max_run_retries: int = 0,
    ytm: Any = None, ytm_factory: Callable[[], Any] | None = None,
    sleep_fn: Callable[[float], None] = time.sleep, rng: random.Random | None = None,
) -> dict[str, Any]:
    """Run resumable single-threaded Stage 2 discovery against catalog-input.json."""
    _validate_search_mode(search_mode)
    batch_size = max(0, int(batch_size))
    cooldown_min, cooldown_max = max(0.0, float(cooldown_min)), max(0.0, float(cooldown_max))
    if cooldown_min > 0 and cooldown_max < cooldown_min:
        cooldown_max = cooldown_min
    initial_cooldown = max(0.0, float(initial_cooldown))
    max_run_retries = max(0, int(max_run_retries))
    rng_obj = rng or random

    catalog = json.loads(input_path.read_text(encoding="utf-8"))
    selected = filter_songs_by_pass(catalog, pass_mode)
    completed_keys, needs_leading_newline = load_checkpoint_state(checkpoint_path)
    pending = [s for s in selected if s.get("song_key") not in completed_keys]
    if limit is not None and limit >= 0:
        pending = pending[:limit]

    skipped_count = len(selected) - len([s for s in selected if s.get("song_key") not in completed_keys])
    summary = {"totalInPass": len(selected), "skippedCompleted": skipped_count, "processed": 0, "tiers": {"high": 0, "medium": 0, "low": 0, "unmatched": 0}}
    if not pending:
        return summary

    factory = ytm_factory
    if ytm is None and factory is None:
        from ytmusicapi import YTMusic
        factory = YTMusic

    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    has_prior_request = False
    pacer = AdaptivePacer(min_jitter=min_jitter, max_jitter=max_jitter)
    status = DiscoveryStatusWriter(
        checkpoint_path.parent / "discovery-status.json", checkpoint_path.parent / "discovery.log",
        pass_mode=pass_mode, search_mode=search_mode, total_in_pass=len(selected),
        skipped_completed=skipped_count, pending_total=len(pending), batch_size=batch_size,
        min_jitter=pacer.min_jitter, max_jitter=pacer.max_jitter,
        cooldown_min=cooldown_min, cooldown_max=cooldown_max, initial_cooldown=initial_cooldown,
    )
    with checkpoint_path.open("a", encoding="utf-8") as fh:
        if needs_leading_newline:
            fh.write("\n")
            fh.flush()

        def flush_checkpoint() -> None:
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                pass

        batch_note = f", batch={batch_size}, cooldown={cooldown_min:g}-{cooldown_max:g}s" if batch_size > 0 else ""
        status.append_log(f"[{pass_mode}] Starting discovery: pending={len(pending)}, skipped={skipped_count}, search={search_mode}, jitter={pacer.min_jitter:g}-{pacer.max_jitter:g}s{batch_note}")
        if initial_cooldown > 0:
            status.start_cooldown("initial_cooldown", initial_cooldown, batch_index=1, batch_processed=0, pace_multiplier=pacer.multiplier, clean_streak=pacer.clean_streak)
            status.append_log(f"[{pass_mode}] Initial cooldown {initial_cooldown:.1f}s before batch 1/{status.state['totalBatches']}...")
            sleep_fn(initial_cooldown)
            has_prior_request = False

        ytm_box = [ytm if ytm is not None else factory()]

        def _rotate_client(new_client: Any) -> None:
            ytm_box[0] = new_client

        def _on_retry(evt: dict[str, Any]) -> None:
            status.record_retry_event(**evt)
            if max_run_retries > 0 and status.state["retryCount"] >= max_run_retries:
                raise DiscoveryRetryExhaustedError(
                    f"Run retry circuit breaker tripped ({max_run_retries} cumulative retries reached): {evt['error']}"
                )

        for idx, song in enumerate(pending, start=1):
            batch_index = ((idx - 1) // batch_size) + 1 if batch_size > 0 else 1
            batch_processed = (idx - 1) % batch_size if batch_size > 0 else idx - 1
            status.start_song(artist=str(song.get("artist") or "").strip(), song_title=song_title_of(song), song_key=str(song.get("song_key") or ""), batch_index=batch_index, batch_processed=batch_processed, pacer=pacer)
            try:
                record, has_prior_request = discover_song(
                    song, ytm_box[0], retry_delays=retry_delays, min_jitter=min_jitter, max_jitter=max_jitter,
                    rng=rng_obj, sleep_fn=sleep_fn, on_before_retry=flush_checkpoint,
                    has_prior_request=has_prior_request, pacer=pacer,
                    on_retry_event=_on_retry,
                    log_fn=lambda msg: status.append_log(msg, is_error=True),
                    search_mode=search_mode, ytm_factory=factory, on_ytm_rotated=_rotate_client,
                )
            except DiscoveryRetryExhaustedError as exc:
                flush_checkpoint()
                status.finish(phase="error", pacer=pacer)
                status.append_log(f"ERROR: {exc}", is_error=True)
                raise

            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            fh.flush()
            summary["processed"] += 1
            summary["tiers"][record["match_tier"]] += 1
            done_in_batch = ((idx - 1) % batch_size) + 1 if batch_size > 0 else idx
            status.record_song_done(record, processed_in_run=idx, batch_processed=done_in_batch, pacer=pacer)
            if idx % 50 == 0 or (batch_size > 0 and idx % batch_size == 0) or idx == len(pending):
                status.append_log(f"[{pass_mode}] Processed {idx}/{len(pending)} | tiers={summary['tiers']} | pace={pacer.multiplier:.2f}x")
            if batch_size > 0 and idx % batch_size == 0 and idx < len(pending):
                flush_checkpoint()
                if cooldown_max > 0:
                    cd = rng_obj.uniform(cooldown_min, cooldown_max)
                    status.start_cooldown("batch_cooldown", cd, batch_index=batch_index, batch_processed=done_in_batch, pace_multiplier=pacer.multiplier, clean_streak=pacer.clean_streak)
                    status.append_log(f"[{pass_mode}] Batch {batch_index}/{status.state['totalBatches']} complete ({idx}/{len(pending)}); cooling down {cd:.1f}s...")
                    sleep_fn(cd)
                pacer.reset()
                if factory is not None:
                    ytm_box[0] = factory()
                has_prior_request = False

        flush_checkpoint()
        status.finish(phase="completed", pacer=pacer)
        status.append_log(f"Done ({pass_mode}): processed={summary['processed']}, skipped={summary['skippedCompleted']}, tiers={summary['tiers']}")

    return summary


def parse_retry_delays(raw: str) -> tuple[float, ...]:
    """Parse comma-separated backoff delays in seconds."""
    return tuple(float(p.strip()) for p in str(raw or "").split(",") if p.strip())


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stage 2 resumable ytmusicapi song link discovery.")
    parser.add_argument("--pass", dest="pass_mode", choices=("multi", "single", "all"), default="all")
    parser.add_argument("--search-mode", choices=("unified", "split"), default="unified", help="ytmusicapi search mode (unified single pass or split songs+videos).")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT_PATH)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT_PATH)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--retry-delays", default=",".join(str(int(d)) for d in DEFAULT_RETRY_DELAYS))
    parser.add_argument("--min-jitter", type=float, default=0.25)
    parser.add_argument("--max-jitter", type=float, default=0.55)
    parser.add_argument("--batch-size", type=int, default=0, help="Songs per batch before cooldown (0 disables batching).")
    parser.add_argument("--cooldown-min", type=float, default=0.0, help="Minimum between-batch cooldown in seconds.")
    parser.add_argument("--cooldown-max", type=float, default=0.0, help="Maximum between-batch cooldown in seconds.")
    parser.add_argument("--initial-cooldown", type=float, default=0.0, help="Initial cooldown in seconds before first batch.")
    parser.add_argument("--max-run-retries", type=int, default=0, help="Abort run after N cumulative retries across songs (0 disables).")
    args = parser.parse_args(argv)

    try:
        summary = run_discovery(
            input_path=args.input, checkpoint_path=args.checkpoint, pass_mode=args.pass_mode,
            search_mode=args.search_mode, limit=args.limit,
            retry_delays=parse_retry_delays(args.retry_delays),
            min_jitter=args.min_jitter, max_jitter=args.max_jitter,
            batch_size=args.batch_size, cooldown_min=args.cooldown_min,
            cooldown_max=args.cooldown_max, initial_cooldown=args.initial_cooldown,
            max_run_retries=args.max_run_retries,
        )
    except DiscoveryRetryExhaustedError:
        return 1

    if summary["processed"] == 0:
        print(f"Done ({args.pass_mode}): processed={summary['processed']}, skipped={summary['skippedCompleted']}, tiers={summary['tiers']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
