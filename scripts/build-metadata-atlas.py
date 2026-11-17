#!/usr/bin/env python3
"""Build production public/data/metadata-atlas.json rollup from local song metadata SQLite."""
import argparse
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.dont_write_bytecode = True

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from atlas_geo import FIPS_TO_STATE, build_albers_states_json, resolve_us_or_intl

REPO_ROOT = SCRIPT_DIR.parent
SQLITE_PATH = REPO_ROOT / ".cache" / "song-metadata" / "song-metadata.sqlite"
SONGS_JSON_PATH = REPO_ROOT / "public" / "data" / "songs.json"
ATLAS_CACHE_PATH = REPO_ROOT / ".cache" / "song-metadata" / "states-albers-10m.json"
OUT_DATA_PATH = REPO_ROOT / "public" / "data" / "metadata-atlas.json"

IGNORED_LABELS = {"", "[no label]", "not on label", "none", "self-released", "self released", "unknown"}


def clean_hyphens(text):
    return re.sub(r"[\u2010-\u2015]", "-", str(text or "")).strip()


def decade_for_year(year):
    if year < 1960:
        return ("pre-1960s", "Pre-1960s", 1900)
    dec = (year // 10) * 10
    return (f"{dec}s", f"{dec}s", dec)


def load_grouped_names(con, query):
    grouped = defaultdict(list)
    for sk, raw_name in con.execute(query):
        name = clean_hyphens(raw_name)
        if name and name not in grouped[sk]:
            grouped[sk].append(name)
    return grouped


def add_entity_spin(agg_map, name, artist, plays):
    entry = agg_map[name]
    entry["songs"] += 1
    entry["spins"] += plays
    entry["artists"][artist] += plays


def top_entities(agg_map):
    ranked = sorted(agg_map.items(), key=lambda kv: (-kv[1]["songs"], -kv[1]["spins"], kv[0]))[:12]
    return [
        {
            "name": name, "songs": info["songs"], "spins": info["spins"],
            "artistCount": len(info["artists"]),
            "sampleArtists": [a for a, _ in info["artists"].most_common(5)],
        }
        for name, info in ranked
    ]


def top_counts(counter):
    return [{"name": k, "count": v} for k, v in counter.most_common(4)]


def build_atlas_data():
    """Aggregate SQLite song/artist/studio metadata and songs.json into the production atlas rollup."""
    if not SQLITE_PATH.exists():
        raise FileNotFoundError(f"Missing metadata SQLite database: {SQLITE_PATH}")
    if not SONGS_JSON_PATH.exists():
        raise FileNotFoundError(f"Missing songs snapshot: {SONGS_JSON_PATH}")

    songs_static = json.loads(SONGS_JSON_PATH.read_text(encoding="utf-8"))
    first_spin_map = {
        (str(row.get("artist", "")).strip().lower(), str(row.get("songTitle", "")).strip().lower()): row["firstAppearance"]
        for row in songs_static if row.get("firstAppearance")
    }

    con = sqlite3.connect(str(SQLITE_PATH))
    try:
        artists_rows = con.execute(
            "SELECT artist_key, artist_name, total_plays, origin_city, origin_state, origin_country, start_year, wiki_summary FROM artists_meta"
        ).fetchall()
        writers_by_song = load_grouped_names(con, "SELECT song_key, writer_name FROM song_writers")
        producers_by_song = load_grouped_names(con, "SELECT song_key, person_name FROM song_personnel WHERE role = 'producer'")
        studio_rows = con.execute("SELECT song_key, studio_name, role, city, state, country FROM song_studios").fetchall()
        songs_rows = con.execute(
            "SELECT song_key, artist, artist_key, song_title, album, total_plays, release_year, is_cover, label FROM songs_meta"
        ).fetchall()
    finally:
        con.close()

    artist_loc = {}
    state_buckets = {
        code: {
            "code": code, "name": name,
            "rec_songs": set(), "rec_spins": 0, "rec_cities": Counter(), "rec_studios": Counter(), "rec_samples": [],
            "all_songs": set(), "all_spins": 0, "all_studios": Counter(),
            "orig_artists": set(), "orig_songs": set(), "orig_spins": 0, "orig_cities": Counter(), "orig_artist_list": [], "orig_samples": [],
        }
        for code, name in FIPS_TO_STATE.values()
    }
    intl_rec_songs, intl_rec_spins = defaultdict(set), Counter()
    intl_orig_artists, intl_orig_songs, intl_orig_spins = defaultdict(set), defaultdict(set), Counter()

    for ak, aname, aplays, ocity, ostate, ocountry, _syear, wsum in artists_rows:
        us_st, clean_city, clean_co = resolve_us_or_intl(ocity, ostate, ocountry, bio=wsum or "")
        artist_loc[ak] = (us_st, clean_city, clean_co)
        if us_st:
            sb = state_buckets[us_st]
            sb["orig_artists"].add(ak)
            if clean_city:
                sb["orig_cities"][clean_city] += 1
            sb["orig_artist_list"].append((int(aplays or 0), aname))
        elif clean_co and clean_co != "United States":
            intl_orig_artists[clean_co].add(ak)

    studios_by_song = defaultdict(list)
    all_studio_names = set()
    for sk, stname, role, city, st, co in studio_rows:
        sname = clean_hyphens(stname)
        all_studio_names.add(sname)
        us_st, c_city, c_co = resolve_us_or_intl(city, st, co, studio_name=sname)
        studios_by_song[sk].append((sname, (role or "recorded at").lower(), us_st, c_city, c_co))

    decades_map = {}
    years_map = defaultdict(lambda: {"songs": 0, "spins": 0, "covers": 0, "top": []})
    producer_agg, writer_agg, label_agg = (
        defaultdict(lambda: {"songs": 0, "spins": 0, "artists": Counter()}) for _ in range(3)
    )
    same_year_spins = age_sum = age_count = covers_count = 0
    vintage_gems = []
    mapped_rec_songs, mapped_all_songs, mapped_orig_songs = set(), set(), set()
    crate_pool, state_crate_pool = defaultdict(list), defaultdict(list)
    year_state_cube = defaultdict(lambda: [0, 0, 0, 0, 0, 0])

    for sk, artist, ak, title, album, plays, ryear, is_cover, label in songs_rows:
        plays = int(plays or 0)
        if is_cover:
            covers_count += 1
        lbl = clean_hyphens(label or "")
        if lbl and lbl.lower() not in IGNORED_LABELS:
            add_entity_spin(label_agg, lbl, artist, plays)
        for prod in producers_by_song.get(sk, [])[:3]:
            add_entity_spin(producer_agg, prod, artist, plays)
        for wr in writers_by_song.get(sk, [])[:4]:
            if wr.lower() != "traditional":
                add_entity_spin(writer_agg, wr, artist, plays)

        seen_rec_st, seen_all_st = set(), set()
        primary_studio = primary_rec_state = None
        for sname, role, us_st, c_city, c_co in studios_by_song.get(sk, []):
            is_rec = "master" not in role
            if is_rec and not primary_studio:
                primary_studio, primary_rec_state = sname, us_st
            if us_st:
                sb = state_buckets[us_st]
                if us_st not in seen_all_st:
                    seen_all_st.add(us_st)
                    mapped_all_songs.add(sk)
                    sb["all_songs"].add(sk)
                    sb["all_spins"] += plays
                sb["all_studios"][sname] += 1
                if is_rec:
                    if not primary_rec_state:
                        primary_rec_state = us_st
                    if us_st not in seen_rec_st:
                        seen_rec_st.add(us_st)
                        mapped_rec_songs.add(sk)
                        sb["rec_songs"].add(sk)
                        sb["rec_spins"] += plays
                        if len(sb["rec_samples"]) < 5:
                            sb["rec_samples"].append({"title": title, "artist": artist, "spins": plays, "year": ryear, "studio": sname})
                    if c_city:
                        sb["rec_cities"][c_city] += 1
                    sb["rec_studios"][sname] += 1
            elif is_rec and c_co and c_co != "United States":
                if sk not in intl_rec_songs[c_co]:
                    intl_rec_songs[c_co].add(sk)
                    intl_rec_spins[c_co] += plays

        a_st, _, a_co = artist_loc.get(ak, (None, None, None))
        if a_st:
            mapped_orig_songs.add(sk)
            sb = state_buckets[a_st]
            sb["orig_songs"].add(sk)
            sb["orig_spins"] += plays
            if len(sb["orig_samples"]) < 5:
                sb["orig_samples"].append({"title": title, "artist": artist, "spins": plays, "year": ryear})
        elif a_co and a_co != "United States":
            intl_orig_songs[a_co].add(sk)
            intl_orig_spins[a_co] += plays

        if ryear and 1900 <= int(ryear) <= 2026:
            ryear = int(ryear)
            did, dlabel, dstart = decade_for_year(ryear)
            if did not in decades_map:
                decades_map[did] = {"id": did, "label": dlabel, "startYear": dstart, "years": set()}
            decades_map[did]["years"].add(ryear)
            yb = years_map[ryear]
            yb["songs"] += 1
            yb["spins"] += plays
            if is_cover:
                yb["covers"] += 1
            yb["top"].append((plays, title, artist, primary_studio, primary_rec_state))

            first_app = first_spin_map.get((artist.lower(), title.lower())) or first_spin_map.get(tuple(sk.split("|||", 1)))
            if first_app and first_app[:4].isdigit():
                gap = max(0, int(first_app[:4]) - ryear)
                age_sum += gap
                age_count += 1
                if gap <= 1:
                    same_year_spins += 1
                if gap >= 25:
                    vintage_gems.append((gap, plays, title, artist, ryear, first_app, primary_studio))

            for st_codes, idx in ((seen_rec_st, 0), (seen_all_st, 2), ((a_st,) if a_st else (), 4)):
                for st_code in st_codes:
                    c = year_state_cube[(ryear, st_code)]
                    c[idx] += 1
                    c[idx + 1] += plays

            if primary_rec_state or a_st:
                score = plays + (3 if primary_studio and producers_by_song.get(sk) and writers_by_song.get(sk) else 0)
                item_doc = {
                    "key": sk, "title": title, "artist": artist, "album": album or "", "year": ryear,
                    "decadeId": did, "spins": plays, "recState": primary_rec_state, "origState": a_st,
                    "studio": primary_studio, "writer": (writers_by_song.get(sk) or [None])[0],
                    "producer": (producers_by_song.get(sk) or [None])[0], "label": lbl or None, "isCover": bool(is_cover),
                }
                crate_pool[did].append((score, item_doc))
                if primary_rec_state:
                    state_crate_pool[primary_rec_state].append((score, item_doc))
                if a_st and a_st != primary_rec_state:
                    state_crate_pool[a_st].append((score, item_doc))

    decades_out = []
    for did, meta in sorted(decades_map.items(), key=lambda kv: kv[1]["startYear"]):
        yr_list = []
        d_songs = d_spins = d_covers = 0
        for yr in sorted(meta["years"]):
            yb = years_map[yr]
            yb["top"].sort(key=lambda t: (-t[0], t[1]))
            d_songs += yb["songs"]
            d_spins += yb["spins"]
            d_covers += yb["covers"]
            yr_list.append({
                "year": yr, "songCount": yb["songs"], "spinCount": yb["spins"], "coverCount": yb["covers"],
                "topSongs": [{"title": t[1], "artist": t[2], "spins": t[0], "studio": t[3], "state": t[4]} for t in yb["top"][:3]],
            })
        peak = max(yr_list, key=lambda y: (y["songCount"], y["spinCount"]))["year"]
        decades_out.append({
            "id": did, "label": meta["label"], "startYear": meta["startYear"],
            "songCount": d_songs, "spinCount": d_spins, "coverCount": d_covers, "peakYear": peak, "years": yr_list,
        })

    states_out = {}
    for code, sb in state_buckets.items():
        sb["orig_artist_list"].sort(key=lambda a: -a[0])
        sb["rec_samples"].sort(key=lambda s: -s["spins"])
        sb["orig_samples"].sort(key=lambda s: -s["spins"])
        states_out[code] = {
            "code": code, "name": sb["name"],
            "recorded": {
                "songs": len(sb["rec_songs"]), "spins": sb["rec_spins"],
                "topCities": top_counts(sb["rec_cities"]), "topStudios": top_counts(sb["rec_studios"]),
                "sampleSongs": sb["rec_samples"][:4],
            },
            "allStudios": {
                "songs": len(sb["all_songs"]), "spins": sb["all_spins"],
                "topStudios": top_counts(sb["all_studios"]),
            },
            "artistOrigin": {
                "artists": len(sb["orig_artists"]), "songs": len(sb["orig_songs"]), "spins": sb["orig_spins"],
                "topCities": top_counts(sb["orig_cities"]),
                "topArtists": [{"name": a[1], "spins": a[0]} for a in sb["orig_artist_list"][:5]],
                "sampleSongs": sb["orig_samples"][:4],
            },
            "magnetDelta": len(sb["rec_songs"]) - len(sb["orig_songs"]),
        }

    vintage_gems.sort(key=lambda g: (-g[0], -g[1], g[2]))
    seen_crate_keys, crate_sample = set(), []
    for pool, limit in ((crate_pool, 30), (state_crate_pool, 10)):
        for bucket_key in sorted(pool.keys()):
            for _, doc in sorted(pool[bucket_key], key=lambda x: (-x[0], -x[1]["spins"], x[1]["key"]))[:limit]:
                if doc["key"] not in seen_crate_keys:
                    seen_crate_keys.add(doc["key"])
                    crate_sample.append(doc)

    cube_out = [[yr, st, v[0], v[1], v[2], v[3], v[4], v[5]] for (yr, st), v in sorted(year_state_cube.items())]

    payload = {
        "summary": {
            "totalSongs": len(songs_rows),
            "songsWithYear": sum(d["songCount"] for d in decades_out),
            "earliestYear": decades_out[0]["years"][0]["year"] if decades_out else None,
            "latestYear": decades_out[-1]["years"][-1]["year"] if decades_out else None,
            "mappedRecordingSongs": len(mapped_rec_songs),
            "mappedAllStudioSongs": len(mapped_all_songs),
            "mappedArtistOriginArtists": sum(len(sb["orig_artists"]) for sb in state_buckets.values()),
            "mappedArtistOriginSongs": len(mapped_orig_songs),
            "distinctStudios": len(all_studio_names),
            "distinctWriters": len(writer_agg),
            "distinctProducers": len(producer_agg),
            "distinctLabels": len(label_agg),
            "coversCount": covers_count,
        },
        "decades": decades_out,
        "states": states_out,
        "international": {
            "recorded": sorted([{"country": c, "songs": len(s), "spins": intl_rec_spins[c]} for c, s in intl_rec_songs.items()], key=lambda x: -x["songs"])[:12],
            "artistOrigin": sorted([{"country": c, "artists": len(intl_orig_artists[c]), "songs": len(s), "spins": intl_orig_spins[c]} for c, s in intl_orig_songs.items()], key=lambda x: -x["artists"])[:12],
        },
        "curiosities": {
            "timeCapsules": {
                "freshSameYearSongs": same_year_spins,
                "avgSongAgeAtFirstSpin": round(age_sum / age_count, 1) if age_count else 0.0,
                "vintageGems": [
                    {"gapYears": g[0], "spins": g[1], "title": g[2], "artist": g[3], "releaseYear": g[4], "firstSpinDate": g[5], "studio": g[6]}
                    for g in vintage_gems[:10]
                ],
            },
            "producers": top_entities(producer_agg),
            "writers": top_entities(writer_agg),
            "labels": top_entities(label_agg),
        },
        "crateSample": crate_sample,
        "yearStateCube": cube_out,
    }
    OUT_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_DATA_PATH.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build public/data/metadata-atlas.json from local song metadata.")
    parser.add_argument("--map-out", default=None, help="Optional output path to regenerate Albers US states JSON.")
    args = parser.parse_args(argv)

    if args.map_out is not None:
        if not str(args.map_out).strip():
            sys.exit("Error: --map-out requires a non-empty output file path.")
        if not ATLAS_CACHE_PATH.exists():
            sys.exit(f"Error: cannot write --map-out because TopoJSON cache is missing: {ATLAS_CACHE_PATH}")

    try:
        payload = build_atlas_data()
    except FileNotFoundError as exc:
        sys.exit(f"Error: {exc}")

    print(f"Wrote atlas rollup -> {OUT_DATA_PATH.relative_to(REPO_ROOT)} ({OUT_DATA_PATH.stat().st_size // 1024} KB)")
    print("SUMMARY:", json.dumps(payload["summary"]))

    if args.map_out is not None:
        map_out_path = Path(args.map_out)
        state_count = build_albers_states_json(ATLAS_CACHE_PATH, map_out_path)
        print(f"Wrote {state_count} US states -> {map_out_path} ({map_out_path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
