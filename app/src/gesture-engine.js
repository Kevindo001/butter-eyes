// ============================================================================
// Gesture engine v3: eyelid gestures only. Pure logic (no DOM) so it runs in Node tests.
//
// Inputs (everything else is ignored, including normal blinks and where the eyes look):
//   DOUBLE_BLINK          two slow, deliberate blinks (each longer than the person's natural blinks)
//   WINK_LEFT / RIGHT     one eye closed briefly while the other stays open
//   HOLD_LEFT / RIGHT     one eye held closed past holdMs (fires while held); HOLD_END on release
//   BROW_HOLD             eyebrows raised and held >= brow.ms (4 s) (turns eye control on / off)
//   BOTH_CLOSED           both eyes closed >= bothMs (universal stop / back; always allowed)
//   LONG_BLINK            both eyes closed >= 500 ms (not a calibrated gesture: quick stop while driving)
// Status events: FACE_LOST, FACE_FOUND, CALIBRATION_DRIFT
//
// Frame: { face: bool, raw: { b:{L,R}, r:{L,R} } }   (raw readings, see closure.js)
// Every threshold comes from this person's calibration (cal.params); nothing is learned at runtime.
// ============================================================================
import { closure } from './closure.js';

const OPEN_EYE_BLINK_MS = 350;
const LEAD_MS = 70; // in an ordinary blink one eye can lead the other by a few tens of ms

export const GESTURES = ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD', 'BOTH_CLOSED'];
export const LONG_BLINK_MS = 500; // a deliberate long blink: used only as a quick stop while driving

export const DEFAULT_PARAMS = {
  closeT: { L: 0.55, R: 0.55 },
  openT: { L: 0.3, R: 0.3 },
  otherMax: { left: 0.3, right: 0.3 }, // during a LEFT wink, the right eye must stay below this
  asymMin: 0.4,
  winkMinMs: 130,
  holdMs: 800,
  graceMs: 90,                 // tolerate a few noisy frames inside a wink
  dbl: { closeMinMs: 250, closeMaxMs: 650, gapMaxMs: 600, quietMs: 250 }, // two slow blinks, each longer than a natural blink
  bothMs: 3000,
  brow: { on: 0.45, off: 0.3, ms: 4000 },
  refractoryMs: 450,
  faceLostMs: 400,
  enabled: Object.fromEntries(GESTURES.map((g) => [g, true])),
};

export class GestureEngine {
  constructor(cal) {
    this.setCalibration(cal);
    this.reset();
  }

  setCalibration(cal) {
    this.cal = cal;
    this.p = cal ? { ...DEFAULT_PARAMS, ...cal.params, enabled: { ...DEFAULT_PARAMS.enabled, ...(cal.params?.enabled || {}) } } : DEFAULT_PARAMS;
    // how long things must be held is a product decision, not something measured per person:
    // always use the current values, even with an older saved calibration
    if (cal) this.p = { ...this.p, winkMinMs: DEFAULT_PARAMS.winkMinMs, bothMs: DEFAULT_PARAMS.bothMs, brow: { ...this.p.brow, ms: DEFAULT_PARAMS.brow.ms } };
  }

  reset() {
    this.closed = { L: false, R: false };
    this.mode = 'none';
    this.both = null;            // {start, longFired}
    this.brow = null;            // {start, fired}
    this.wink = null;            // {side, start, holdFired, lastOk}
    this.candSide = null; this.candSince = 0;
    this.pending = null;         // first blink of a possible double: {start, end}
    this.lastClosureEnd = -Infinity;
    this.lastT = null;
    this.refractoryUntil = -Infinity;
    this.lastFace = -Infinity;
    this.faceLost = true;
    this.openEma = null;
    this.driftSince = null;
    this.driftFiredAt = -Infinity;
    this.state = { face: false, eyes: 'open', c: { L: 0, R: 0 }, hold: null, both: 0, brow: 0 };
  }

  update(frame, t) {
    const ev = [];
    if (!this.cal) return ev;
    const p = this.p;
    const emit = (type, extra = {}, safety = false) => {
      if (!p.enabled[type] && type in p.enabled) return false;
      if (!safety && t < this.refractoryUntil) return false;
      ev.push({ type, t, ...extra });
      if (!safety || type === 'BOTH_CLOSED') this.refractoryUntil = t + p.refractoryMs;
      this.pending = null;
      return true;
    };

    // ---------- face presence (face-lock already picked the user's face, or said none/ambiguous)
    if (!frame || !frame.face) {
      // a dropped frame or two is normal: keep the gesture in progress. Only a real loss resets.
      if (!this.faceLost && t - this.lastFace > p.faceLostMs) {
        if (this.wink?.holdFired === true) ev.push({ type: 'HOLD_END', t, side: this.wink.side });
        this.wink = null; this.both = null; this.brow = null; this.pending = null; this.closed = { L: false, R: false };
        this.faceLost = true;
        this.state.face = false;
        this.state.hold = null; this.state.both = 0;
        ev.push({ type: 'FACE_LOST', t });
      }
      return ev;
    }
    this.lastFace = t;
    if (this.faceLost) { this.faceLost = false; this.state.face = true; ev.push({ type: 'FACE_FOUND', t }); }

    // ---------- closure on this person's scale
    let raw = frame.raw;
    if (this.cal.swapB) raw = { ...raw, b: { L: raw.b.R, R: raw.b.L } };
    const dt = this.lastT === null ? 33 : Math.min(100, t - this.lastT);
    this.lastT = t;
    const parts = {};
    let c = closure(raw, this.cal.tf, parts);
    if (this.cal.swapSides) c = { L: c.R, R: c.L };
    this.state.c = c;
    for (const e of ['L', 'R']) this.closed[e] = this.closed[e] ? c[e] > p.openT[e] : c[e] > p.closeT[e];
    // A wink is judged by how LOPSIDED the eyes are, not by the other eye staying open: when most
    // people wink, the other eye squints half shut and the winking eye closes less than in a blink.
    // While the eyes are clearly lopsided, the less-closed eye counts as open.
    const lopsided = (side) => {
      const e = side === 'left' ? 'L' : 'R', o = side === 'left' ? 'R' : 'L';
      const held = this.wink?.side === side; // easier to stay in a wink than to start one
      return c[e] > p.closeT[e] - (held ? 0.2 : 0.1) && c[o] < p.otherMax[side] && c[e] - c[o] >= p.asymMin - (held ? 0.08 : 0);
    };
    let cand = lopsided('left') ? 'left' : lopsided('right') ? 'right' : null;
    // once both eyes are closed (the stop gesture), a noisy lopsided frame or two must not break it
    if (cand !== this.candSide) { this.candSide = cand; this.candSince = t; }
    if (cand && this.both && !this.wink && t - this.candSince < 150) cand = null;
    if (cand) { this.closed[cand === 'left' ? 'L' : 'R'] = true; this.closed[cand === 'left' ? 'R' : 'L'] = false; }

    // ---------- both eyes closed
    if (this.closed.L && this.closed.R) {
      // a wink that already had >= 70 ms of clean one-eye closure survives a short blink of the other
      // eye; a normal blink's leading eye (a few tens of ms) never gets that far
      // a wink survives a short blink of the other eye. Only clean one-eye-closed time counts toward
      // the wink, so the leading eye of a normal blink (a few tens of ms) can never add up to one.
      if (!this.both) this.both = { start: t, longFired: false, fromWink: !!this.wink };
      const dur = t - this.both.start;
      // during an established wink/hold the open eye still blinks naturally: tolerate a short blink
      // of it. A wink that hasn't lasted winkMinMs yet is just the leading eye of a normal blink.
      if (this.wink && (!this.both.fromWink || dur > OPEN_EYE_BLINK_MS)) {
        if (this.wink.holdFired === true) ev.push({ type: 'HOLD_END', t, side: this.wink.side });
        this.wink = null;
        this.state.hold = null;
      }
      this.state.both = Math.min(1, dur / p.bothMs);
      if (!this.both.midFired && !this.both.fromWink && dur >= LONG_BLINK_MS) { this.both.midFired = true; ev.push({ type: 'LONG_BLINK', t }); }
      if (!this.both.longFired && dur >= p.bothMs) {
        this.both.longFired = true;
        emit('BOTH_CLOSED', {}, true);
      }
    } else if (this.both) {
      const { start, longFired, fromWink } = this.both;
      const dur = t - start;
      this.both = null;
      this.state.both = 0;
      const w = this.wink;
      const we = w ? (w.side === 'left' ? 'L' : 'R') : null;
      let blinkPath = !fromWink || !w;
      if (w && this.closed[we]) {
        w.lastOk = t; // the open eye blinked and reopened while the wink continued: resume the wink
      } else if (w && w.clean >= LEAD_MS) {
        // both eyes opened together: the wink ended during the other eye's blink
        if (w.holdFired === true) ev.push({ type: 'HOLD_END', t, side: w.side });
        else if (!w.holdFired && !this.closed.L && !this.closed.R && w.clean >= p.winkMinMs) {
          emit(w.side === 'left' ? 'WINK_LEFT' : 'WINK_RIGHT', { side: w.side, dur: w.clean });
        }
        if (w.clean >= p.winkMinMs) this.lastClosureEnd = t;
        this.wink = null; this.state.hold = null;
      } else {
        // the "wink" was only the leading eye of an ordinary blink: treat it as a blink
        this.wink = null; this.state.hold = null;
        blinkPath = true;
      }
      if (blinkPath && !longFired) this._countBlink(start, t, emit);
      else if (w && this.wink === w && !longFired) w.blink = { start, end: t }; // decide when the wink ends
    }
    // the second blink must START within the gap; don't expire while it is still closed
    if (this.pending && !this.both && t - this.pending.end > p.dbl.gapMaxMs) this.pending = null;

    // ---------- winks / holds: one eye closed, the other clearly open, clearly lopsided
    if (!this.both) {
      if (this.wink) {
        const w = this.wink;
        if (cand === w.side) { w.lastOk = t; w.clean += dt; }
        if (!w.real && w.clean >= p.winkMinMs) { w.real = true; this.pending = null; } // a real wink between two blinks breaks a double blink
        const stillClosed = this.closed[w.side === 'left' ? 'L' : 'R'];
        const dur = t - w.start;
        if (cand === w.side || (stillClosed && t - w.lastOk <= p.graceMs)) {
          if (!w.holdFired && w.clean >= p.holdMs) { // clean one-eye time, so a blink can't stretch a wink into a hold
            w.holdFired = emit(w.side === 'left' ? 'HOLD_LEFT' : 'HOLD_RIGHT', { side: w.side }) || 'blocked';
          }
          this.state.hold = { side: w.side, frac: Math.min(1, w.clean / p.holdMs) };
        } else {
          // the wink ended. Only a clean ending (both eyes open again) counts as a wink.
          const bothOpen = !this.closed.L && !this.closed.R;
          if (w.real) this.lastClosureEnd = t;
          else if (w.blink && w.clean < 2 * LEAD_MS) this._countBlink(w.blink.start, w.blink.end, emit); // it was just a lagging eye
          if (w.holdFired === true) ev.push({ type: 'HOLD_END', t, side: w.side });
          else if (!w.holdFired && bothOpen && w.clean >= p.winkMinMs) {
            emit(w.side === 'left' ? 'WINK_LEFT' : 'WINK_RIGHT', { side: w.side, dur: w.clean });
          }
          this.wink = null;
          this.state.hold = null;
        }
      }
      if (!this.wink && cand) this.wink = { side: cand, start: t, holdFired: false, lastOk: t, real: false, clean: 0 };
    }
    this.state.eyes = this.both ? 'closed' : this.wink ? `wink-${this.wink.side}` : (this.closed.L || this.closed.R) ? 'closing' : 'open';
    if (!this.wink) this.state.hold = null;

    // ---------- eyebrows raised and held
    if (this.cal.brow && typeof raw.brow === 'number' && p.enabled.BROW_HOLD) {
      const n = (raw.brow - this.cal.brow.rest) / (this.cal.brow.raised - this.cal.brow.rest);
      const up = this.brow ? n > p.brow.off : n > p.brow.on;
      if (up) {
        if (!this.brow) this.brow = { start: t, fired: false };
        this.state.brow = Math.min(1, (t - this.brow.start) / p.brow.ms);
        if (!this.brow.fired && t - this.brow.start >= p.brow.ms) { this.brow.fired = true; ev.push({ type: 'BROW_HOLD', t }); }
      } else { this.brow = null; this.state.brow = 0; }
    }

    // ---------- calibration drift (e.g. glasses taken off, very different lighting): tell, don't adapt
    // each reading is watched on its own: taking glasses off shifts the blink score a lot but
    // barely changes lid shape, so the combined value alone would hide it
    if (this.state.eyes === 'open') {
      const m = [(parts.L.nb + parts.R.nb) / 2, (parts.L.nr + parts.R.nr) / 2];
      this.openEma = this.openEma === null ? m : this.openEma.map((v, i) => v + 0.02 * (m[i] - v));
      if (Math.max(Math.abs(this.openEma[0]), Math.abs(this.openEma[1])) > 0.3) {
        if (this.driftSince === null) this.driftSince = t;
        if (t - this.driftSince > 8000 && t - this.driftFiredAt > 60000) {
          this.driftFiredAt = t;
          ev.push({ type: 'CALIBRATION_DRIFT', t, blinkScore: this.openEma[0], lidShape: this.openEma[1] });
        }
      } else this.driftSince = null;
    }
    return ev;
  }

  // an ordinary both-eyes closure: maybe half of a double blink, otherwise ignored
  _countBlink(start, end, emit) {
    const p = this.p;
    const dur = end - start;
    if (dur < p.dbl.closeMinMs) return; // a natural blink: as if it never happened
    const short = dur <= p.dbl.closeMaxMs;
    if (short && this.pending && start - this.pending.end <= p.dbl.gapMaxMs) {
      emit('DOUBLE_BLINK', { gap: start - this.pending.end });
      this.pending = null;
    } else if (short && start - this.lastClosureEnd >= p.dbl.quietMs) {
      this.pending = { start, end };
    } else {
      this.pending = null;
    }
    this.lastClosureEnd = end;
  }
}
