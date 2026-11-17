#!/usr/bin/env python3
"""Album-first Discogs discovery resolver with track fallback."""
import sys

from song_meta_norm import (
    clean_writer_display,
    extract_year,
    pick_earliest_year,
    strip_discogs_num,
    text_similarity,
    title_matches,
    track_applies,
)
from song_meta_wiki import parse_studio_location

sys.dont_write_bytecode = True

DISCOGS_WRITER_KEYWORDS = ("written", "composed", "lyrics", "words", "songwriter", "music by")
DISCOGS_STUDIO_ROLES = {"recorded at", "mixed at", "mastered at", "engineered at"}


def _split_dc_role(role_text):
    return [r.strip() for r in str(role_text or "").split(",") if r.strip()]


def _ingest_dc_credits(extraartists, writers, personnel, track_pos=None, song_title="", check_track_spec=False):
    for ex in extraartists or []:
        if check_track_spec and not track_applies(ex.get("tracks"), track_pos, song_title):
            continue
        name = strip_discogs_num(ex.get("name") or "")
        if not name:
            continue
        role_raw = str(ex.get("role") or "credit").strip()
        for role_part in _split_dc_role(role_raw):
            rl = role_part.lower()
            if any(kw in rl for kw in DISCOGS_WRITER_KEYWORDS):
                w = clean_writer_display(name)
                if w and w not in writers:
                    writers.append(w)
            else:
                personnel.append({"name": name, "role": role_part, "instrument": None, "source": "discogs"})


def _parse_dc_release_doc(rel_doc, master_year=None):
    companies = []
    for comp in rel_doc.get("companies") or []:
        ent_role = str(comp.get("entity_type_name") or "").strip().lower()
        cname = strip_discogs_num(comp.get("name") or "")
        if cname and ent_role in DISCOGS_STUDIO_ROLES:
            loc = parse_studio_location(cname)
            loc["role"] = ent_role
            loc["source"] = "discogs"
            companies.append(loc)
    labels = [strip_discogs_num(lb.get("name") or "") for lb in (rel_doc.get("labels") or []) if lb.get("name")]
    return {
        "found": True,
        "release_id": rel_doc.get("id"),
        "master_id": rel_doc.get("master_id"),
        "album_year": pick_earliest_year(master_year, rel_doc.get("year")),
        "genres": [str(g) for g in (rel_doc.get("genres") or []) if g],
        "styles": [str(s) for s in (rel_doc.get("styles") or []) if s],
        "label": labels[0] if labels else None,
        "companies": companies,
        "extraartists": rel_doc.get("extraartists") or [],
        "tracklist": rel_doc.get("tracklist") or [],
    }


def fetch_dc_album_bundle(dc_client, artist, album):
    """Search Discogs release + master to build reusable Album credits, tracklist, and companies."""
    if not album:
        return None
    res = dc_client.get_json(
        "https://api.discogs.com/database/search",
        params={"artist": artist, "release_title": album, "per_page": 8},
    )
    results = (res or {}).get("results") or []
    best = None
    best_score = -1.0
    for cand in results:
        title = str(cand.get("title") or "")
        parts = title.split(" - ", 1)
        ca = parts[0] if len(parts) == 2 else ""
        ct = parts[1] if len(parts) == 2 else title
        a_sim = text_similarity(artist, ca) if ca else 0.75
        t_sim = text_similarity(album, ct)
        if a_sim < 0.65 or t_sim < 0.70:
            continue
        score = a_sim * 0.4 + t_sim * 0.5 + (0.05 if cand.get("type") == "release" else 0.0)
        if score > best_score:
            best_score = score
            best = cand
    if not best:
        return None

    master_year = extract_year(best.get("year"))
    rel_id = best.get("id")
    if best.get("type") == "master":
        master_doc = dc_client.get_json(f"https://api.discogs.com/masters/{rel_id}")
        if master_doc:
            master_year = pick_earliest_year(master_year, master_doc.get("year"))
            rel_id = master_doc.get("main_release") or master_doc.get("most_recent_release")
    elif best.get("master_id"):
        master_doc = dc_client.get_json(f"https://api.discogs.com/masters/{best['master_id']}")
        if master_doc:
            master_year = pick_earliest_year(master_year, master_doc.get("year"))

    if not rel_id:
        return None
    rel_doc = dc_client.get_json(f"https://api.discogs.com/releases/{rel_id}")
    if not rel_doc:
        return None
    return _parse_dc_release_doc(rel_doc, master_year=master_year)


def extract_dc_song_from_album(bundle, song_title):
    """Extract track writers, track-scoped extraartists, studios, and genres from Discogs bundle."""
    if not bundle or not bundle.get("found"):
        return None
    matched = None
    best_sim = 0.0
    for trk in bundle.get("tracklist") or []:
        t_title = trk.get("title") or ""
        sim = text_similarity(song_title, t_title)
        if title_matches(song_title, t_title, 0.78) and sim >= best_sim:
            best_sim = sim
            matched = trk
    if not matched:
        return None

    writers = []
    personnel = []
    pos = matched.get("position") or ""
    _ingest_dc_credits(matched.get("extraartists"), writers, personnel)
    _ingest_dc_credits(
        bundle.get("extraartists"),
        writers,
        personnel,
        track_pos=pos,
        song_title=song_title,
        check_track_spec=True,
    )
    return {
        "found": True,
        "release_id": bundle.get("release_id"),
        "release_year": bundle.get("album_year"),
        "album_year": bundle.get("album_year"),
        "writers": writers,
        "personnel": personnel,
        "studios": list(bundle.get("companies") or []),
        "genres": bundle.get("genres") or [],
        "styles": bundle.get("styles") or [],
        "label": bundle.get("label"),
    }


def fetch_dc_track_fallback(dc_client, artist, song_title):
    """Direct Discogs track query fallback when Album search missed or song is a single."""
    res = dc_client.get_json(
        "https://api.discogs.com/database/search",
        params={"artist": artist, "track": song_title, "type": "release", "per_page": 5},
    )
    for cand in (res or {}).get("results") or []:
        title = str(cand.get("title") or "")
        ca = title.split(" - ", 1)[0] if " - " in title else ""
        if ca and text_similarity(artist, ca) < 0.70:
            continue
        rel_doc = dc_client.get_json(f"https://api.discogs.com/releases/{cand.get('id')}")
        if not rel_doc:
            continue
        bundle = _parse_dc_release_doc(rel_doc, master_year=extract_year(cand.get("year")))
        extracted = extract_dc_song_from_album(bundle, song_title)
        if extracted:
            return extracted
    return None

