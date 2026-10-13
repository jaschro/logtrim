# cardio-minutes.csv — Setup

Pipeline that pulls per-sample heart-rate data from Garmin Connect and
maintains one always-sorted `cardio-minutes.csv` in this repo.

## What goes where

```
logtrim/
├── scripts/
│   ├── cardio_minutes.py      # the pipeline
│   └── garmin_login.py        # one-time token generator
├── .github/workflows/
│   └── cardio-minutes.yml     # daily scheduled run
└── cardio-minutes.csv         # created on first run
```

## One-time setup (~5 minutes)

1. **Copy the three files** into the repo at the paths above and push.

2. **Generate the Garmin token blob** on your Mac:
   ```
   pip install garminconnect
   python scripts/garmin_login.py
   ```
   Enter your Garmin email/password (MFA code if prompted). It prints a
   long base64 string. Your password is used once and never stored;
   the token is what the Action uses, and it lasts about a year.

3. **Add the secret:** GitHub → jaschro/logtrim → Settings → Secrets and
   variables → Actions → New repository secret.
   Name: `GARMIN_TOKENS`. Value: the base64 string from step 2.

4. **First run:** Actions tab → `cardio-minutes` → Run workflow.
   It will fetch your 30 most recent activities and commit the CSV.
   After that it runs daily at ~5:20 AM ET automatically.

## The file

One row per clock minute (America/New_York) of any Garmin activity with HR:

| column | meaning |
|---|---|
| `date` | NY calendar date |
| `activity_id` | Garmin activity ID (dedup key) |
| `activity_type` | e.g. `running`, `treadmill_running`, `elliptical` |
| `minute` | `YYYY-MM-DD HH:MM`, NY local |
| `avg_hr_weighted` | time-weighted mean HR for that minute |
| `seconds_covered` | seconds of actual sensor coverage in that minute |

Design notes baked in: readings are forward-filled to the next sample
(smart-recording semantics), gaps are capped at 30 s, boundary-spanning
readings are split proportionally, every minute is written regardless of
coverage (apply your ≥10 s filter at analysis time), no zone columns —
classify against whatever zones you like, re-rollable forever.

## Backfill

The daily run fetches the 30 most recent activities. For a deeper
historical backfill, run once with a bigger window (locally or by
editing the workflow env):

```
ACTIVITY_FETCH_LIMIT=300 GARMIN_TOKENS="..." python scripts/cardio_minutes.py
```

## When auth eventually expires (~1 year)

The Action will start failing with an auth error. Re-run
`garmin_login.py` and update the `GARMIN_TOKENS` secret. That's it.

## Note on the Garmin API

This uses Garmin's unofficial Connect API via the `garminconnect`
library. It's well-maintained but not contractual — if Garmin changes
something, the Action may fail until the library updates. The CSV is
append-only from your side, so nothing already written is ever at risk.

## cardio-buckets.csv — what the app reads

`build_cardio_buckets.py` runs in the same Action right after the CSV update
and rebuilds `cardio-buckets.csv` in full: **one row per Garmin activity**,
with the minutes spent in each 5-bpm heart-rate bucket.

| column | meaning |
|---|---|
| `date`, `start` | NY date and first minute of the activity |
| `activity_id`, `activity_type` | as in `cardio-minutes.csv` |
| `minutes` | minutes with at least 10 s of sensor coverage |
| `avg_hr`, `max_minute_hr` | over those minutes |
| `corrected` | `y` if `corrections.json` changed this activity |
| `hr_under70`, `hr70_74`, … `hr180_184`, `hr185_up` | minutes in each bucket (blank = 0) |

Heart-rate data is stored as buckets, never as zones. A zone is a boundary
table that changes with every retest or coach; the app applies whatever
boundaries are current when it displays the data (zone floors and
heart-rate-range goals both live in `goals.json`, editable under
Settings → Weekly Goals). Changing a boundary rewrites nothing.

A log row is linked to its activity by the `Garmin <activity_id>` tag in its
notes. Weekly heart-rate-range goals count only activities that have a row in
the workout log.

### Hand corrections

Never edit `cardio-buckets.csv` — it is regenerated every run. Put the fix in
`cardio-minutes-pipeline/corrections.json`, keyed by activity ID:

```json
"24509403359": {
  "note":   "watch left recording ~3 h after the ride",
  "keep":   ["2026-09-26 11:26", "2026-09-26 12:04"],
  "set_hr": [{ "from": "2026-09-24 12:42", "to": "2026-09-24 12:59", "hr": 127 }],
  "add":    [{ "minutes": 9.4, "hr": 85 }]
}
```

`keep` drops minutes outside the window, `set_hr` overrides a stretch the
sensor misread, `add` supplies minutes the watch did not record. Tests:
`python -m unittest discover -s cardio-minutes-pipeline -p "test_*.py"`.
