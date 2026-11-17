#!/usr/bin/env python3
"""Normalization, year extraction, writer dedup, and track matching helpers."""
import re
import sys
import unicodedata
from difflib import SequenceMatcher

sys.dont_write_bytecode = True

CURRENT_MAX_YEAR = 2026
MIN_VALID_YEAR = 1800

EXACT_SINGLE_LABELS = {
    "",
    "single",
    "(single)",
    "[single]",
    "non-album",
    "non album",
    "non-album track",
    "non album track",
    "unknown",
    "unknown album",
    "n/a",
    "na",
    "none",
    "various",
}

BAD_WRITER_TOKENS = {
    "",
    "[unknown]",
    "unknown",
    "unknown artist",
    "[none]",
    "none",
    "n/a",
    "various",
    "various artists",
    "public domain",
    "[public domain]",
    "copyright control",
}


def strip_discogs_num(name):
    """Strip Discogs trailing disambiguator suffixes like ' (2)' or '*'."""
    text = re.sub(r"\s*\(\d+\)\s*$", "", str(name or ""))
    text = re.sub(r"\*+$", "", text)
    return text.strip()


def strip_featured_parens(name):
    """Remove parenthetical or bracketed featuring clauses from titles or artists."""
    text = str(name or "")
    text = re.sub(
        r"\s*[\[(]\s*(?:feat\.?|ft\.?|featuring|with|w/)\s+[^)\]]*[\])]",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", text).strip()


def ascii_fold(text):
    """Fold Unicode accents to ASCII base characters."""
    decomposed = unicodedata.normalize("NFKD", str(text or ""))
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize_text(value):
    """Lowercase, ASCII-fold, strip featured tags and punctuation for comparison."""
    text = ascii_fold(strip_featured_parens(strip_discogs_num(value))).lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[\u2018\u2019'`\"]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def text_similarity(a, b):
    """Normalized SequenceMatcher similarity ratio in [0.0, 1.0]."""
    na = normalize_text(a)
    nb = normalize_text(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    return SequenceMatcher(None, na, nb).ratio()


def title_matches(expected, candidate, min_ratio=0.80):
    """Return True if candidate title matches expected reasonably closely."""
    ne = normalize_text(expected)
    nc = normalize_text(candidate)
    if not ne or not nc:
        return False
    if ne == nc:
        return True
    shorter, longer = (ne, nc) if len(ne) <= len(nc) else (nc, ne)
    if len(shorter) >= 6 and shorter in longer and len(shorter) / len(longer) >= 0.65:
        return True
    return SequenceMatcher(None, ne, nc).ratio() >= min_ratio


def extract_year(value):
    """Extract earliest credible 4-digit year in [1800, 2026], or None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if MIN_VALID_YEAR <= value <= CURRENT_MAX_YEAR else None
    text = str(value).strip()
    if not text:
        return None
    matches = re.findall(r"(?<!\d)((?:18|19|20)\d{2})(?!\d)", text)
    years = [int(y) for y in matches if MIN_VALID_YEAR <= int(y) <= CURRENT_MAX_YEAR]
    return min(years) if years else None


def pick_earliest_year(*values):
    """Return the minimum valid year across heterogeneous inputs."""
    years = [y for y in (extract_year(v) for v in values) if y is not None]
    return min(years) if years else None


def clean_writer_display(name):
    """Normalize display formatting for a writer or credit name."""
    cleaned = strip_discogs_num(name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,;-")
    if cleaned.lower() in BAD_WRITER_TOKENS:
        return ""
    if cleaned.lower() in {"trad", "trad.", "traditional", "[traditional]"}:
        return "Traditional"
    return cleaned


def _writer_tokens(name):
    return [tok for tok in normalize_text(name).split() if tok]


def writers_refer_to_same_person(a, b):
    """Detect equality, accent variants, or initial+surname matches ('J. Prine' vs 'John Prine')."""
    na = normalize_text(a)
    nb = normalize_text(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    ta = _writer_tokens(a)
    tb = _writer_tokens(b)
    if len(ta) >= 2 and len(tb) >= 2 and ta[-1] == tb[-1]:
        if ta[0][0] == tb[0][0] and (len(ta[0]) == 1 or len(tb[0]) == 1):
            return True
    return SequenceMatcher(None, na, nb).ratio() >= 0.90


def merge_writer(writers_list, writer_sources, candidate_name, source_tag):
    """Insert or upgrade a writer name without duplicates, tracking provenance."""
    display = clean_writer_display(candidate_name)
    if not display:
        return
    for idx, existing in enumerate(writers_list):
        if writers_refer_to_same_person(existing, display):
            if len(display) > len(existing) and "." not in display:
                prev_sources = writer_sources.pop(existing, set())
                prev_sources.add(source_tag)
                writers_list[idx] = display
                writer_sources[display] = prev_sources
            else:
                writer_sources.setdefault(existing, set()).add(source_tag)
            return
    writers_list.append(display)
    writer_sources.setdefault(display, set()).add(source_tag)


def is_single_album(album):
    """Match TypeScript/JS prepare-song-metadata-input single-album classification."""
    clean = re.sub(r"\s+", " ", str(album or "").strip().lower())
    if clean in EXACT_SINGLE_LABELS:
        return True
    if re.match(r"^single\s*[-:/]", clean):
        return True
    if re.search(r"\s+(?:\(|\[|-\s*)single[\])]?$", clean):
        return True
    return False


def _pos_parts(pos):
    text = str(pos or "").strip().upper()
    m = re.match(r"^([A-Z]*)(\d+)$", text)
    if m:
        return (m.group(1), int(m.group(2)))
    m_num = re.match(r"^(\d+)(?:-(\d+))?$", text)
    if m_num:
        prefix = f"D{m_num.group(1)}-" if m_num.group(2) else ""
        num = int(m_num.group(2) or m_num.group(1))
        return (prefix, num)
    return (text, -1)


def _match_pos_range(track_pos, start_spec, end_spec):
    tp = _pos_parts(track_pos)
    sp = _pos_parts(start_spec)
    ep = _pos_parts(end_spec)
    if tp[1] < 0 or sp[1] < 0 or ep[1] < 0:
        return False
    if tp[0] == sp[0] == ep[0]:
        return sp[1] <= tp[1] <= ep[1]
    if not sp[0] and not ep[0]:
        return sp[1] <= tp[1] <= ep[1]
    return False


def track_applies(track_spec, track_pos, song_title=""):
    """Evaluate Discogs release-level extraartist track specs ('A1-A3, B2', '1 to 4', '')."""
    spec = str(track_spec or "").strip()
    if not spec:
        return True
    pos_clean = str(track_pos or "").strip().upper()
    norm_title = normalize_text(song_title)
    parts = [p.strip() for p in re.split(r"[,;/]+", spec) if p.strip()]
    for part in parts:
        part_upper = part.upper()
        if pos_clean and part_upper == pos_clean:
            return True
        if norm_title and len(norm_title) >= 5 and norm_title in normalize_text(part):
            return True
        range_match = re.match(r"^([A-Z]?\d+)\s*(?:-|TO)\s*([A-Z]?\d+)$", part_upper)
        if range_match and pos_clean:
            if _match_pos_range(pos_clean, range_match.group(1), range_match.group(2)):
                return True
    return False

