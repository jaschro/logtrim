# LogTrim

A simple, free, self-hosted workout logger. Your workout data lives in **your own
GitHub repository** — no accounts, no subscriptions, no one else's servers. The app
is a single web page hosted free on GitHub Pages, and it works on desktop and phone.

**Want your own copy?** Follow **[SETUP.md](SETUP.md)**: fork this repo, turn on
GitHub Pages, create one access token, and you're logging workouts in about
20–30 minutes.

## Optional extras (all covered in SETUP.md)

- **Claude as your workout coach** — connect a Claude Project that reads your
  workout history, suggests sessions, and writes plans into the app as
  "Today's Plan". It uses the same access token the app already uses; there is
  nothing extra to deploy.
- **Garmin integration** — scheduled GitHub Actions that pull your daily Garmin
  stats (`garmin-recent.json`) and per-minute heart-rate data
  (`cardio-minutes.csv`) into your repo. Off by default; enabled with one
  repository variable and two secrets — see SETUP.md.

## Repo tour

- `index.html` — the app itself
- `SETUP.md` — new-user setup guide (start here)
- `equipment/` — gym and machine definitions with images. Ships with the
  generic "Common Machines" set; real gyms are imported from the
  [gym catalog](https://github.com/logtrim/gyms) inside the app
  (Settings → Manage Equipment → Import from Gym Catalog)
- `scripts/garmin_sync.py` + `.github/workflows/garmin-sync.yml` — Garmin
  daily-stats pipeline (opt-in)
- `cardio-minutes-pipeline/` + `.github/workflows/cardio-minutes.yml` — Garmin
  per-minute heart-rate pipeline (opt-in)
- `Project-Instructions-Template.md` — starting point for your Claude coach Project
- `worker.js` — optional Cloudflare Worker relay. Not needed for normal setup;
  it exists for people who would rather Claude never hold a GitHub token. See
  the note at the end of Part 2 in SETUP.md.

## License

See [LICENSE](LICENSE).
