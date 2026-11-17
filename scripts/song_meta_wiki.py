#!/usr/bin/env python3
"""MusicBrainz artist lookup, Wikidata/Wikipedia bio enrichment, and studio place resolution."""
import re
import sys
import urllib.parse

from song_meta_norm import extract_year, normalize_text, text_similarity

sys.dont_write_bytecode = True

US_STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "District of Columbia",
}

US_STATE_ABBREV = {v.lower(): k for k, v in US_STATE_NAMES.items()}
KNOWN_UK_CITIES = {"london", "manchester", "liverpool", "birmingham", "bristol", "glasgow", "edinburgh", "belfast"}
KNOWN_CA_CITIES = {"toronto", "montreal", "vancouver", "winnipeg", "calgary", "ottawa"}


def _compact_extract(text, max_chars=420):
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(clean) <= max_chars:
        return clean
    clipped = clean[:max_chars]
    last_dot = clipped.rfind(". ")
    if last_dot >= max_chars // 2:
        return clipped[: last_dot + 1]
    return clipped.rstrip(" ,;") + "..."


def _qid_from_url(url):
    m = re.search(r"wikidata\.org/(?:wiki|entity)/(Q\d+)", str(url or ""))
    return m.group(1) if m else None


def _wiki_title_from_url(url):
    m = re.search(r"en\.wikipedia\.org/wiki/([^?#]+)", str(url or ""))
    return urllib.parse.unquote(m.group(1)).replace("_", " ") if m else None


def _wikidata_claim_year(claims, prop):
    years = []
    for st in claims.get(prop) or []:
        dv = ((st.get("mainsnak") or {}).get("datavalue") or {})
        val = dv.get("value")
        time_str = val.get("time") if isinstance(val, dict) else val
        yr = extract_year(time_str)
        if yr is not None:
            years.append(yr)
    return min(years) if years else None


def _wikidata_claim_qids(claims, prop):
    qids = []
    for st in claims.get(prop) or []:
        dv = ((st.get("mainsnak") or {}).get("datavalue") or {})
        val = dv.get("value")
        if isinstance(val, dict) and isinstance(val.get("id"), str):
            qids.append(val["id"])
    return qids


def _resolve_qid_labels(wiki_client, qids):
    unique = [q for q in dict.fromkeys(qids) if q]
    if not unique:
        return {}
    data = wiki_client.get_json(
        "https://www.wikidata.org/w/api.php",
        params={"action": "wbgetentities", "ids": "|".join(unique[:10]), "props": "labels", "languages": "en", "format": "json"},
    )
    entities = (data or {}).get("entities") or {}
    out = {}
    for qid, ent in entities.items():
        lbl = ((ent.get("labels") or {}).get("en") or {}).get("value")
        if lbl:
            out[qid] = lbl
    return out


def fetch_artist_profile(mb_client, wiki_client, artist_name):
    """Resolve artist MBID, origin, active/birth year, Wikidata properties, and Wikipedia bio."""
    profile = {
        "artist": artist_name,
        "mbid": None,
        "origin_city": None,
        "origin_state": None,
        "origin_country": None,
        "start_year": None,
        "wiki_summary": None,
        "wiki_url": None,
        "wikidata_id": None,
    }

    mb_search = mb_client.get_json(
        "https://musicbrainz.org/ws/2/artist/",
        params={"query": f'artist:"{artist_name}"', "fmt": "json", "limit": 5},
    )
    best_artist = None
    best_score = 0.0
    for cand in (mb_search or {}).get("artists") or []:
        sim = text_similarity(artist_name, cand.get("name") or "")
        mb_score = int(cand.get("score") or 0) / 100.0
        combined = sim * 0.7 + mb_score * 0.3
        if sim >= 0.78 and combined > best_score:
            best_score = combined
            best_artist = cand

    wiki_title = None
    qid = None

    if best_artist:
        profile["mbid"] = best_artist.get("id")
        ls = best_artist.get("life-span") or {}
        profile["start_year"] = extract_year(ls.get("begin"))
        begin_area = (best_artist.get("begin-area") or {}).get("name")
        area = (best_artist.get("area") or {}).get("name")
        if begin_area and begin_area != area:
            profile["origin_city"] = begin_area
        if area:
            if area in US_STATE_NAMES.values():
                profile["origin_state"] = US_STATE_ABBREV.get(area.lower(), area)
                profile["origin_country"] = "United States"
            else:
                profile["origin_country"] = area

        full_artist = mb_client.get_json(
            f"https://musicbrainz.org/ws/2/artist/{profile['mbid']}",
            params={"inc": "url-rels", "fmt": "json"},
        )
        for rel in (full_artist or {}).get("relations") or []:
            res = ((rel.get("url") or {}).get("resource")) or ""
            if not qid:
                qid = _qid_from_url(res)
            if not wiki_title:
                wiki_title = _wiki_title_from_url(res)

    if qid:
        profile["wikidata_id"] = qid
        wd = wiki_client.get_json(
            f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json",
            allow_not_found=True,
        )
        entity = ((wd or {}).get("entities") or {}).get(qid) or {}
        claims = entity.get("claims") or {}
        wd_start = _wikidata_claim_year(claims, "P571") or _wikidata_claim_year(claims, "P2031")
        if wd_start and (not profile["start_year"] or wd_start < profile["start_year"]):
            profile["start_year"] = wd_start
        origin_qids = _wikidata_claim_qids(claims, "P740") or _wikidata_claim_qids(claims, "P19")
        country_qids = _wikidata_claim_qids(claims, "P495") or _wikidata_claim_qids(claims, "P27")
        labels = _resolve_qid_labels(wiki_client, origin_qids[:1] + country_qids[:1])
        if origin_qids and labels.get(origin_qids[0]) and not profile["origin_city"]:
            profile["origin_city"] = labels[origin_qids[0]]
        if country_qids and labels.get(country_qids[0]) and not profile["origin_country"]:
            profile["origin_country"] = labels[country_qids[0]]
        if not wiki_title:
            enwiki = (entity.get("sitelinks") or {}).get("enwiki") or {}
            wiki_title = enwiki.get("title")

    if not wiki_title:
        search = wiki_client.get_json(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "opensearch", "search": f"{artist_name} musician", "limit": 3, "format": "json"},
        )
        if isinstance(search, list) and len(search) >= 2 and search[1]:
            first = str(search[1][0])
            if text_similarity(artist_name, re.sub(r"\s*\([^)]*\)$", "", first)) >= 0.72:
                wiki_title = first

    if wiki_title:
        slug = urllib.parse.quote(wiki_title.replace(" ", "_"), safe="")
        summary = wiki_client.get_json(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{slug}",
            allow_not_found=True,
        )
        if summary and summary.get("type") != "disambiguation":
            extract = summary.get("extract") or ""
            if extract:
                profile["wiki_summary"] = _compact_extract(extract)
                profile["wiki_url"] = (
                    ((summary.get("content_urls") or {}).get("desktop") or {}).get("page")
                    or f"https://en.wikipedia.org/wiki/{slug}"
                )

    return profile


def parse_studio_location(studio_name, raw_area=None, coords=None):
    """Parse studio name/area into structured city/state/country without mis-attributing UK/CA cities."""
    text = str(studio_name or "").strip()
    area = str(raw_area or "").strip()
    city = None
    state = None
    country = None

    if area:
        parts = [p.strip() for p in area.split(",") if p.strip()]
        if parts:
            city = parts[0]
        if len(parts) >= 2 and parts[-1] != city:
            last = parts[-1]
            if last in US_STATE_NAMES.values():
                state = US_STATE_ABBREV.get(last.lower(), last)
                country = "United States"
            elif last.upper() in US_STATE_NAMES:
                state = last.upper()
                country = "United States"
            else:
                country = last

    if not city:
        m = re.search(r",\s*([A-Za-z .'-]+?)(?:,\s*([A-Z]{2}))?(?:,\s*([A-Za-z .]+))?$", text)
        if m:
            city = m.group(1).strip()
            if m.group(2) and m.group(2).upper() in US_STATE_NAMES:
                state = m.group(2).upper()
                country = "United States"
            elif m.group(3):
                country = m.group(3).strip()

    city_lower = normalize_text(city or "")
    if city_lower in KNOWN_UK_CITIES and not state:
        country = "United Kingdom"
    elif city_lower in KNOWN_CA_CITIES and not state:
        country = "Canada"

    lat = None
    lon = None
    if isinstance(coords, dict):
        try:
            lat = float(coords["latitude"]) if coords.get("latitude") is not None else None
            lon = float(coords["longitude"]) if coords.get("longitude") is not None else None
        except (TypeError, ValueError):
            lat, lon = None, None

    return {"name": text, "city": city, "state": state, "country": country, "lat": lat, "lon": lon}

