#!/usr/bin/env python3
"""
Fetches recent Garmin Connect data and writes garmin-recent.json to the repo.
Runs via GitHub Actions on a daily schedule.

Authentication (preferred):
  Set GARMIN_TOKENS — a base64-encoded tarball of ~/.garth tokens generated
  locally by running: python scripts/garmin_auth_setup.py
  Store the output as a GitHub Actions secret named GARMIN_TOKENS.

Fallback (local only — blocked in CI by Garmin rate-limiting):
  GARMIN_EMAIL + GARMIN_PASSWORD
"""
import base64
import io
import json
import os
import sys
import tarfile
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
    token_dir  = os.path.expanduser("~/.garth")
    tokens_b64 = os.environ.get("GARMIN_TOKENS", "")

    print("Connecting to Garmin Connect…")

    if tokens_b64:
        # Restore pre-authenticated tokens — avoids email/password + MFA in CI
        print("  Restoring tokens from GARMIN_TOKENS secret…")
        buf = io.BytesIO(base64.b64decode(tokens_b64))
        with tarfile.open(fileobj=buf, mode='r:gz') as tar:
            tar.extractall(os.path.expanduser("~"))
        garmin = garminconnect.Garmin()
        # garminconnect API varies by version — try each possible attribute path
        for getter in [
            lambda: garmin.garth,
            lambda: garmin.client.garth,
            lambda: garmin.client,
        ]:
            try:
                obj = getter()
                if hasattr(obj, 'load'):
                    obj.load(token_dir)
                    break
                elif hasattr(obj, 'resume'):
                    obj.resume(token_dir)
                    break
            except AttributeError:
                continue
    else:
        # Fallback: direct login (works locally; blocked in CI by Garmin rate-limiting)
        email    = os.environ.get("GARMIN_EMAIL", "")
        password = os.environ.get("GARMIN_PASSWORD", "")
        if not email or not password:
            print("ERROR: Set GARMIN_TOKENS (preferred) or GARMIN_EMAIL + GARMIN_PASSWORD.")
            sys.exit(1)
        garmin = garminconnect.Garmin(email=email, password=password)
        garmin.login()

    # Populate display_name so get_stats works (skipped when restoring tokens)
    try:
        if not getattr(garmin, 'display_name', None):
            profile = garmin.get_user_profile()
            if profile:
                garmin.display_name = (
                    profile.get("displayName")
                    or profile.get("userName")
                    or str(profile.get("userProfileId", ""))
                )
                print(f"  display_name set to: {garmin.display_name}")
    except Exception as e:
        print(f"  Warning: could not fetch user profile — {e}")

    # Persist refreshed tokens for next run
    try:
        os.makedirs(token_dir, exist_ok=True)
        for getter in [lambda: garmin.garth, lambda: garmin.client.garth, lambda: garmin.client]:
            try:
                obj = getter()
                if hasattr(obj, 'dump'):
                    obj.dump(token_dir)
                    break
            except AttributeError:
                continue
    except Exception:
        pass

    today          = date.today()
    today_str      = today.isoformat()
    yesterday_str  = (today - timedelta(days=1)).isoformat()
    two_weeks_ago  = (today - timedelta(days=14)).isoformat()
    week_ago_str   = (today - timedelta(days=7)).isoformat()

    # ── Activities ────────────────────────────────────────────────────────────
    print("Fetching activities…")
    raw_activities = safe_get(
        garmin.get_activities_by_date, two_weeks_ago, today_str, default=[]
    )
    activities = []
    for a in (raw_activities or []):
        dist_m = a.get("distance") or 0
        dur_s  = a.get("duration") or 0
        activities.append({
            "activityId":    a.get("activityId"),
            "date":          (a.get("startTimeLocal") or "")[:10],
            "type":          (a.get("activityType") or {}).get("typeKey", "unknown"),
            "name":          a.get("activityName", ""),
            "durationMins":  round(dur_s / 60, 1),
            "distanceMiles": round(dist_m / 1609.34, 2) if dist_m else None,
            "avgHR":         a.get("averageHR"),
            "maxHR":         a.get("maxHR"),
            "calories":      a.get("calories"),
            "elevationGain": a.get("elevationGain"),
            "avgPace":       a.get("averageSpeed"),   # m/s; convert downstream if needed
        })

    # ── HR zones for 5 most recent activities ─────────────────────────────────
    print("Fetching HR zones for recent activities…")
    for act in activities[:5]:
        aid = act.get("activityId")
        if not aid:
            continue
        zones_raw = safe_get(garmin.get_activity_hr_in_timezones, aid, default=None)
        if zones_raw and isinstance(zones_raw, list):
            act["hrZones"] = [
                {
                    "zone":        z.get("zoneNumber"),
                    "secsInZone":  z.get("secsInZone"),
                }
                for z in zones_raw
            ]

    # ── Daily stats (today) ───────────────────────────────────────────────────
    print("Fetching daily stats…")
    stats = safe_get(garmin.get_stats, today_str, default={}) or {}

    # ── Body battery ──────────────────────────────────────────────────────────
    print("Fetching body battery…")
    # Try both calling conventions (API varies by version)
    bb_raw = safe_get(garmin.get_body_battery, today_str, today_str, default=None)
    if not bb_raw:
        bb_raw = safe_get(garmin.get_body_battery, [today_str, today_str], default=None)
    body_battery = None
    if bb_raw and isinstance(bb_raw, list) and len(bb_raw) > 0:
        entry = bb_raw[0] if isinstance(bb_raw[0], dict) else {}
        # Try several known field names
        body_battery = (
            entry.get("charged")
            or entry.get("endBatteryLevel")
            or (entry.get("bodyBatteryStatList") or [None])[0]
        )

    # ── HRV ───────────────────────────────────────────────────────────────────
    print("Fetching HRV…")
    hrv_raw = safe_get(garmin.get_hrv_data, today_str, default=None)
    # Fall back to yesterday if today's data isn't ready yet
    if not hrv_raw or not (hrv_raw.get("hrvSummary") or {}):
        hrv_raw = safe_get(garmin.get_hrv_data, yesterday_str, default=None)
    hrv = None
    if hrv_raw:
        summary = hrv_raw.get("hrvSummary") or {}
        hrv = {
            "weeklyAvg":  summary.get("weeklyAvg"),
            "lastNight":  summary.get("lastNight"),
            "status":     summary.get("status"),  # e.g. "BALANCED", "LOW", "UNBALANCED"
        }

    # ── Sleep ─────────────────────────────────────────────────────────────────
    print("Fetching sleep…")
    # Try today first (Garmin sometimes files last night's sleep under today)
    sleep_raw = safe_get(garmin.get_sleep_data, today_str, default=None)
    sleep_date = today_str
    if not sleep_raw or not (sleep_raw.get("dailySleepDTO") or {}).get("sleepTimeSeconds"):
        sleep_raw = safe_get(garmin.get_sleep_data, yesterday_str, default=None)
        sleep_date = yesterday_str
    sleep = None
    if sleep_raw:
        dto    = sleep_raw.get("dailySleepDTO") or {}
        scores = dto.get("sleepScores") or {}
        sleep  = {
            "date":              sleep_date,
            "durationHours":     round((dto.get("sleepTimeSeconds")  or 0) / 3600, 1),
            "score":             (scores.get("overall") or {}).get("value"),
            "deepSleepMins":     round((dto.get("deepSleepSeconds")  or 0) / 60),
            "lightSleepMins":    round((dto.get("lightSleepSeconds") or 0) / 60),
            "remSleepMins":      round((dto.get("remSleepSeconds")   or 0) / 60),
            "awakeMins":         round((dto.get("awakeSleepSeconds") or 0) / 60),
            "avgRespirationRate": dto.get("averageRespirationValue"),
            "avgSpO2":           dto.get("averageSpO2Value"),
        }

    # ── Stress ────────────────────────────────────────────────────────────────
    print("Fetching stress…")
    stress_raw = safe_get(garmin.get_stress_data, today_str, default=None)
    stress_avg = None
    if stress_raw:
        stress_avg = stress_raw.get("avgStressLevel") or stress_raw.get("overallStressLevel")

    # ── Training readiness ────────────────────────────────────────────────────
    print("Fetching training readiness…")
    tr_raw = safe_get(garmin.get_training_readiness, today_str, default=None)
    print(f"  RAW training readiness: {tr_raw}")
    training_readiness = None
    if tr_raw:
        entry = tr_raw[0] if isinstance(tr_raw, list) and tr_raw else tr_raw
        if isinstance(entry, dict):
            training_readiness = {
                "score":    entry.get("trainingReadinessScore"),
                "level":    entry.get("trainingReadinessLevel"),
                "feedback": entry.get("trainingReadinessFeedbackShort"),
            }

    # ── VO2 max / fitness age ─────────────────────────────────────────────────
    print("Fetching VO2 max…")
    vo2_raw = safe_get(garmin.get_max_metrics, today_str, default=None)
    print(f"  RAW vo2max: {vo2_raw}")
    vo2max = None
    if vo2_raw:
        entry = vo2_raw[0] if isinstance(vo2_raw, list) and vo2_raw else vo2_raw
        if isinstance(entry, dict):
            generic = entry.get("generic") or entry
            vo2max = {
                "vo2max":      generic.get("vo2MaxValue") or entry.get("vo2MaxValue"),
                "fitnessAge":  generic.get("biologicalAgeInYears") or entry.get("biologicalAgeInYears"),
            }

    # ── Weekly intensity minutes ───────────────────────────────────────────────
    print("Fetching intensity minutes…")
    intensity_raw = safe_get(garmin.get_intensity_minutes_data, today_str, default=None)
    print(f"  RAW intensity minutes: {intensity_raw}")
    intensity_minutes = None
    if intensity_raw:
        intensity_minutes = {
            "moderate": (
                intensity_raw.get("weeklyModerateIntensityMinutes")
                or intensity_raw.get("moderateIntensityMinutes")
            ),
            "vigorous": (
                intensity_raw.get("weeklyVigorousIntensityMinutes")
                or intensity_raw.get("vigorousIntensityMinutes")
            ),
        }

    # ── SpO2 ──────────────────────────────────────────────────────────────────
    print("Fetching SpO2…")
    spo2_raw = safe_get(garmin.get_spo2_data, today_str, default=None)
    spo2_avg = None
    if spo2_raw:
        if isinstance(spo2_raw, dict):
            spo2_avg = (
                spo2_raw.get("averageSpO2")
                or (spo2_raw.get("spO2SleepSummary") or {}).get("averageSpO2")
                or (spo2_raw.get("continuousReadingDTOList") or [{}])[0].get("averageSpo2")
            )

    # ── Respiration ───────────────────────────────────────────────────────────
    print("Fetching respiration…")
    resp_raw = safe_get(garmin.get_respiration_data, today_str, default=None)
    respiration = None
    if resp_raw:
        respiration = {
            "avgWaking": resp_raw.get("avgWakingRespirationValue"),
            "avgSleep":  resp_raw.get("avgSleepRespirationValue") or resp_raw.get("lowestRespirationValue"),
        }

    # ── Floors / weekly steps ─────────────────────────────────────────────────
    print("Fetching floors and weekly steps…")
    floors_today  = stats.get("floorsAscended")
    weekly_steps  = None
    steps_raw     = safe_get(garmin.get_daily_steps, week_ago_str, today_str, default=None)
    if steps_raw and isinstance(steps_raw, list):
        weekly_steps = sum(
            (d.get("totalSteps") or 0) for d in steps_raw if isinstance(d, dict)
        )

    # ── Assemble output ───────────────────────────────────────────────────────
    output = {
        "fetchedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "today":     today_str,
        "recentActivities": activities,
        "todayStats": {
            "steps":            stats.get("totalSteps"),
            "floors":           floors_today,
            "restingHR":        stats.get("restingHeartRate"),
            "activeCalories":   stats.get("activeKilocalories"),
            "bodyBattery":      body_battery,
            "stressAvg":        stress_avg or stats.get("averageStressLevel"),
            "weeklySteps":      weekly_steps,
        },
        "trainingReadiness": training_readiness,
        "vo2max":            vo2max,
        "intensityMinutes":  intensity_minutes,
        "hrv":               hrv,
        "sleep":             sleep,
        "spo2Avg":           spo2_avg,
        "respiration":       respiration,
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
