// Synthetic face stream for testing the gesture engine under realistic, ugly conditions.
// Noise levels are taken from the old eye_mouse.py selftest on Anh's MacBook webcam:
// iris feature std ~0.02 while staring still; looking left/right moves features ~0.08.
export function rng(seed = 1) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const n = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

// feature layout: [bsX, bsY, irisX, irisY]
export const DIR_OFFSETS = {
  left: [-0.35, 0, -0.08, 0],
  right: [0.35, 0, 0.08, 0],
  up: [0, 0.25, 0, -0.05],
  down: [0, -0.22, 0, 0.045],
};

export function makeSim({ seed = 7, noise = 1, fps = 30, dropRate = 0.02, spikeRate = 0.01, naturalBlinks = true } = {}) {
  const r = rng(seed);
  const dt = 1000 / fps;
  let t = 0;
  let drift = [0, 0, 0, 0];
  let nextBlink = 2000 + r.u() * 3000;
  const frames = [];
  const sd = [0.06, 0.06, 0.02, 0.02].map((x) => x * noise);

  function frame({ gaze = null, gazeAmt = 1, lidL = 0, lidR = 0, face = true }) {
    t += dt * (0.85 + 0.3 * r.u()); // uneven frame timing like a real webcam
    for (let i = 0; i < 4; i++) drift[i] += -0.001 * drift[i] + 0.0006 * r.n() * noise; // bounded posture drift (stationary sd ~ noise level)
    // natural blinks: ~150 ms, both eyes, drag the gaze estimate downward
    let nb = 0;
    if (naturalBlinks && t >= nextBlink) {
      const ph = t - nextBlink;
      if (ph < 160) nb = Math.sin((ph / 160) * Math.PI) * 1.1;
      else nextBlink = t + 2500 + r.u() * 3500;
    }
    if (!face || r.u() < dropRate) return { t, f: { face: false } };
    const base = gaze ? DIR_OFFSETS[gaze].map((x) => x * gazeAmt) : [0, 0, 0, 0];
    const feat = base.map((x, i) => x + drift[i] + sd[i] * r.n() + (r.u() < spikeRate ? 4 * sd[i] * r.n() : 0));
    if (nb > 0.2) { feat[1] -= 0.25 * nb; feat[3] += 0.05 * nb; } // eyelid artifact
    const bl = Math.min(1, Math.max(0, 0.08 + 0.03 * r.n() + Math.max(lidL, nb) * 0.75));
    const br = Math.min(1, Math.max(0, 0.08 + 0.03 * r.n() + Math.max(lidR, nb) * 0.75));
    return { t, f: { face: true, blinkL: bl, blinkR: br, feat } };
  }

  // script: array of [durationMs, frameSpec]
  function run(script) {
    const out = [];
    for (const [dur, spec] of script) {
      const end = t + dur;
      while (t < end) out.push(frame(typeof spec === 'function' ? spec(t) : spec));
    }
    return out;
  }
  return { run, now: () => t };
}

// Builds calibration samples the same way the app's calibration screen does.
export function simCalibrationSamples(sim, { winks = true } = {}) {
  const grab = (spec, ms) => sim.run([[ms, spec]]).map((x) => x.f);
  sim.run([[600, {}]]);
  const s = { center: grab({}, 2400) };
  for (const d of ['left', 'right', 'up', 'down']) { sim.run([[700, { gaze: d }]]); s[d] = grab({ gaze: d }, 1600); }
  s.center2 = grab({}, 1500);
  sim.run([[700, { lidL: 1, lidR: 1 }]]); s.closed = grab({ lidL: 1, lidR: 1 }, 1500);
  if (winks) {
    sim.run([[700, { lidL: 1 }]]); s.winkL = grab({ lidL: 1 }, 1400);
    sim.run([[700, { lidR: 1 }]]); s.winkR = grab({ lidR: 1 }, 1400);
  }
  return s;
}
