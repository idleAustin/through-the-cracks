#!/usr/bin/env python3
"""Album-first MusicBrainz discovery resolver with recording fallback."""
import sys

from song_meta_norm import (
    clean_writer_display,
    extract_year,
    pick_earliest_year,
    text_similarity,
    title_matches,
)
from song_meta_wiki import parse_studio_location

sys.dont_write_bytecode = True

WRITER_REL_TYPES = {"composer", "lyricist", "writer", "librettist", "author"}
PERSONNEL_REL_MAP = {
    "producer": "producer",
    "co-producer": "producer",
    "executive producer": "producer",
    "engineer": "engineer",
    "recording": "engineer",
    "mix": "mixing",
    "mixer": "mixing",
    "mastering": "mastering",
    "arranger": "arranger",
    "orchestrator": "arranger",
    "vocal": "vocals",
    "instrument": "instrument",
    "performing orchestra": "ensemble",
}
STUDIO_REL_TYPES = {"recorded at", "mixed at", "mastered at", "engineered at", "edited at"}


def _artist_credit_name(credits):
    parts = []
    for item in credits or []:
        if isinstance(item, dict):
            parts.append(item.get("name") or ((item.get("artist") or {}).get("name")) or "")
            parts.append(item.get("joinphrase") or "")
    return "".join(parts).strip()


def _extract_mb_rels(relations, target_personnel, target_studios):
    for rel in relations or []:
        rtype = str(rel.get("type") or "").lower().strip()
        target_type = rel.get("target-type")
        if target_type == "artist":
            artist_obj = rel.get("artist") or {}
            name = str(artist_obj.get("name") or "").strip()
            if not name:
                continue
            attrs = [str(a).strip() for a in (rel.get("attributes") or []) if a]
            if rtype in PERSONNEL_REL_MAP:
                role = PERSONNEL_REL_MAP[rtype]
                instrument = ", ".join(attrs) if attrs else None
                target_personnel.append({"name": name, "role": role, "instrument": instrument, "source": "mb"})
        elif target_type == "place" and rtype in STUDIO_REL_TYPES:
            place = rel.get("place") or {}
            pname = str(place.get("name") or "").strip()
            if not pname:
                continue
            area = ((place.get("area") or {}).get("name")) or None
            coords = place.get("coordinates")
            loc = parse_studio_location(pname, raw_area=area, coords=coords)
            loc["role"] = rtype
            loc["source"] = "mb"
            target_studios.append(loc)


def _extract_work_writers_and_cover(rec):
    writers = []
    work_ids = []
    is_cover = False
    for rel in rec.get("relations") or []:
        if rel.get("target-type") != "work":
            continue
        attrs = [str(a).lower() for a in (rel.get("attributes") or [])]
        if "cover" in attrs:
            is_cover = True
        work = rel.get("work") or {}
        if work.get("id"):
            work_ids.append(work["id"])
        for wrel in work.get("relations") or []:
            if wrel.get("target-type") == "artist" and str(wrel.get("type") or "").lower() in WRITER_REL_TYPES:
                wname = clean_writer_display((wrel.get("artist") or {}).get("name") or "")
                if wname and wname not in writers:
                    writers.append(wname)
    return writers, work_ids, is_cover


def _score_mb_release(cand, artist, album):
    cand_artist = _artist_credit_name(cand.get("artist-credit"))
    cand_title = str(cand.get("title") or "")
    a_sim = text_similarity(artist, cand_artist)
    t_sim = text_similarity(album, cand_title)
    if a_sim < 0.68 or t_sim < 0.72:
        return -1.0
    score = (a_sim * 0.40) + (t_sim * 0.45) + ((int(cand.get("score") or 0) / 100.0) * 0.15)
    if str(cand.get("status") or "").lower() == "official":
        score += 0.08
    if "live" in cand_title.lower() and "live" not in str(album or "").lower():
        score -= 0.12
    return score


def fetch_mb_album_bundle(mb_client, artist, album):
    """Search MusicBrainz release + fetch full tracklist, recording rels, work writers, and places."""
    if not album:
        return None
    res = mb_client.get_json(
        "https://musicbrainz.org/ws/2/release/",
        params={"query": f'artist:"{artist}" AND release:"{album}"', "fmt": "json", "limit": 10},
    )
    releases = (res or {}).get("releases") or []
    ranked = sorted(
        ((_score_mb_release(c, artist, album), extract_year(c.get("date")) or 9999, c) for c in releases),
        key=lambda row: (-row[0], row[1]),
    )
    if not ranked or ranked[0][0] < 0:
        return None

    best = ranked[0][2]
    rid = best.get("id")
    full = mb_client.get_json(
        f"https://musicbrainz.org/ws/2/release/{rid}",
        params={
            "inc": "recordings+artist-rels+place-rels+labels+recording-level-rels+work-rels+work-level-rels+url-rels",
            "fmt": "json",
        },
    )
    if not full:
        return None

    rg = best.get("release-group") or full.get("release-group") or {}
    album_year = pick_earliest_year(rg.get("first-release-date"), full.get("date"), best.get("date"))
    labels = [
        ((li.get("label") or {}).get("name") or "").strip()
        for li in (full.get("label-info") or [])
        if (li.get("label") or {}).get("name")
    ]

    rel_personnel = []
    rel_studios = []
    _extract_mb_rels(full.get("relations"), rel_personnel, rel_studios)

    tracks = []
    for medium in full.get("media") or []:
        for trk in medium.get("tracks") or []:
            rec = trk.get("recording") or {}
            tracks.append({"title": trk.get("title") or rec.get("title") or "", "recording": rec})

    return {
        "found": True,
        "release_id": rid,
        "release_title": full.get("title"),
        "album_year": album_year,
        "country": full.get("country"),
        "label": labels[0] if labels else None,
        "release_personnel": rel_personnel,
        "release_studios": rel_studios,
        "tracks": tracks,
    }


def _enrich_work_writers(mb_client, work_ids, existing_writers):
    writers = list(existing_writers)
    for wid in work_ids[:1]:
        work = mb_client.get_json(
            f"https://musicbrainz.org/ws/2/work/{wid}",
            params={"inc": "artist-rels", "fmt": "json"},
        )
        for rel in (work or {}).get("relations") or []:
            if rel.get("target-type") == "artist" and str(rel.get("type") or "").lower() in WRITER_REL_TYPES:
                wname = clean_writer_display((rel.get("artist") or {}).get("name") or "")
                if wname and wname not in writers:
                    writers.append(wname)
    return writers


def extract_mb_song_from_album(mb_client, bundle, song_title, fetch_work_if_empty=True):
    """Extract per-track credits, writers, studios, and release year from a cached MB Album bundle."""
    if not bundle or not bundle.get("found"):
        return None
    matched = None
    best_sim = 0.0
    for item in bundle.get("tracks") or []:
        sim = text_similarity(song_title, item["title"])
        if title_matches(song_title, item["title"], 0.78) and sim >= best_sim:
            best_sim = sim
            matched = item["recording"]
    if not matched:
        return None

    writers, work_ids, is_cover = _extract_work_writers_and_cover(matched)
    if fetch_work_if_empty and not writers and work_ids:
        writers = _enrich_work_writers(mb_client, work_ids, writers)

    personnel = list(bundle.get("release_personnel") or [])
    studios = list(bundle.get("release_studios") or [])
    _extract_mb_rels(matched.get("relations"), personnel, studios)

    rec_year = pick_earliest_year(matched.get("first-release-date"), bundle.get("album_year"))
    return {
        "found": True,
        "recording_id": matched.get("id"),
        "release_id": bundle.get("release_id"),
        "release_year": rec_year,
        "album_year": bundle.get("album_year"),
        "is_cover": is_cover,
        "writers": writers,
        "personnel": personnel,
        "studios": studios,
        "label": bundle.get("label"),
    }


def fetch_mb_track_fallback(mb_client, artist, song_title):
    """Direct MusicBrainz recording query fallback when Album lookup missed or track is a single."""
    res = mb_client.get_json(
        "https://musicbrainz.org/ws/2/recording/",
        params={"query": f'artist:"{artist}" AND recording:"{song_title}"', "fmt": "json", "limit": 6},
    )
    best = None
    best_score = -1.0
    for cand in (res or {}).get("recordings") or []:
        ca = _artist_credit_name(cand.get("artist-credit"))
        ct = cand.get("title") or ""
        a_sim = text_similarity(artist, ca)
        t_sim = text_similarity(song_title, ct)
        if a_sim < 0.72 or t_sim < 0.76:
            continue
        score = a_sim * 0.45 + t_sim * 0.45 + (int(cand.get("score") or 0) / 1000.0)
        if score > best_score:
            best_score = score
            best = cand
    if not best or not best.get("id"):
        return None

    rec = mb_client.get_json(
        f"https://musicbrainz.org/ws/2/recording/{best['id']}",
        params={"inc": "artist-rels+place-rels+work-rels+work-level-rels+releases+release-groups", "fmt": "json"},
    )
    if not rec:
        return None
    writers, work_ids, is_cover = _extract_work_writers_and_cover(rec)
    if not writers and work_ids:
        writers = _enrich_work_writers(mb_client, work_ids, writers)
    personnel = []
    studios = []
    _extract_mb_rels(rec.get("relations"), personnel, studios)
    rel_years = [extract_year(r.get("date")) for r in rec.get("releases") or []]
    rel_year = pick_earliest_year(rec.get("first-release-date"), *rel_years)
    return {
        "found": True,
        "recording_id": rec.get("id"),
        "release_id": None,
        "release_year": rel_year,
        "album_year": rel_year,
        "is_cover": is_cover,
        "writers": writers,
        "personnel": personnel,
        "studios": studios,
        "label": None,
    }

