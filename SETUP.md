# LogTrim — New User Setup Guide

LogTrim is a free, self-hosted workout tracker. Your workout data lives in **your own GitHub repository** — no accounts, no subscriptions, no one else's servers. The app runs as a web page (hosted free on GitHub Pages) and works on desktop and phone.

Optionally, you can connect it to Claude (Anthropic's AI assistant) to act as your personal workout coach — it can read your history and push suggested workouts into the app.

Setup takes about 20–30 minutes.

---

## Part 1 — Get the App Running (required)

### Step 1: Create a GitHub account

1. Go to [github.com](https://github.com) and click **Sign up**
2. Choose a username (you'll use this in the app later), verify your email
3. The free plan is all you need

### Step 2: Fork the LogTrim repository

"Forking" makes your own personal copy of the app.

1. While logged in to GitHub, go to **github.com/logtrim/logtrim**
2. Click the **Fork** button (top right)
3. Leave the defaults ("Copy the main branch only" is fine) and click **Create fork**
4. You now have your own copy at `github.com/YOUR-USERNAME/logtrim`

### Step 3: Turn on GitHub Pages (this hosts your app)

1. In **your fork**, click **Settings** (the tab in the repo, not your account settings)
2. In the left sidebar, click **Pages**
3. Under "Build and deployment" → Source, choose **Deploy from a branch**
4. Branch: select **main** and **/ (root)**, then click **Save**
5. Wait 1–2 minutes, then refresh the page. You'll see your app URL:
   `https://YOUR-USERNAME.github.io/logtrim/`
6. Open that URL — you should see the LogTrim app

### Step 4: Create a fine-grained access token

The app needs permission to save your workouts to your repository. A "fine-grained token" grants access to *only* your logtrim repo — nothing else.

1. On GitHub, click your profile photo (top right) → **Settings**
2. Scroll to the bottom of the left sidebar → **Developer settings**
3. Click **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
4. Fill in:
   - **Token name:** `logtrim-app`
   - **Expiration:** 1 year (or "No expiration" if offered — you can always revoke it)
   - **Repository access:** choose **Only select repositories** → select `YOUR-USERNAME/logtrim`
   - **Permissions** → Repository permissions → **Contents** → set to **Read and write**
5. Click **Generate token**
6. **Copy the token immediately** (it starts with `github_pat_…`) and save it somewhere safe — GitHub only shows it once

> Keep this token handy. If you set up the Claude coach in Part 2, you'll use the same one — there's no need for a second token.

### Step 5: Connect the app

1. Open your app: `https://YOUR-USERNAME.github.io/logtrim/`
2. Tap the ⚙️ (Settings) icon
3. Under **GitHub Connection**, enter:
   - **Username:** your GitHub username
   - **Repository:** `logtrim`
   - **Token:** paste the token from Step 4
4. Tap **Connect & Load Data**
5. You should see the app load with the built-in "Common Machines" equipment

### Step 6: Add it to your phone

**iPhone (Safari):**
1. Open your app URL in Safari
2. Tap the Share button (square with arrow)
3. Scroll down the list of actions and tap **Add to Home Screen** → **Add**

It must be Safari — Chrome and in-app browsers don't offer this. If you don't see the option, scroll further down the share sheet; it sits below Add to Bookmarks and Add to Favorites.

**Android (Chrome):**
1. Open your app URL in Chrome
2. Tap the ⋮ menu → **Add to Home screen** (or "Install app")

It now behaves like a regular app icon. Repeat Step 5 on the phone the first time you open it (settings are stored per-device).

### Step 7: Set up your gyms

1. In the app: **Settings → Manage Equipment**
2. Tap **📚 Import from Gym Catalog** to pull in a ready-made gym — machines, layout and photos already filled in. If yours isn't listed, skip this and add it by hand.
3. Add your gym(s), rooms within them, and the machines you use
4. You can take photos of machines with your phone as you add them — very handy for remembering which machine is which
5. The built-in "Common Machines" gym covers generic equipment (outdoor activities, cardio, free weights, classes) with no setup needed

You're done with the core setup. Log your first workout!

---

## Part 2 — Connect Claude as Your Workout Coach (optional)

This lets Claude read your workout history and act as a coach: analyzing progress, suggesting session plans, answering "how much weight did I use last time?", and writing a plan straight into the app.

**Log a few real workouts before starting this.** Claude builds plans from the machines in your history, so it needs something to work with.

### Step 1: Get Claude

1. Sign up at [claude.ai](https://claude.ai) (or download the Claude desktop app)
2. A paid plan is recommended — coaching conversations use a meaningful amount of usage

### Step 2: Turn on network access

Claude needs to be able to reach GitHub to read your log and write plans.

In Claude: **Settings → Capabilities** → make sure **Allow network egress** is switched on. (On a Team or Enterprise account this appears as a Domain allowlist controlled by the organization owner.)

### Step 3: Create a Claude Project

1. In Claude, create a new **Project** (e.g. "Workout Coach")
2. Copy the contents of `Project-Instructions-Template.md` (in this repository) into the Project's custom instructions
3. Fill in the placeholders — your name, GitHub username, gym names, and the token from Part 1 Step 4

### Step 4: Check that Claude can read your data

Your workout log is a plain file in your repo:

```
https://raw.githubusercontent.com/YOUR-USERNAME/logtrim/main/workout-log.csv
```

If your fork is public, Claude can fetch this with no authentication at all. Start a conversation in your Project and ask "what did I do in my last workout?" — it should answer from the file.

**Privacy note:** a public repo means anyone with the URL can see your workout data (dates, exercises, weights — no personal identity info beyond your GitHub username). If you prefer privacy, make the repo private; Claude then reads through the token instead, using the same GitHub API it uses to write.

### Step 5: Let Claude push workout plans into the app

Nothing more to install — this works as soon as the token from Part 1 is in your Project instructions.

Say: **"Look at my recent workouts and push a plan for tomorrow to my app."**

Claude writes a file called `suggested-workout.json` into your repository using the GitHub API. The app reads that file and displays it as **Today's Plan** at the top of the screen. Refresh LogTrim (or fully close and reopen it on your phone) and the plan is there.

**What you're trading:** the token sits in your Project's instructions, which only you can see. It's scoped to this one repository and can only read and write files there — it can't touch your other repos or your account. If that's not a trade you want to make, see `worker.js` in this repository for a relay-based alternative that keeps the token out of Claude's hands, at the cost of a Cloudflare account and about twenty minutes of setup.

### Garmin integration (advanced, optional)

If you have a Garmin watch, the repo ships with **two** scheduled GitHub Actions
pipelines that pull your Garmin data into your fork, where the app and Claude can
use it:

- **Garmin Sync** (`scripts/garmin_sync.py`, every 3 hours) — daily stats like
  steps, sleep, heart rate zones, and training readiness, written to
  `garmin-recent.json`. Useful for recovery-aware coaching.
- **cardio-minutes** (`cardio-minutes-pipeline/`, daily) — per-minute heart-rate
  data from every activity, written to `cardio-minutes.csv`. Useful for
  time-in-zone analysis.

Both are **off by default** — they're skipped until you opt in, so if you don't
use Garmin you can ignore this section entirely.

To enable them:

1. Generate your Garmin auth token blob (one-time, on your computer):
   `pip install garminconnect`, then `python cardio-minutes-pipeline/garmin_login.py`
   (enter your Garmin login; it prints a base64 string — copy it)
2. In your fork: **Settings → Secrets and variables → Actions**
   - **Secrets tab:** add `GARMIN_TOKENS` = the base64 string.
     For Garmin Sync, also add `GARMIN_DISPLAY_NAME` = your Garmin Connect
     display name (find it in your Garmin Connect profile URL).
3. **Variables tab:** add `GARMIN_ENABLED` = `true`. This one variable switches
   both workflows on. Remove it (or set it to anything else) to switch them off.
4. Kick off a first run of each from the **Actions** tab (Run workflow), or just
   wait for the schedule.

For more detail on the per-minute pipeline (CSV format, backfilling history,
token renewal), see `cardio-minutes-pipeline/CARDIO-MINUTES-SETUP.md`.

---

## Troubleshooting

### The app

- **App shows old version after an update:** hard-refresh (Ctrl+Shift+R on desktop; on phone, close the tab fully and reopen)
- **"Set up GitHub in Settings first":** the username/repo/token fields aren't all filled in, or the token is wrong
- **Save fails:** token may have expired, or its Contents permission isn't Read and write
- **Pages site is 404:** GitHub Pages can take a few minutes after enabling; check repo Settings → Pages for the status
- **No "Add to Home Screen" on iPhone:** you're not in Safari, or you're in a Private tab, or the action was hidden — scroll to the bottom of the share sheet and check **Edit Actions**

### The Claude coach

- **Claude hands you a long URL to paste instead of pushing:** network access is off, or it hasn't been told to make the call itself. Check Part 2 Step 2, and that the push section of your Project instructions is intact.
- **403 when pushing:** the token is missing **Contents: Read and write**
- **404 when pushing:** the token isn't scoped to this repo, or the username in the instructions is wrong
- **401 when pushing:** the token is invalid or has expired — generate a new one and update both the app and the Project instructions
- **409 when pushing:** a stale file version; Claude should re-read the file's `sha` and retry
- **Plan pushed but not visible:** the app cached the old page — fully close and reopen it
- **Claude can't find your workouts:** confirm the username in the instructions, and that you've logged at least a few sessions
