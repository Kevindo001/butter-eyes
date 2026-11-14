// Calibration: ~20 s guided routine. Pure math lives in computeCalibration() so it is testable.
//
// Phases (each collects frames after a short settle time):
//   center  - look at the dot, eyes relaxed (neutral gaze + open-eye lid baseline)
//   left / right / up / down - look toward the arrow, keep head still
//   closed  - close both eyes gently
//   winkL / winkR (optional) - close only that eye; skipped if the user can't
export const PHASES = [
  { id: 'center', label: 'Look at the dot', settle: 600, collect: 2400 },
  { id: 'left', label: 'Look LEFT (eyes only)', settle: 700, collect: 1600 },
  { id: 'right', label: 'Look RIGHT (eyes only)', settle: 700, collect: 1600 },
  { id: 'up', label: 'Look UP (eyes only)', settle: 700, collect: 1600 },
  { id: 'down', label: 'Look DOWN (eyes only)', settle: 700, collect: 1600 },
  { id: 'center2', label: 'Back to the dot', settle: 500, collect: 1500 },
  { id: 'closed', label: 'Close both eyes until you hear the chime', settle: 700, collect: 1500 },
  { id: 'winkL', label: 'Close only your LEFT eye (skip if you can\'t)', settle: 700, collect: 1400, optional: true },
  { id: 'winkR', label: 'Close only your RIGHT eye (skip if you can\'t)', settle: 700, collect: 1400, optional: true },
];

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const colMedian = (rows) => rows[0].map((_, i) => median(rows.map((r) => r[i])));
const colMad = (rows, med) => rows[0].map((_, i) => 1.4826 * median(rows.map((r) => Math.abs(r[i] - med[i]))));

/**
 * samples: { [phaseId]: Array<{face, blinkL, blinkR, feat}> }
 * returns { cal, report } ; cal === null when unusable
 */
export function computeCalibration(samples) {
  const report = { ok: false, warnings: [], dirs: {}, winks: false };
  const faces = (id) => (samples[id] || []).filter((s) => s.face);
  const neutralRows = [...faces('center'), ...faces('center2')].filter((s) => s.blinkL < 0.5 && s.blinkR < 0.5);
  if (neutralRows.length < 20) {
    report.warnings.push('Face not found while looking at the center dot. Improve lighting / sit in front of the camera.');
    return { cal: null, report };
  }
  const nMed = colMedian(neutralRows.map((s) => s.feat));
  // robust spread, with a floor so a perfectly still face doesn't make thresholds razor thin
  const nSd = colMad(neutralRows.map((s) => s.feat), nMed).map((v, i) => Math.max(v, 0.01, Math.abs(nMed[i]) * 0.02));

  const dirs = {};
  for (const d of ['left', 'right', 'up', 'down']) {
    const rows = faces(d).filter((s) => s.blinkL < 0.6 && s.blinkR < 0.6);
    if (rows.length < 10) { report.warnings.push(`No usable frames for "${d}".`); continue; }
    const m = colMedian(rows.map((s) => s.feat));
    const sep = Math.sqrt(m.reduce((a, x, i) => a + ((x - nMed[i]) / nSd[i]) ** 2, 0));
    report.dirs[d] = Number(sep.toFixed(1));
    if (sep < 2) { report.warnings.push(`Looking ${d} was hard to tell apart from center (separation ${sep.toFixed(1)}). That direction is disabled; use blinks/winks for it.`); continue; }
    dirs[d] = m;
  }
  // directions must also be distinct from each other
  const ds = Object.keys(dirs);
  for (let a = 0; a < ds.length; a++) for (let b = a + 1; b < ds.length; b++) {
    const va = dirs[ds[a]], vb = dirs[ds[b]];
    const dist = Math.sqrt(va.reduce((s, x, i) => s + ((x - vb[i]) / nSd[i]) ** 2, 0));
    if (dist < 2) report.warnings.push(`"${ds[a]}" and "${ds[b]}" look the same to the camera.`);
  }

  const openL = median(neutralRows.map((s) => s.blinkL));
  const openR = median(neutralRows.map((s) => s.blinkR));
  const closedRows = faces('closed');
  let closedL = closedRows.length ? median(closedRows.map((s) => s.blinkL)) : NaN;
  let closedR = closedRows.length ? median(closedRows.map((s) => s.blinkR)) : NaN;
  if (!(closedL - openL > 0.2 && closedR - openR > 0.2)) {
    report.warnings.push('Closing both eyes was not detected clearly. Blink gestures will use default thresholds.');
    closedL = Math.max(closedL || 0, openL + 0.45);
    closedR = Math.max(closedR || 0, openR + 0.45);
  }

  // winks: the MediaPipe "left/right" channels can be mirrored; detect which channel rose.
  let swap = false;
  const wl = faces('winkL'), wr = faces('winkR');
  const winkScore = (rows, chan) => rows.length ? median(rows.map((s) => s[chan])) : 0;
  if (wl.length >= 10 && wr.length >= 10) {
    const lL = winkScore(wl, 'blinkL'), lR = winkScore(wl, 'blinkR');
    const rL = winkScore(wr, 'blinkL'), rR = winkScore(wr, 'blinkR');
    const straight = (lL - lR) + (rR - rL);
    const mirrored = (lR - lL) + (rL - rR);
    swap = mirrored > straight;
    const sepWink = Math.max(straight, mirrored) / 2;
    report.winks = sepWink > 0.25;
    if (!report.winks) report.warnings.push('Winks were not clearly one-eyed; wink gestures are off (that is normal for many people).');
  }

  const cal = {
    version: 2,
    createdAt: Date.now(),
    featDim: nMed.length,
    neutral: { mean: nMed, sd: nSd },
    dirs,
    blink: { L: { open: openL, closed: closedL }, R: { open: openR, closed: closedR } },
    swapEyes: swap,
    winks: report.winks,
  };
  report.ok = Object.keys(dirs).length >= 2;
  if (!report.ok) report.warnings.push('Fewer than 2 gaze directions usable. Recalibrate with brighter, front lighting.');
  return { cal: report.ok ? cal : null, report };
}
