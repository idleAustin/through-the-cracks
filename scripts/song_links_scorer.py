"""Candidate scoring and text normalization helpers for Stage 2 song link discovery."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from rapidfuzz import fuzz

DISQUALIFIERS = (
    "cover", "karaoke", "instrumental", "tribute", "reaction", "lesson",
    "tutorial", "guitar tab", "bass cover", "nightcore", "slowed",
    "skit", "interlude", "intro", "outro",
)
VARIANT_KEYWORDS = ("live", "acoustic", "demo", "remix", "session", "tiny desk", "kexp")


def normalize_text(text: str) -> str:
    """Normalize song/artist/album strings for base comparison."""
    s = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    s = s.lower().strip().replace("&", " and ")
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", s)
    s = re.sub(r"\b(feat\.?|ft\.?|featuring)\b.*$", " ", s)
    s = re.sub(r"\bw/.*$", " ", s)
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"^the\s+", "", s)
    return re.sub(r"\s+", " ", s).strip()


def strip_query_noise(text: str) -> str:
    """Strip parentheticals, brackets, featuring/with clauses, and quotes for fallback searches."""
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", text or "")
    s = re.sub(r"\b(?:feat\.?|ft\.?|featuring)\b.*$", " ", s, flags=re.I)
    s = re.sub(r"\bw/.*$", " ", s, flags=re.I)
    s = re.sub(r'["“”]', " ", s)
    return re.sub(r"\s+", " ", s).strip()


def extract_primary_artist(artist: str) -> str:
    """Return the lead artist name when an archive artist credit lists multiple acts."""
    raw = re.sub(r"\s+", " ", str(artist or "")).strip()
    if not raw:
        return ""
    parts = re.split(r"\s+(?:&|and|/|with|feat\.?|ft\.?|w/)\s+", raw, maxsplit=1, flags=re.I)
    lead = parts[0].strip() if parts else ""
    return lead if lead and len(lead) < len(raw) else ""


def build_fallback_queries(song: dict[str, Any]) -> list[tuple[str, str, str | None]]:
    """Build ordered, deduplicated (label, query, filter) fallback searches for an unmatched track."""
    raw_artist = str(song.get("artist") or "").strip()
    raw_title = song_title_of(song)
    raw_query = re.sub(r"\s+", " ", f"{raw_artist} {raw_title}").strip().lower()
    strip_q = lambda v: re.sub(r"\s+", " ", re.sub(r'["“”]', " ", str(v or ""))).strip()
    clean_artist = strip_query_noise(raw_artist) or strip_q(raw_artist)
    unwrapped = strip_query_noise(re.sub(r"^\(([^)]+)\)", r"\1 ", raw_title)) if raw_title.lstrip().startswith("(") else ""
    clean_title = strip_query_noise(raw_title) or strip_q(raw_title)
    base_title = unwrapped or clean_title
    if not clean_artist or not base_title:
        return []

    queries: list[tuple[str, str, str | None]] = []
    seen: set[tuple[str, str | None]] = {(raw_query, None)}

    def add(label: str, query: str, search_filter: str | None) -> None:
        norm_q = re.sub(r"\s+", " ", str(query or "")).strip()
        key = (norm_q.lower(), search_filter)
        if norm_q and key not in seen:
            seen.add(key)
            queries.append((label, norm_q, search_filter))

    if unwrapped and unwrapped.lower() != raw_title.lower():
        add("unwrapped_unified", f"{clean_artist} {unwrapped}", None)
    elif clean_title.lower() != raw_title.lower() or clean_artist.lower() != raw_artist.lower():
        add("stripped_unified", f"{clean_artist} {clean_title}", None)

    add("songs_filter", f"{clean_artist} {base_title}", "songs")
    add("videos_filter", f'"{clean_artist}" {base_title}', "videos")

    lead_artist = extract_primary_artist(clean_artist)
    if lead_artist and lead_artist.lower() != clean_artist.lower():
        add("primary_artist", f"{lead_artist} {base_title}", None)
    else:
        clauses = [c.strip() for c in re.split(r"\s*[,;:/]\s*", base_title) if c.strip()]
        if len(clauses) >= 2:
            add("partial_title", f"{clean_artist} {clauses[-1]}", None)
        else:
            words = [w for w in re.sub(r"[,;:/]+", " ", base_title).split() if w]
            if len(words) >= 3:
                add("partial_title", f"{clean_artist} {' '.join(words[len(words) // 2:])}", None)

    return queries


def parse_duration_seconds(item: dict[str, Any]) -> int | None:
    """Extract duration in seconds from ytmusicapi result."""
    if isinstance(item.get("duration_seconds"), (int, float)):
        return int(item["duration_seconds"])
    dur = item.get("duration") or ""
    parts = [p for p in str(dur).split(":") if p.isdigit()]
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    return None


def song_title_of(song: dict[str, Any]) -> str:
    """Extract normalized or legacy song title from input catalog item."""
    return str(song.get("song_title") or song.get("songTitle") or "").strip()


def song_albums_of(song: dict[str, Any]) -> list[str]:
    """Extract non-'single' album names from input catalog item."""
    raw = song.get("albums") or ([song.get("album", "")] if song.get("album") else [])
    return [str(a) for a in raw if a and str(a).lower() != "single"]


def score_candidate(song: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """Score a single ytmusicapi candidate against an archive song."""
    arch_title = song_title_of(song)
    arch_artist = str(song.get("artist") or "").strip()
    arch_albums = song_albums_of(song)

    yt_title = item.get("title") or ""
    yt_artists = [a.get("name", "") for a in (item.get("artists") or []) if a.get("name")]
    yt_album = (item.get("album") or {}).get("name", "") if isinstance(item.get("album"), dict) else ""
    duration_sec = parse_duration_seconds(item)
    result_type = item.get("resultType", "unknown")

    norm_arch_title = normalize_text(arch_title)
    norm_yt_title = normalize_text(yt_title)
    norm_arch_artist = normalize_text(arch_artist)
    breakdown: dict[str, Any] = {}

    yt_title_no_artist = norm_yt_title
    if norm_arch_artist and norm_arch_artist in norm_yt_title:
        yt_title_no_artist = re.sub(rf"\b{re.escape(norm_arch_artist)}\b", " ", norm_yt_title)
        yt_title_no_artist = re.sub(r"^the\s+", "", re.sub(r"\s+", " ", yt_title_no_artist).strip())

    title_segments = [seg.strip() for seg in re.split(r"\s+[-–—|·]\s+", yt_title) if seg.strip()]
    title_candidates: list[str] = []
    for cand in (norm_yt_title, yt_title_no_artist):
        if cand and cand not in title_candidates:
            title_candidates.append(cand)
    for seg in title_segments:
        norm_seg = normalize_text(seg)
        if norm_seg and norm_seg != norm_arch_artist and norm_seg not in title_candidates:
            title_candidates.append(norm_seg)
    for quoted in re.findall(r'["“]([^"”]{2,})["”]', yt_title):
        norm_q = normalize_text(quoted)
        if norm_q and norm_q not in title_candidates:
            title_candidates.append(norm_q)

    title_sim = max(
        (
            max(fuzz.ratio(norm_arch_title, cand), fuzz.token_sort_ratio(norm_arch_title, cand))
            for cand in title_candidates
        ),
        default=0.0,
    )
    if norm_arch_title and norm_arch_title in title_candidates:
        title_pts = 35
    elif title_sim >= 90:
        title_pts = 30
    elif title_sim >= 80:
        title_pts = 24
    elif title_sim >= 70:
        title_pts = 16
    elif title_sim >= 60:
        title_pts = 8
    else:
        return {"score": 0, "rejected": f"title_mismatch ({title_sim:.0f}%)", "breakdown": {"title_sim": round(title_sim, 1)}}
    breakdown["title"] = title_pts

    best_artist_sim = 0.0
    artist_candidates = list(yt_artists)
    if len(yt_artists) > 1:
        artist_candidates.append(" & ".join(yt_artists))
    if title_segments:
        artist_candidates.append(title_segments[0])
        if len(title_segments) >= 2:
            seg0_norm = normalize_text(title_segments[0])
            seg0_sim = max(fuzz.ratio(norm_arch_title, seg0_norm), fuzz.token_sort_ratio(norm_arch_title, seg0_norm)) if (norm_arch_title and seg0_norm) else 0.0
            if norm_arch_title and seg0_norm and (seg0_norm == norm_arch_title or seg0_sim >= 80):
                artist_candidates.append(title_segments[1])

    arch_tokens = set(norm_arch_artist.split())
    for cand_a in artist_candidates:
        norm_cand = normalize_text(cand_a)
        if not norm_cand:
            continue
        if norm_cand == norm_arch_artist:
            best_artist_sim = 100.0
            break
        sim = max(fuzz.ratio(norm_arch_artist, norm_cand), fuzz.token_sort_ratio(norm_arch_artist, norm_cand))
        cand_tokens = set(norm_cand.split())
        if (arch_tokens and arch_tokens <= cand_tokens) or (len(cand_tokens) >= 2 and cand_tokens <= arch_tokens):
            sim = max(sim, fuzz.token_set_ratio(norm_arch_artist, norm_cand))
        if norm_arch_artist and re.search(rf"\b{re.escape(norm_arch_artist)}\b", norm_cand):
            sim = max(sim, 90.0)
        best_artist_sim = max(best_artist_sim, sim)

    if best_artist_sim < 65 and len(title_segments) <= 1 and norm_arch_artist and re.search(rf"\b{re.escape(norm_arch_artist)}\b", norm_yt_title):
        best_artist_sim = 85.0

    if best_artist_sim == 100.0:
        artist_pts = 35
    elif best_artist_sim >= 85:
        artist_pts = 25
    elif best_artist_sim >= 65:
        artist_pts = 15
    else:
        return {"score": 0, "rejected": f"artist_mismatch ({best_artist_sim:.0f}%)", "breakdown": {"title": title_pts, "artist_sim": round(best_artist_sim, 1)}}
    breakdown["artist"] = artist_pts

    joined_artists = " ".join(yt_artists).lower()
    if result_type == "song":
        auth_pts = 20
    elif " - topic" in joined_artists or "official" in joined_artists or "vevo" in joined_artists:
        auth_pts = 15
    else:
        auth_pts = 5
    breakdown["authority"] = auth_pts

    album_pts = 0
    if yt_album and arch_albums:
        norm_yt_album = normalize_text(yt_album)
        for aa in arch_albums:
            if fuzz.token_sort_ratio(normalize_text(aa), norm_yt_album) >= 85:
                album_pts = 10
                break
    breakdown["album"] = album_pts

    penalty = 0
    arch_context = f"{arch_title} {' '.join(arch_albums)}".lower()
    yt_title_lower = yt_title.lower()
    for kw in DISQUALIFIERS:
        if re.search(rf"\b{re.escape(kw)}\b", yt_title_lower) and kw not in arch_context:
            penalty -= 40
            breakdown["disqualifier"] = kw
            break
    for kw in VARIANT_KEYWORDS:
        if re.search(rf"\b{re.escape(kw)}\b", yt_title_lower) and kw not in arch_context:
            penalty -= 15
            breakdown["variant"] = kw
            break
    if duration_sec is not None and (duration_sec < 60 or duration_sec > 720):
        penalty -= 25
        breakdown["duration_penalty"] = f"{duration_sec}s"
    if penalty:
        breakdown["penalty"] = penalty

    total = max(0, min(100, title_pts + artist_pts + auth_pts + album_pts + penalty))
    return {"score": total, "rejected": None, "breakdown": breakdown, "duration_seconds": duration_sec}


def tier_for(score: int, video_id: str | None) -> str:
    """Map confidence score and video_id into canonical match_tier."""
    if not video_id or score <= 0:
        return "unmatched"
    if score >= 85:
        return "high"
    if score >= 65:
        return "medium"
    return "low"
