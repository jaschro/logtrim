// LogTrim Claude Suggest — Cloudflare Worker
//
// Endpoints:
//   GET  /log?token=SECRET            — returns workout-log.csv (for Claude to read)
//   GET  /profile?token=SECRET        — returns profile.json (for Claude to read)
//   GET  /garmin?token=SECRET         — returns garmin-recent.json (for Claude to read)
//   GET  /trigger-sync?token=SECRET   — dispatch the Garmin Sync workflow (garmin-recent.json)
//   GET  /trigger-cardio?token=SECRET[&fetch_limit=N]
//                                     — dispatch the cardio-minutes workflow (per-minute HR CSV)
//   POST /log-write?token=SECRET      — commit workout-log.json + workout-log.csv to the repo
//                                       body: {"logJson": "<full JSON text>", "logCsv": "<full CSV text>",
//                                              "message": "optional commit message", "allowShrink": false}
//   GET  /?token=SECRET&data=BASE64   — writes suggested-workout.json to GitHub
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      'User-Agent': 'LogTrim-Suggest-Worker/1.1'
    };
    const apiBase = `https://api.github.com/repos/${env.GITHUB_USER}/${env.GITHUB_REPO}/contents`;

    const b64 = (str) => btoa(unescape(encodeURIComponent(str)));

    // Fetch a repo file's current { sha, text } (null if it doesn't exist).
    async function getFile(path) {
      const res = await fetch(`${apiBase}/${path}`, { headers: ghHeaders });
      if (!res.ok) return null;
      const file = await res.json();
      return { sha: file.sha, text: decodeURIComponent(escape(atob(file.content.replace(/\n/g, '')))) };
    }

    // PUT one file to the repo (creating or overwriting).
    async function putFile(path, text, message, sha) {
      const body = { message, content: b64(text) };
      if (sha) body.sha = sha;
      const res = await fetch(`${apiBase}/${path}`, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`GitHub write failed for ${path}: ${res.status} ${await res.text()}`);
    }

    // Dispatch a GitHub Actions workflow by file name, with optional inputs.
    async function dispatchWorkflow(workflowFile, inputs) {
      const body = { ref: 'main' };
      if (inputs && Object.keys(inputs).length) body.inputs = inputs;
      const res = await fetch(
        `https://api.github.com/repos/${env.GITHUB_USER}/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
        { method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (!res.ok) throw new Error(`Dispatch failed: ${res.status} ${await res.text()}`);
    }

    // GET /log — return workout-log.csv for Claude to read
    if (url.pathname === '/log') {
      const f = await getFile('workout-log.csv');
      if (!f) return new Response(JSON.stringify({ error: 'Could not fetch log' }), { status: 502, headers: cors });
      return new Response(f.text, { headers: { ...cors, 'Content-Type': 'text/csv' } });
    }

    // GET /profile — return profile.json for Claude to read
    if (url.pathname === '/profile') {
      const f = await getFile('profile.json');
      if (!f) return new Response(JSON.stringify({ error: 'Could not fetch profile' }), { status: 502, headers: cors });
      return new Response(f.text, { headers: cors });
    }

    // GET /garmin — return garmin-recent.json for Claude to read
    if (url.pathname === '/garmin') {
      const f = await getFile('garmin-recent.json');
      if (!f) return new Response(JSON.stringify({ error: 'No Garmin data found — has the sync run yet?' }), { status: 404, headers: cors });
      return new Response(f.text, { headers: cors });
    }

    // GET /trigger-sync — dispatch the Garmin sync workflow (garmin-recent.json)
    if (url.pathname === '/trigger-sync') {
      try {
        await dispatchWorkflow('garmin-sync.yml');
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, message: 'Sync triggered — data will be ready in ~60 seconds.' }), { headers: cors });
    }

    // GET /trigger-cardio — dispatch the cardio-minutes workflow (per-minute HR CSV)
    if (url.pathname === '/trigger-cardio') {
      const inputs = {};
      const limit = url.searchParams.get('fetch_limit');
      if (limit) inputs.fetch_limit = limit;
      try {
        await dispatchWorkflow('cardio-minutes.yml', inputs);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, message: 'cardio-minutes triggered — the CSV should update in ~60 seconds.' }), { headers: cors });
    }

    // POST /log-write — commit workout-log.json + workout-log.csv
    if (url.pathname === '/log-write') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Use POST with a JSON body' }), { status: 405, headers: cors });
      }
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body: ' + e.message }), { status: 400, headers: cors });
      }
      const { logJson, logCsv, message, allowShrink } = payload || {};
      if (typeof logJson !== 'string' || typeof logCsv !== 'string' || !logJson.length || !logCsv.length) {
        return new Response(JSON.stringify({ error: 'Body must include logJson and logCsv as non-empty strings' }), { status: 400, headers: cors });
      }

      // Sanity: the JSON must parse to an array of entries.
      let newEntries;
      try {
        newEntries = JSON.parse(logJson);
        if (!Array.isArray(newEntries)) throw new Error('not an array');
      } catch (e) {
        return new Response(JSON.stringify({ error: 'logJson is not a valid JSON array: ' + e.message }), { status: 400, headers: cors });
      }

      // Safety guard: refuse a write that would shrink the log unless explicitly allowed.
      const currentJson = await getFile('workout-log.json');
      let currentCount = null;
      if (currentJson) {
        try { currentCount = JSON.parse(currentJson.text).length; } catch (_) { /* unreadable current file — skip guard */ }
      }
      if (currentCount !== null && newEntries.length < currentCount && !allowShrink) {
        return new Response(JSON.stringify({
          error: `Refusing to shrink the log (${currentCount} -> ${newEntries.length} entries). ` +
                 `If deletions are intentional, resend with "allowShrink": true.`
        }), { status: 409, headers: cors });
      }

      const msg = message || 'Post cardio zone records via Worker';
      const currentCsv = await getFile('workout-log.csv');
      try {
        await putFile('workout-log.json', logJson, msg, currentJson ? currentJson.sha : null);
        await putFile('workout-log.csv', logCsv, msg, currentCsv ? currentCsv.sha : null);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, warning: 'The two log files may now be out of sync — retry the write.' }), { status: 502, headers: cors });
      }
      return new Response(JSON.stringify({
        ok: true,
        message: `Log updated: ${newEntries.length} entries (was ${currentCount === null ? 'unknown' : currentCount}).`
      }), { headers: cors });
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

    const existing = await getFile('suggested-workout.json');
    try {
      await putFile('suggested-workout.json', JSON.stringify(suggestion, null, 2), 'Update workout suggestion', existing ? existing.sha : null);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
    }

    return new Response(
      JSON.stringify({ ok: true, message: 'Workout suggestion saved! Open LogTrim to see Today\'s Plan.' }),
      { headers: cors }
    );
  }
};
