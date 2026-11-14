// Calibration v3: learn THIS person's eyes, then prove the settings work before using them.
//
//   1. relaxed  (12 s)  follow a moving circle, blink normally           -> what "nothing" looks like
//   2. closed   (3 s)   close both eyes until the chime                  -> fully-closed reference + BOTH_CLOSED
//   3. gestures (2 each) double blink, wink L, wink R, hold L, hold R    -> how they do each one
//   4. fit thresholds between "nothing" and each gesture, with margins
//   5. replay the recorded calibration through the fitted engine: report card, disable what isn't reliable
//
// Pure functions (no DOM): unit-tested with simulated people (glasses, small eyes, weak closure,
// partial winks, can't wink).
import { fitTransform, closure, closureIntervals, stats } from './closure.js';
import { GestureEngine, DEFAULT_PARAMS, GESTURES } from './gesture-engine.js';

const { median, quantile } = stats;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const RELAXED_MS = 12000;
export const CLOSED_MS = 4000;
export const CLOSED_CHIME_MS = 3600;
export const REPS = 2; // whole calibration is about one minute
export const ENROLL = [
  { g: 'DOUBLE_BLINK', label: 'Double blink', cue: 'Blink twice, slowly and firmly', windowMs: 2600 },
  { g: 'WINK_LEFT', label: 'Wink left', cue: 'Wink your LEFT eye', windowMs: 2000 },
  { g: 'WINK_RIGHT', label: 'Wink right', cue: 'Wink your RIGHT eye', windowMs: 2000 },
  { g: 'HOLD_LEFT', label: 'Hold left', cue: 'Close your LEFT eye until the chime', windowMs: 2600, chimeMs: 1900 },
  { g: 'HOLD_RIGHT', label: 'Hold right', cue: 'Close your RIGHT eye until the chime', windowMs: 2600, chimeMs: 1900 },
  { g: 'BROW_HOLD', label: 'Raise eyebrows', cue: 'Raise your eyebrows until the chime', windowMs: 5600, chimeMs: 4800 },
];

function corr(a, b) {
  const n = a.length; if (n < 5) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db + 1e-12);
}

/**
 * samples = {
 *   relaxed: [{t, face, raw}], closed: [{t, face, raw}],
 *   reps: { DOUBLE_BLINK: [[frames...], ...], WINK_LEFT: [...], ... }   (each rep starts at its cue)
 *   sig?: [number[]] face signatures from relaxed, eyeWidthPx?: number
 * }
 */
export function fitCalibration(samples) {
  const report = { ok: false, gestures: {}, notes: [], warnings: [], falseOnRelaxed: 0 };
  const faces = (rows) => (rows || []).filter((f) => f.face);
  const relaxed = faces(samples.relaxed);
  const closedAll = faces(samples.closed);
  if (relaxed.length < 80 || closedAll.length < 15) {
    report.warnings.push('Your face was not visible for most of the calibration. Check lighting and sit in front of the camera.');
    return { cal: null, report };
  }

  // ---- 1. which blendshape channel belongs to which eye? (lid ratio side is known from geometry)
  const winkFrames = ['WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT'].flatMap((g) => (samples.reps?.[g] || []).flat()).filter((f) => f.face);
  let swapB = false;
  if (winkFrames.length > 30) {
    const bL = winkFrames.map((f) => f.raw.b.L), rL = winkFrames.map((f) => -f.raw.r.L), rR = winkFrames.map((f) => -f.raw.r.R);
    swapB = corr(bL, rR) > corr(bL, rL) + 0.1;
  }
  const fix = (f) => (swapB ? { ...f, raw: { ...f.raw, b: { L: f.raw.b.R, R: f.raw.b.L } } } : f);

  // ---- 2. personal open/closed scale. Exclude natural blinks from "open".
  const rx = relaxed.map(fix);
  const bMid = median(rx.map((f) => (f.raw.b.L + f.raw.b.R) / 2));
  const blinkish = rx.map((f) => (f.raw.b.L + f.raw.b.R) / 2 > bMid + 0.2);
  const openRows = rx.filter((_, i) => !blinkish.slice(Math.max(0, i - 4), i + 5).some(Boolean)).map((f) => f.raw);
  const t0c = closedAll[0].t;
  const closedRows = closedAll.map(fix).filter((f) => f.t - t0c > 800).map((f) => f.raw);
  const { tf, notes } = fitTransform(openRows, closedRows);
  report.notes.push(...notes);
  const series = (rows) => rows.filter((f) => f.face).map(fix).map((f) => { const c = closure(f.raw, tf); return { t: f.t, cL: c.L, cR: c.R }; });
  const sRelaxed = series(relaxed);
  const sOpen = openRows.map((r) => closure(r, tf));
  const sClosed = closedRows.map((r) => closure(r, tf));
  if (median(sClosed.map((c) => (c.L + c.R) / 2)) < 0.6) report.warnings.push('Closing your eyes barely changed the reading. Calibrate again with your eyes fully closed.');

  // ---- 3. did they wink with the eye we asked for? (some webcams mirror the image)
  const repSeries = {};
  for (const { g } of ENROLL) repSeries[g] = (samples.reps?.[g] || []).map((rep) => series(rep));
  const sideScore = (g, eye) => repSeries[g].flat().map((s) => s[eye] - s[eye === 'cL' ? 'cR' : 'cL']).reduce((a, b) => a + Math.max(0, b), 0);
  const leftAsked = sideScore('WINK_LEFT', 'cL') + sideScore('HOLD_LEFT', 'cL');
  const leftOther = sideScore('WINK_LEFT', 'cR') + sideScore('HOLD_LEFT', 'cR');
  const swapSides = leftOther > leftAsked * 1.5 && leftOther > 5;
  if (swapSides) { report.notes.push('Your left and right were swapped by the camera (mirrored image); corrected.'); for (const g in repSeries) repSeries[g] = repSeries[g].map((r) => r.map((s) => ({ t: s.t, cL: s.cR, cR: s.cL }))); }
  const sw = (s) => (swapSides ? { t: s.t, cL: s.cR, cR: s.cL } : s);

  // ---- 4. thresholds
  const P = structuredClone(DEFAULT_PARAMS);
  const oL = sOpen.map((c) => c.L), oR = sOpen.map((c) => c.R);
  const openP99 = swapSides ? { L: quantile(oR, 0.99), R: quantile(oL, 0.99) } : { L: quantile(oL, 0.99), R: quantile(oR, 0.99) };
  const closedMed = (e) => median(sClosed.map((c) => c[swapSides ? (e === 'L' ? 'R' : 'L') : e]));
  const eyeKey = { left: 'L', right: 'R' };
  for (const e of ['L', 'R']) {
    const side = e === 'L' ? 'left' : 'right';
    const peaks = [...repSeries[`WINK_${side.toUpperCase()}`], ...repSeries[`HOLD_${side.toUpperCase()}`]]
      .map((r) => Math.max(...r.map((s) => s['c' + e]), 0)).filter((v) => v > 0.35);
    const peakLow = peaks.length >= 2 ? quantile(peaks, 0.2) : closedMed(e);
    P.closeT[e] = clamp((openP99[e] + Math.min(peakLow, 1)) / 2, 0.35, 0.7);
    P.openT[e] = clamp(Math.max(openP99[e] + 0.05, P.closeT[e] - 0.25), 0.15, P.closeT[e] - 0.1);
  }
  const winkDurs = [];
  const sideReliable = {};
  for (const side of ['left', 'right']) {
    const e = eyeKey[side], o = e === 'L' ? 'R' : 'L';
    // per rep, only the frames inside its longest closure of this eye (natural blinks in the rep are excluded)
    const frames = [];
    for (const r of [...repSeries[`WINK_${side.toUpperCase()}`], ...repSeries[`HOLD_${side.toUpperCase()}`]]) {
      const iv = closureIntervals(r, (s) => s['c' + e], P.closeT[e], P.openT[e]);
      if (!iv.length) continue;
      const best = iv.reduce((a, b) => (b.dur > a.dur ? b : a));
      frames.push(...r.filter((s) => s.t >= best.start + 60 && s.t <= best.end - 60));
    }
    if (frames.length < 10) { sideReliable[side] = false; continue; }
    // typical level of the other eye during this person's winks. A median, not a high percentile:
    // with only two reps, one natural blink of the open eye would otherwise dominate.
    const other90 = quantile(frames.map((s) => s['c' + o]), 0.55);
    P.otherMax[side] = clamp(other90 + 0.2, 0.25, P.closeT[o] - 0.04);
    sideReliable[side] = other90 < P.closeT[o] - 0.15;
    // the other eye must count as "open" at the level it drags to during this person's winks,
    // or after a natural blink mid-hold it would look stuck closed
    P.openT[o] = clamp(Math.max(P.openT[o], other90 + 0.08), 0.15, P.closeT[o] - 0.08);
    if (!sideReliable[side]) report.notes.push(`When you close your ${side} eye, your other eye closes a lot too, so ${side} winks are hard to tell from blinks.`);
    const asym = frames.map((s) => s['c' + e] - s['c' + o]);
    P.asymMin = Math.min(P.asymMin, clamp(quantile(asym, 0.2) * 0.7, 0.3, 0.7));
    for (const r of repSeries[`WINK_${side.toUpperCase()}`]) {
      const iv = closureIntervals(r, (s) => s['c' + e] - s['c' + o], 0.4, 0.2);
      if (iv.length) winkDurs.push(Math.max(...iv.map((x) => x.dur)));
    }
  }
  if (winkDurs.length >= 2) {
    P.winkMinMs = clamp(0.45 * Math.min(...winkDurs), 150, 280);
    P.holdMs = clamp(Math.max(...winkDurs) * 1.3, 650, 1300);
  }
  // double blink = two SLOW, deliberate blinks. Each must last clearly longer than this person's
  // natural blinks, so natural blink pairs (which everyone has) can't be mistaken for it.
  const bothLow = Math.min(P.closeT.L, P.closeT.R), bothOff = Math.max(P.openT.L, P.openT.R);
  const nat = closureIntervals(sRelaxed.map(sw), (s) => Math.min(s.cL, s.cR), bothLow, bothOff);
  // a short relaxed sample only catches a few blinks, so never assume natural blinks are shorter than 180 ms
  const natP95 = Math.max(180, nat.length ? quantile(nat.map((x) => x.dur), 0.95) : 0);
  const dblCloses = [], dblGaps = [];
  for (const r of repSeries.DOUBLE_BLINK) {
    const iv = closureIntervals(r, (s) => Math.min(s.cL, s.cR), bothLow, bothOff);
    for (let i = 0; i + 1 < iv.length; i++) {
      const gap = iv[i + 1].start - iv[i].end;
      if (gap < 900) { dblCloses.push(iv[i].dur, iv[i + 1].dur); dblGaps.push(gap); break; }
    }
  }
  P.dbl.closeMinMs = clamp(natP95 + 50, 200, 330);
  if (dblGaps.length >= 1) {
    const minClose = Math.min(...dblCloses);
    if (minClose * 0.85 < P.dbl.closeMinMs) {
      report.notes.push('Your double blinks were about as quick as your normal blinks. Make each of the two blinks slower and firmer, then recalibrate, or double blink may be unreliable.');
    }
    P.dbl.closeMaxMs = clamp(Math.max(...dblCloses) * 1.5, P.dbl.closeMinMs + 200, 700);
    P.dbl.gapMaxMs = clamp(Math.max(...dblGaps) * 1.35, 300, 700);
  }
  report.naturalBlinksPerMin = Number(((nat.length * 60000) / RELAXED_MS).toFixed(1));

  // eyebrows: rest level from relaxed reading, raised level from the reps
  let brow = null;
  const restB = relaxed.map((f) => f.raw.brow).filter((v) => typeof v === 'number');
  const repB = (samples.reps?.BROW_HOLD || []).map((rep) => quantile(rep.filter((f) => f.face && typeof f.raw.brow === 'number').map((f) => f.raw.brow), 0.7)).filter((v) => !Number.isNaN(v));
  if (restB.length > 100 && repB.length >= 1) {
    const rest = median(restB), raised = median(repB);
    if (raised - rest > 0.15) brow = { rest, raised };
    else report.notes.push('Raising your eyebrows barely showed up on camera, so that gesture is off.');
  }

  // ---- 5. replay the calibration through the fitted engine: the report card
  const cal = { version: 3, createdAt: Date.now(), tf, swapB, swapSides, brow, params: P };
  const replay = (rows, enabled) => {
    const eng = new GestureEngine({ ...cal, params: { ...P, enabled } });
    const out = [];
    for (const f of rows) out.push(...eng.update(f, f.t).filter((e) => GESTURES.includes(e.type) || e.type === 'HOLD_END'));
    return out;
  };
  const allOn = Object.fromEntries(GESTURES.map((g) => [g, true]));
  const relaxedEv = replay(samples.relaxed, allOn).filter((e) => e.type !== 'HOLD_END');
  report.falseOnRelaxed = relaxedEv.length;
  const falseBy = Object.fromEntries(GESTURES.map((g) => [g, relaxedEv.filter((e) => e.type === g).length]));

  const enabled = {};
  const closedEv = replay(samples.closed, allOn);
  const bothOk = closedEv.some((e) => e.type === 'BOTH_CLOSED');
  report.gestures.BOTH_CLOSED = { label: 'Close both eyes 2 s', detected: bothOk ? 1 : 0, of: 1, reliable: bothOk && !falseBy.BOTH_CLOSED };
  enabled.BOTH_CLOSED = true; // safety stop is never disabled
  for (const { g, label } of ENROLL) {
    const reps = samples.reps?.[g] || [];
    let hit = 0, wrong = 0;
    for (const rep of reps) {
      const ev = replay(rep, allOn).filter((e) => e.type !== 'HOLD_END');
      if (ev.some((e) => e.type === g)) hit++;
      if (ev.some((e) => e.type !== g)) wrong++;
    }
    const side = g.includes('LEFT') ? 'left' : g.includes('RIGHT') ? 'right' : null;
    const needHit = Math.max(1, reps.length - 1);
    let reliable = reps.length > 0 && hit >= needHit && wrong <= 1 && falseBy[g] === 0 && (side ? sideReliable[side] !== false : true);
    let reason = '';
    if (!reps.length) reason = 'skipped';
    else if (hit < needHit) reason = `caught ${hit} of ${reps.length}`;
    else if (wrong > 1) reason = 'got confused with another gesture';
    else if (falseBy[g]) reason = 'fired while you were relaxed';
    else if (side && sideReliable[side] === false) reason = 'other eye closes too much';
    report.gestures[g] = { label, detected: hit, of: reps.length, reliable, reason };
    enabled[g] = reliable;
  }
  cal.params.enabled = enabled;

  if (samples.sig?.length) {
    const dims = samples.sig[0].length;
    const m = Array.from({ length: dims }, (_, i) => median(samples.sig.map((s) => s[i])));
    const sd = Array.from({ length: dims }, (_, i) => 1.4826 * median(samples.sig.map((s) => Math.abs(s[i] - m[i]))) + 0.01);
    cal.signature = { mean: m, sd };
  }
  const usable = ENROLL.filter(({ g }) => enabled[g]).length;
  report.ok = bothOk && usable >= 1;
  if (!bothOk) report.warnings.push('Closing both eyes for 2 seconds was not detected. That is the stop gesture, so calibration needs it.');
  if (usable === 0) report.warnings.push('No gesture was reliable. Try again closer to the camera, with light on your face.');
  report.usable = usable;
  return { cal: report.ok ? cal : null, report };
}


// ============================================================================
// Quick calibration (what the app uses): ~20 s, no per-gesture enrollment.
//   relaxed: follow the circle, blink normally      -> open-eye baseline, natural blink length, brow rest
//   closed:  close both eyes until the beep         -> fully-closed reference
// Thresholds are standard values on the person's own open..closed scale. The practice screen then
// shows which gestures actually register.
// ============================================================================
export const QUICK = { RELAXED_MS: 8000, CLOSED_MS: 3500, BROW_MS: 2500, WINK_MS: 2500 };

export function quickCalibration(samples) {
  const report = { ok: false, notes: [], warnings: [] };
  const relaxed = (samples.relaxed || []).filter((f) => f.face);
  const closedAll = (samples.closed || []).filter((f) => f.face);
  if (relaxed.length < 40 || closedAll.length < 15) {
    report.warnings.push('Your face was not visible for most of the calibration. Check lighting and sit in front of the camera.');
    return { cal: null, report };
  }
  // open frames: relaxed, away from natural blinks
  const bAvg = (f) => (f.raw.b.L + f.raw.b.R) / 2;
  const bMid = median(relaxed.map(bAvg));
  const blinkish = relaxed.map((f) => bAvg(f) > bMid + 0.2);
  const openRows = relaxed.filter((_, i) => !blinkish.slice(Math.max(0, i - 4), i + 5).some(Boolean)).map((f) => f.raw);
  // closed frames: whenever in the window the eyes really were closed (no assumption about reaction time)
  const lo = quantile(closedAll.map(bAvg), 0.1), hi = quantile(closedAll.map(bAvg), 0.9);
  const rOpen = median(relaxed.map((f) => (f.raw.r.L + f.raw.r.R) / 2));
  const rMin = quantile(closedAll.map((f) => (f.raw.r.L + f.raw.r.R) / 2), 0.1);
  const byBlink = hi - bMid > 0.15, byLid = rOpen - rMin > 0.25 * rOpen;
  if (!byBlink && !byLid) {
    report.warnings.push('We did not see your eyes close. Close them fully when you hear "close both eyes", and keep them closed until the beep.');
    return { cal: null, report };
  }
  const isClosed = (f) => (byBlink ? bAvg(f) > (bMid + hi) / 2 : (f.raw.r.L + f.raw.r.R) / 2 < (rOpen + rMin) / 2);
  const closedFrames = closedAll.filter(isClosed);
  const closedMs = closedFrames.length ? closedFrames.at(-1).t - closedFrames[0].t : 0;
  if (closedFrames.length < 10 || closedMs < 700) {
    report.warnings.push('Your eyes were closed too briefly. Keep them closed until the beep.');
    return { cal: null, report };
  }
  const { tf, notes } = fitTransform(openRows.length > 20 ? openRows : relaxed.map((f) => f.raw), closedFrames.map((f) => f.raw));
  report.notes.push(...notes);

  const P = structuredClone(DEFAULT_PARAMS);
  P.otherMax = { left: 0.78, right: 0.78 }; // winks are judged by lopsidedness; the other eye may squint
  P.asymMin = 0.28;
  // each person's own winks: how lopsided THEIR left and right winks really are (one side is often
  // much weaker, with the other eye closing most of the way too)
  report.winks = {};
  if (samples.winkL?.length || samples.winkR?.length) {
    P.asymMin = { left: P.asymMin, right: P.asymMin }; P.winkOn = {}; 
    for (const [side, rows] of [['left', samples.winkL], ['right', samples.winkR]]) {
      const e = side === 'left' ? 'L' : 'R', o = side === 'left' ? 'R' : 'L';
      const cs = (rows || []).filter((f) => f.face).map((f) => closure(f.raw, tf)).map((c) => ({ e: c[e], o: c[o], d: c[e] - c[o] }));
      const top = cs.filter((x) => x.e > 0.3).sort((a, b) => b.d - a.d);
      const best = top.slice(0, Math.max(1, Math.floor(top.length / 2))); // the clearly-winking half of the step
      if (best.length < 6) { report.winks[side] = { ok: false, why: 'no wink seen' }; report.notes.push(`We did not see a ${side} wink, so it uses the standard setting.`); continue; }
      const d = median(best.map((x) => x.d)), lvl = median(best.map((x) => x.e)), other = quantile(best.map((x) => x.o), 0.9);
      if (d < 0.12) { report.winks[side] = { ok: false, d, why: 'both eyes close together' }; report.notes.push(`Your ${side} wink closes both eyes almost equally, so it may be unreliable.`); P.asymMin[side] = 0.15; continue; }
      P.asymMin[side] = clamp(0.55 * d, 0.15, 0.35);
      P.winkOn[side] = clamp(0.7 * lvl, 0.3, P.closeT[e] - 0.1);
      P.otherMax[side] = clamp(other + 0.15, 0.6, 0.9);
      report.winks[side] = { ok: true, d, level: lvl, other };
    }
  }
  // natural blink length -> how slow a "slow double blink" must be
  const ser = relaxed.map((f) => { const c = closure(f.raw, tf); return { t: f.t, cL: c.L, cR: c.R }; });
  const nat = closureIntervals(ser, (x) => Math.min(x.cL, x.cR), 0.55, 0.3);
  const natP95 = Math.max(180, nat.length ? quantile(nat.map((x) => x.dur), 0.95) : 0);
  P.dbl.closeMinMs = clamp(natP95 + 25, 200, 300);
  const restB = relaxed.map((f) => f.raw.brow).filter((v) => typeof v === 'number');
  let brow = restB.length > 20 ? { rest: median(restB), raised: median(restB) + 0.4 } : null;
  // if the person did the eyebrow step, use how high THEIR eyebrows actually go
  const upB = (samples.brow || []).filter((f) => f.face && typeof f.raw.brow === 'number').map((f) => f.raw.brow);
  if (brow && upB.length > 10) {
    const raised = quantile(upB, 0.75);
    if (raised - brow.rest > 0.15) brow = { rest: brow.rest, raised, measured: true };
    else report.notes.push('Raising your eyebrows barely showed up, so eyebrow control may be unreliable.');
  }
  // sideways gaze: what the reading looks like when the circle sat at the left and right of the screen
  let gaze = null;
  const gAt = (pick) => relaxed.filter((f) => f.settled && typeof f.raw.gaze === 'number' && pick(f.x) && closure(f.raw, tf).L < 0.4 && closure(f.raw, tf).R < 0.4).map((f) => f.raw.gaze);
  const gl = gAt((x) => x < 35), gr = gAt((x) => x > 65);
  if (gl.length > 8 && gr.length > 8) {
    const left = median(gl), right = median(gr);
    gaze = { left, right, center: (left + right) / 2, ok: Math.abs(left - right) > 0.08 };
    if (!gaze.ok) report.notes.push('Looking left and right barely showed up, so steering by looking may be unreliable.');
  }
  const cal = { version: 3, quick: true, createdAt: Date.now(), tf, swapB: false, swapSides: false, brow, gaze, params: P };
  if (samples.sig?.length) {
    const dims = samples.sig[0].length;
    const m = Array.from({ length: dims }, (_, i) => median(samples.sig.map((x) => x[i])));
    const sd = Array.from({ length: dims }, (_, i) => 1.4826 * median(samples.sig.map((x) => Math.abs(x[i] - m[i]))) + 0.01);
    cal.signature = { mean: m, sd };
  }
  report.ok = true;
  report.stats = { winks: report.winks, asymMin: P.asymMin, winkOn: P.winkOn, openB: bMid, closedB: hi, lidOpen: rOpen, lidClosed: rMin, gaze, naturalBlinks: nat.length, slowBlinkMinMs: Math.round(P.dbl.closeMinMs), closedMs: Math.round(closedMs) };
  return { cal, report };
}
