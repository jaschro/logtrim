#!/usr/bin/env python3
"""
daily_wellness.py — pull per-day wellness stats from Garmin Connect and
maintain a single, always-sorted daily-wellness.csv (one row per date).

Spec (agreed with Jason, Sep 2026):
  * One file: daily-wellness.csv, sorted ascending by date, one row per day.
  * Columns: date, steps, distance_miles, floors, resting_hr,
      active_calories, total_calories, avg_stress,
      body_battery_high, body_battery_low,
      intensity_moderate_min, intensity_vigorous_min,
      sleep_hours, sleep_score, deep_sleep_min, light_sleep_min,
      rem_sleep_min, awake_min, sleep_respiration, sleep_spo2,
      hrv_last_night, hrv_status, vo2max
  * Only COMPLETE days are recorded: the scan runs from YESTERDAY
    (America/New_York) backwards. Today's live numbers stay in
    garmin-recent.json.
  * The last REFRESH_DAYS days (default 3) are always re-fetched and
    overwritten — sleep/HRV can arrive late when the watch syncs late.
  * Older dates already in the CSV are never re-fetched, so re-runs are
    cheap and a killed backfill resumes where it left off.
  * Backfill: dispatch with MAX_DAYS large (e.g. 4000). The scan walks
    backwards and stops early after EMPTY_STOP consecutive days with no
    data at all — i.e. it finds the beginning of your Garmin history by
    itself. Days with no data are not written.
  * Checkpoint: the CSV is rewritten every CHECKPOINT_EVERY fetched days
    during long backfills, so progress survives an interrupted run.
  * Zones/derived metrics are NOT stored — compute at analysis time.

Auth: GARMIN_TOKENS env var, same secret and both formats as
cardio_minutes.py (garth dumps() blob, or base64 gzipped ~/.garth tarball).
"""

from __future__ import annotations

import csv
import os
import sys
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------- config ---

CSV_PATH = os.environ.get("WELLNESS_CSV", "daily-wellness.csv")
LOCAL_TZ = ZoneInfo("America/New_York")
MAX_DAYS = int(os.environ.get("MAX_DAYS", "40"))          # how far back to scan
REFRESH_DAYS = int(os.environ.get("REFRESH_DAYS", "3"))   # always re-fetch these
EMPTY_STOP = int(os.environ.get("EMPTY_STOP", "45"))      # stop after N empty days in a row
CHECKPOINT_EVERY = 25                                     # write CSV every N fetched days
PAUSE_SECONDS = float(os.environ.get("PAUSE_SECONDS", "1.0"))  # be polite to Garmin

FIELDNAMES = [
    "date",
    "steps",
    "distance_miles",
    "floors",
    "resting_hr",
    "active_calories",
    "total_calories",
    "avg_stress",
    "body_battery_high",
    "body_battery_low",
    "intensity_moderate_min",
    "intensity_vigorous_min",
    "sleep_hours",
    "sleep_score",
    "deep_sleep_min",
    "light_sleep_min",
    "rem_sleep_min",
    "awake_min",
    "sleep_respiration",
    "sleep_spo2",
    "hrv_last_night",
    "hrv_status",
    "vo2max",
]

# ------------------------------------------------------------- garmin io ---


def garmin_client():
    """Same dual-format GARMIN_TOKENS login as cardio_minutes.py."""
    import base64
    import io
    import tarfile
    import tempfile

    from garminconnect import Garmin

    tokens = os.environ.get("GARMIN_TOKENS", "").strip()
    if not tokens:
        g = Garmin()
        g.login("~/.garminconnect")
        return g

    if not tokens.startswith("H4sI"):
        g = Garmin()
        g.login(tokens)
        return g

    buf = io.BytesIO(base64.b64decode(tokens))
    tmp = tempfile.mkdtemp(prefix="garth-")
    with tarfile.open(fileobj=buf, mode="r:gz") as tar:
        tar.extractall(tmp)
    token_dir = os.path.join(tmp, ".garth")
    if not os.path.isdir(token_dir):
        token_dir = tmp
    g = Garmin()
    g.login(token_dir)
    return g


def _num(x, digits=None):
    """None-safe number formatting -> '' or a string."""
    if x is None:
        return ""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return ""
    if digits is None:
        return str(int(v)) if v == int(v) else f"{v}"
    return f"{v:.{digits}f}"


def _call(fn, *args):
    """Call a Garmin endpoint; one retry with backoff; None on failure."""
    for attempt in (1, 2):
        try:
            return fn(*args)
        except Exception as e:  # noqa: BLE001
            if attempt == 1:
                time.sleep(10)
            else:
                print(f"    ! {fn.__name__}: {e}")
    return None


def fetch_day(g, cdate: str) -> dict | None:
    """Fetch one date's wellness row. Returns None if Garmin has nothing."""
    row = {k: "" for k in FIELDNAMES}
    row["date"] = cdate
    got_anything = False

    summary = _call(g.get_user_summary, cdate) or {}
    if summary.get("totalSteps") is not None or summary.get("restingHeartRate") is not None:
        got_anything = True
    row["steps"] = _num(summary.get("totalSteps"))
    dist_m = summary.get("totalDistanceMeters")
    row["distance_miles"] = _num(dist_m / 1609.344, 2) if dist_m else ""
    row["floors"] = _num(summary.get("floorsAscended"), 1)
    row["resting_hr"] = _num(summary.get("restingHeartRate"))
    row["active_calories"] = _num(summary.get("activeKilocalories"))
    row["total_calories"] = _num(summary.get("totalKilocalories"))
    stress = summary.get("averageStressLevel")
    row["avg_stress"] = _num(stress) if stress is not None and float(stress) >= 0 else ""
    row["body_battery_high"] = _num(summary.get("bodyBatteryHighestValue"))
    row["body_battery_low"] = _num(summary.get("bodyBatteryLowestValue"))
    row["intensity_moderate_min"] = _num(summary.get("moderateIntensityMinutes"))
    row["intensity_vigorous_min"] = _num(summary.get("vigorousIntensityMinutes"))

    sleep = _call(g.get_sleep_data, cdate) or {}
    dto = sleep.get("dailySleepDTO") or {}
    secs = dto.get("sleepTimeSeconds")
    if secs:
        got_anything = True
        row["sleep_hours"] = _num(secs / 3600.0, 2)
        scores = dto.get("sleepScores") or {}
        row["sleep_score"] = _num((scores.get("overall") or {}).get("value"))
        row["deep_sleep_min"] = _num((dto.get("deepSleepSeconds") or 0) / 60.0, 0)
        row["light_sleep_min"] = _num((dto.get("lightSleepSeconds") or 0) / 60.0, 0)
        row["rem_sleep_min"] = _num((dto.get("remSleepSeconds") or 0) / 60.0, 0)
        row["awake_min"] = _num((dto.get("awakeSleepSeconds") or 0) / 60.0, 0)
        row["sleep_respiration"] = _num(dto.get("averageRespirationValue"), 1)
        row["sleep_spo2"] = _num(dto.get("averageSpO2Value"), 1)

    hrv = _call(g.get_hrv_data, cdate) or {}
    hs = hrv.get("hrvSummary") or {}
    if hs.get("lastNightAvg") is not None:
        got_anything = True
        row["hrv_last_night"] = _num(hs.get("lastNightAvg"))
        row["hrv_status"] = str(hs.get("status") or "")

    metrics = _call(g.get_max_metrics, cdate) or []
    if metrics:
        generic = (metrics[0] or {}).get("generic") or {}
        row["vo2max"] = _num(generic.get("vo2MaxPreciseValue")
                             or generic.get("vo2MaxValue"), 1)

    return row if got_anything else None


# --------------------------------------------------------------- csv io ----


def read_existing(path: str) -> dict[str, dict]:
    if not os.path.exists(path):
        return {}
    with open(path, newline="") as f:
        return {r["date"]: r for r in csv.DictReader(f)}


def write_all(path: str, by_date: dict[str, dict]) -> None:
    rows = [by_date[d] for d in sorted(by_date)]
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


# ----------------------------------------------------------------- main ----


def main() -> int:
    by_date = read_existing(CSV_PATH)
    print(f"existing file: {len(by_date)} days")

    g = garmin_client()

    yesterday = datetime.now(LOCAL_TZ).date() - timedelta(days=1)
    fetched = 0
    empty_streak = 0

    for back in range(MAX_DAYS):
        d = yesterday - timedelta(days=back)
        cdate = d.isoformat()
        if cdate in by_date and back >= REFRESH_DAYS:
            empty_streak = 0          # known data — history continues
            continue

        row = fetch_day(g, cdate)
        fetched += 1
        if row is None:
            empty_streak += 1
            print(f"  - {cdate}: no data ({empty_streak} empty in a row)")
            if empty_streak >= EMPTY_STOP:
                print(f"stopping: {EMPTY_STOP} consecutive empty days — "
                      f"reached the start of Garmin history")
                break
        else:
            empty_streak = 0
            by_date[cdate] = row
            print(f"  + {cdate}: steps={row['steps'] or '-'} rhr={row['resting_hr'] or '-'} "
                  f"sleep={row['sleep_hours'] or '-'}h hrv={row['hrv_last_night'] or '-'}")

        if fetched % CHECKPOINT_EVERY == 0:
            write_all(CSV_PATH, by_date)
            print(f"  checkpoint: wrote {len(by_date)} days")
        time.sleep(PAUSE_SECONDS)

    write_all(CSV_PATH, by_date)
    print(f"wrote {CSV_PATH}: {len(by_date)} days ({fetched} fetched this run)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
