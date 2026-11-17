#!/usr/bin/env python3
"""Pure reconciliation rules merging raw MusicBrainz, Discogs, Wiki, and SHS evidence."""
import sys

from song_meta_norm import (
    clean_writer_display,
    extract_year,
    normalize_text,
    pick_earliest_year,
    strip_discogs_num,
    text_similarity,
)

sys.dont_write_bytecode = True

IGNORED_CREDIT_ROLES = {
    "artwork",
    "cover",
    "cover design",
    "design",
    "layout",
    "photography",
    "photo",
    "management",
    "legal",
    "Booking",
    "liner notes",
    "typography",
}

STUDIO_HINTS = {
    "sun studio": ("Memphis", "TN", "United States"),
    "fame recording": ("Muscle Shoals", "AL", "United States"),
    "fame studio": ("Muscle Shoals", "AL", "United States"),
    "muscle shoals sound": ("Sheffield", "AL", "United States"),
    "sound emporium": ("Nashville", "TN", "United States"),
    "rca studio b": ("Nashville", "TN", "United States"),
    "abbey road": ("London", None, "United Kingdom"),
    "capitol studios": ("Los Angeles", "CA", "United States"),
    "ardeNt": ("Memphis", "TN", "United States"),
    "ardent studio": ("Memphis", "TN", "United States"),
    "pedernales": ("Spicewood", "TX", "United States"),
    "cedar creek": ("Austin", "TX", "United States"),
}


def _apply_studio_hints(studio):
    st = dict(studio)
    nl = normalize_text(st.get("name") or "")
    for hint, (city, state, country) in STUDIO_HINTS.items():
        if hint in nl:
            st["city"] = st.get("city") or city
            st["state"] = st.get("state") or state
            st["country"] = st.get("country") or country
            break
    return st


def _merge_writers(mb_raw, dc_raw, shs_raw):
    writers = []
    writer_sources = {}
    pairs = [
        ("shs", (shs_raw or {}).get("writers") or []),
        ("mb", (mb_raw or {}).get("writers") or []),
        ("discogs", (dc_raw or {}).get("writers") or []),
    ]
    from song_meta_norm import merge_writer

    for src, candidates in pairs:
        for cand in candidates:
            merge_writer(writers, writer_sources, cand, src)

    rows = []
    for w in writers:
        clean = clean_writer_display(w)
        if not clean:
            continue
        srcs = sorted(writer_sources.get(w, set()))
        rows.append({"writer_name": clean, "role": "writer", "source": ",".join(srcs) or "unknown"})
    return rows


def _merge_personnel(mb_raw, dc_raw):
    dedup = {}
    for src_data in (mb_raw, dc_raw):
        for item in (src_data or {}).get("personnel") or []:
            name = strip_discogs_num(item.get("name") or "")
            if not name:
                continue
            role = str(item.get("role") or "credit").strip().lower()
            if role in IGNORED_CREDIT_ROLES:
                continue
            instrument = item.get("instrument")
            key = (normalize_text(name), role)
            if key not in dedup:
                dedup[key] = {
                    "person_name": name,
                    "role": role,
                    "instrument": instrument,
                    "source": item.get("source") or "unknown",
                }
            else:
                if not dedup[key]["instrument"] and instrument:
                    dedup[key]["instrument"] = instrument
                if item.get("source") and item["source"] not in dedup[key]["source"]:
                    dedup[key]["source"] = f"{dedup[key]['source']},{item['source']}"
    return list(dedup.values())


def _merge_studios(mb_raw, dc_raw):
    dedup = {}
    for src_data in (mb_raw, dc_raw):
        for raw_st in (src_data or {}).get("studios") or []:
            st = _apply_studio_hints(raw_st)
            name = strip_discogs_num(st.get("name") or "")
            if not name:
                continue
            role = str(st.get("role") or "recorded at").lower()
            key = (normalize_text(name), role)
            existing = dedup.get(key)
            if not existing:
                dedup[key] = {
                    "studio_name": name,
                    "role": role,
                    "city": st.get("city"),
                    "state": st.get("state"),
                    "country": st.get("country"),
                    "lat": st.get("lat"),
                    "lon": st.get("lon"),
                    "source": st.get("source") or "unknown",
                }
            else:
                for field in ("city", "state", "country", "lat", "lon"):
                    if not existing.get(field) and st.get(field):
                        existing[field] = st[field]
    return list(dedup.values())


def _format_studio_place(studio):
    parts = [studio["studio_name"]]
    loc_bits = [x for x in (studio.get("city"), studio.get("state") or studio.get("country")) if x]
    if loc_bits:
        return f"{parts[0]} ({', '.join(loc_bits)})"
    return parts[0]


def reconcile_song(song, raw_record, artist_profile=None):
    """Merge multi-source evidence into normalized Song, Writer, Personnel, Studio, and Fact rows."""
    mb_raw = (raw_record or {}).get("mb") or {}
    dc_raw = (raw_record or {}).get("discogs") or {}
    shs_raw = (raw_record or {}).get("shs") or {}
    wiki_raw = artist_profile or (raw_record or {}).get("artist_profile") or {}

    release_year = pick_earliest_year(
        mb_raw.get("release_year"),
        dc_raw.get("release_year"),
        shs_raw.get("perf_year"),
    )
    album_year = pick_earliest_year(mb_raw.get("album_year"), dc_raw.get("album_year"), release_year)
    original_year = extract_year(shs_raw.get("original_year"))
    if original_year and release_year and original_year > release_year:
        original_year = release_year

    is_cover = 1 if (shs_raw.get("is_cover") or mb_raw.get("is_cover")) else 0
    orig_artist = shs_raw.get("original_artist")
    orig_title = shs_raw.get("original_title")

    writers = _merge_writers(mb_raw, dc_raw, shs_raw)
    personnel = _merge_personnel(mb_raw, dc_raw)
    studios = _merge_studios(mb_raw, dc_raw)
    label = mb_raw.get("label") or dc_raw.get("label")

    facts = []
    if is_cover and orig_artist:
        yr_note = f" in {original_year}" if original_year else ""
        facts.append({
            "fact_type": "cover_origin",
            "fact_text": f"Originally recorded by {orig_artist}{yr_note}.",
            "source": "shs",
            "confidence": "high",
        })
    elif writers:
        writer_str = ", ".join(w["writer_name"] for w in writers[:4])
        if len(writers) > 4:
            writer_str += f" (+{len(writers) - 4})"
        facts.append({
            "fact_type": "songwriters",
            "fact_text": f"Written by {writer_str}.",
            "source": writers[0]["source"],
            "confidence": "high",
        })

    producers = [p["person_name"] for p in personnel if p["role"] == "producer"]
    if producers:
        facts.append({
            "fact_type": "production",
            "fact_text": f"Produced by {', '.join(dict.fromkeys(producers[:3]))}.",
            "source": "mb/discogs",
            "confidence": "high",
        })

    recorded_studios = [s for s in studios if "record" in s["role"]] or studios
    if recorded_studios:
        facts.append({
            "fact_type": "recording_location",
            "fact_text": f"Recorded at {_format_studio_place(recorded_studios[0])}.",
            "source": recorded_studios[0]["source"],
            "confidence": "high",
        })

    sources_used = []
    if mb_raw.get("found"):
        sources_used.append("mb")
    if dc_raw.get("found"):
        sources_used.append("discogs")
    if shs_raw.get("found"):
        sources_used.append("shs")
    if wiki_raw.get("wiki_summary"):
        sources_used.append("wiki")

    return {
        "song_meta": {
            "song_key": song["song_key"],
            "artist": song["artist"],
            "artist_key": song["artist_key"],
            "song_title": song["song_title"],
            "album": song.get("album") or "",
            "album_key": song.get("album_key") or "",
            "total_plays": int(song.get("totalPlays") or 0),
            "pass_tier": song.get("pass_tier") or "single",
            "release_year": release_year,
            "album_year": album_year,
            "original_year": original_year,
            "is_cover": is_cover,
            "original_artist": orig_artist if is_cover or (orig_artist and text_similarity(orig_artist, song["artist"]) < 0.85) else None,
            "original_title": orig_title,
            "shs_cover_count": shs_raw.get("cover_count"),
            "primary_studio": recorded_studios[0]["studio_name"] if recorded_studios else None,
            "label": label,
            "genres": dc_raw.get("genres") or [],
            "styles": dc_raw.get("styles") or [],
            "sources_used": sources_used,
        },
        "writers": writers,
        "personnel": personnel,
        "studios": studios,
        "facts": facts,
        "artist_meta": {
            "artist_key": song["artist_key"],
            "artist_name": song["artist"],
            "total_plays": int(song.get("artistTotalPlays") or 0),
            "origin_city": wiki_raw.get("origin_city"),
            "origin_state": wiki_raw.get("origin_state"),
            "origin_country": wiki_raw.get("origin_country"),
            "start_year": extract_year(wiki_raw.get("start_year")),
            "wiki_summary": wiki_raw.get("wiki_summary"),
            "wiki_url": wiki_raw.get("wiki_url"),
            "mbid": wiki_raw.get("mbid"),
            "shs_uri": (raw_record or {}).get("shs_artist_uri"),
        },
    }

