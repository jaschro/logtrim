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


def get_stats_for_date(garmin, date_str, user_pk=None):
    """Fetch daily summary stats.
    Tries get_stats() first; if display_name is not set, falls back to a
    direct API call using the numeric userProfilePK."""
    result = safe_get(garmin.get_stats, date_str, default=None)
    if result is not None:
        return result
    if not user_pk:
        return {}
    path = f"/usersummary-service/usersummary/daily/{user_pk}?calendarDate={date_str}"
    # Try every known way to call the Connect API directly
    attempts = [
        ("garmin.connectapi",            lambda: garmin.connectapi(path)),
        ("garmin.client.connectapi",     lambda: garmin.client.connectapi(path)),
        ("garmin.client.garth.connectapi", lambda: garmin.client.garth.connectapi(path)),
        ("garmin.client.get",            lambda: garmin.client.get("connectapi", path).json()),
        ("garmin.client.garth.get",      lambda: garmin.client.garth.get("connectapi", path).json()),
        ("garmin.garth.connectapi",      lambda: garmin.garth.connectapi(path)),
        ("garmin.garth.get",             lambda: garmin.garth.get("connectapi", path).json()),
    ]
    for label, attempt in attempts:
        try:
            result = attempt()
            print(f"  Got stats via {label}")
            return result if isinstance(result, dict) else result.json()
        except AttributeError:
            continue                       # this path doesn't exist — try next
        except Exception as e:
            print(f"  Warning: {label} failed — {e}")
            break                          # path exists but API error — stop
    print(f"  Warning: all direct stats paths failed for pk={user_pk}")
    return {}


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

    # Resolve display_name and userProfilePK.
    # display_name is set during login but not restored with tokens.
    # Garmin privacy settings make the social profile API return an empty displayName,
    # so we try multiple sources. userProfilePK is a reliable fallback for stats calls.
    _user_pk = None

    if not getattr(garmin, 'display_name', None):
        # 0. GARMIN_DISPLAY_NAME env var / secret (quickest override)
        _dn = os.environ.get("GARMIN_DISPLAY_NAME", "").strip()
        if _dn:
            garmin.display_name = _dn
            print(f"  display_name set from GARMIN_DISPLAY_NAME: {_dn}")

    if not getattr(garmin, 'display_name', None):
        # 1a. Read display_name.json saved explicitly by garmin_auth_setup.py
        _dn_file = os.path.join(token_dir, "display_name.json")
        if os.path.exists(_dn_file):
            with open(_dn_file) as _f:
                _dn = json.load(_f).get("display_name")
            if _dn:
                garmin.display_name = _dn
                print(f"  display_name set from display_name.json: {_dn}")

    if not getattr(garmin, 'display_name', None):
        # 1b. Read garth's saved profile.json (present when garth >= 0.4 was used for auth)
        _profile_json = os.path.join(token_dir, "profile.json")
        if os.path.exists(_profile_json):
            with open(_profile_json) as _f:
                _prof = json.load(_f)
            _dn = _prof.get("display_name") or _prof.get("displayName") or _prof.get("userName")
            if _dn:
                garmin.display_name = _dn
                print(f"  display_name set from profile.json: {_dn}")

    if not getattr(garmin, 'display_name', None):
        # 2. Try garth in-memory profile object
        for _getter in [lambda: garmin.garth, lambda: garmin.client.garth, lambda: garmin.client]:
            try:
                _obj = _getter()
                _p = getattr(_obj, 'profile', None)
                if _p:
                    _dn = getattr(_p, 'display_name', None)
                    if not _dn and hasattr(_p, 'get'):
                        _dn = _p.get('display_name') or _p.get('displayName')
                    if _dn:
                        garmin.display_name = _dn
                        print(f"  display_name set from garth.profile: {_dn}")
                        break
            except AttributeError:
                continue

    # 3. Call user profile API — extracts PK and userData (contains vo2MaxRunning etc.)
    _user_data = {}
    try:
        _api_profile = garmin.get_user_profile()
        if isinstance(_api_profile, dict):
            _user_pk = _api_profile.get("id") or _api_profile.get("userProfileId")
            _user_data = _api_profile.get("userData") or {}
    except Exception as _e:
        print(f"  Warning: could not fetch user profile — {_e}")

    # 4. Try the social profile endpoint (same one garth uses during login for display_name)
    if not getattr(garmin, 'display_name', None) and hasattr(garmin, 'connectapi'):
        try:
            _sp = garmin.connectapi("/userprofile-service/socialProfile")
            if isinstance(_sp, dict):
                _dn = _sp.get("displayName") or _sp.get("userName") or _sp.get("screenName")
                if _dn:
                    garmin.display_name = _dn
                    print(f"  display_name set from socialProfile: {_dn}")
        except Exception as _e:
            print(f"  Warning: socialProfile call failed — {_e}")

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
    stats = get_stats_for_date(garmin, today_str, _user_pk)
    if not stats.get("totalSteps") and not stats.get("restingHeartRate"):
        # Workflow can run near midnight UTC before today's data exists; try yesterday
        print("  No data for today yet — trying yesterday")
        stats = get_stats_for_date(garmin, yesterday_str, _user_pk)

    # ── Body battery ──────────────────────────────────────────────────────────
    print("Fetching body battery…")
    bb_raw = safe_get(garmin.get_body_battery, today_str, today_str, default=None)
    if not bb_raw:
        bb_raw = safe_get(garmin.get_body_battery, [today_str, today_str], default=None)
    print(f"  RAW body battery: {bb_raw}")
    body_battery = None
    if bb_raw and isinstance(bb_raw, list) and len(bb_raw) > 0:
        entry = bb_raw[0] if isinstance(bb_raw[0], dict) else {}
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
    # get_max_metrics returns [] for Venu 4; use userData from get_user_profile instead
    vo2max = None
    if isinstance(_user_data, dict):
        _v = _user_data.get("vo2MaxRunning") or _user_data.get("vo2MaxCycling")
        if _v:
            vo2max = {"vo2max": _v, "fitnessAge": None}  # fitnessAge not in userData

    # ── Weekly intensity minutes ───────────────────────────────────────────────
    print("Fetching intensity minutes…")
    intensity_raw = safe_get(garmin.get_intensity_minutes_data, today_str, default=None)
    intensity_minutes = None
    if intensity_raw:
        intensity_minutes = {
            "moderate": (
                intensity_raw.get("weeklyModerate")           # actual field name
                or intensity_raw.get("moderateMinutes")
                or intensity_raw.get("weeklyModerateIntensityMinutes")
            ),
            "vigorous": (
                intensity_raw.get("weeklyVigorous")           # actual field name
                or intensity_raw.get("vigorousMinutes")
                or intensity_raw.get("weeklyVigorousIntensityMinutes")
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
