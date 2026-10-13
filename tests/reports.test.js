const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../scripts/reports.js');

// ─── weekBounds ─────────────────────────────────────────────────────────────
// 2026-09-29 is a Tuesday.
test('weekBounds: sat start, Tue 9/29 → Sat 9/26 .. Fri 10/2', () => {
  assert.deepEqual(R.weekBounds('2026-09-29', 'sat', 0), { start: '2026-09-26', end: '2026-10-02' });
});
test('weekBounds: sat start, on a Saturday the week starts today', () => {
  assert.deepEqual(R.weekBounds('2026-09-26', 'sat', 0), { start: '2026-09-26', end: '2026-10-02' });
});
test('weekBounds: sat start, on a Friday the week started 6 days ago', () => {
  assert.deepEqual(R.weekBounds('2026-10-02', 'sat', 0), { start: '2026-09-26', end: '2026-10-02' });
});
test('weekBounds: offset -1 is the prior week', () => {
  assert.deepEqual(R.weekBounds('2026-09-29', 'sat', -1), { start: '2026-09-19', end: '2026-09-25' });
});
test('weekBounds: mon start', () => {
  assert.deepEqual(R.weekBounds('2026-09-29', 'mon', 0), { start: '2026-09-28', end: '2026-10-04' });
});
test('weekBounds: sun start', () => {
  assert.deepEqual(R.weekBounds('2026-09-29', 'sun', 0), { start: '2026-09-27', end: '2026-10-03' });
});
test('weekBounds: unknown weekStart falls back to monday', () => {
  assert.deepEqual(R.weekBounds('2026-09-29', 'xyz', 0), { start: '2026-09-28', end: '2026-10-04' });
});
test('weekBounds: crosses a month boundary correctly', () => {
  assert.deepEqual(R.weekBounds('2026-11-01', 'sat', 0), { start: '2026-10-31', end: '2026-11-06' });
});

// ─── classifyEntry ──────────────────────────────────────────────────────────
const gyms = [{ id: 'generic', rooms: [
  { id: 'outdoor-activities', machines: [{ id: 'walk', logType: 'walk' }, { id: 'swim', logType: 'time' }] },
  { id: 'bodyweight-no-equipment', machines: [
    { id: 'push-ups', logType: 'weight' }, { id: 'elbow-planks', logType: 'time' }, { id: 'meditation', logType: 'time' }] },
  { id: 'classes', machines: [{ id: 'spin-class', logType: 'mins' }] },
  { id: 'machines', machines: [{ id: 'pm03', logType: 'weight' }] }
] }];
const info = R.machineInfoMap(gyms);
const E = o => Object.assign({ weight: null, reps: null, duration: null, level: null, incline: null, hr: null }, o);

test('classify: garmin walk with zones → cardio', () => assert.equal(R.classifyEntry(E({ machineId: 'walk', duration: 40, zone1: 30 }), info), 'cardio'));
test('classify: walk logType without zones → cardio', () => assert.equal(R.classifyEntry(E({ machineId: 'walk', duration: 40 }), info), 'cardio'));
test('classify: swim (time, outdoor) → cardio', () => assert.equal(R.classifyEntry(E({ machineId: 'swim', duration: 30 }), info), 'cardio'));
test('classify: spin class (mins) → cardio', () => assert.equal(R.classifyEntry(E({ machineId: 'spin-class', duration: 45 }), info), 'cardio'));
test('classify: pushups (reps, no weight) → strength', () => assert.equal(R.classifyEntry(E({ machineId: 'push-ups', reps: 20 }), info), 'strength'));
test('classify: machine with weight → strength', () => assert.equal(R.classifyEntry(E({ machineId: 'pm03', weight: 100, reps: 10 }), info), 'strength'));
test('classify: plank (time) → strength', () => assert.equal(R.classifyEntry(E({ machineId: 'elbow-planks', duration: 60 }), info), 'strength'));
test('classify: meditation (time) → other', () => assert.equal(R.classifyEntry(E({ machineId: 'meditation', duration: 10 }), info), 'other'));
test('classify: legacy timed entry on unknown machine → cardio', () => assert.equal(R.classifyEntry(E({ machineId: 'm000', duration: 30 }), info), 'cardio'));
test('classify: unknown machine with reps → strength', () => assert.equal(R.classifyEntry(E({ machineId: 'm000', weight: 50, reps: 12 }), info), 'strength'));
test('classify: incline treadmill entry → cardio', () => assert.equal(R.classifyEntry(E({ machineId: 'm000', duration: 30, incline: 5 }), info), 'cardio'));

// ─── parseWellnessCSV ───────────────────────────────────────────────────────
test('parseWellnessCSV: numbers, blanks → null, strings kept', () => {
  const rows = R.parseWellnessCSV('date,steps,sleep_hours,hrv_status\n2026-09-27,12756,8.37,UNBALANCED\n2026-09-28,20070,,LOW\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].steps, 12756);
  assert.equal(rows[0].sleep_hours, 8.37);
  assert.equal(rows[0].hrv_status, 'UNBALANCED');
  assert.equal(rows[1].sleep_hours, null);
});
test('parseWellnessCSV: empty text → []', () => assert.deepEqual(R.parseWellnessCSV(''), []));

// ─── computeGoals ───────────────────────────────────────────────────────────
const goals = [
  { id: 'steps', label: 'Steps', kind: 'sum', source: 'wellness', field: 'steps', target: 70000 },
  { id: 'cardioDays', label: 'Cardio days', kind: 'days', source: 'log', filter: 'cardio', target: 4 },
  { id: 'strengthDays', label: 'Strength days', kind: 'days', source: 'log', filter: 'strength', target: 3 },
  { id: 'zone2', label: 'Zone 2', kind: 'sum', source: 'log', field: 'zone2', target: 45 },
  { id: 'pushups', label: 'Pushups', kind: 'sum', source: 'log', field: 'reps', machineIds: ['push-ups'], target: 140 },
  { id: 'plank', label: 'Plank', kind: 'sum', source: 'log', field: 'duration', machineIds: ['elbow-planks'], target: 315 },
  { id: 'sleep', label: 'Sleep', kind: 'avg', source: 'wellness', field: 'sleep_hours', target: 7.1 },
  { id: 'rhr', label: 'RHR', kind: 'avg', source: 'wellness', field: 'resting_hr', target: 46, direction: 'below' }
];
// Week Sat 9/26 .. Fri 10/2, "today" = Tue 9/29 (4 days elapsed)
const log = [
  E({ machineId: 'push-ups', machine: 'Push Ups', date: '2026-09-29', reps: 30 }),
  E({ machineId: 'elbow-planks', machine: 'Elbow Planks', date: '2026-09-29', duration: 30 }),
  E({ machineId: 'push-ups', machine: 'Push Ups', date: '2026-09-28', reps: 20 }),
  E({ machineId: 'push-ups', machine: 'Push Ups', date: '2026-09-28', reps: 20 }),
  E({ machineId: 'walk', machine: 'Walk', date: '2026-09-28', duration: 106, zone1: 100, zone2: 6 }),
  E({ machineId: 'walk', machine: 'Walk', date: '2026-09-27', duration: 50, zone1: 40, zone2: 10 }),
  E({ machineId: 'pm03', machine: 'Chest Press', date: '2026-09-26', weight: 100, reps: 10 }),
  E({ machineId: 'walk', machine: 'Walk', date: '2026-09-25', duration: 50, zone1: 40, zone2: 10 }), // prior week
  E({ machineId: 'push-ups', machine: 'Push Ups', date: '2026-09-25', reps: 99 })                     // prior week
];
const wellness = [
  { date: '2026-09-25', steps: 9000, sleep_hours: 6, resting_hr: 50 },
  { date: '2026-09-26', steps: 9087, sleep_hours: 7.63, resting_hr: 51 },
  { date: '2026-09-27', steps: 12756, sleep_hours: 8.37, resting_hr: 47 },
  { date: '2026-09-28', steps: 20070, sleep_hours: null, resting_hr: 47 }
];
const ctx = { log, wellness, gyms, weekStart: 'sat', today: '2026-09-29', offset: 0 };
const out = R.computeGoals(goals, ctx);
const by = id => out.results.find(r => r.id === id);

test('computeGoals: week bounds and elapsed days', () => {
  assert.equal(out.start, '2026-09-26'); assert.equal(out.end, '2026-10-02');
  assert.equal(out.isCurrent, true); assert.equal(out.daysElapsed, 4);
});
test('steps: sums only in-week days; pace uses synced days', () => {
  const r = by('steps');
  assert.equal(r.value, 9087 + 12756 + 20070);
  assert.equal(r.daysWithData, 3);
  assert.equal(r.expected, 30000);       // 70000 * 3/7
  assert.equal(r.status, 'onpace');
  assert.equal(r.note, '3 of 4 days synced');
});
test('cardio days: distinct dates, prior week excluded, drill-down lists dates', () => {
  const r = by('cardioDays');
  assert.equal(r.value, 2);
  assert.deepEqual(r.items.map(i => i.date), ['2026-09-27', '2026-09-28']);
  assert.equal(r.status, 'behind');     // expected 4*4/7 = 2.3
});
test('strength days: pushups-only day and plank day count', () => {
  const r = by('strengthDays');
  assert.deepEqual(r.items.map(i => i.date), ['2026-09-26', '2026-09-28', '2026-09-29']);
  assert.equal(r.status, 'hit');
});
test('zone2: summed across activities with per-date items', () => {
  const r = by('zone2');
  assert.equal(r.value, 16);
  assert.equal(r.items.length, 2);
});
test('pushups: reps summed only for the machineId, per-date set counts', () => {
  const r = by('pushups');
  assert.equal(r.value, 70);
  assert.deepEqual(r.items.map(i => [i.date, i.value, i.detail]), [['2026-09-28', 40, '2 sets'], ['2026-09-29', 30, '1 set']]);
  assert.equal(r.expected, 80);
  assert.equal(r.status, 'behind');
});
test('plank: duration summed', () => assert.equal(by('plank').value, 30));
test('sleep avg: skips null nights, no pace', () => {
  const r = by('sleep');
  assert.equal(r.value, 8);             // (7.63 + 8.37) / 2
  assert.equal(r.daysWithData, 2);
  assert.equal(r.status, 'hit');
  assert.equal(r.expected, undefined);
});
test('rhr avg: direction below → 48.3 vs 46 is a miss', () => {
  const r = by('rhr');
  assert.equal(r.value, 48.3);
  assert.equal(r.status, 'miss');
});
test('prior week: finished week → hit/miss, no onpace', () => {
  const prev = R.computeGoals(goals, Object.assign({}, ctx, { offset: -1 }));
  assert.equal(prev.isCurrent, false); assert.equal(prev.daysElapsed, 7);
  assert.equal(prev.results.find(r => r.id === 'pushups').value, 99);
  assert.equal(prev.results.find(r => r.id === 'pushups').status, 'miss');
  assert.equal(prev.results.find(r => r.id === 'cardioDays').value, 1);
});
test('avg with no data → nodata', () => {
  const o = R.computeGoals(goals, Object.assign({}, ctx, { wellness: [] }));
  assert.equal(o.results.find(r => r.id === 'sleep').status, 'nodata');
  assert.equal(o.results.find(r => r.id === 'steps').value, 0);
});
test('fmtGoalNum: thousands, decimals, units', () => {
  assert.equal(R.fmtGoalNum(41913), '41,913');
  assert.equal(R.fmtGoalNum(7.63, 'h'), '7.6 h');
  assert.equal(R.fmtGoalNum(315, 's'), '315 s');
  assert.equal(R.fmtGoalNum(null), '—');
});

// ─── heart-rate buckets (cardio-buckets.csv) ────────────────────────────────
const BUCKET_CSV = [
  'date,start,activity_id,activity_type,minutes,avg_hr,max_minute_hr,corrected,hr_under70,hr70_74,hr100_104,hr105_109,hr115_119,hr120_124,hr125_129,hr130_134,hr185_up',
  '2026-09-27,2026-09-27 08:00,24000000001,walking,60,98,131,,2,8,20,10,5,6,4,5,',
  '2026-09-28,2026-09-28 18:00,24000000002,running,30,150,190,y,,,,,,10,,10,10',
  '2026-09-28,2026-09-28 20:00,24000000003,walking,15,101,104,,,,15,,,,,,',
  '2026-09-25,2026-09-25 08:00,24000000004,walking,20,122,124,,,,,,,20,,,'
].join('\n');
const B = R.parseBucketsCSV(BUCKET_CSV);

test('garminIdOf: reads the "Garmin <id>" tag from notes', () => {
  assert.equal(R.garminIdOf({ notes: 'Miami Beach walk (Garmin 24609293314; 1.23 mi; +3 ft).' }), '24609293314');
  assert.equal(R.garminIdOf({ notes: 'West Tisbury Lower Loop (Garmin walk 24042101553; 2.99 mi)' }), '24042101553');
});
test('garminIdOf: a garminId field wins; no tag → null', () => {
  assert.equal(R.garminIdOf({ garminId: 24000000001, notes: 'Garmin 24000000009' }), '24000000001');
  assert.equal(R.garminIdOf({ notes: 'Avg HR: 131. Max HR:168' }), null);
  assert.equal(R.garminIdOf({ notes: 'Garmin says 12 floors' }), null);
  assert.equal(R.garminIdOf({}), null);
});
test('parseBucketsCSV: one row per activity, only non-empty buckets kept', () => {
  assert.equal(Object.keys(B).length, 4);
  const r = B['24000000001'];
  assert.equal(r.date, '2026-09-27'); assert.equal(r.type, 'walking'); assert.equal(r.minutes, 60);
  assert.equal(r.bins.length, 8);
  assert.deepEqual(r.bins[2], { lo: 100, hi: 105, open: null, min: 20 });
  assert.equal(B['24000000002'].corrected, true);
  assert.equal(B['24000000002'].bins.length, 3);
});
test('parseBucketsCSV: empty / header-only / CRLF text', () => {
  assert.deepEqual(R.parseBucketsCSV(''), {});
  assert.deepEqual(R.parseBucketsCSV('date,start,activity_id\n'), {});
  assert.equal(Object.keys(R.parseBucketsCSV(BUCKET_CSV.replace(/\n/g, '\r\n'))).length, 4);
});
test('hrRangeMinutes: ranges on bucket edges are exact', () => {
  const r = B['24000000001'];
  assert.equal(R.hrRangeMinutes(r, null, 120), 45);   // 2+8+20+10+5
  assert.equal(R.hrRangeMinutes(r, 120, 130), 10);    // 6+4
  assert.equal(R.hrRangeMinutes(r, 130, null), 5);
  assert.equal(R.hrRangeMinutes(r, null, null), 60);
  assert.equal(R.hrRangeMinutes(r, 105, 120), 15);
});
test('hrRangeMinutes: open-ended buckets count for open-ended ranges', () => {
  assert.equal(R.hrRangeMinutes(B['24000000002'], 130, null), 20);  // 130–134 plus 185+
  assert.equal(R.hrRangeMinutes(B['24000000002'], 185, null), 10);
  assert.equal(R.hrRangeMinutes(B['24000000001'], null, 70), 2);    // the under-70 bucket
});
test('hrRangeMinutes: an edge inside a bucket takes a proportional share', () => {
  // 105–109 holds 10 min; a floor of 107 takes 3/5 of it
  assert.ok(Math.abs(R.hrRangeMinutes(B['24000000001'], 107, 110) - 6) < 1e-9);
});
test('hrRangeMinutes: missing row → 0', () => assert.equal(R.hrRangeMinutes(undefined, 100, 120), 0));
test('zonesFromBuckets: minutes below the first floor stay separate from zone 1', () => {
  const z = R.zonesFromBuckets(B['24000000001'], [105, 120, 130, 145, 155]);
  assert.equal(z.below, 30);                           // 2+8+20
  assert.deepEqual(z.zones, [15, 10, 5, 0, 0]);
  assert.equal(z.below + z.zones.reduce((a, b) => a + b, 0), 60);
});
test('zonesFromBuckets: moving a floor re-slices the same stored data', () => {
  assert.deepEqual(R.zonesFromBuckets(B['24000000001'], [100, 125, 130]).zones, [41, 4, 5]);
});
test('zonesFromBuckets / cleanFloors: unusable floors → null / []', () => {
  assert.equal(R.zonesFromBuckets(B['24000000001'], null), null);
  assert.equal(R.zonesFromBuckets(B['24000000001'], [120, 110]), null);
  assert.deepEqual(R.cleanFloors(['105', 120]), [105, 120]);
  assert.deepEqual(R.cleanFloors(undefined), []);
});
test('hrRangeText', () => {
  assert.equal(R.hrRangeText(null, 120), 'under 120 bpm');
  assert.equal(R.hrRangeText(120, 130), '120–129 bpm');
  assert.equal(R.hrRangeText(130, null), '130+ bpm');
});

// HR-range goals: same week as above (Sat 9/26 .. Fri 10/2, today Tue 9/29)
const hrGoals = [
  { id: 'easy', label: 'Under 120', kind: 'sum', source: 'log', hrMax: 120, target: 180 },
  { id: 'z2', label: '120–129', kind: 'sum', source: 'log', hrMin: 120, hrMax: 130, target: 45 },
  { id: 'zone2', label: 'Zone 2 (typed)', kind: 'sum', source: 'log', field: 'zone2', target: 45 }
];
const hrLog = [
  E({ machineId: 'run', machine: 'Run', date: '2026-09-28', duration: 30, notes: 'Evening run (Garmin 24000000002; 3 mi).' }),
  E({ machineId: 'walk', machine: 'Walk', date: '2026-09-27', set: 1, duration: 60, zone1: 50, zone2: 10, notes: 'Morning walk (Garmin 24000000001; 3 mi).' }),
  E({ machineId: 'walk', machine: 'Walk', date: '2026-09-27', set: 2, duration: 1, notes: 'second set, same activity: Garmin 24000000001' }),
  E({ machineId: 'tm', machine: 'Treadmill', date: '2026-09-26', duration: 30, zone2: 25 }),          // typed by hand, no Garmin link
  E({ machineId: 'walk', machine: 'Walk', date: '2026-09-25', duration: 20, notes: 'Garmin 24000000004' }) // prior week
];
const hrOut = R.computeGoals(hrGoals, { log: hrLog, buckets: B, gyms, weekStart: 'sat', today: '2026-09-29', offset: 0 });
const hrBy = id => hrOut.results.find(r => r.id === id);

test('hr-range goal: sums bucket minutes for Garmin activities in this week\'s log', () => {
  assert.equal(hrBy('easy').value, 45);               // walk 45, run 0
  assert.equal(hrBy('z2').value, 20);                 // walk 10 + run 10
  assert.deepEqual(hrBy('z2').items.map(i => [i.date, i.value, i.detail]), [['2026-09-27', 10, 'Walk'], ['2026-09-28', 10, 'Run']]);
});
test('hr-range goal: an activity cited by two log rows is counted once', () => {
  assert.equal(hrBy('easy').items.length, 1);
  assert.equal(hrBy('easy').items[0].value, 45);
});
test('hr-range goal: hand-typed zone minutes and prior-week activities are not counted', () => {
  // the 9/26 treadmill row (zone2: 25 typed) and the 9/25 walk add nothing
  assert.equal(hrBy('z2').value, 20);
});
test('hr-range goal: flags Garmin activities in the week that are not in the log', () => {
  assert.equal(hrBy('z2').note, '1 Garmin activity not in the log');   // 24000000003
});
test('hr-range goal: status and pace work like any other sum', () => {
  assert.equal(hrBy('z2').status, 'behind');           // 20 of 45, pace 25.7 by day 4
  assert.equal(hrBy('z2').expected, 25.7);
});
test('hr-range goal: no bucket file → 0 with a hint, typed-zone goals unaffected', () => {
  const o = R.computeGoals(hrGoals, { log: hrLog, gyms, weekStart: 'sat', today: '2026-09-29', offset: 0 });
  assert.equal(o.results.find(r => r.id === 'z2').value, 0);
  assert.equal(o.results.find(r => r.id === 'z2').note, 'needs cardio-buckets.csv');
  assert.equal(o.results.find(r => r.id === 'zone2').value, 35);       // 10 + 25, from the log fields
});
test('typed-zone goal still sums the log fields when buckets are present', () => {
  assert.equal(hrBy('zone2').value, 35);
});
