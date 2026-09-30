#!/usr/bin/env python3
"""
post_zone_records.py — compute Karvonen zone minutes from cardio-minutes.csv
and insert one record per unprocessed Garmin activity into LogTrim's
workout-log.json and workout-log.csv.

Spec source of truth: the Claude Project doc `garmin-to-logtrim-flow.md`
(snapshot in ../references/flow-snapshot.md). Key conventions implemented:
  * Karvonen: zone floor(i) = RHR + pct_i * (HRmax - RHR), pcts 50..90%.
  * Minutes with < 10 s sensor coverage are ignored for zones.
  * Minutes below the Zone 1 floor count into zone1 (warm-up convention).
  * Each qualifying minute contributes seconds_covered/60 (fractional).
  * Duration = total coverage of ALL minutes (no 10 s filter) in minutes.
  * Dedup key: the Garmin activity ID cited in a log entry's notes.
  * Log order: date blocks descending, entries within a day ascending.

Usage:
  python post_zone_records.py --cardio cardio-minutes.csv \
      --log-json workout-log.json --log-csv workout-log.csv \
      --garmin garmin-recent.json --rhr 46 --hrmax 168 --out-dir out/
      [--activity-ids ID ...] [--mapping mapping.json] [--dry-run]

mapping.json (for indoor/gym activity types that need a machine):
  { "24015814175": {"machineId": "m1785620472687", "machine": "Elliptical",
                    "gym": "Admirals Cove", "room": "Aerobic Area"} }
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

ZONE_PCTS = (0.5, 0.6, 0.7, 0.8, 0.9)
MIN_COVERAGE_SECONDS = 10.0

OUTDOOR_TYPES = {
    "cycling": ("bike-ride", "Bike Ride", "ride"),
    "running": ("run", "Run", "run"),
    "walking": ("walk", "Walk", "walk"),
    "hiking":  ("walk", "Walk", "hike"),
}
NAME_SUFFIXES = ("Cycling", "Running", "Walking", "Hiking", "Ride", "Run", "Walk")


def parse_log_datetime(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %I:%M:%S %p")


def fmt_log_datetime(minute_key: str) -> str:
    """'2026-08-24 16:26' -> '2026-08-24 04:26:00 PM'"""
    dt = datetime.strptime(minute_key, "%Y-%m-%d %H:%M")
    return dt.strftime("%Y-%m-%d %I:%M:%S %p")


def num_or_none(v: float):
    if not v:
        return None
    return int(v) if float(v).is_integer() else v


def csv_esc(s) -> str:
    return str(s or "").replace(",", " ").replace("\n", " ").replace('"', " ")


def entry_to_csv_row(e: dict) -> str:
    def f(v):
        return "" if v is None else v
    def js_num(v):
        if v is None:
            return ""
        return repr(v) if isinstance(v, float) else str(v)
    return ",".join(str(x) for x in [
        csv_esc(e["datetime"]), csv_esc(e["gym"]), csv_esc(e["room"]),
        csv_esc(e["machine"]), e["machineId"], e["set"],
        f(e["weight"]), f(e["reps"]), js_num(e["duration"]), f(e["level"]),
        f(e["incline"]), f(e["hr"]), csv_esc(e["notes"]),
        js_num(e.get("zone1")), js_num(e.get("zone2")), js_num(e.get("zone3")),
        js_num(e.get("zone4")), js_num(e.get("zone5")),
    ])


def compute_zones(minutes: list[dict], rhr: float, hrmax: float):
    floors = [rhr + p * (hrmax - rhr) for p in ZONE_PCTS]
    zones = [0.0] * 5
    total_seconds = 0.0
    max_minute_hr = 0.0
    for r in minutes:
        sec = float(r["seconds_covered"])
        hr = float(r["avg_hr_weighted"])
        total_seconds += sec
        if sec < MIN_COVERAGE_SECONDS:
            continue
        max_minute_hr = max(max_minute_hr, hr)
        zi = 0  # below Zone 1 floor counts as zone1
        for i, floor in enumerate(floors):
            if hr >= floor:
                zi = i
        zones[zi] += sec / 60.0
    return zones, total_seconds / 60.0, max_minute_hr


def build_note(meta, aid, word, dist, elev, zones, max_minute_hr, rhr, hrmax):
    prefix = ""
    if meta and meta.get("name"):
        n = meta["name"]
        for suf in NAME_SUFFIXES:
            if n.endswith(suf):
                n = n[: -len(suf)].strip()
                break
        prefix = n
    label = f"{prefix} {word}".strip()
    label = label[0].upper() + label[1:] if label else word.capitalize()
    parts = [f"Garmin {aid}"]
    if dist:
        parts.append(f"{dist} mi")
    if elev:
        parts.append(f"+{int(round(elev))} ft")
    head = f"{label} ({'; '.join(parts)})."
    only_z1 = zones[0] > 0 and all(z == 0 for z in zones[1:])
    if only_z1:
        return (f"{head} All Zone 1 - max minute HR ~{int(round(max_minute_hr))} "
                f"(Karvonen RHR {int(rhr)} / max {int(hrmax)}).")
    return (f"{head} Karvonen zones from cardio-minutes "
            f"(RHR {int(rhr)} / max {int(hrmax)}); warmup below Z1 counted in zone1.")


def insertion_index(entries: list[dict], new_entry: dict) -> int:
    """Date blocks descending; within a date block, ascending datetime."""
    d = new_entry["date"]
    ndt = parse_log_datetime(new_entry["datetime"])
    block = [i for i, e in enumerate(entries) if e.get("date") == d]
    if block:
        for i in block:
            try:
                edt = parse_log_datetime(entries[i]["datetime"])
            except (KeyError, ValueError, TypeError):
                continue
            if edt > ndt:
                return i
        return block[-1] + 1
    for i, e in enumerate(entries):
        if (e.get("date") or "") < d:
            return i
    return len(entries)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cardio", required=True)
    ap.add_argument("--log-json", required=True)
    ap.add_argument("--log-csv", required=True)
    ap.add_argument("--garmin", help="garmin-recent.json for names/distance/elevation/avg HR")
    ap.add_argument("--rhr", type=float, required=True)
    ap.add_argument("--hrmax", type=float, required=True)
    ap.add_argument("--out-dir", default="out")
    ap.add_argument("--activity-ids", nargs="*", help="only process these IDs")
    ap.add_argument("--since", help="only process activities on/after this date (YYYY-MM-DD)")
    ap.add_argument("--mapping", help="JSON file mapping activityId -> machine fields for indoor types")
    ap.add_argument("--post-possible-duplicates", action="store_true",
                    help="post even when an existing log entry overlaps the activity's time window")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cardio = list(csv.DictReader(open(args.cardio)))
    log_entries = json.load(open(args.log_json))
    csv_text = open(args.log_csv, encoding="utf-8").read()
    csv_lines = csv_text.split("\n")
    header, csv_rows = csv_lines[0], [l for l in csv_lines[1:] if l.strip()]
    trailing_newline = csv_text.endswith("\n")
    if len(csv_rows) != len(log_entries):
        print(f"WARNING: csv rows ({len(csv_rows)}) != json entries ({len(log_entries)}) — "
              f"files out of sync; CSV inserts fall back to matching positions anyway.")

    garmin_meta = {}
    if args.garmin and os.path.exists(args.garmin):
        g = json.load(open(args.garmin))
        for a in g.get("recentActivities", []):
            garmin_meta[str(a.get("activityId"))] = a

    mapping = json.load(open(args.mapping)) if args.mapping else {}

    logged_blob = json.dumps(log_entries)
    by_activity: dict[str, list[dict]] = defaultdict(list)
    for r in cardio:
        by_activity[r["activity_id"]].append(r)

    candidates = []
    for aid, mins in by_activity.items():
        if args.activity_ids and aid not in args.activity_ids:
            continue
        if args.since and min(m["minute"] for m in mins)[:10] < args.since:
            continue
        if aid in logged_blob:
            continue  # already posted — dedup by Garmin ID in notes
        candidates.append((min(m["minute"] for m in mins), aid))
    candidates.sort()

    # Existing timed entries, for manual-duplicate detection: older cardio was
    # sometimes logged by hand WITHOUT a Garmin ID, so ID dedup alone is not
    # enough — an activity overlapping an existing timed entry is suspect.
    existing_timed = []
    for e in log_entries:
        if e.get("duration") in (None, "", 0):
            continue
        try:
            edt = parse_log_datetime(e["datetime"])
        except (KeyError, ValueError, TypeError):
            continue
        existing_timed.append((edt, float(e["duration"]), e.get("machine", "")))

    if not candidates:
        print("Nothing to do: every activity in the cardio CSV is already logged.")
        return 0

    posted, skipped = [], []
    for _, aid in candidates:
        mins = sorted(by_activity[aid], key=lambda r: r["minute"])
        atype = mins[0]["activity_type"]
        meta = garmin_meta.get(aid)

        if atype in OUTDOOR_TYPES:
            machine_id, machine, word = OUTDOOR_TYPES[atype]
            gym, room = "Common Machines", "Outdoor Activities"
        elif aid in mapping:
            m = mapping[aid]
            machine_id, machine = m["machineId"], m["machine"]
            gym, room = m["gym"], m["room"]
            word = m.get("word", machine.lower())
        else:
            skipped.append((aid, atype, "needs mapping — indoor/gym type; supply via --mapping"))
            continue

        zones, duration, max_minute_hr = compute_zones(mins, args.rhr, args.hrmax)

        if not args.post_possible_duplicates:
            from datetime import timedelta
            start = datetime.strptime(mins[0]["minute"], "%Y-%m-%d %H:%M")
            end = datetime.strptime(mins[-1]["minute"], "%Y-%m-%d %H:%M")
            pad = timedelta(minutes=20)
            overlap = next(
                ((edt, mach) for edt, edur, mach in existing_timed
                 if start - pad <= edt <= end + pad
                 or edt <= start <= edt + timedelta(minutes=edur) + pad),
                None)
            if overlap:
                skipped.append((aid, atype,
                    f"possible manual duplicate — existing timed entry "
                    f"'{overlap[1]}' at {overlap[0]:%Y-%m-%d %I:%M %p}; review, then "
                    f"use --post-possible-duplicates or --activity-ids to override"))
                continue
        dist = meta.get("distanceMiles") if meta else None
        elev = meta.get("elevationGain") if meta else None
        avg_hr = meta.get("avgHR") if meta else None
        if avg_hr is None:
            covered = [(float(r["seconds_covered"]), float(r["avg_hr_weighted"])) for r in mins]
            tot = sum(s for s, _ in covered)
            avg_hr = round(sum(s * h for s, h in covered) / tot) if tot else None

        entry = {
            "machineId": machine_id, "machine": machine, "gym": gym, "room": room,
            "date": mins[0]["minute"][:10],
            "datetime": fmt_log_datetime(mins[0]["minute"]),
            "set": 1, "weight": None, "reps": None,
            "duration": duration, "level": dist, "incline": None,
            "hr": int(avg_hr) if avg_hr is not None else None,
            "notes": build_note(meta, aid, word, dist, elev, zones,
                                max_minute_hr, args.rhr, args.hrmax),
        }
        for i, z in enumerate(zones, 1):
            entry[f"zone{i}"] = num_or_none(z)

        idx = insertion_index(log_entries, entry)
        log_entries.insert(idx, entry)
        csv_rows.insert(idx, entry_to_csv_row(entry))
        posted.append((aid, atype, entry, zones, duration))

    # ----- report -----
    floors = [args.rhr + p * (args.hrmax - args.rhr) for p in ZONE_PCTS]
    print(f"Karvonen RHR {args.rhr:g} / max {args.hrmax:g} — zone floors: "
          + ", ".join(f"Z{i+1}≥{f:.1f}" for i, f in enumerate(floors)))
    print()
    print(f"{'activity':>12} {'type':<18} {'start':<22} {'dur':>7} "
          f"{'Z1':>7} {'Z2':>7} {'Z3':>7} {'Z4':>7} {'Z5':>7}")
    for aid, atype, entry, zones, duration in posted:
        print(f"{aid:>12} {atype:<18} {entry['datetime']:<22} {duration:>7.2f} "
              + " ".join(f"{z:>7.2f}" for z in zones))
    for aid, atype, reason in skipped:
        print(f"{aid:>12} {atype:<18} SKIPPED: {reason}")

    if args.dry_run:
        print("\n--dry-run: no files written.")
        return 0
    if not posted:
        print("\nNo postable activities (all skipped); no files written.")
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    out_json = os.path.join(args.out_dir, "workout-log.json")
    out_csv = os.path.join(args.out_dir, "workout-log.csv")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(log_entries, f, indent=2, ensure_ascii=False)
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join([header] + csv_rows) + ("\n" if trailing_newline else ""))
    print(f"\nWrote {out_json} ({len(log_entries)} entries) and {out_csv}.")
    print("Deliver both to the repo (device_commit_files + push.bat, or GitHub web editor).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
