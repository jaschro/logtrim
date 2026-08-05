const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fmtPace, fmtWalkPace, parseMinutes, fmtDuration, fmtLast, csvEsc, toCSV } = require('../scripts/utils.js');

// ─── fmtPace ────────────────────────────────────────────────────────────────
test('fmtPace: 3 mph → 20:00/mi', () => assert.equal(fmtPace(3), '20:00/mi'));
test('fmtPace: 4 mph → 15:00/mi', () => assert.equal(fmtPace(4), '15:00/mi'));
test('fmtPace: 3.5 mph → 17:09/mi', () => assert.equal(fmtPace(3.5), '17:09/mi'));
test('fmtPace: 0 → —',            () => assert.equal(fmtPace(0), '—'));
test('fmtPace: null → —',         () => assert.equal(fmtPace(null), '—'));
test('fmtPace: negative → —',     () => assert.equal(fmtPace(-1), '—'));

// ─── fmtWalkPace ────────────────────────────────────────────────────────────
test('fmtWalkPace: 1.5mi in 30min → 20:00/mi', () => assert.equal(fmtWalkPace(1.5, 30), '20:00/mi'));
test('fmtWalkPace: 1mi in 20min → 20:00/mi',   () => assert.equal(fmtWalkPace(1, 20), '20:00/mi'));
test('fmtWalkPace: 2mi in 45min → 22:30/mi',   () => assert.equal(fmtWalkPace(2, 45), '22:30/mi'));
test('fmtWalkPace: 0 distance → —',             () => assert.equal(fmtWalkPace(0, 30), '—'));
test('fmtWalkPace: null distance → —',          () => assert.equal(fmtWalkPace(null, 30), '—'));
test('fmtWalkPace: null duration → —',          () => assert.equal(fmtWalkPace(1.5, null), '—'));

// ─── parseMinutes ────────────────────────────────────────────────────────────
test('parseMinutes: "30" → 30',       () => assert.equal(parseMinutes('30'), 30));
test('parseMinutes: "5:06" → 5.1',    () => assert.ok(Math.abs(parseMinutes('5:06') - 5.1) < 0.001));
test('parseMinutes: "30:00" → 30',    () => assert.equal(parseMinutes('30:00'), 30));
test('parseMinutes: "32:45" → 32.75', () => assert.ok(Math.abs(parseMinutes('32:45') - 32.75) < 0.001));
test('parseMinutes: "1:30:00" → 90',  () => assert.equal(parseMinutes('1:30:00'), 90));
test('parseMinutes: "" → null',        () => assert.equal(parseMinutes(''), null));
test('parseMinutes: null → null',      () => assert.equal(parseMinutes(null), null));
test('parseMinutes: 30 (number) → 30',() => assert.equal(parseMinutes(30), 30));

// ─── fmtDuration ─────────────────────────────────────────────────────────────
test('fmtDuration: 30 → "30"',         () => assert.equal(fmtDuration(30), '30'));
test('fmtDuration: 5.1 → "5:06"',      () => assert.equal(fmtDuration(5.1), '5:06'));
test('fmtDuration: 32.75 → "32:45"',   () => assert.equal(fmtDuration(32.75), '32:45'));
test('fmtDuration: 0 → "0"',           () => assert.equal(fmtDuration(0), '0'));
test('fmtDuration: null → ""',         () => assert.equal(fmtDuration(null), ''));

// ─── parseMinutes / fmtDuration round-trip ───────────────────────────────────
test('round-trip "5:06"',   () => assert.equal(fmtDuration(parseMinutes('5:06')), '5:06'));
test('round-trip "32:45"',  () => assert.equal(fmtDuration(parseMinutes('32:45')), '32:45'));
test('round-trip "30:00"',  () => assert.equal(fmtDuration(parseMinutes('30:00')), '30'));

// ─── fmtLast ─────────────────────────────────────────────────────────────────
const today = new Date().toISOString().split('T')[0];

test('fmtLast: weight — shows max weight and set count', () => {
  const sets = [
    { date: today, weight: 135, reps: 10 },
    { date: today, weight: 145, reps: 8 },
  ];
  const result = fmtLast(sets, 'weight');
  assert.ok(result.includes('145 lbs'), `expected 145 lbs, got: ${result}`);
  assert.ok(result.includes('2 sets'), `expected 2 sets, got: ${result}`);
});

test('fmtLast: walk — shows distance, time, pace', () => {
  const sets = [{ date: today, level: 1.5, duration: 30 }];
  const result = fmtLast(sets, 'walk');
  assert.ok(result.includes('1.5mi'), result);
  assert.ok(result.includes('30min'), result);
  assert.ok(result.includes('20:00/mi'), result);
});

test('fmtLast: pace — shows mph and pace', () => {
  const sets = [{ date: today, level: 3, duration: 30 }];
  const result = fmtLast(sets, 'pace');
  assert.ok(result.includes('3mph'), result);
  assert.ok(result.includes('20:00/mi'), result);
});

test('fmtLast: time — shows set count and duration', () => {
  const sets = [
    { date: today, duration: 60 },
    { date: today, duration: 60 },
  ];
  const result = fmtLast(sets, 'time');
  assert.ok(result.includes('2×60'), result);
});

// ─── csvEsc ──────────────────────────────────────────────────────────────────
test('csvEsc: no special chars → unchanged',  () => assert.equal(csvEsc('Hello'), 'Hello'));
test('csvEsc: comma replaced with space',      () => assert.equal(csvEsc('a,b'), 'a b'));
test('csvEsc: newline replaced with space',    () => assert.equal(csvEsc('a\nb'), 'a b'));
test('csvEsc: null → empty string',           () => assert.equal(csvEsc(null), ''));

// ─── toCSV ───────────────────────────────────────────────────────────────────
test('toCSV: header row is correct', () => {
  const csv = toCSV([]);
  assert.equal(csv, 'date,gym,room,machine,machineId,set,weight,reps,duration,level,incline,hr,notes');
});

test('toCSV: walk entry — distance in level column', () => {
  const entries = [{
    date: today, gym: 'Home', room: 'Outdoor', machine: 'Walk', machineId: 'walk',
    set: 1, weight: null, reps: null, duration: 30, level: 1.5, incline: null, hr: null, notes: ''
  }];
  const lines = toCSV(entries).split('\n');
  assert.equal(lines.length, 2);
  const cols = lines[1].split(',');
  assert.equal(cols[8], '30');   // duration
  assert.equal(cols[9], '1.5'); // level = distance
});

test('toCSV: weight entry — nulls become empty strings', () => {
  const entries = [{
    date: today, gym: 'Gym', room: 'Weights', machine: 'Bench Press', machineId: 'bench',
    set: 1, weight: 135, reps: 10, duration: null, level: null, incline: null, hr: null, notes: ''
  }];
  const lines = toCSV(entries).split('\n');
  const cols = lines[1].split(',');
  assert.equal(cols[6], '135'); // weight
  assert.equal(cols[7], '10');  // reps
  assert.equal(cols[8], '');    // duration (null → '')
});
