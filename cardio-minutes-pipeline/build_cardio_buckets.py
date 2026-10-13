#!/usr/bin/env python3
"""
build_cardio_buckets.py — turn cardio-minutes.csv into cardio-buckets.csv:
one row per Garmin activity, with the minutes spent in each 5-bpm heart-rate
bucket.

Why buckets and not zones: a zone is an interpretation (a boundary table that
changes with every retest, formula or coach); a bucket is just a count. The app
turns buckets into zone minutes or "minutes between X and Y bpm" when it
displays them, so changing a boundary never requires rewriting stored data.

  cardio-minutes.csv   per-minute average HR          (the finest record)
        |  this script, rerun in full on every Action run
        v
  cardio-buckets.csv   per-activity 5-bpm minute counts (what the app reads)

The output is rebuilt from scratch each run and is never edited by hand or by
the app. Hand corrections live in corrections.json, next to this script:

  {
    "<activity_id>": {
      "note":   "why (free text, ignored by the script)",
      "keep":   ["YYYY-MM-DD HH:MM", "YYYY-MM-DD HH:MM"],   # inclusive window; minutes outside are dropped
      "set_hr": [{"from": "...", "to": "...", "hr": 127}],  # sensor misread: treat those minutes as this HR
      "add":    [{"minutes": 9.4, "hr": 85}]                 # watch was paused: add minutes at this HR
    }
  }

Conventions shared with post_zone_records.py:
  * a minute with < 10 s of sensor coverage is ignored;
  * every other minute contributes seconds_covered / 60 (fractional minutes).

A minute's average HR h lands in the bucket [lo, lo+5) with lo = floor(h/5)*5.
Columns: hr_under70, hr70_74, hr75_79, ... hr180_184, hr185_up.

Usage:
  python cardio-minutes-pipeline/build_cardio_buckets.py \
      [--cardio cardio-minutes.csv] [--out cardio-buckets.csv] \
      [--corrections cardio-minutes-pipeline/corrections.json]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import OrderedDict

BUCKET_WIDTH = 5
LOW_EDGE = 70      # everything below this goes in hr_under70
HIGH_EDGE = 185    # everything at or above this goes in hr185_up
MIN_COVERAGE_SECONDS = 10.0

BUCKET_LOWS = list(range(LOW_EDGE, HIGH_EDGE, BUCKET_WIDTH))
BUCKET_COLUMNS = (
    [f"hr_under{LOW_EDGE}"]
    + [f"hr{lo}_{lo + BUCKET_WIDTH - 1}" for lo in BUCKET_LOWS]
    + [f"hr{HIGH_EDGE}_up"]
)
FIELDNAMES = ["date", "start", "activity_id", "activity_type", "minutes",
              "avg_hr", "max_minute_hr", "corrected"] + BUCKET_COLUMNS
CORRECTION_KEYS = {"note", "keep", "set_hr", "add"}


def bucket_index(hr: float) -> int:
    """Index into BUCKET_COLUMNS for one minute's average HR."""
    if hr < LOW_EDGE:
        return 0
    if hr >= HIGH_EDGE:
        return len(BUCKET_COLUMNS) - 1
    return 1 + int((hr - LOW_EDGE) // BUCKET_WIDTH)


def apply_corrections(minutes: list[dict], corr: dict | None) -> list[tuple[float, float]]:
    """
    minutes: cardio-minutes rows for one activity, sorted by minute.
    Returns [(hr, seconds), ...] after keep / set_hr / add.
    """
    corr = corr or {}
    unknown = set(corr) - CORRECTION_KEYS
    if unknown:
        raise ValueError(f"unknown correction key(s): {sorted(unknown)}")

    keep = corr.get("keep")
    if keep is not None and (len(keep) != 2 or keep[0] > keep[1]):
        raise ValueError(f"keep must be [from, to] with from <= to, got {keep!r}")

    out = []
    for r in minutes:
        m = r["minute"]
        if keep and not (keep[0] <= m <= keep[1]):
            continue
        hr = float(r["avg_hr_weighted"])
        for s in corr.get("set_hr") or []:
            if s["from"] <= m <= s["to"]:
                hr = float(s["hr"])
        out.append((hr, float(r["seconds_covered"])))
    for a in corr.get("add") or []:
        out.append((float(a["hr"]), float(a["minutes"]) * 60.0))
    return out


def summarise(samples: list[tuple[float, float]]):
    """[(hr, seconds)] -> (bucket minutes list, total minutes, avg hr, max minute hr)."""
    buckets = [0.0] * len(BUCKET_COLUMNS)
    total = hr_seconds = max_hr = 0.0
    for hr, sec in samples:
        if sec < MIN_COVERAGE_SECONDS:
            continue
        buckets[bucket_index(hr)] += sec / 60.0
        total += sec / 60.0
        hr_seconds += hr * sec
        max_hr = max(max_hr, hr)
    avg = hr_seconds / (total * 60.0) if total else 0.0
    return buckets, total, avg, max_hr


def fmt(v: float) -> str:
    """Minutes to 2 decimals, trailing zeros trimmed; zero is an empty cell."""
    if v <= 0:
        return ""
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s or ""


def build_rows(cardio_rows: list[dict], corrections: dict) -> list[dict]:
    by_activity: "OrderedDict[str, list[dict]]" = OrderedDict()
    for r in cardio_rows:
        by_activity.setdefault(r["activity_id"], []).append(r)

    for aid in corrections:
        if aid not in by_activity:
            print(f"  ! corrections.json names activity {aid}, which is not in the cardio CSV")

    rows = []
    for aid, mins in by_activity.items():
        mins.sort(key=lambda r: r["minute"])
        corr = corrections.get(aid)
        try:
            samples = apply_corrections(mins, corr)
        except (ValueError, KeyError, TypeError) as e:
            raise SystemExit(f"corrections.json entry for {aid} is invalid: {e}")
        buckets, total, avg, max_hr = summarise(samples)
        if total <= 0:
            continue  # nothing usable (e.g. a few seconds of data)
        kept = [r for r in mins if not (corr and corr.get("keep"))
                or corr["keep"][0] <= r["minute"] <= corr["keep"][1]] or mins
        row = {
            "date": kept[0]["minute"][:10],
            "start": kept[0]["minute"],
            "activity_id": aid,
            "activity_type": mins[0]["activity_type"],
            "minutes": fmt(total) or "0",
            "avg_hr": f"{avg:.0f}",
            "max_minute_hr": f"{max_hr:.0f}",
            "corrected": "y" if corr else "",
        }
        for col, v in zip(BUCKET_COLUMNS, buckets):
            row[col] = fmt(v)
        rows.append(row)
    rows.sort(key=lambda r: (r["start"], r["activity_id"]))
    return rows


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--cardio", default="cardio-minutes.csv")
    ap.add_argument("--out", default="cardio-buckets.csv")
    ap.add_argument("--corrections", default=os.path.join(here, "corrections.json"))
    args = ap.parse_args()

    with open(args.cardio, newline="") as f:
        cardio = list(csv.DictReader(f))
    corrections = {}
    if os.path.exists(args.corrections):
        with open(args.corrections, encoding="utf-8") as f:
            corrections = {str(k): v for k, v in json.load(f).items() if not k.startswith("_")}

    rows = build_rows(cardio, corrections)
    tmp = args.out + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, args.out)
    print(f"wrote {args.out}: {len(rows)} activities, "
          f"{sum(1 for r in rows if r['corrected'])} with corrections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
