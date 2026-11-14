// Per-eye closure on a personal 0..1 scale (0 = this person's relaxed open eye, 1 = fully closed).
//
// Two independent readings per eye, combined:
//   b = MediaPipe blendshape eyeBlink (0..1, rises when closing)
//   r = lid ratio = eyelid gap / eye width (falls when closing). Dividing by eye width makes it
//       independent of eye size and distance from the camera.
// Each is scaled to the person's own open..closed range, then they're averaged with weights set by
// how cleanly each one separated open from closed at calibration. Glasses glare usually corrupts one
// reading more than the other; that one gets down-weighted automatically.

export function closure(raw, tf, parts) {
  // raw: { b: {L,R}, r: {L,R} }   tf: calibration transform   parts: optional {L:{nb,nr},R:{...}} out
  const out = {};
  for (const e of ['L', 'R']) {
    const t = tf[e];
    const nb = (raw.b[e] - t.b.open) / (t.b.closed - t.b.open);
    const nr = (t.r.open - raw.r[e]) / (t.r.open - t.r.closed);
    out[e] = (t.wb * nb + t.wr * nr) / (t.wb + t.wr);
    if (parts) parts[e] = { nb, nr };
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))] : NaN; };
export const stats = { median, quantile };

/**
 * Build the transform from relaxed (open) frames and eyes-closed frames.
 * openRows/closedRows: arrays of raw frames {b:{L,R}, r:{L,R}}
 */
export function fitTransform(openRows, closedRows) {
  const tf = {};
  const notes = [];
  for (const e of ['L', 'R']) {
    const bo = openRows.map((x) => x.b[e]), ro = openRows.map((x) => x.r[e]);
    const bc = closedRows.map((x) => x.b[e]), rc = closedRows.map((x) => x.r[e]);
    const b = { open: median(bo), closed: median(bc) };
    const r = { open: median(ro), closed: median(rc) };
    // guarantee a usable range even if a reading barely moved (then its weight goes ~0 anyway)
    if (b.closed - b.open < 0.05) b.closed = b.open + 0.05;
    if (r.open - r.closed < 0.01) r.closed = r.open - 0.01;
    // noise of each reading while relaxed, in its own normalized units
    const nbOpen = bo.map((v) => (v - b.open) / (b.closed - b.open));
    const nrOpen = ro.map((v) => (r.open - v) / (r.open - r.closed));
    const sd = (a) => { const m = median(a); return 1.4826 * median(a.map((v) => Math.abs(v - m))) + 0.02; };
    const sb = sd(nbOpen), sr = sd(nrOpen);
    // separation is 1.0 by construction, so reliability = 1 / noise^2
    const wb = 1 / (sb * sb), wr = 1 / (sr * sr);
    tf[e] = { b, r, wb, wr, noiseB: sb, noiseR: sr };
    const share = wb / (wb + wr);
    if (share > 0.85) notes.push(`${e === 'L' ? 'Left' : 'Right'} eye: lid-shape reading was noisy (glasses glare?), relying mostly on the blink score.`);
    if (share < 0.15) notes.push(`${e === 'L' ? 'Left' : 'Right'} eye: blink score was noisy, relying mostly on lid shape.`);
  }
  return { tf, notes };
}

// Find closure intervals of one eye or both in a series of {t, cL, cR}
export function closureIntervals(series, pick, thrOn = 0.5, thrOff = 0.3) {
  const out = [];
  let start = null, peak = 0;
  for (const s of series) {
    const c = pick(s);
    if (start === null && c > thrOn) { start = s.t; peak = c; }
    else if (start !== null) {
      peak = Math.max(peak, c);
      if (c < thrOff) { out.push({ start, end: s.t, dur: s.t - start, peak }); start = null; }
    }
  }
  return out;
}
