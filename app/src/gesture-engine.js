// ============================================================================
// Gesture engine: turns noisy per-frame face measurements into a few clean,
// deliberate eye gestures. Pure logic, no DOM, so it is unit-testable in Node.
//
// Why this instead of a gaze cursor: a webcam cannot place a cursor on a
// screen better than ~100+ px (the old eye_mouse.py measured 125 px), so the
// cursor always shakes. Butter only needs ~6 commands, so we classify
// DIRECTIONS and EYELID gestures with hysteresis + hold times. Noise inside
// the dead band can never fire a command.
//
// Input per frame (from face-tracker.js):
//   { face: bool, blinkL: 0..1, blinkR: 0..1, feat: number[], featEye?: {L,R} }   (feat = gaze features)
// Output: array of events { type, t, ...} and a live `state` for the UI.
//
// Events:
//   LOOK_LEFT / LOOK_RIGHT / LOOK_UP / LOOK_DOWN   gaze held past threshold for gazeHoldMs
//   LOOK_REPEAT (dir)                              still holding, fires every repeatMs
//   LOOK_END                                       gaze back to neutral
//   BLINK                                          deliberate blink (both eyes, 350-1200 ms)
//   DOUBLE_BLINK                                   two quick blinks within doubleBlinkGapMs
//   LONG_CLOSE                                     both eyes closed >= longCloseMs (stop / back)
//   WINK_LEFT / WINK_RIGHT                         one eye closed 250-1500 ms, other open
//   WINK_HOLD_START / WINK_HOLD_END (side)         one eye held closed (clutch)
//   FACE_LOST / FACE_FOUND
// ============================================================================
import { OneEuroVec } from './one-euro.js';

export const DIRS = ['left', 'right', 'up', 'down'];

export const DEFAULTS = {
  // gaze, in calibrated units (1.0 = how far you looked during calibration)
  gazeEnter: 0.55,
  gazeExit: 0.35,
  gazeHoldMs: 280,
  repeatMs: 900,
  dominance: 0.2,          // best direction must beat 2nd best by this much
  minCutoff: 1.0,          // One Euro on raw features
  beta: 0.05,
  driftRate: 0.0015,       // slow re-centering of "neutral" while relaxed
  postBlinkMuteMs: 220,    // eyelids drag the gaze estimate during/after blinks
  // eyelids, as fraction between open baseline (0) and closed baseline (1)
  closeFrac: 0.55,
  openFrac: 0.3,
  deliberateBlinkMinMs: 350,
  deliberateBlinkMaxMs: 1200,
  longCloseMs: 2000,
  doubleBlinkMinMs: 50,
  doubleBlinkMaxMs: 330,
  doubleBlinkGapMs: 550,
  winkMinMs: 250,
  winkMaxMs: 1500,
  winkHoldMs: 700,
  faceLostMs: 400,
};

export class GestureEngine {
  constructor(calibration, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.setCalibration(calibration);
    this.reset();
  }

  setCalibration(cal) {
    this.cal = cal;
    if (!cal) return;
    this.neutral = cal.neutral.mean.slice();
    this.sd = cal.neutral.sd.map((s) => Math.max(s, 1e-4));
    // direction templates in whitened space
    this.dirVecs = {};
    for (const d of DIRS) {
      const m = cal.dirs[d];
      if (!m) continue;
      const v = m.map((x, i) => (x - cal.neutral.mean[i]) / this.sd[i]);
      const n2 = v.reduce((a, b) => a + b * b, 0);
      if (n2 > 4) this.dirVecs[d] = { v, n2 }; // needs >2 sd separation to be usable
    }
    // MediaPipe's left/right blink channels may be mirrored relative to the user; calibration detects it
    this.swap = !!cal.swapEyes;
    this.blinkCal = this.swap ? { L: cal.blink.R, R: cal.blink.L } : cal.blink;
    const th = (e) => ({
      close: e.open + this.o.closeFrac * (e.closed - e.open),
      open: e.open + this.o.openFrac * (e.closed - e.open),
    });
    this.lid = { L: th(this.blinkCal.L), R: th(this.blinkCal.R) };
  }

  reset() {
    this.filter = new OneEuroVec(this.o.minCutoff, this.o.beta);
    this.closedL = this.closedR = false;
    this.both = null;          // {start, longFired}
    this.wink = null;          // {side, start, holdFired}
    this.pendingShort = null;  // time a short both-eye blink ended (double blink candidate)
    this.mutedUntil = 0;
    this.cand = null;          // {dir, since}
    this.held = null;          // {dir, since, lastRepeat}
    this.lastFace = -Infinity;
    this.faceLost = true;
    this.state = { face: false, scores: {}, held: null, eyes: 'open', lidL: 0, lidR: 0 };
  }

  update(frame, t) {
    const ev = [];
    const emit = (type, extra = {}) => ev.push({ type, t, ...extra });
    if (!this.cal) return ev;

    // ---------------- face presence
    if (!frame || !frame.face) {
      if (!this.faceLost && t - this.lastFace > this.o.faceLostMs) {
        this.faceLost = true;
        this._endGaze(emit);
        this.both = this.wink = this.pendingShort = null;
        this.closedL = this.closedR = false;
        this.state.face = false;
        emit('FACE_LOST');
      }
      return ev;
    }
    this.lastFace = t;
    if (this.swap) frame = { ...frame, blinkL: frame.blinkR, blinkR: frame.blinkL, featEye: frame.featEye && { L: frame.featEye.R, R: frame.featEye.L } };
    if (this.faceLost) {
      this.faceLost = false;
      this.state.face = true;
      this.filter.reset();
      emit('FACE_FOUND');
    }

    // ---------------- eyelids (per-eye hysteresis)
    const { L, R } = this.lid;
    this.closedL = this.closedL ? frame.blinkL > L.open : frame.blinkL > L.close;
    this.closedR = this.closedR ? frame.blinkR > R.open : frame.blinkR > R.close;
    const fracL = (frame.blinkL - this.blinkCal.L.open) / (this.blinkCal.L.closed - this.blinkCal.L.open);
    const fracR = (frame.blinkR - this.blinkCal.R.open) / (this.blinkCal.R.closed - this.blinkCal.R.open);
    this.state.lidL = fracL; this.state.lidR = fracR;
    const clearlyOpenL = frame.blinkL < L.open;
    const clearlyOpenR = frame.blinkR < R.open;

    // double-blink window expiry
    if (this.pendingShort !== null && t - this.pendingShort > this.o.doubleBlinkGapMs) this.pendingShort = null;

    // both eyes closed
    if (this.closedL && this.closedR) {
      if (this.wink) { // a wink turned into a full close: cancel the wink
        if (this.wink.holdFired) emit('WINK_HOLD_END', { side: this.wink.side });
        this.wink = null;
      }
      if (!this.both) this.both = { start: t, longFired: false };
      const dur = t - this.both.start;
      if (!this.both.longFired && dur >= this.o.longCloseMs) {
        this.both.longFired = true;
        this.pendingShort = null;
        emit('LONG_CLOSE');
      }
    } else if (this.both) {
      // a full close just ended (first eye reopened)
      const dur = t - this.both.start;
      if (!this.both.longFired) {
        if (dur >= this.o.deliberateBlinkMinMs && dur <= this.o.deliberateBlinkMaxMs) {
          this.pendingShort = null;
          emit('BLINK', { dur });
        } else if (dur >= this.o.doubleBlinkMinMs && dur <= this.o.doubleBlinkMaxMs) {
          if (this.pendingShort !== null) {
            this.pendingShort = null;
            emit('DOUBLE_BLINK');
          } else {
            this.pendingShort = t;
          }
        }
      }
      this.both = null;
      this.mutedUntil = t + this.o.postBlinkMuteMs;
    }

    // winks: exactly one eye closed AND the other clearly open
    const winkSide = this.closedL && !this.closedR && clearlyOpenR ? 'left'
      : this.closedR && !this.closedL && clearlyOpenL ? 'right' : null;
    if (!this.both) {
      if (winkSide && (!this.wink || this.wink.side !== winkSide)) {
        if (this.wink?.holdFired) emit('WINK_HOLD_END', { side: this.wink.side });
        this.wink = { side: winkSide, start: t, holdFired: false };
      } else if (winkSide && this.wink) {
        if (!this.wink.holdFired && t - this.wink.start >= this.o.winkHoldMs) {
          this.wink.holdFired = true;
          emit('WINK_HOLD_START', { side: winkSide });
        }
      } else if (!winkSide && this.wink) {
        const dur = t - this.wink.start;
        if (this.wink.holdFired) emit('WINK_HOLD_END', { side: this.wink.side });
        // a wink is only a tap if it ended with BOTH eyes open (not by closing the other eye)
        else if (!this.closedL && !this.closedR && dur >= this.o.winkMinMs && dur <= this.o.winkMaxMs) {
          emit(this.wink.side === 'left' ? 'WINK_LEFT' : 'WINK_RIGHT', { dur });
        }
        this.wink = null;
      }
    }
    this.state.eyes = this.both ? 'closed' : this.wink ? `wink-${this.wink.side}` : 'open';

    // ---------------- gaze (only when both eyes are clearly open, or with one-eye clutch)
    const f = this.filter.filter(frame.feat, t);
    // clutch mode: while one eye is held shut, steer with the other eye alone
    const oneEye = this.wink?.holdFired && frame.featEye ? frame.featEye[this.wink.side === 'left' ? 'R' : 'L'] : null;
    const eyesUsable = (clearlyOpenL && clearlyOpenR) || !!oneEye;
    if (!eyesUsable || t < this.mutedUntil) {
      this.state.scores = {};
      if (!this.wink?.holdFired) this._endGaze(emit, t < this.mutedUntil); // keep held gaze through brief blinks
      return ev;
    }
    const feat = oneEye || f;
    const z = feat.map((x, i) => (x - this.neutral[i]) / this.sd[i]);
    const scores = {};
    for (const d of DIRS) {
      const dv = this.dirVecs[d];
      if (!dv) continue;
      let dot = 0;
      for (let i = 0; i < z.length; i++) dot += z[i] * dv.v[i];
      scores[d] = dot / dv.n2; // 1.0 == calibrated extent
    }
    this.state.scores = scores;
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [best, bestS] = ranked[0] || [null, 0];
    const second = ranked[1] ? ranked[1][1] : 0;

    if (this.held) {
      const s = scores[this.held.dir] ?? 0;
      if (s < this.o.gazeExit) {
        this._endGaze(emit);
      } else if (this.o.repeatMs && t - this.held.lastRepeat >= this.o.repeatMs) {
        this.held.lastRepeat = t;
        emit('LOOK_REPEAT', { dir: this.held.dir });
      }
    }
    if (!this.held) {
      if (best && bestS >= this.o.gazeEnter && bestS - second >= this.o.dominance) {
        if (!this.cand || this.cand.dir !== best) this.cand = { dir: best, since: t };
        else if (t - this.cand.since >= this.o.gazeHoldMs) {
          this.held = { dir: best, since: t, lastRepeat: t };
          this.cand = null;
          emit('LOOK_' + best.toUpperCase(), { dir: best });
        }
      } else {
        this.cand = null;
        // relaxed: let neutral slowly track lighting / posture drift
        if (bestS < 0.25) {
          for (let i = 0; i < this.neutral.length; i++) {
            this.neutral[i] += this.o.driftRate * (f[i] - this.neutral[i]);
          }
        }
      }
    }
    this.state.held = this.held?.dir ?? null;
    this.state.cand = this.cand?.dir ?? null;
    return ev;
  }

  _endGaze(emit, soft = false) {
    this.cand = null;
    if (soft) return;
    if (this.held) {
      this.held = null;
      emit('LOOK_END');
    }
    this.state.held = null;
  }
}
