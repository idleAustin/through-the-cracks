#!/usr/bin/env python3
"""SecondHandSongs Artist-first and performance/work metadata resolver."""
import re
import sys

from song_meta_norm import clean_writer_display, extract_year, pick_earliest_year, text_similarity, title_matches

sys.dont_write_bytecode = True


def to_shs_api_uri(uri):
    """Normalize a SecondHandSongs web or relative URI to https://api.secondhandsongs.com/..."""
    raw = str(uri or "").strip()
    if not raw:
        return ""
    if raw.startswith("https://api.secondhandsongs.com"):
        return raw
    if raw.startswith("https://secondhandsongs.com"):
        return "https://api.secondhandsongs.com" + raw[len("https://secondhandsongs.com") :]
    if raw.startswith("/"):
        return "https://api.secondhandsongs.com" + raw
    return raw


def to_shs_web_url(uri):
    """Normalize a SecondHandSongs API URI to canonical web URL."""
    raw = str(uri or "").strip()
    if not raw:
        return ""
    if raw.startswith("https://api.secondhandsongs.com"):
        return "https://secondhandsongs.com" + raw[len("https://api.secondhandsongs.com") :]
    return raw


def _artist_search_variants(artist_name):
    variants = [str(artist_name or "").strip()]
    no_the = re.sub(r"^the\s+", "", variants[0], flags=re.IGNORECASE).strip()
    if no_the and no_the not in variants:
        variants.append(no_the)
    return [v for v in variants if v]


def fetch_shs_artist_bundle(shs_client, artist_name):
    """Fetch SecondHandSongs Artist URI and full performance index in 2 HTTP calls."""
    best_artist = None
    best_sim = 0.0

    for variant in _artist_search_variants(artist_name):
        res = shs_client.get_json(
            "https://api.secondhandsongs.com/search/artist",
            params={"commonName": variant},
        )
        candidates = (res or {}).get("resultPage") if isinstance(res, dict) else res
        for cand in candidates or []:
            cname = cand.get("commonName") or cand.get("name") or ""
            sim = text_similarity(artist_name, cname)
            if sim >= 0.84 and sim > best_sim:
                best_sim = sim
                best_artist = cand
        if best_artist and best_sim >= 0.94:
            break

    if not best_artist or not best_artist.get("uri"):
        return None

    api_artist_uri = to_shs_api_uri(best_artist["uri"]).rstrip("/")
    perfs = shs_client.get_json(f"{api_artist_uri}/performances")
    if isinstance(perfs, dict) and "resultPage" in perfs:
        perf_list = perfs.get("resultPage") or []
    elif isinstance(perfs, list):
        perf_list = perfs
    else:
        perf_list = []

    return {
        "artist": artist_name,
        "shs_artist_uri": to_shs_web_url(best_artist["uri"]),
        "performances": perf_list,
    }


def _match_perf_stub(performances, song_title):
    best = None
    best_score = -1.0
    for stub in performances or []:
        title = stub.get("title") or ""
        sim = text_similarity(song_title, title)
        if not title_matches(song_title, title, 0.80):
            continue
        score = sim + (0.04 if stub.get("isOriginal") else 0.0)
        if score > best_score:
            best_score = score
            best = stub
    return best


def _extract_work_origin(shs_client, work_uri):
    work_doc = shs_client.get_json(to_shs_api_uri(work_uri))
    if not work_doc:
        return {}
    writers = []
    for c in work_doc.get("credits") or []:
        artist = c.get("artist") or {}
        name = clean_writer_display(artist.get("commonName") or artist.get("name") or c.get("creditedAs") or "")
        if name and name not in writers:
            writers.append(name)

    originals = work_doc.get("originals") or []
    first_orig = originals[0] if originals else {}
    orig_perf = first_orig.get("performance") or first_orig
    orig_artist = ((orig_perf.get("performer") or {}).get("name")) or orig_perf.get("performerName")
    orig_title = orig_perf.get("title") or work_doc.get("title")
    orig_year = pick_earliest_year(orig_perf.get("date"), work_doc.get("writtenDate"))
    versions = work_doc.get("versions") or []
    cover_count = len(versions) if isinstance(versions, list) and versions else work_doc.get("versionCount")

    return {
        "shs_work_uri": to_shs_web_url(work_uri),
        "writers": writers,
        "original_artist": orig_artist,
        "original_title": orig_title,
        "original_year": orig_year,
        "cover_count": int(cover_count) if isinstance(cover_count, int) else None,
    }


def fetch_shs_song(shs_client, artist_name, song_title, artist_bundle=None):
    """Resolve SecondHandSongs performance + originating Work, cover lineage, and external links."""
    stub = None
    if artist_bundle and artist_bundle.get("performances"):
        stub = _match_perf_stub(artist_bundle["performances"], song_title)

    if not stub:
        res = shs_client.get_json(
            "https://api.secondhandsongs.com/search/performance",
            params={"title": song_title, "performer": artist_name},
        )
        candidates = (res or {}).get("resultPage") if isinstance(res, dict) else res
        for cand in candidates or []:
            perf_name = ((cand.get("performer") or {}).get("name")) or ""
            if text_similarity(artist_name, perf_name) >= 0.78 and title_matches(song_title, cand.get("title") or "", 0.80):
                stub = cand
                break

    if not stub or not stub.get("uri"):
        return None

    perf_doc = shs_client.get_json(to_shs_api_uri(stub["uri"]))
    if not perf_doc:
        return None

    is_original = bool(perf_doc.get("isOriginal"))
    perf_year = extract_year(perf_doc.get("date"))
    works = perf_doc.get("works") or []
    work_info = {}
    if works and isinstance(works[0], dict) and works[0].get("uri"):
        work_info = _extract_work_origin(shs_client, works[0]["uri"])

    ext_recs = []
    for ext in perf_doc.get("externalRecordings") or []:
        if ext.get("uri") or ext.get("url"):
            ext_recs.append({"site": ext.get("site") or ext.get("type"), "url": ext.get("uri") or ext.get("url")})

    is_cover = not is_original
    if work_info.get("original_artist") and text_similarity(artist_name, work_info["original_artist"]) >= 0.85:
        is_cover = False

    return {
        "found": True,
        "shs_perf_uri": to_shs_web_url(stub["uri"]),
        "is_original": is_original,
        "is_cover": is_cover,
        "perf_year": perf_year,
        "external_recordings": ext_recs,
        **work_info,
    }

