/**
 * Pure utility functions shared between index.html and the test suite.
 * UMD wrapper: works as a browser <script> (adds globals) and as a Node require().
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(global, factory());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function fmtPace(mph) {
    if (!mph || mph <= 0) return '—';
    const total = 60 / mph;
    const mins = Math.floor(total);
    const secs = Math.round((total - mins) * 60);
    return `${mins}:${String(secs).padStart(2, '0')}/mi`;
  }

  function fmtWalkPace(dist, dur) {
    if (!dist || !dur || dist <= 0) return '—';
    const mpm = dur / dist;
    const m = Math.floor(mpm);
    const s = Math.round((mpm - m) * 60);
    return `${m}:${String(s).padStart(2, '0')}/mi`;
  }

  function parseMinutes(val) {
    if (!val && val !== 0) return null;
    const str = String(val).trim();
    if (str.includes(':')) {
      const parts = str.split(':');
      if (parts.length === 3) return parseFloat(parts[0]) * 60 + parseFloat(parts[1] || 0) + parseFloat(parts[2] || 0) / 60;
      return parseFloat(parts[0] || 0) + parseFloat(parts[1] || 0) / 60;
    }
    return parseFloat(str) || null;
  }

  function fmtDuration(mins) {
    if (!mins && mins !== 0) return '';
    const m = Math.floor(mins);
    const s = Math.round((mins - m) * 60);
    return s > 0 ? `${m}:${String(s).padStart(2, '0')}` : String(m);
  }

  function fmtDate(ds) {
    const d = new Date(ds + 'T12:00:00'), t = new Date(); t.setHours(12, 0, 0, 0);
    const diff = Math.round((t - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return `${diff}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function fmtDateFull(ds) {
    return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtLast(sets, logType) {
    const d = fmtDate(sets[0].date), f = sets[0];
    if (f.weight != null) { const mx = Math.max(...sets.map(s => s.weight || 0)); return `${d} · ${mx} lbs × ${sets.length} sets`; }
    if (f.duration != null) {
      if (logType === 'walk' && f.level && f.duration) { return `${d} · ${f.level}mi in ${fmtDuration(f.duration)}min (${fmtWalkPace(f.level, f.duration)})`; }
      if (logType === 'pace' && f.level) { return `${d} · ${f.duration}min @ ${f.level}mph (${fmtPace(f.level)})`; }
      if (logType === 'time') { return `${d} · ${sets.length}×${f.duration} sec`; }
      const tot = sets.reduce((s, e) => s + (e.duration || 0), 0); return `${d} · ${tot} min`;
    }
    return d;
  }

  function csvEsc(s) { return String(s || '').replace(/[,\n"]/g, ' '); }

  function toCSV(entries) {
    const h = 'datetime,gym,room,machine,machineId,set,weight,reps,duration,level,incline,hr,notes,zone1,zone2,zone3,zone4,zone5';
    const rows = entries.map(e => [
      csvEsc(e.datetime||e.date), csvEsc(e.gym), csvEsc(e.room), csvEsc(e.machine), e.machineId, e.set,
      e.weight != null ? e.weight : '', e.reps != null ? e.reps : '',
      e.duration != null ? e.duration : '', e.level != null ? e.level : '',
      e.incline != null ? e.incline : '', e.hr != null ? e.hr : '',
      csvEsc(e.notes || ''),
      e.zone1 != null ? e.zone1 : '', e.zone2 != null ? e.zone2 : '',
      e.zone3 != null ? e.zone3 : '', e.zone4 != null ? e.zone4 : '',
      e.zone5 != null ? e.zone5 : ''
    ].join(','));
    return [h, ...rows].join('\n');
  }

  return { fmtPace, fmtWalkPace, parseMinutes, fmtDuration, fmtDate, fmtDateFull, fmtLast, csvEsc, toCSV };
});
