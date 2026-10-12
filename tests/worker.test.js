// Tests for worker.js (the Cloudflare Worker) against an in-memory stand-in
// for the GitHub Contents API. Run: node --test tests/worker.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { toCSV } = require('../scripts/utils.js');

const ENV = { SECRET_TOKEN: 's3cret', GITHUB_PAT: 'pat', GITHUB_USER: 'u', GITHUB_REPO: 'r' };
const BASE = 'https://w.example';

// worker.js is an ES module; load it from its source text so this works
// whatever the package's module type is.
let workerPromise;
function loadWorker() {
  if (!workerPromise) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
    workerPromise = import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src)).then(m => m.default);
  }
  return workerPromise;
}

const sha1 = t => crypto.createHash('sha1').update(t).digest('hex');
const b64 = t => Buffer.from(t, 'utf8').toString('base64');

// Minimal GitHub: files keyed by path, sha = hash of content, PUT enforces sha.
function fakeGitHub(files, opts = {}) {
  const state = { files: { ...files }, puts: [], gets: [] };
  state.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace('/repos/u/r/contents/', '');
    const method = init.method || 'GET';
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    if (method === 'GET') {
      state.gets.push(u.pathname + u.search);
      if (!(p in state.files)) return json({ message: 'Not Found' }, 404);
      const text = state.files[p];
      if ((init.headers.Accept || '').includes('raw')) return new Response(text);
      const big = opts.bigFiles && opts.bigFiles.includes(p);
      return json({ sha: sha1(text), content: big ? '' : b64(text).replace(/(.{60})/g, '$1\n'), encoding: big ? 'none' : 'base64' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      if (opts.failPut === p) return json({ message: 'boom' }, 500);
      if (opts.beforePut) opts.beforePut(p, state);
      const cur = p in state.files ? sha1(state.files[p]) : undefined;
      if (cur !== body.sha) return json({ message: `${p} does not match ${cur}` }, 409);
      state.files[p] = Buffer.from(body.content, 'base64').toString('utf8');
      state.puts.push({ path: p, message: body.message });
      return json({ content: { sha: sha1(state.files[p]) } });
    }
    return json({}, 405);
  };
  return state;
}

function entry(datetime, machineId, set, extra = {}) {
  return { machineId, machine: machineId, gym: 'G', room: 'Bodyweight — No Equipment', date: datetime.slice(0, 10), datetime,
           set, weight: null, reps: 10, duration: null, level: null, incline: null, hr: null, notes: '', ...extra };
}
const LOG = [
  entry('2026-10-11 09:52:52 AM', 'situp', 1),
  entry('2026-10-11 09:52:52 AM', 'situp', 2),
  entry('2026-10-10 05:22:00 PM', 'bike-ride', 1, { reps: null, duration: 70.8, notes: 'Ride (Garmin 1; 13.61 mi).', zone1: 58.3 }),
];
const RUN = entry('2026-10-11 09:42:00 PM', 'run', 1, { reps: null, duration: 14.9, notes: 'Run (Garmin 2).', zone3: 10.9 });
const text = entries => ({ json: JSON.stringify(entries, null, 2), csv: toCSV(entries) });
const repoWith = (entries, opts) => {
  const t = text(entries);
  return fakeGitHub({ 'workout-log.json': t.json, 'workout-log.csv': t.csv }, opts);
};

async function call(gh, pathAndQuery, body) {
  const worker = await loadWorker();
  const realFetch = globalThis.fetch;
  globalThis.fetch = gh.fetch;
  try {
    const init = body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) };
    const res = await worker.fetch(new Request(BASE + pathAndQuery, init), ENV);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const read = gh => call(gh, '/log-json?token=s3cret');
const write = (gh, body) => call(gh, '/log-write?token=s3cret', body);

test('rejects a missing or wrong token', async () => {
  const gh = repoWith(LOG);
  assert.strictEqual((await call(gh, '/log-json')).status, 401);
  assert.strictEqual((await call(gh, '/log-json?token=nope')).status, 401);
});

test('/log-json returns both files, their shas and inSync=true', async () => {
  const gh = repoWith(LOG);
  const r = await read(gh);
  const t = text(LOG);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.logJson, t.json);
  assert.strictEqual(r.body.logCsv, t.csv);
  assert.strictEqual(r.body.jsonSha, sha1(t.json));
  assert.strictEqual(r.body.csvSha, sha1(t.csv));
  assert.strictEqual(r.body.entries, 3);
  assert.strictEqual(r.body.csvRows, 3);
  assert.strictEqual(r.body.inSync, true);
  assert.strictEqual(r.body.mismatch, null);
});

test('/log-json keeps non-ASCII text intact', async () => {
  const r = await read(repoWith(LOG));
  assert.ok(r.body.logJson.includes('Bodyweight — No Equipment'));
  assert.ok(r.body.logCsv.includes('Bodyweight — No Equipment'));
});

test('/log-json never reuses a URL between reads (no cached copy can answer)', async () => {
  const gh = repoWith(LOG);
  await read(gh);
  await new Promise(r => setTimeout(r, 25));
  await read(gh);
  const jsonGets = gh.gets.filter(g => g.includes('workout-log.json'));
  assert.strictEqual(jsonGets.length, 2);
  assert.notStrictEqual(jsonGets[0], jsonGets[1]);
});

test('/log-json reports inSync=false when the files disagree', async () => {
  const gh = fakeGitHub({ 'workout-log.json': text(LOG).json, 'workout-log.csv': text([RUN, ...LOG]).csv });
  const r = await read(gh);
  assert.strictEqual(r.body.inSync, false);
  assert.strictEqual(r.body.entries, 3);
  assert.strictEqual(r.body.csvRows, 4);
  assert.match(r.body.mismatch, /3 entries.*4 rows/);
});

test('/log-json reads files over 1 MB, which GitHub returns without content', async () => {
  const gh = repoWith(LOG, { bigFiles: ['workout-log.json'] });
  const r = await read(gh);
  assert.strictEqual(r.body.logJson, text(LOG).json);
  assert.strictEqual(r.body.inSync, true);
});

test('/log-write commits both files when based on the current version', async () => {
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  const next = text([RUN, ...LOG]);
  const r = await write(gh, { logJson: next.json, logCsv: next.csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha, message: 'post run' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(gh.files['workout-log.json'], next.json);
  assert.strictEqual(gh.files['workout-log.csv'], next.csv);
  assert.deepStrictEqual(gh.puts.map(p => p.path), ['workout-log.json', 'workout-log.csv']);
  assert.strictEqual(gh.puts[0].message, 'post run');
  assert.strictEqual(r.body.jsonSha, sha1(next.json));
  assert.strictEqual(r.body.csvSha, sha1(next.csv));
  assert.match(r.body.message, /4 entries \(was 3\)/);
});

test('/log-write returns shas that work for a follow-up write', async () => {
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  const a = text([RUN, ...LOG]);
  const first = await write(gh, { logJson: a.json, logCsv: a.csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  const b = text([{ ...RUN, notes: 'Run, tidied (Garmin 2).' }, ...LOG]);
  const second = await write(gh, { logJson: b.json, logCsv: b.csv, baseJsonSha: first.body.jsonSha, baseCsvSha: first.body.csvSha });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(gh.files['workout-log.json'], b.json);
});

// The Oct 2026 incident: a session read the log, the Garmin job then posted a
// record, and the session wrote back its older copy plus one entry.
test('/log-write refuses an edit built on an out-of-date copy', async () => {
  const gh = repoWith(LOG);
  const staleRead = (await read(gh)).body;
  const bot = text([RUN, ...LOG]);            // the Garmin job posts meanwhile
  gh.files['workout-log.json'] = bot.json;
  gh.files['workout-log.csv'] = bot.csv;
  const mine = text([entry('2026-10-11 10:30:00 PM', 'push-ups', 1), ...JSON.parse(staleRead.logJson)]);
  const r = await write(gh, { logJson: mine.json, logCsv: mine.csv, baseJsonSha: staleRead.jsonSha, baseCsvSha: staleRead.csvSha });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.body.stale, ['workout-log.json', 'workout-log.csv']);
  assert.match(r.body.error, /changed on GitHub since you read it/);
  assert.strictEqual(gh.puts.length, 0);
  assert.strictEqual(gh.files['workout-log.json'], bot.json);   // the job's record survives
});

test('/log-write refuses when only the CSV version is out of date', async () => {
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  gh.files['workout-log.csv'] = text(LOG).csv + '\n';
  const next = text([RUN, ...LOG]);
  const r = await write(gh, { logJson: next.json, logCsv: next.csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.body.stale, ['workout-log.csv']);
  assert.strictEqual(gh.puts.length, 0);
});

test('/log-write requires the base versions', async () => {
  const gh = repoWith(LOG);
  const next = text([RUN, ...LOG]);
  const r = await write(gh, { logJson: next.json, logCsv: next.csv });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /baseJsonSha/);
  assert.match(r.body.error, /\/log-json/);
  assert.strictEqual(gh.puts.length, 0);
});

test('/log-write refuses JSON and CSV with different row counts', async () => {
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  const r = await write(gh, { logJson: text(LOG).json, logCsv: text([RUN, ...LOG]).csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /disagree/);
  assert.strictEqual(gh.puts.length, 0);
});

test('/log-write refuses JSON and CSV that label the same record differently', async () => {
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  const walk = { ...RUN, machineId: 'walk', machine: 'Walk' };
  const r = await write(gh, { logJson: text([RUN, ...LOG]).json, logCsv: text([walk, ...LOG]).csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /walk/);
  assert.strictEqual(gh.puts.length, 0);
});

test('/log-write accepts the same entries in a different row order, and a trailing newline', async () => {
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  const r = await write(gh, { logJson: text([RUN, ...LOG]).json, logCsv: text([...LOG, RUN]).csv + '\n', baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  assert.strictEqual(r.status, 200);
});

test('/log-write accepts duplicate rows when both files have them', async () => {
  const dup = [LOG[0], LOG[0], ...LOG];
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  const ok = await write(gh, { logJson: text(dup).json, logCsv: text(dup).csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  assert.strictEqual(ok.status, 200);
});

test('/log-write still refuses to shrink the log unless allowShrink is set', async () => {
  const gh = repoWith(LOG);
  const base = (await read(gh)).body;
  const fewer = text(LOG.slice(1));
  const body = { logJson: fewer.json, logCsv: fewer.csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha };
  const r = await write(gh, body);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /Refusing to shrink/);
  assert.strictEqual(gh.puts.length, 0);
  const allowed = await write(gh, { ...body, allowShrink: true });
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(gh.files['workout-log.json'], fewer.json);
});

test('/log-write reports 409 and writes nothing if the log moves mid-write', async () => {
  let moved = false;
  const gh = repoWith(LOG, { beforePut: (p, state) => {
    if (!moved && p === 'workout-log.json') { moved = true; state.files[p] = text([RUN, ...LOG]).json; }
  } });
  const base = (await read(gh)).body;
  const mine = text([entry('2026-10-11 10:30:00 PM', 'push-ups', 1), ...LOG]);
  const r = await write(gh, { logJson: mine.json, logCsv: mine.csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.warning, /Nothing was written/);
  assert.strictEqual(gh.puts.length, 0);
});

test('/log-write says so plainly when only the CSV write fails', async () => {
  const gh = repoWith(LOG, { failPut: 'workout-log.csv' });
  const base = (await read(gh)).body;
  const next = text([RUN, ...LOG]);
  const r = await write(gh, { logJson: next.json, logCsv: next.csv, baseJsonSha: base.jsonSha, baseCsvSha: base.csvSha });
  assert.strictEqual(r.status, 502);
  assert.match(r.body.warning, /out of sync/);
  const after = await read(gh);
  assert.strictEqual(after.body.inSync, false);
});

test('/log-write rejects bad bodies', async () => {
  const gh = repoWith(LOG);
  assert.strictEqual((await write(gh, 'not json')).status, 400);
  assert.strictEqual((await write(gh, { logJson: '{}', logCsv: 'x', baseJsonSha: 'a', baseCsvSha: 'b' })).status, 400);
  assert.strictEqual((await call(gh, '/log-write?token=s3cret')).status, 405);
});

test('/log still returns the CSV as text', async () => {
  const worker = await loadWorker();
  const gh = repoWith(LOG);
  const realFetch = globalThis.fetch;
  globalThis.fetch = gh.fetch;
  try {
    const res = await worker.fetch(new Request(BASE + '/log?token=s3cret'), ENV);
    assert.strictEqual(await res.text(), text(LOG).csv);
  } finally { globalThis.fetch = realFetch; }
});
