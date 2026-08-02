#!/usr/bin/env python3
"""
Fetches recent Garmin Connect data and writes garmin-recent.json to the repo.
Runs via GitHub Actions on a daily schedule.

Required GitHub Secrets:
  GARMIN_EMAIL    — your Garmin Connect email
  GARMIN_PASSWORD — your Garmin Connect password
"""
import os
import json
import sys
from datetime import date, timedelta, datetime

try:
    import garminconnect
except ImportError:
    os.system(f"{sys.executable} -m pip install garminconnect")
    import garminconnect


def safe_get(fn, *args, default=None, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        print(f"  Warning: {fn.__name__} failed — {e}")
        return default


def main():
    email    = os.environ.get("GARMIN_EMAIL", "")
    password = os.environ.get("GARMIN_PASSWORD", "")
    if not email or not password:
        print("ERROR: GARMIN_EMAIL and GARMIN_PASSWORD must be set.")
        sys.exit(1)

    token_dir = os.path.expanduser("~/.garth")

    print("Connecting to Garmin Connect…")
    garmin = garminconnect.Garmin(email=email, password=password)
    try:
        # Resume cached session if available
        garmin.login(garth_home=token_dir)
    except Exception:
        garmin.login()
    try:
        garmin.garth.dump(token_dir)   # Save/refresh tokens for next run
    except Exception:
        pass

    today          = date.today()
    today_str      = today.isoformat()
    yesterday_str  = (today - timedelta(days=1)).isoformat()
    two_weeks_ago  = (today - timedelta(days=14)).isoformat()

    # ── Activities ────────────────────────────────────────────────────────────
    print("Fetching activities…")
    raw_activities = safe_get(
        garmin.get_activities_by_date, two_weeks_ago, today_str, default=[]
    )
    activities = []
    for a in raw_activities:
        dist_m = a.get("distance") or 0
        dur_s  = a.get("duration") or 0
        activities.append({
            "date":          (a.get("startTimeLocal") or "")[:10],
            "type":          (a.get("activityType") or {}).get("typeKey", "unknown"),
            "name":          a.get("activityName", ""),
            "durationMins":  round(dur_s / 60, 1),
            "distanceMiles": round(dist_m / 1609.34, 2) if dist_m else None,
            "avgHR":         a.get("averageHR"),
            "maxHR":         a.get("maxHR"),
            "calories":      a.get("calories"),
        })

    # ── Daily stats (today) ────────────────────────────────────────────────────
    print("Fetching daily stats…")
    stats = safe_get(garmin.get_stats, today_str, default={})

    # ── Body battery ──────────────────────────────────────────────────────────
    print("Fetching body battery…")
    bb_raw       = safe_get(garmin.get_body_battery, [today_str, today_str], default=[])
    body_battery = None
    if bb_raw and isinstance(bb_raw, list):
        entry = bb_raw[0] if isinstance(bb_raw[0], dict) else {}
        body_battery = entry.get("charged") or entry.get("bodyBatteryStatList", [None])[0]

    # ── HRV ───────────────────────────────────────────────────────────────────
    print("Fetching HRV…")
    hrv_raw = safe_get(garmin.get_hrv_data, today_str, default=None)
    hrv     = None
    if hrv_raw:
        summary = hrv_raw.get("hrvSummary") or {}
        hrv = {
            "weeklyAvg":  summary.get("weeklyAvg"),
            "lastNight":  summary.get("lastNight"),
            "status":     summary.get("status"),    # e.g. "BALANCED", "LOW", "UNBALANCED"
        }

    # ── Sleep ─────────────────────────────────────────────────────────────────
    print("Fetching sleep…")
    sleep_raw = safe_get(garmin.get_sleep_data, yesterday_str, default=None)
    sleep     = None
    if sleep_raw:
        dto = sleep_raw.get("dailySleepDTO") or {}
        scores = dto.get("sleepScores") or {}
        sleep = {
            "date":           yesterday_str,
            "durationHours":  round((dto.get("sleepTimeSeconds") or 0) / 3600, 1),
            "score":          (scores.get("overall") or {}).get("value"),
            "deepSleepMins":  round((dto.get("deepSleepSeconds")  or 0) / 60),
            "lightSleepMins": round((dto.get("lightSleepSeconds") or 0) / 60),
            "remSleepMins":   round((dto.get("remSleepSeconds")   or 0) / 60),
            "awakeMins":      round((dto.get("awakeSleepSeconds") or 0) / 60),
        }

    # ── Stress ────────────────────────────────────────────────────────────────
    print("Fetching stress…")
    stress_raw  = safe_get(garmin.get_stress_data, today_str, default=None)
    stress_avg  = None
    if stress_raw:
        stress_avg = stress_raw.get("avgStressLevel") or stress_raw.get("overallStressLevel")

    # ── Assemble output ───────────────────────────────────────────────────────
    output = {
        "fetchedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "today": today_str,
        "recentActivities": activities,
        "todayStats": {
            "steps":          stats.get("totalSteps"),
            "restingHR":      stats.get("restingHeartRate"),
            "activeCalories": stats.get("activeKilocalories"),
            "bodyBattery":    body_battery,
            "stressAvg":      stress_avg or stats.get("averageStressLevel"),
        },
        "hrv":   hrv,
        "sleep": sleep,
    }

    out_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "garmin-recent.json"
    )
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"✓ Wrote garmin-recent.json  ({len(activities)} activities in last 14 days)")


if __name__ == "__main__":
    main()
