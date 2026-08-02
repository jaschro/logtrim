// LogTrim Claude Suggest — Cloudflare Worker
//
// Endpoints:
//   GET /log?token=SECRET          — returns workout-log.csv (for Claude to read)
//   GET /profile?token=SECRET      — returns profile.json (for Claude to read)
//   GET /?token=SECRET&data=BASE64 — writes suggested-workout.json to GitHub
//
// Required environment variables:
//   SECRET_TOKEN  — any string you choose; Claude includes it to authenticate
//   GITHUB_PAT    — Personal Access Token with repo write access
//   GITHUB_USER   — your GitHub username (e.g. jaschro)
//   GITHUB_REPO   — your repo name (e.g. logtrim)

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    // Authenticate all requests
    if (!token || token !== env.SECRET_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors });
    }

    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'LogTrim-Suggest-Worker/1.0'
    };
    const apiBase = `https://api.github.com/repos/${env.GITHUB_USER}/${env.GITHUB_REPO}/contents`;

    // GET /log — return workout-log.csv for Claude to read
    if (url.pathname === '/log') {
      const res = await fetch(`${apiBase}/workout-log.csv`, { headers: ghHeaders });
      if (!res.ok) return new Response(JSON.stringify({ error: 'Could not fetch log' }), { status: 502, headers: cors });
      const file = await res.json();
      const csv = atob(file.content.replace(/\n/g, ''));
      return new Response(csv, { headers: { ...cors, 'Content-Type': 'text/csv' } });
    }

    // GET /profile — return profile.json for Claude to read
    if (url.pathname === '/profile') {
      const res = await fetch(`${apiBase}/profile.json`, { headers: ghHeaders });
      if (!res.ok) return new Response(JSON.stringify({ error: 'Could not fetch profile' }), { status: 502, headers: cors });
      const file = await res.json();
      const json = atob(file.content.replace(/\n/g, ''));
      return new Response(json, { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // GET /garmin — return garmin-recent.json for Claude to read
    if (url.pathname === '/garmin') {
      const res = await fetch(`${apiBase}/garmin-recent.json`, { headers: ghHeaders });
      if (!res.ok) return new Response(JSON.stringify({ error: 'No Garmin data found — has the sync run yet?' }), { status: 404, headers: cors });
      const file = await res.json();
      const json = atob(file.content.replace(/\n/g, ''));
      return new Response(json, { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // GET /?token=SECRET&data=BASE64 — push a workout suggestion
    const data = url.searchParams.get('data');

    if (!data) {
      return new Response(JSON.stringify({ error: 'Missing data parameter' }), { status: 400, headers: cors });
    }

    // Decode base64 → JSON
    let suggestion;
    try {
      suggestion = JSON.parse(atob(data));
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid data: ' + e.message }), { status: 400, headers: cors });
    }

    const filePath = 'suggested-workout.json';

    // Get current SHA if the file already exists (required to overwrite)
    let sha = null;
    try {
      const getRes = await fetch(`${apiBase}/${filePath}`, { headers: ghHeaders });
      if (getRes.ok) {
        const existing = await getRes.json();
        sha = existing.sha;
      }
    } catch (_) {
      // File doesn't exist yet — that's fine
    }

    // Write the suggestion file
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(suggestion, null, 2))));
    const body = { message: 'Update workout suggestion', content };
    if (sha) body.sha = sha;

    const putRes = await fetch(`${apiBase}/${filePath}`, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return new Response(
        JSON.stringify({ error: `GitHub write failed: ${putRes.status}`, detail: errText }),
        { status: 502, headers: cors }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, message: 'Workout suggestion saved! Open LogTrim to see Today\'s Plan.' }),
      { headers: cors }
    );
  }
};
