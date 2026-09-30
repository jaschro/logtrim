/**
 * Weekly goal reporting — pure functions shared between index.html and the tests.
 * UMD wrapper: works as a browser <script> (adds globals) and as a Node require().
 *
 * Inputs are the files already in the repo:
 *   goals.json          — { weekStart: 'sat', goals: [ ... ] }
 *   workout-log.json    — array of set entries (newest first)
 *   daily-wellness.csv  — optional; one row per complete Garmin day
 *
 * Goal shapes (all fields optional except id/kind/target):
 *   { id, label, kind:'sum'|'days'|'avg', source:'log'|'wellness', field, machineIds,
 *     filter:'cardio'|'strength'|'any', target, unit, direction:'above'|'below' }
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(global, factory());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const CARDIO_LOG_TYPES = ['walk', 'pace', 'cardio', 'mins'];
  // 'time'-logged generic exercises that are not training (no day credit).
  const NON_TRAINING = ['meditation', 'downward-dog'];

  // ---- date helpers (all on YYYY-MM-DD strings, no timezone surprises) ----
  function toDate(ds) { return new Date(ds + 'T12:00:00Z'); }
  function toStr(d) { return d.toISOString().slice(0, 10); }
  function addDays(ds, n) { const d = toDate(ds); d.setUTCDate(d.getUTCDate() + n); return toStr(d); }
  function dayIndex(ds) { return toDate(ds).getUTCDay(); }
  function todayStr(now) {
    const d = now || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Bounds of the week containing `today`, shifted by `offset` weeks (0 = this
   * week, -1 = last week). weekStart is a day name ('sat', 'mon', ...).
   * Returns { start, end } inclusive date strings.
   */
  function weekBounds(today, weekStart, offset) {
    const ws = DAY_NAMES.indexOf(String(weekStart || 'mon').toLowerCase().slice(0, 3));
    const wsi = ws < 0 ? 1 : ws;
    const back = (dayIndex(today) - wsi + 7) % 7;
    const start = addDays(today, -back + 7 * (offset || 0));
    return { start, end: addDays(start, 6) };
  }

  function inRange(ds, b) { return !!ds && ds >= b.start && ds <= b.end; }

  /** Build machineId -> { logType, roomId, gymId, name } from the loaded gyms. */
  function machineInfoMap(gyms) {
    const map = {};
    (gyms || []).forEach(g => (g.rooms || []).forEach(r => (r.machines || []).forEach(m => {
      map[m.id] = { logType: m.logType || 'weight', roomId: r.id, gymId: g.id, name: m.name };
    })));
    return map;
  }

  /** 'cardio' | 'strength' | 'other' for one log entry. */
  function classifyEntry(e, info) {
    const mi = info && info[e.machineId];
    const hasZones = [1, 2, 3, 4, 5].some(i => e['zone' + i] != null);
    if (hasZones || (e.hr != null && e.hr > 0) || e.incline != null) return 'cardio';
    if (mi && CARDIO_LOG_TYPES.includes(mi.logType)) return 'cardio';
    if (mi && mi.logType === 'time' && mi.roomId === 'outdoor-activities') return 'cardio';
    if (e.reps != null || e.weight != null) return 'strength';
    if (mi && mi.logType === 'time') return NON_TRAINING.includes(e.machineId) ? 'other' : 'strength';
    if (!mi && e.duration != null) return 'cardio'; // legacy timed entry on a deleted machine
    return 'other';
  }

  /** Parse daily-wellness.csv text into an array of { date, steps, ... } with numbers. */
  function parseWellnessCSV(text) {
    const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const head = lines[0].split(',');
    return lines.slice(1).map(l => {
      const cells = l.split(',');
      const row = {};
      head.forEach((h, i) => {
        const v = cells[i];
        if (v == null || v === '') { row[h] = null; return; }
        const n = Number(v);
        row[h] = isNaN(n) ? v : n;
      });
      return row;
    });
  }

  function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
  function round1(v) { return Math.round(v * 10) / 10; }

  /**
   * Compute every goal for one week.
   * ctx: { log, wellness, gyms, weekStart, today, offset }
   * Returns { start, end, isCurrent, daysElapsed, results: [...] }
   */
  function computeGoals(goals, ctx) {
    const today = ctx.today || todayStr();
    const b = weekBounds(today, ctx.weekStart || 'sat', ctx.offset || 0);
    const isCurrent = inRange(today, b);
    const daysElapsed = isCurrent ? Math.round((toDate(today) - toDate(b.start)) / 86400000) + 1 : (b.start > today ? 0 : 7);
    const info = machineInfoMap(ctx.gyms);
    const log = (ctx.log || []).filter(e => inRange(e.date, b));
    const wellness = (ctx.wellness || []).filter(r => inRange(r.date, b));

    const results = (goals || []).map(goal => {
      const r = Object.assign({}, goal, { value: 0, items: [], daysWithData: null, note: '' });
      r.direction = goal.direction || 'above';
      r.source = goal.source || (goal.kind === 'days' ? 'log' : 'log');

      if (r.source === 'wellness') {
        const rows = wellness.filter(w => num(w[goal.field]) > 0).sort((a, b2) => a.date < b2.date ? -1 : 1);
        r.daysWithData = rows.length;
        r.items = rows.map(w => ({ date: w.date, label: fmtShortDate(w.date), value: num(w[goal.field]) }));
        if (goal.kind === 'avg') {
          r.value = rows.length ? round1(rows.reduce((s, w) => s + num(w[goal.field]), 0) / rows.length) : null;
        } else {
          r.value = rows.reduce((s, w) => s + num(w[goal.field]), 0);
          const expectedDays = isCurrent ? daysElapsed : 7;
          if (rows.length < expectedDays) r.note = `${rows.length} of ${expectedDays} day${expectedDays === 1 ? '' : 's'} synced`;
        }
      } else if (goal.kind === 'days') {
        const want = goal.filter || 'any';
        const byDate = {};
        log.forEach(e => {
          const c = classifyEntry(e, info);
          if (want !== 'any' && c !== want) return;
          if (want === 'any' && c === 'other') return;
          (byDate[e.date] = byDate[e.date] || new Set()).add(e.machine || e.machineId);
        });
        const dates = Object.keys(byDate).sort();
        r.value = dates.length;
        r.items = dates.map(d => ({ date: d, label: fmtShortDate(d), value: null, detail: [...byDate[d]].join(', ') }));
      } else {
        // sum over log entries
        const ids = goal.machineIds && goal.machineIds.length ? goal.machineIds : null;
        const byDate = {};
        log.forEach(e => {
          if (ids && !ids.includes(e.machineId)) return;
          const v = num(e[goal.field]);
          if (!v) return;
          const d = byDate[e.date] = byDate[e.date] || { value: 0, sets: 0, names: new Set() };
          d.value += v; d.sets += 1; d.names.add(e.machine || e.machineId);
        });
        const dates = Object.keys(byDate).sort();
        r.value = round1(dates.reduce((s, d) => s + byDate[d].value, 0));
        r.items = dates.map(d => ({
          date: d, label: fmtShortDate(d), value: round1(byDate[d].value),
          detail: ids ? `${byDate[d].sets} set${byDate[d].sets === 1 ? '' : 's'}` : [...byDate[d].names].join(', ')
        }));
      }

      // ---- status / pace ----
      const t = num(goal.target);
      if (goal.kind === 'avg') {
        if (r.value == null) r.status = 'nodata';
        else r.status = (r.direction === 'below' ? r.value <= t : r.value >= t) ? 'hit' : 'miss';
        r.pct = r.value == null ? 0 : Math.min(1, r.direction === 'below' ? (r.value ? t / r.value : 1) : r.value / t);
      } else {
        // pace: fraction of the week that "counts" — for wellness sums, only synced days
        const paceDays = r.source === 'wellness' && r.daysWithData != null ? Math.min(r.daysWithData, isCurrent ? daysElapsed : 7) : (isCurrent ? daysElapsed : 7);
        r.expected = round1(t * paceDays / 7);
        r.pct = t ? Math.min(1, r.value / t) : 0;
        if (r.value >= t) r.status = 'hit';
        else if (!isCurrent) r.status = (r.source === 'wellness' && paceDays < 7 && r.value >= r.expected) ? 'onpace' : 'miss';
        else r.status = r.value >= r.expected ? 'onpace' : 'behind';
      }
      return r;
    });

    return { start: b.start, end: b.end, isCurrent, daysElapsed, results };
  }

  function fmtShortDate(ds) {
    const d = toDate(ds);
    return `${DAY_NAMES[d.getUTCDay()].replace(/^./, c => c.toUpperCase())} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }

  function fmtGoalNum(v, unit) {
    if (v == null) return '—';
    const n = Number(v);
    const s = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : (Number.isInteger(n) ? String(n) : n.toFixed(1));
    return unit ? `${s}${unit === 'h' || unit === 's' ? ' ' + unit : unit}` : s;
  }

  /** Default goals for a fresh install (mirrors goals.json in the template). */
  function defaultGoals() {
    return {
      weekStart: 'mon',
      goals: [
        { id: 'cardioDays', label: 'Days with cardio', kind: 'days', source: 'log', filter: 'cardio', target: 3 },
        { id: 'strengthDays', label: 'Days with strength', kind: 'days', source: 'log', filter: 'strength', target: 2 }
      ]
    };
  }

  return { DAY_NAMES, weekBounds, addDays, todayStr, machineInfoMap, classifyEntry, parseWellnessCSV,
           computeGoals, fmtShortDate, fmtGoalNum, defaultGoals };
});
