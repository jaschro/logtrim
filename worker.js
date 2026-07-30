// LogTrim Claude Suggest — Cloudflare Worker
//
// Accepts a GET request from Claude and writes suggested-workout.json to GitHub.
//
// Required environment variables (set in Cloudflare dashboard → Workers → Settings → Variables):
//   SECRET_TOKEN  — any string you choose; Claude includes it to authenticate
//   GITHUB_PAT    — Personal Access Token with repo write access
//   GITHUB_USER   — your GitHub username (e.g. jaschro)
//   GITHUB_REPO   — your repo name (e.g. logtrim)
//
// Usage from Claude:
//   https://your-worker.your-subdomain.workers.dev/?token=SECRET&data=BASE64_JSON
//
// where BASE64_JSON is btoa(JSON.stringify(suggestionObject))

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
    const data  = url.searchParams.get('data');

    // Authenticate
    if (!token || token !== env.SECRET_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors });
    }

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

    const apiBase = `https://api.github.com/repos/${env.GITHUB_USER}/${env.GITHUB_REPO}/contents`;
    const filePath = 'suggested-workout.json';
    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'LogTrim-Suggest-Worker/1.0'
    };

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
      headers: ghHeaders,
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
