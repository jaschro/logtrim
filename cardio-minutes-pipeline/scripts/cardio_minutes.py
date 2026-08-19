#!/usr/bin/env python3
"""
cardio_minutes.py — pull per-sample heart-rate data from Garmin Connect and
maintain a single, always-sorted cardio-minutes.csv.

Spec (agreed with Jason, Aug 2026):
  * One file: cardio-minutes.csv
      columns: date, activity_id, activity_type, minute, avg_hr_weighted, seconds_covered
  * Time-weighted average: each HR reading is forward-filled to the NEXT
    reading's timestamp (Garmin "smart recording" writes a record when the
    value changes, so a reading holds from its own timestamp forward).
  * Any single interval is capped at GAP_CAP_SECONDS (default 30); longer
    gaps are treated as missing data, not filled.
  * The last reading of an activity gets 1 nominal second.
  * Readings spanning a minute boundary are split proportionally.
  * Every minute is written with its seconds_covered — no filtering here;
    thresholds (e.g. ">=10s") are applied at analysis time.
  * No zone columns — zones are applied at analysis time so they can change.
  * Timestamps are America/New_York local time (named tz, so DST is automatic).
  * Dedup by activity_id; whole file is re-sorted and rewritten every run,
    so it is always natively sorted by (minute, activity_id).

Auth: set GARMIN_TOKENS env var to the base64 token blob printed by
scripts/garmin_login.py (run that once, locally). Falls back to ~/.garminconnect.
"""

from __future__ import annotations

import csv
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------- config ---

CSV_PATH = os.environ.get("CARDIO_CSV", "cardio-minutes.csv")
LOCAL_TZ = ZoneInfo("America/New_York")
GAP_CAP_SECONDS = float(os.environ.get("GAP_CAP_SECONDS", "30"))
LAST_SAMPLE_SECONDS = 1.0          # nominal weight for the final reading
ACTIVITY_FETCH_LIMIT = int(os.environ.get("ACTIVITY_FETCH_LIMIT", "30"))
MAXCHART = 200_000                 # ask Garmin for full-resolution samples

FIELDNAMES = [
    "date",
    "activity_id",
    "activity_type",
    "minute",
    "avg_hr_weighted",
    "seconds_covered",
]

# ----------------------------------------------------------- aggregation ---


def weighted_intervals(samples: list[tuple[float, float]]):
    """
    samples: list of (epoch_seconds, hr), sorted ascending, nulls removed.
    Yields (start_epoch_seconds, duration_seconds, hr) with forward-fill
    weighting: each reading holds until the next one, capped at GAP_CAP.
    """
    n = len(samples)
    for i, (ts, hr) in enumerate(samples):
        if i < n - 1:
            gap = samples[i + 1][0] - ts
            if gap <= 0:
                continue  # duplicate / out-of-order timestamp — skip
            duration = min(gap, GAP_CAP_SECONDS)
        else:
            duration = LAST_SAMPLE_SECONDS
        yield ts, duration, hr


def split_into_minutes(start_epoch: float, duration: float, hr: float, acc):
    """
    Distribute one weighted interval across NY-local minute buckets.
    acc: dict[minute_key] -> [sum_hr_seconds, seconds]
    minute_key is a 'YYYY-MM-DD HH:MM' string in America/New_York.
    """
    remaining = duration
    cursor = start_epoch
    while remaining > 1e-9:
        local = datetime.fromtimestamp(cursor, tz=LOCAL_TZ)
        # seconds until the top of the next minute
        into_minute = local.second + local.microsecond / 1e6
        room = 60.0 - into_minute
        take = min(remaining, room)
        key = local.strftime("%Y-%m-%d %H:%M")
        bucket = acc[key]
        bucket[0] += hr * take
        bucket[1] += take
        cursor += take
        remaining -= take


def activity_to_rows(activity_id, activity_type, samples):
    """samples -> list of csv row dicts for this activity."""
    acc: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    for ts, dur, hr in weighted_intervals(samples):
        split_into_minutes(ts, dur, hr, acc)

    rows = []
    for minute_key, (hr_seconds, seconds) in acc.items():
        if seconds <= 0:
            continue
        rows.append(
            {
                "date": minute_key[:10],
                "activity_id": str(activity_id),
                "activity_type": activity_type,
                "minute": minute_key,
                "avg_hr_weighted": f"{hr_seconds / seconds:.1f}",
                "seconds_covered": f"{seconds:.1f}",
            }
        )
    return rows


# ------------------------------------------------------------- garmin io ---


def garmin_client():
    from garminconnect import Garmin

    tokens = os.environ.get("GARMIN_TOKENS", "").strip()
    g = Garmin()
    if tokens:
        g.login(tokens)                       # base64 token blob
    else:
        g.login("~/.garminconnect")           # local token directory
    return g


def extract_hr_samples(details: dict) -> list[tuple[float, float]]:
    """From activity details JSON -> sorted [(epoch_seconds, hr), ...]."""
    descriptors = details.get("metricDescriptors") or []
    ts_idx = hr_idx = None
    for d in descriptors:
        key = d.get("key")
        if key == "directTimestamp":
            ts_idx = d.get("metricsIndex")
        elif key == "directHeartRate":
            hr_idx = d.get("metricsIndex")
    if ts_idx is None or hr_idx is None:
        return []

    out = []
    for m in details.get("activityDetailMetrics") or []:
        metrics = m.get("metrics") or []
        try:
            ts_ms = metrics[ts_idx]
            hr = metrics[hr_idx]
        except (IndexError, TypeError):
            continue
        if ts_ms is None or hr is None or hr <= 0:
            continue
        out.append((float(ts_ms) / 1000.0, float(hr)))
    out.sort(key=lambda p: p[0])
    return out


# --------------------------------------------------------------- csv io ----


def read_existing(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return [row for row in csv.DictReader(f)]


def write_all(path: str, rows: list[dict]) -> None:
    rows.sort(key=lambda r: (r["minute"], r["activity_id"]))
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


# ----------------------------------------------------------------- main ----


def main() -> int:
    existing = read_existing(CSV_PATH)
    known_ids = {r["activity_id"] for r in existing}
    print(f"existing file: {len(existing)} rows, {len(known_ids)} activities")

    g = garmin_client()
    activities = g.get_activities(0, ACTIVITY_FETCH_LIMIT)
    print(f"fetched {len(activities)} recent activities from Garmin")

    new_rows: list[dict] = []
    for a in activities:
        aid = str(a.get("activityId"))
        if aid in known_ids:
            continue
        atype = (a.get("activityType") or {}).get("typeKey", "unknown")
        try:
            details = g.get_activity_details(aid, maxchart=MAXCHART)
        except Exception as e:  # noqa: BLE001 — log and move on
            print(f"  ! {aid} ({atype}): details fetch failed: {e}")
            continue
        samples = extract_hr_samples(details)
        if not samples:
            print(f"  - {aid} ({atype}): no HR samples, skipped")
            continue
        rows = activity_to_rows(aid, atype, samples)
        new_rows.extend(rows)
        print(f"  + {aid} ({atype}): {len(samples)} samples -> {len(rows)} minutes")

    if not new_rows:
        print("nothing new; file unchanged")
        return 0

    write_all(CSV_PATH, existing + new_rows)
    print(f"wrote {CSV_PATH}: {len(existing) + len(new_rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
