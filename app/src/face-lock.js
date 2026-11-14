// One user only. Locks onto the calibrated user's face and follows it frame to frame, so a caregiver
// leaning into view never takes over. Pure logic (unit tested).
//
// update(faces, t) with faces = [{cx, cy, size, sig}] (normalized 0..1 frame coords) returns
//   { index: number|null, status: 'locked'|'ambiguous'|'lost'|'searching', multiple: bool }
// 'ambiguous' => input pauses (and the robot stops) until it's clear which face is the user.
export class FaceLock {
  constructor({ sigThresh = 3.5, relockMs = 800 } = {}) {
    this.sigThresh = sigThresh;
    this.relockMs = relockMs;
    this.sig = null;
    this.pos = null;   // {cx, cy, size}
    this.lostAt = null;
    this.single = null; // {since} a single face present while searching (no signature case)
    this.refSize = null; // typical size of the user's face in frame
  }

  setSignature(sig) { this.sig = sig; }
  reset() { this.pos = null; this.lostAt = null; this.single = null; this.refSize = null; }

  sigDist(s) {
    if (!this.sig || !s) return null;
    let acc = 0;
    for (let i = 0; i < s.length; i++) acc += ((s[i] - this.sig.mean[i]) / Math.max(this.sig.sd[i], 0.015)) ** 2;
    return Math.sqrt(acc / s.length);
  }

  take(f, i) {
    const k = this.pos ? 0.35 : 1;
    this.pos = this.pos ? { cx: this.pos.cx + k * (f.cx - this.pos.cx), cy: this.pos.cy + k * (f.cy - this.pos.cy), size: this.pos.size + k * (f.size - this.pos.size) } : { cx: f.cx, cy: f.cy, size: f.size };
    this.lostAt = null; this.single = null;
    return i;
  }

  // In a crowd: people behind the user are much smaller in frame. Once we know how big the user's
  // face is, anything clearly smaller is ignored completely (it can't take over, pause input, or
  // even count as "multiple faces").
  update(all, t) {
    const ref = this.refSize;
    const keep = all.map((f, i) => ({ f, i })).filter((x) => !ref || x.f.size >= 0.55 * ref);
    const r = this._update(keep.map((x) => x.f), t);
    if (r.index !== null) {
      const f = keep[r.index].f;
      this.refSize = ref ? ref + 0.02 * (f.size - ref) : f.size;
      r.index = keep[r.index].i;
    }
    r.ignored = all.length - keep.length;
    return r;
  }

  _update(faces, t) {
    const multiple = faces.length > 1;
    const res = (index, status) => ({ index, status, multiple });
    if (!faces.length) {
      if (this.pos && this.lostAt === null) this.lostAt = t;
      return res(null, this.pos ? 'lost' : 'searching');
    }
    const matches = (f) => { const d = this.sigDist(f.sig); return d === null || d < this.sigThresh; };

    // ---- following a locked face: position continuity
    if (this.pos && this.lostAt === null) {
      const near = faces.map((f, i) => ({ f, i, d: Math.hypot(f.cx - this.pos.cx, f.cy - this.pos.cy) / this.pos.size, r: f.size / this.pos.size }))
        .filter((x) => x.d < 0.6 && x.r > 0.6 && x.r < 1.6)
        .sort((a, b) => a.d - b.d);
      if (near.length === 1) return res(this.take(near[0].f, near[0].i), 'locked');
      if (near.length > 1) {
        // two faces where the user was (overlapping): decide by signature, else pause
        const bySig = near.map((x) => ({ ...x, s: this.sigDist(x.f.sig) })).filter((x) => x.s !== null).sort((a, b) => a.s - b.s);
        if (bySig.length >= 2 && bySig[0].s < this.sigThresh && bySig[1].s - bySig[0].s > 1.5) return res(this.take(bySig[0].f, bySig[0].i), 'locked');
        if (near[1].d - near[0].d > 0.35) return res(this.take(near[0].f, near[0].i), 'locked');
        return res(null, 'ambiguous');
      }
      this.lostAt = t; // the user moved away or out of frame
    }

    // ---- searching / re-acquiring
    const cands = faces.map((f, i) => ({ f, i })).filter((x) => matches(x.f));
    if (this.sig) {
      const scored = cands.map((x) => ({ ...x, s: this.sigDist(x.f.sig) })).sort((a, b) => a.s - b.s);
      if (scored.length === 1 || (scored.length > 1 && scored[1].s - scored[0].s > 1.5)) return res(this.take(scored[0].f, scored[0].i), 'locked');
      // several look-alikes: the user is the one still sitting where the user was
      if (this.pos && scored.length > 1) {
        const byPos = scored.map((x) => ({ ...x, d: Math.hypot(x.f.cx - this.pos.cx, x.f.cy - this.pos.cy) / this.pos.size })).sort((a, b) => a.d - b.d);
        if (byPos[0].d < 1 && byPos[1].d - byPos[0].d > 1) return res(this.take(byPos[0].f, byPos[0].i), 'locked');
      }
      return res(null, scored.length ? 'ambiguous' : this.pos ? 'lost' : 'searching');
    }
    // no signature yet (before calibration): only lock when exactly one face is steadily present
    if (faces.length === 1) {
      if (!this.single) this.single = { since: t };
      if (!this.pos || t - this.single.since >= this.relockMs) return res(this.take(faces[0], 0), 'locked');
      return res(null, 'lost');
    }
    this.single = null;
    // several faces and no signature: take the clearly biggest (closest to the camera), else wait
    const bySize = faces.map((f, i) => ({ f, i })).sort((a, b) => b.f.size - a.f.size);
    if (!this.pos && bySize[0].f.size > 1.4 * bySize[1].f.size) return res(this.take(bySize[0].f, bySize[0].i), 'locked');
    return res(null, this.pos ? 'lost' : 'ambiguous');
  }
}
