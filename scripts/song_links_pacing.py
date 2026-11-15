"""Adaptive request pacing, batch cooldown helpers, and atomic status telemetry for Stage 2 discovery."""

from __future__ import annotations

import json
import math
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

__all__ = ["AdaptivePacer", "DiscoveryStatusWriter", "iso_from_epoch", "utc_now_iso"]


def iso_from_epoch(epoch_sec: float) -> str:
    """Format a POSIX epoch timestamp as a UTC ISO-8601 string with Z suffix."""
    return datetime.fromtimestamp(float(epoch_sec), tz=timezone.utc).isoformat().replace("+00:00", "Z")


def utc_now_iso() -> str:
    """Return the current UTC timestamp as an ISO-8601 string with Z suffix."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class AdaptivePacer:
    """Adaptive request jitter pacer that scales up on retries and decays after clean streaks."""

    def __init__(
        self, min_jitter: float = 0.25, max_jitter: float = 0.55, penalty_factor: float = 1.75,
        max_multiplier: float = 4.0, recovery_streak: int = 8, decay_factor: float = 0.85,
    ) -> None:
        self.min_jitter = max(0.0, float(min_jitter))
        self.max_jitter = float(max_jitter)
        if self.max_jitter > 0 and self.max_jitter < self.min_jitter:
            self.max_jitter = self.min_jitter
        self.penalty_factor = float(penalty_factor)
        self.max_multiplier = float(max_multiplier)
        self.recovery_streak = int(recovery_streak)
        self.decay_factor = float(decay_factor)
        self.multiplier = 1.0
        self.clean_streak = 0

    def record_retry(self) -> float:
        """Reset clean streak and scale jitter multiplier upward up to max_multiplier."""
        self.clean_streak = 0
        self.multiplier = min(self.max_multiplier, self.multiplier * self.penalty_factor)
        return self.multiplier

    def record_success(self) -> float:
        """Track consecutive clean calls and gently decay multiplier back toward 1.0x."""
        if self.multiplier > 1.0:
            self.clean_streak += 1
            if self.clean_streak >= self.recovery_streak:
                self.clean_streak = 0
                self.multiplier = max(1.0, self.multiplier * self.decay_factor)
                if self.multiplier < 1.02:
                    self.multiplier = 1.0
        return self.multiplier

    def next_delay(self, rng_obj: Any = random) -> float:
        """Sample next pre-request jitter delay scaled by the active multiplier."""
        if self.max_jitter <= 0:
            return 0.0
        return rng_obj.uniform(self.min_jitter * self.multiplier, self.max_jitter * self.multiplier)


class DiscoveryStatusWriter:
    """Atomic JSON status writer and timestamped log appender for Stage 2 discovery."""

    def __init__(
        self, status_path: Path, log_path: Path, *, enabled: bool = True, pass_mode: str,
        total_in_pass: int, skipped_completed: int, pending_total: int, batch_size: int,
        min_jitter: float, max_jitter: float, cooldown_min: float, cooldown_max: float,
        initial_cooldown: float,
    ) -> None:
        self.status_path, self.log_path, self.enabled = Path(status_path), Path(log_path), bool(enabled)
        started_at = utc_now_iso()
        total_batches = math.ceil(pending_total / batch_size) if batch_size > 0 else (1 if pending_total > 0 else 0)
        initial_phase = "initial_cooldown" if initial_cooldown > 0 else ("active_batch" if pending_total > 0 else "completed")
        self.state: dict[str, Any] = {
            "pid": os.getpid(), "passMode": pass_mode,
            "startedAt": started_at, "updatedAt": started_at, "phase": initial_phase,
            "totalInPass": int(total_in_pass), "skippedCompleted": int(skipped_completed),
            "pendingTotal": int(pending_total), "processedInRun": 0,
            "batchSize": int(batch_size), "batchIndex": 1 if pending_total > 0 else 0,
            "totalBatches": total_batches, "batchProcessed": 0,
            "minJitter": float(min_jitter), "maxJitter": float(max_jitter),
            "cooldownMin": float(cooldown_min), "cooldownMax": float(cooldown_max),
            "initialCooldown": float(initial_cooldown), "paceMultiplier": 1.0, "cleanStreak": 0,
            "cooldownSeconds": 0.0, "cooldownStartedAt": None, "cooldownUntil": None, "currentSong": None,
            "tiers": {"high": 0, "medium": 0, "low": 0, "unmatched": 0},
            "retryCount": 0, "recentRetries": [],
        }

    def _clear_cooldown(self) -> None:
        self.state["cooldownSeconds"] = 0.0
        self.state["cooldownStartedAt"] = None
        self.state["cooldownUntil"] = None

    def _set_cooldown_window(self, now: float, seconds: float) -> None:
        self.state["cooldownSeconds"] = round(float(seconds), 2)
        self.state["cooldownStartedAt"] = iso_from_epoch(now)
        self.state["cooldownUntil"] = iso_from_epoch(now + float(seconds))

    def _sync_pacer(self, pacer: AdaptivePacer) -> None:
        self.state["paceMultiplier"] = round(float(pacer.multiplier), 4)
        self.state["cleanStreak"] = int(pacer.clean_streak)

    def write_status(self) -> None:
        """Update updatedAt and atomically swap status JSON via a temporary sibling file."""
        self.state["updatedAt"] = utc_now_iso()
        if not self.enabled:
            return
        self.status_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.status_path.with_name(f"{self.status_path.name}.tmp")
        tmp_path.write_text(json.dumps(self.state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp_path, self.status_path)

    def append_log(self, line: str, *, is_error: bool = False) -> None:
        """Emit a message to stdout/stderr and append a UTC-timestamped line to discovery.log."""
        print(line, file=sys.stderr if is_error else sys.stdout, flush=True)
        if not self.enabled:
            return
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(f"[{utc_now_iso()}] {line}\n")
            fh.flush()

    def start_cooldown(
        self, phase: str, seconds: float, *, batch_index: int, batch_processed: int,
        pace_multiplier: float, clean_streak: int,
    ) -> None:
        """Record an initial or between-batch cooldown window and flush status."""
        self.state["phase"] = phase
        self._set_cooldown_window(time.time(), seconds)
        self.state["currentSong"] = None
        self.state["batchIndex"] = int(batch_index)
        self.state["batchProcessed"] = int(batch_processed)
        self.state["paceMultiplier"] = round(float(pace_multiplier), 4)
        self.state["cleanStreak"] = int(clean_streak)
        self.write_status()

    def start_song(
        self, *, artist: str, song_title: str, song_key: str,
        batch_index: int, batch_processed: int, pacer: AdaptivePacer,
    ) -> None:
        """Transition into active_batch for the current song and clear cooldown markers."""
        self.state["phase"] = "active_batch"
        self._clear_cooldown()
        self.state["currentSong"] = {"artist": artist, "songTitle": song_title, "songKey": song_key}
        self.state["batchIndex"] = int(batch_index)
        self.state["batchProcessed"] = int(batch_processed)
        self._sync_pacer(pacer)
        self.write_status()

    def record_song_done(
        self, record: dict[str, Any], *, processed_in_run: int, batch_processed: int, pacer: AdaptivePacer,
    ) -> None:
        """Record one completed song tier, update counters, and clear currentSong."""
        tier = str(record["match_tier"])
        self.state["tiers"][tier] = self.state["tiers"].get(tier, 0) + 1
        self.state["processedInRun"] = int(processed_in_run)
        self.state["batchProcessed"] = int(batch_processed)
        if self.state["phase"] == "retry_backoff":
            self.state["phase"] = "active_batch"
            self._clear_cooldown()
        self._sync_pacer(pacer)
        self.state["currentSong"] = None
        self.write_status()

    def record_retry_event(
        self, *, query: str, search_filter: str, attempt: int, max_retries: int,
        backoff_seconds: float, pace_multiplier: float, error: str,
    ) -> None:
        """Increment retry telemetry, track bounded recent retry log, and enter retry_backoff."""
        self.state["retryCount"] += 1
        self.state["phase"] = "retry_backoff"
        self.state["paceMultiplier"] = round(float(pace_multiplier), 4)
        self.state["cleanStreak"] = 0
        if backoff_seconds > 0:
            self._set_cooldown_window(time.time(), backoff_seconds)
        else:
            self._clear_cooldown()
        self.state["recentRetries"].append({
            "at": utc_now_iso(), "query": query, "searchFilter": search_filter,
            "attempt": int(attempt), "maxRetries": int(max_retries),
            "backoffSeconds": float(backoff_seconds),
            "paceMultiplier": round(float(pace_multiplier), 4), "error": str(error)[:240],
        })
        self.state["recentRetries"] = self.state["recentRetries"][-20:]
        self.write_status()

    def finish(self, *, phase: str, pacer: AdaptivePacer) -> None:
        """Mark discovery completed or errored, clearing transient song/cooldown fields."""
        self.state["phase"] = phase
        self._clear_cooldown()
        self.state["currentSong"] = None
        self._sync_pacer(pacer)
        self.write_status()
