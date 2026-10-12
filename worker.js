// LogTrim Claude Suggest — Cloudflare Worker
//
// Endpoints:
//   GET  /log?token=SECRET            — returns workout-log.csv (for Claude to read)
//   GET  /profile?token=SECRET        — returns profile.json (for Claude to read)
//   GET  /garmin?token=SECRET         — returns garmin-recent.json (for Claude to read)
//   GET  /trigger-sync?token=SECRET   — dispatch the Garmin Sync workflow (garmin-recent.json)
//   GET  /trigger-cardio?token=SECRET[&fetch_limit=N]
//                                     — dispatch the cardio-minutes workflow (per-minute HR CSV)
//   GET  /trigger-wellness?token=SECRET[&max_days=N]
//                                     — dispatch the daily-wellness workflow (daily-wellness.csv)
//   GET  /log-json?token=SECRET       — returns BOTH log files read live from GitHub, with their versions:
//                                       {"logJson","logCsv","jsonSha","csvSha","entries","csvRows","inSync"}
//                                       Always read the log through this before a /log-write — never
//                                       from raw.githubusercontent.com, which can be minutes stale.
//   POST /log-write?token=SECRET      — commit workout-log.json + workout-log.csv to the repo
//                                       body: {"logJson": "<full JSON text>", "logCsv": "<full CSV text>",
//                                              "baseJsonSha": "<jsonSha from /log-json>",
//                                              "baseCsvSha":  "<csvSha from /log-json>",
//                                              "message": "optional commit message", "allowShrink": false}
//                                       Refused with 409 if either file changed on GitHub since that
//                                       read, and with 400 if the JSON and CSV don't describe the same
//                                       entries. Returns the new jsonSha / csvSha for a follow-up write.
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

    // Fetch a repo file's current { sha, text } live from GitHub (null if it
    // doesn't exist). Files over 1 MB come back from the Contents API with an
    // empty `content`, so those are re-fetched in raw form.
    async function getFile(path) {
      // The timestamp makes every read a distinct URL, so no cache between
      // here and GitHub can answer with an older copy. GitHub ignores it.
      const fresh = `${apiBase}/${path}?t=${Date.now()}`;
      const res = await fetch(fresh, { headers: ghHeaders });
      if (!res.ok) return null;
      const file = await res.json();
      if (file.content) {
        return { sha: file.sha, text: decodeURIComponent(escape(atob(file.content.replace(/\n/g, '')))) };
      }
      const raw = await fetch(fresh, { headers: { ...ghHeaders, Accept: 'application/vnd.github.raw+json' } });
      if (!raw.ok) return null;
      return { sha: file.sha, text: await raw.text() };
    }

    // PUT one file to the repo (creating or overwriting). GitHub rejects the
    // write with 409 if `sha` is no longer the file's current version.
    // Returns the file's new sha.
    async function putFile(path, text, message, sha) {
      const body = { message, content: b64(text) };
      if (sha) body.sha = sha;
      const res = await fetch(`${apiBase}/${path}`, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`GitHub write failed for ${path}: ${res.status} ${await res.text()}`);
      const out = await res.json().catch(() => null);
      return out && out.content ? out.content.sha : null;
    }

    // Non-blank data rows of a log CSV (header dropped).
    function csvDataRows(csvText) {
      return csvText.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim()).slice(1);
    }

    // Do the JSON entries and the CSV rows describe the same log? Compares the
    // (datetime, machineId, set) of every entry against every row, ignoring
    // order. Returns null when they agree, or a short description of the
    // first difference. Columns 1, 5 and 6 are safe to split on: the app strips
    // commas from the text fields before them.
    function logMismatch(entries, csvText) {
      const rows = csvDataRows(csvText);
      if (rows.length !== entries.length) {
        return `logJson has ${entries.length} entries but logCsv has ${rows.length} rows`;
      }
      const count = new Map();
      for (const e of entries) {
        const k = `${String(e.datetime || e.date || '').replace(/[,\n"]/g, ' ')}|${e.machineId}|${e.set}`;
        count.set(k, (count.get(k) || 0) + 1);
      }
      for (const r of rows) {
        const c = r.split(',');
        const k = `${c[0]}|${c[4]}|${c[5]}`;
        const n = count.get(k);
        if (!n) return `logCsv has a row with no matching logJson entry: ${c[0]} / ${c[4]} / set ${c[5]}`;
        if (n === 1) count.delete(k); else count.set(k, n - 1);
      }
      if (count.size) {
        const [k] = count.keys();
        return `logJson has an entry with no matching logCsv row: ${k.split('|').join(' / ')}`;
      }
      return null;
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

    // GET /log-json — both log files, read live, with the versions a later
    // /log-write must quote back.
    if (url.pathname === '/log-json') {
      const [j, c] = await Promise.all([getFile('workout-log.json'), getFile('workout-log.csv')]);
      if (!j || !c) return new Response(JSON.stringify({ error: 'Could not fetch log' }), { status: 502, headers: cors });
      let entries = null, mismatch = null;
      try {
        const parsed = JSON.parse(j.text);
        entries = parsed.length;
        mismatch = logMismatch(parsed, c.text);
      } catch (e) {
        mismatch = 'workout-log.json is not valid JSON: ' + e.message;
      }
      return new Response(JSON.stringify({
        ok: true, logJson: j.text, logCsv: c.text, jsonSha: j.sha, csvSha: c.sha,
        entries, csvRows: csvDataRows(c.text).length, inSync: !mismatch, mismatch
      }), { headers: cors });
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

    // GET /trigger-wellness — dispatch the daily-wellness workflow (daily-wellness.csv)
    if (url.pathname === '/trigger-wellness') {
      const inputs = {};
      const days = url.searchParams.get('max_days');
      if (days) inputs.max_days = days;
      try {
        await dispatchWorkflow('daily-wellness.yml', inputs);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, message: 'daily-wellness triggered — the CSV should update in ~90 seconds (longer for backfills).' }), { headers: cors });
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
      const { logJson, logCsv, message, allowShrink, baseJsonSha, baseCsvSha } = payload || {};
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

      // The two files must describe the same entries.
      const mismatch = logMismatch(newEntries, logCsv);
      if (mismatch) {
        return new Response(JSON.stringify({
          error: `logJson and logCsv disagree (${mismatch}). Nothing was written. ` +
                 `Rebuild both from one fresh GET /log-json read and resend.`
        }), { status: 400, headers: cors });
      }

      // The caller must say which version of the log its edit is based on.
      if (typeof baseJsonSha !== 'string' || typeof baseCsvSha !== 'string' || !baseJsonSha || !baseCsvSha) {
        return new Response(JSON.stringify({
          error: 'Missing baseJsonSha / baseCsvSha. Read the log with GET /log-json, apply the change to that ' +
                 'copy, and send its jsonSha and csvSha back as baseJsonSha and baseCsvSha. Nothing was written.'
        }), { status: 400, headers: cors });
      }

      const [currentJson, currentCsv] = await Promise.all([getFile('workout-log.json'), getFile('workout-log.csv')]);

      // Refuse an edit built on an out-of-date copy: writing it would erase
      // whatever the app or the Garmin job added in the meantime.
      const stale = [];
      if ((currentJson ? currentJson.sha : null) !== baseJsonSha) stale.push('workout-log.json');
      if ((currentCsv ? currentCsv.sha : null) !== baseCsvSha) stale.push('workout-log.csv');
      if (stale.length) {
        return new Response(JSON.stringify({
          error: `The log changed on GitHub since you read it (${stale.join(' and ')}). Nothing was written. ` +
                 `GET /log-json again, re-apply your change to that fresh copy, and resend. ` +
                 `Do not re-add records from your older copy — check the fresh copy for them first.`,
          stale
        }), { status: 409, headers: cors });
      }

      // Safety guard: refuse a write that would shrink the log unless explicitly allowed.
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
      let jsonSha, csvSha;
      try {
        jsonSha = await putFile('workout-log.json', logJson, msg, currentJson ? currentJson.sha : null);
      } catch (e) {
        const moved = / 409 /.test(e.message);
        return new Response(JSON.stringify({
          error: e.message,
          warning: moved
            ? 'The log changed on GitHub mid-write. Nothing was written — GET /log-json again and redo the change.'
            : 'Nothing was written.'
        }), { status: moved ? 409 : 502, headers: cors });
      }
      try {
        csvSha = await putFile('workout-log.csv', logCsv, msg, currentCsv ? currentCsv.sha : null);
      } catch (e) {
        return new Response(JSON.stringify({
          error: e.message,
          warning: 'workout-log.json was written but workout-log.csv was not, so the two are out of sync. ' +
                   'GET /log-json (inSync will be false), rebuild the CSV from that JSON, and resend both.'
        }), { status: 502, headers: cors });
      }
      return new Response(JSON.stringify({
        ok: true,
        message: `Log updated: ${newEntries.length} entries (was ${currentCount === null ? 'unknown' : currentCount}).`,
        jsonSha, csvSha
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
