#!/usr/bin/env python3
"""Albers USA TopoJSON decoder and US state / international geographic resolver."""
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

US_ATLAS_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-albers-10m.json"

FIPS_TO_STATE = {
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"), "04": ("AZ", "Arizona"), "05": ("AR", "Arkansas"),
    "06": ("CA", "California"), "08": ("CO", "Colorado"), "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"),
    "11": ("DC", "District of Columbia"), "12": ("FL", "Florida"), "13": ("GA", "Georgia"), "15": ("HI", "Hawaii"),
    "16": ("ID", "Idaho"), "17": ("IL", "Illinois"), "18": ("IN", "Indiana"), "19": ("IA", "Iowa"),
    "20": ("KS", "Kansas"), "21": ("KY", "Kentucky"), "22": ("LA", "Louisiana"), "23": ("ME", "Maine"),
    "24": ("MD", "Maryland"), "25": ("MA", "Massachusetts"), "26": ("MI", "Michigan"), "27": ("MN", "Minnesota"),
    "28": ("MS", "Mississippi"), "29": ("MO", "Missouri"), "30": ("MT", "Montana"), "31": ("NE", "Nebraska"),
    "32": ("NV", "Nevada"), "33": ("NH", "New Hampshire"), "34": ("NJ", "New Jersey"), "35": ("NM", "New Mexico"),
    "36": ("NY", "New York"), "37": ("NC", "North Carolina"), "38": ("ND", "North Dakota"), "39": ("OH", "Ohio"),
    "40": ("OK", "Oklahoma"), "41": ("OR", "Oregon"), "42": ("PA", "Pennsylvania"), "44": ("RI", "Rhode Island"),
    "45": ("SC", "South Carolina"), "46": ("SD", "South Dakota"), "47": ("TN", "Tennessee"), "48": ("TX", "Texas"),
    "49": ("UT", "Utah"), "50": ("VT", "Vermont"), "51": ("VA", "Virginia"), "53": ("WA", "Washington"),
    "54": ("WV", "West Virginia"), "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"),
}
STATE_CODES = {code for code, _ in FIPS_TO_STATE.values()}
STATE_NAME_TO_CODE = {name.lower(): code for code, name in FIPS_TO_STATE.values()}

CITY_TO_STATE = {
    "nashville": "TN", "memphis": "TN", "knoxville": "TN", "chattanooga": "TN", "franklin": "TN", "murfreesboro": "TN",
    "austin": "TX", "houston": "TX", "dallas": "TX", "san antonio": "TX", "lubbock": "TX", "fort worth": "TX",
    "waco": "TX", "marfa": "TX", "spicewood": "TX", "el paso": "TX", "denton": "TX", "galveston": "TX",
    "los angeles": "CA", "hollywood": "CA", "north hollywood": "CA", "burbank": "CA", "culver city": "CA",
    "santa clarita": "CA", "san francisco": "CA", "berkeley": "CA", "oakland": "CA", "santa monica": "CA",
    "pasadena": "CA", "venice": "CA", "ojai": "CA", "mill valley": "CA", "sausalito": "CA", "malibu": "CA",
    "new york": "NY", "brooklyn": "NY", "manhattan": "NY", "midtown manhattan": "NY", "chelsea": "NY",
    "woodstock": "NY", "astoria": "NY", "queens": "NY", "kingston": "NY", "nyc": "NY", "n.y.": "NY",
    "new orleans": "LA", "lafayette": "LA", "baton rouge": "LA", "shreveport": "LA", "chicago": "IL",
    "evanston": "IL", "muscle shoals": "AL", "sheffield": "AL", "birmingham": "AL", "mobile": "AL",
    "atlanta": "GA", "athens": "GA", "macon": "GA", "savannah": "GA", "clarksdale": "MS", "oxford": "MS",
    "jackson": "MS", "coldwater": "MS", "hernando": "MS", "asheville": "NC", "durham": "NC", "chapel hill": "NC",
    "raleigh": "NC", "charlotte": "NC", "winston-salem": "NC", "portland": "OR", "eugene": "OR", "seattle": "WA",
    "olympia": "WA", "boston": "MA", "cambridge": "MA", "somerville": "MA", "northampton": "MA", "minneapolis": "MN",
    "st. paul": "MN", "duluth": "MN", "denver": "CO", "boulder": "CO", "philadelphia": "PA", "pittsburgh": "PA",
    "detroit": "MI", "ann arbor": "MI", "st. louis": "MO", "kansas city": "MO", "tulsa": "OK", "oklahoma city": "OK",
    "louisville": "KY", "lexington": "KY", "richmond": "VA", "charlottesville": "VA", "washington, d.c.": "DC",
    "washington, dc": "DC", "washington dc": "DC", "washington d.c.": "DC",
    "washington": "DC", "miami": "FL", "jacksonville": "FL", "gainesville": "FL", "tampa": "FL", "ringwood": "NJ",
    "hoboken": "NJ", "jersey city": "NJ", "baltimore": "MD", "silver spring": "MD", "providence": "RI",
    "burlington": "VT", "santa fe": "NM", "albuquerque": "NM", "tucson": "AZ", "phoenix": "AZ", "las vegas": "NV",
    "salt lake city": "UT", "boise": "ID", "missoula": "MT", "anchorage": "AK", "fairbanks": "AK", "juneau": "AK",
    "alaska": "AK", "maui": "HI", "honolulu": "HI", "hawaii": "HI", "indianapolis": "IN", "bloomington": "IN",
    "cleveland": "OH", "columbus": "OH", "cincinnati": "OH", "madison": "WI", "milwaukee": "WI", "little rock": "AR",
}

STUDIO_HOME_HINTS = {
    "blackbird studio": ("Nashville", "TN"), "sound emporium": ("Nashville", "TN"), "yes master": ("Nashville", "TN"),
    "independent mastering": ("Nashville", "TN"), "georgetown masters": ("Nashville", "TN"), "alex the great": ("Nashville", "TN"),
    "infrasonic": ("Nashville", "TN"), "butcher shoppe": ("Nashville", "TN"), "east iris": ("Nashville", "TN"),
    "welcome to 1979": ("Nashville", "TN"), "rca studio": ("Nashville", "TN"), "ardent": ("Memphis", "TN"),
    "sun studio": ("Memphis", "TN"), "royal studios": ("Memphis", "TN"), "american sound": ("Memphis", "TN"),
    "stax": ("Memphis", "TN"), "zebra ranch": ("Coldwater", "MS"), "arlyn": ("Austin", "TX"), "cedar creek": ("Austin", "TX"),
    "pedernales": ("Spicewood", "TX"), "sunset sound": ("Los Angeles", "CA"), "the village recorder": ("Los Angeles", "CA"),
    "lurssen": ("Los Angeles", "CA"), "the mastering lab": ("Los Angeles", "CA"), "bernie grundman": ("Los Angeles", "CA"),
    "capitol studios": ("Los Angeles", "CA"), "sterling sound": ("New York", "NY"), "masterdisk": ("New York", "NY"),
    "electric lady": ("New York", "NY"), "sear sound": ("New York", "NY"), "gateway mastering": ("Portland", "ME"),
    "knack mastering": ("Ringwood", "NJ"), "fame": ("Muscle Shoals", "AL"), "muscle shoals sound": ("Sheffield", "AL"),
    "levon helm": ("Woodstock", "NY"), "soma electronic": ("Chicago", "IL"), "the loft": ("Chicago", "IL"),
    "chess": ("Chicago", "IL"),
}

COUNTRY_ALIASES = {"uk": "United Kingdom", "u.k.": "United Kingdom", "england": "United Kingdom", "scotland": "United Kingdom"}
STATE_NAMES_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(n) for n in sorted(STATE_NAME_TO_CODE, key=len, reverse=True)) + r")\b"
)
DC_QUALIFIER_RE = re.compile(r"\b(?:d\.?c|district of columbia)\b")
WASH_DC_PHRASE_RE = re.compile(r"\bwashington,?\s*(?:d\.?c\.?|district of columbia)\b")
US_COUNTRY_LABELS = {"", "united states", "usa", "us"}
CITY_COUNTRY_SUFFIX_RE = re.compile(r",\s*(?:united states|u\.?s\.?a?\.?)$")


def build_albers_states_json(topo_path, out_path):
    """Decode us-atlas Albers 10m TopoJSON into lightweight SVG path data."""
    topo_file = Path(topo_path)
    out_file = Path(out_path)
    if not topo_file.exists():
        raise FileNotFoundError(
            f"Missing US Atlas TopoJSON cache file: {topo_file} (expected source: {US_ATLAS_URL})"
        )

    topo = json.loads(topo_file.read_text(encoding="utf-8"))
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]

    decoded_arcs = []
    for arc in topo["arcs"]:
        pts = []
        x = y = 0
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((round(x * sx + tx, 1), round(y * sy + ty, 1)))
        decoded_arcs.append(pts)

    def ring_to_pts(arc_ids):
        pts = []
        for idx in arc_ids:
            seg = decoded_arcs[idx] if idx >= 0 else list(reversed(decoded_arcs[~idx]))
            pts.extend(seg if not pts else seg[1:])
        return pts

    states_out = []
    for geom in topo["objects"]["states"]["geometries"]:
        fips = str(geom.get("id", "")).zfill(2)
        if fips not in FIPS_TO_STATE:
            continue
        code, name = FIPS_TO_STATE[fips]
        polys = [geom["arcs"]] if geom["type"] == "Polygon" else geom["arcs"]
        rings = []
        for poly in polys:
            if not poly:
                continue
            pts = ring_to_pts(poly[0])
            if len(pts) < 3:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            rings.append(((x1 - x0) + (y1 - y0), x0, y0, x1, y1, pts))
        if not rings:
            continue
        rings.sort(key=lambda r: -r[0])
        kept = [r for i, r in enumerate(rings) if i == 0 or r[0] >= 5.0]
        paths = []
        for _, _, _, _, _, pts in kept:
            sampled = pts[::2] if len(pts) > 120 else pts
            if sampled[-1] != pts[-1]:
                sampled.append(pts[-1])
            paths.append("M" + "L".join(f"{px},{py}" for px, py in sampled) + "Z")
        _, x0, y0, x1, y1, _ = rings[0]
        states_out.append({
            "code": code, "name": name, "d": "".join(paths),
            "cx": round((x0 + x1) / 2, 1), "cy": round((y0 + y1) / 2, 1),
        })

    states_out.sort(key=lambda s: s["code"])
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps({"viewBox": "0 0 975 610", "states": states_out}, separators=(",", ":")), encoding="utf-8")
    return len(states_out)


def _match_state_name(text_lower):
    """Match a full US state name in text, treating Washington + D.C. as DC rather than WA."""
    normalized = WASH_DC_PHRASE_RE.sub("district of columbia", text_lower)
    match = STATE_NAMES_PATTERN.search(normalized)
    if not match:
        return None
    matched = match.group(1)
    if matched == "washington" and DC_QUALIFIER_RE.search(text_lower):
        return "DC"
    return STATE_NAME_TO_CODE[matched]


def resolve_us_or_intl(city, state, country, bio="", studio_name=""):
    """Resolve (us_state, clean_city, country_name) with explicit metadata taking precedence."""
    st_raw = (state or "").strip()
    st_upper = st_raw.upper().replace(".", "")
    ct = (city or "").strip()
    ct_norm = CITY_COUNTRY_SUFFIX_RE.sub("", ct.lower()).strip()
    co = COUNTRY_ALIASES.get((country or "").strip().lower(), (country or "").strip())
    co_lower = co.lower()
    co_nopunct = co.upper().replace(".", "")

    # 1. Explicit state field always takes precedence.
    if st_upper in STATE_CODES:
        return (st_upper, ct or None, "United States")
    st_name_code = _match_state_name(st_raw.lower()) if st_raw else None
    if st_name_code and st_raw.lower() in STATE_NAME_TO_CODE:
        return (st_name_code, ct or None, "United States")
    if st_raw and WASH_DC_PHRASE_RE.fullmatch(st_raw.lower()):
        return ("DC", ct or None, "United States")

    # Classify explicit country before matching city names so foreign cities (e.g. Burlington, Canada) stay non-US.
    co_state = None
    if co_lower not in US_COUNTRY_LABELS:
        if co_nopunct in STATE_CODES:
            co_state = co_nopunct
        elif co_lower in STATE_NAME_TO_CODE:
            co_state = STATE_NAME_TO_CODE[co_lower]
        elif co_lower in CITY_TO_STATE:
            if not ct:
                ct = co
                ct_norm = co_lower
        else:
            return (None, ct or None, co)
        co = "United States"

    sn = (studio_name or "").lower()

    # 2. Explicit known city in CITY_TO_STATE (handles Washington, D.C. variants before state-name matching).
    if ct_norm == "portland" and "gateway mastering" in sn:
        return ("ME", "Portland", "United States")
    if ct_norm in CITY_TO_STATE:
        return (CITY_TO_STATE[ct_norm], ct, "United States")

    # 3. Structured state suffix or state name inside city text (not bio).
    if ct_norm:
        if ct in (STATE_CODES - {"LA"}):
            return (ct, ct, "United States")
        m_abbr = re.search(r",\s*([a-z]{2})\.?$", ct_norm)
        if m_abbr and m_abbr.group(1).upper() in STATE_CODES:
            return (m_abbr.group(1).upper(), ct, "United States")
        if DC_QUALIFIER_RE.search(ct_norm):
            return ("DC", ct, "United States")
        ct_state = _match_state_name(ct_norm)
        if ct_state:
            return (ct_state, ct, "United States")

    # 4. US state/city stored in the country field when city did not specify a state.
    if co_state:
        return (co_state, ct or None, "United States")

    # 5. Fallback heuristics only when explicit state, city, and country did not resolve.
    if sn:
        for hint, (h_city, h_st) in STUDIO_HOME_HINTS.items():
            if re.search(r"\b" + re.escape(hint), sn):
                return (h_st, ct or h_city, "United States")

    bio_lower = (bio or "")[:240].lower()
    if "anchorage, kentucky" in bio_lower:
        return ("KY", ct or "Anchorage", "United States")
    if "portland, maine" in bio_lower:
        return ("ME", ct or "Portland", "United States")
    if bio_lower:
        bio_state = _match_state_name(bio_lower)
        if bio_state:
            return (bio_state, ct or None, "United States")

    return (None, ct or None, co or None)
