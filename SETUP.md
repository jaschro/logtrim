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
3. Tap **Add to Home Screen** → **Add**

**Android (Chrome):**
1. Open your app URL in Chrome
2. Tap the ⋮ menu → **Add to Home screen** (or "Install app")

It now behaves like a regular app icon. Repeat Step 5 on the phone the first time you open it (settings are stored per-device).

### Step 7: Set up your gyms

1. In the app: **Settings → Manage Equipment**
2. Add your gym(s), rooms within them, and the machines you use
3. You can take photos of machines with your phone as you add them — very handy for remembering which machine is which
4. The built-in "Common Machines" gym covers generic equipment (outdoor activities, cardio, free weights, classes) with no setup needed

You're done with the core setup. Log your first workout!

---

## Part 2 — Connect Claude as Your Workout Coach (optional)

This lets Claude read your workout history and act as a coach: analyzing progress, suggesting session plans, and answering "how much weight did I use last time?"

### Step 1: Get Claude

1. Sign up at [claude.ai](https://claude.ai) (or download the Claude desktop app)
2. A paid plan is recommended — coaching conversations use a meaningful amount of usage

### Step 2: Create a Claude Project

1. In Claude, create a new **Project** (e.g. "Workout Coach")
2. Copy the contents of `Project-Instructions-Template.md` (in this repository) into the Project's custom instructions
3. Fill in the placeholders — your GitHub username, repo name, and gym names

### Step 3: Let Claude read your data

The simplest approach — your workout CSV is publicly readable if your fork is public:

```
https://raw.githubusercontent.com/YOUR-USERNAME/logtrim/main/workout-log.csv
```

Claude can fetch this URL directly in any conversation. The template instructions tell it how.

**Privacy note:** a public repo means anyone with the URL can see your workout data (dates, exercises, weights — no personal identity info beyond your GitHub username). If you prefer privacy, make the repo private and see "Private repo option" below.

**Private repo option:** if your fork is private, Claude can't fetch the raw URL. Options:
- Use Claude's GitHub connector (in Claude settings → Connectors) to grant read access to your repo, or
- Paste your recent workout data into the conversation when asking for coaching

### Step 4 (advanced, optional): Let Claude push workout plans into the app

This requires deploying a small Cloudflare Worker (free tier) that accepts workout suggestions from Claude and writes them into your repo, where the app displays them as "Today's Plan."

1. Create a free account at [cloudflare.com](https://cloudflare.com)
2. Go to **Workers & Pages** → **Create** → **Create Worker**, give it any name
3. Click **Edit Code**, replace the contents with the `worker.js` file from this repository, and click **Deploy**
4. In the Worker's **Settings → Variables and Secrets**, add:
   - `SECRET_TOKEN` — any password-like string you invent (e.g. `logtrim-x8k2p`)
   - `GITHUB_PAT` — a fine-grained token like Step 4 of Part 1 (Contents: Read and write on your fork)
   - `GITHUB_USER` — your GitHub username
   - `GITHUB_REPO` — `logtrim`
5. Note your Worker URL (e.g. `https://your-worker.your-subdomain.workers.dev`)
6. Fill in the Worker URL and secret token in your Project instructions (the template shows where)

Now you can tell Claude "plan me a workout for tomorrow and push it to my app," and it will appear in LogTrim.

### Garmin integration (advanced, optional)

If you have a Garmin watch, the repo includes scripts (`scripts/garmin_sync.py` and `.github/workflows/garmin-sync.yml`) that automatically pull your daily stats (steps, sleep, heart rate zones, training readiness) into the repo on a schedule, where Claude can read them for recovery-aware coaching. This requires:

1. Running `scripts/garmin_auth_setup.py` locally once to generate Garmin auth tokens
2. Adding `GARMIN_TOKENS` and `GARMIN_DISPLAY_NAME` as repository secrets (repo **Settings → Secrets and variables → Actions**)
3. Editing the `if: github.repository ==` line in `.github/workflows/garmin-sync.yml` to match your fork

This is the fiddliest part of setup — feel free to skip it, or ask Claude to walk you through it once your Project is set up.

---

## Troubleshooting

- **App shows old version after an update:** hard-refresh (Ctrl+Shift+R on desktop; on phone, close the tab fully and reopen)
- **"Set up GitHub in Settings first":** the username/repo/token fields aren't all filled in, or the token is wrong
- **Save fails:** token may have expired, or its Contents permission isn't Read and write
- **Pages site is 404:** GitHub Pages can take a few minutes after enabling; check repo Settings → Pages for the status
