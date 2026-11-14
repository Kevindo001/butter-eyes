// Simulated people for testing the eyelid gesture engine + calibration.
// Each persona produces the same raw readings the real tracker does: blendshape blink (b) and
// lid ratio (r) per eye, with noise, uneven frame timing, dropped frames, and natural blinks whose
// spacing follows a realistic heavy-tailed distribution (so natural blinks sometimes come in quick pairs).
export function rng(seed = 1) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const n = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

export const PERSONAS = {
  typical: {},
  glasses: { bOpen: 0.27, bNoise: 0.05, rNoise: 0.012, glare: 0.04 },          // glasses: higher open baseline, glare spikes on lid shape
  smallEyes: { rOpen: 0.17, rClosed: 0.04, rNoise: 0.009 },
  glassesSmall: { bOpen: 0.25, bNoise: 0.05, rOpen: 0.17, rClosed: 0.04, rNoise: 0.012, glare: 0.04 },
  weak: { strength: 0.72, lidTau: 55 },                                         // ALS-like: can't fully close, slower lids
  partialWink: { otherDrop: 0.32 },                                             // other eye half-closes during winks
  noWink: { otherDrop: 0.85 },                                                   // can't wink: "wink" is basically a blink
  asymmetric: { droopL: 0.12 },                                                  // left lid sits lower at rest
};

export function makeSim({ seed = 7, persona = 'typical', fps = 30, dropRate = 0.02, naturalBlinks = true } = {}) {
  const P = { bOpen: 0.08, bClosed: 0.78, bNoise: 0.03, rOpen: 0.28, rClosed: 0.06, rNoise: 0.007, glare: 0, strength: 1, lidTau: 28, otherDrop: 0.05, droopL: 0, ...PERSONAS[persona] };
  const r = rng(seed);
  const dt = 1000 / fps;
  let t = 0;
  const lid = { L: 0, R: 0 };
  let brow = 0, nextBrowBlip = 15000 + 10000 * r.u(), browBlipEnd = -1;
  // natural blinks: log-normal spacing (median ~3.2 s) -> occasional quick pairs, like real people
  const nextGap = () => Math.max(180, Math.exp(Math.log(3200) + 0.75 * r.n()));
  let nextBlink = nextGap();
  let blinkEnd = -1, blinkStart = 0, blinkLeadL = 0;
  let naturalOn = naturalBlinks;

  function frame(target = {}) {
    t += dt * (0.85 + 0.3 * r.u());
    // natural blink overlay (both eyes, ~150 ms, one eye may lead by up to 40 ms)
    let nb = 0, lead = 0;
    if (naturalOn && t >= nextBlink && blinkEnd < 0) { blinkStart = t; blinkEnd = t + 110 + 90 * r.u(); blinkLeadL = (r.u() - 0.5) * 80; }
    if (blinkEnd > 0) {
      if (t < blinkEnd) { nb = 1; lead = blinkLeadL; } else { blinkEnd = -1; nextBlink = t + nextGap(); }
    }
    for (const e of ['L', 'R']) {
      const offset = e === 'L' ? Math.max(0, lead) : Math.max(0, -lead);
      const nat = nb && t - blinkStart >= offset ? 1 : 0;
      let goal = Math.max(target['lid' + e] || 0, nat);
      // the other eye drags along during a wink (more for some people)
      const other = e === 'L' ? target.lidR || 0 : target.lidL || 0;
      goal = Math.max(goal, other * P.otherDrop);
      lid[e] += (goal - lid[e]) * (1 - Math.exp(-dt / P.lidTau));
    }
    // eyebrows: follow the target; when relaxed, an occasional short natural raise (surprise, emphasis)
    if (naturalOn && t >= nextBrowBlip) { browBlipEnd = t + 350 + 300 * r.u(); nextBrowBlip = t + 15000 + 15000 * r.u(); }
    const browGoal = Math.max(target.brow || 0, t < browBlipEnd ? 0.8 : 0);
    brow += (browGoal - brow) * (1 - Math.exp(-dt / 60));
    if (target.face === false || r.u() < dropRate) return { t, f: { face: false } };
    const raw = { b: {}, r: {} };
    for (const e of ['L', 'R']) {
      const k = Math.min(1, lid[e] * P.strength + (e === 'L' ? P.droopL : 0));
      raw.b[e] = Math.min(1, Math.max(0, P.bOpen + (P.bClosed - P.bOpen) * k + P.bNoise * r.n()));
      let rv = P.rOpen - (P.rOpen - P.rClosed) * k + P.rNoise * r.n();
      if (P.glare && r.u() < P.glare) rv += (r.u() - 0.5) * 0.2; // glare on the lens corrupts lid shape
      raw.r[e] = Math.max(0, rv);
    }
    raw.brow = Math.max(0, 0.06 + 0.55 * brow * P.strength + 0.025 * r.n());
    return { t, f: { face: true, raw } };
  }

  function run(script) {
    const out = [];
    for (const [dur, spec] of script) { const end = t + dur; while (t < end) out.push(frame(spec)); }
    return out;
  }
  return { run, now: () => t, setNatural: (v) => { naturalOn = v; }, P };
}

// gesture scripts (target lid closure over time), with a human reaction delay
export const G = {
  DOUBLE_BLINK: [[330, { lidL: 1, lidR: 1 }], [260, {}], [330, { lidL: 1, lidR: 1 }]], // slow and deliberate
  WINK_LEFT: [[420, { lidL: 1 }]],
  WINK_RIGHT: [[420, { lidR: 1 }]],
  HOLD_LEFT: [[1800, { lidL: 1 }]],
  HOLD_RIGHT: [[1800, { lidR: 1 }]],
  BROW_HOLD: [[4800, { brow: 1 }]],
  BOTH_CLOSED: [[3600, { lidL: 1, lidR: 1 }]],
};
export const doGesture = (sim, g, settle = 700) => [...sim.run([[300 + 200 * Math.random(), {}]]), ...sim.run(G[g]), ...sim.run([[settle, {}]])];

// Builds calibration samples the way the app's calibration screen collects them.
export function simCalibrationSamples(sim, { reps = 2, skip = [] } = {}) {
  const fr = (a) => a.map((x) => ({ t: x.t, ...x.f }));
  sim.run([[1000, {}]]);
  const relaxed = fr(sim.run([[12000, {}]]));
  const closed = fr([...sim.run([[350, {}]]), ...sim.run([[3800, { lidL: 1, lidR: 1 }]])]);
  sim.run([[800, {}]]);
  const out = { relaxed, closed, reps: {} };
  sim.setNatural(true);
  for (const g of ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD']) {
    out.reps[g] = [];
    if (skip.includes(g)) continue;
    for (let i = 0; i < reps; i++) {
      const windowMs = g === 'BROW_HOLD' ? 5600 : g === 'DOUBLE_BLINK' || g.startsWith('HOLD') ? 2600 : 2000;
      const t0 = sim.now();
      const frames = [...sim.run([[350 + 150 * (i % 3), {}]]), ...sim.run(G[g])];
      frames.push(...sim.run([[Math.max(100, windowMs - (sim.now() - t0)), {}]]));
      out.reps[g].push(fr(frames));
      sim.run([[500, {}]]);
    }
  }
  return out;
}
