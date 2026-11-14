import test from 'node:test';
import assert from 'node:assert/strict';
import { GestureEngine } from '../src/gesture-engine.js';
import { fitCalibration, quickCalibration } from '../src/calibration.js';
import { FaceLock } from '../src/face-lock.js';
import { makeSim, simCalibrationSamples, PERSONAS, G } from './sim.js';

const IGNORE = new Set(['FACE_FOUND', 'FACE_LOST', 'HOLD_END', 'CALIBRATION_DRIFT', 'LONG_BLINK']);
const types = (ev, detail = false) => ev.filter((e) => !IGNORE.has(e.type)).map((e) => (detail && (e.dir || e.look) ? `${e.type}:${e.dir || e.look}` : e.type));

function setup(persona, seed = 3) {
  const sim = makeSim({ seed, persona });
  const { cal, report } = fitCalibration(simCalibrationSamples(sim));
  assert.ok(cal, `${persona}: calibration failed: ${report.warnings.join('; ')}`);
  const eng = new GestureEngine(cal);
  const feed = (frames) => frames.flatMap(({ t, f }) => eng.update(f, t));
  feed(sim.run([[1500, {}]]));
  return { sim, eng, feed, cal, report };
}

const EXPECT_RELIABLE = {
  typical: ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD'],
  glasses: ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD'],
  smallEyes: ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD'],
  glassesSmall: ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD'],
  weak: ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD'],
  partialWink: ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD'],
  asymmetric: ['DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'HOLD_LEFT', 'HOLD_RIGHT', 'BROW_HOLD'],
  noWink: ['DOUBLE_BLINK', 'BROW_HOLD'],
};

for (const persona of Object.keys(PERSONAS)) {
  test(`[${persona}] calibration report card enables exactly the gestures this person can do`, () => {
    const { cal, report } = setup(persona);
    const on = Object.entries(cal.params.enabled).filter(([g, v]) => v && g !== 'BOTH_CLOSED').map(([g]) => g).sort();
    assert.deepEqual(on, [...EXPECT_RELIABLE[persona]].sort(), JSON.stringify(report.gestures));
    assert.equal(report.gestures.BOTH_CLOSED.reliable, true);
  });

  test(`[${persona}] 10 minutes relaxed (natural blinks incl. quick pairs, drops, noise): zero commands`, () => {
    for (const seed of [3, 4]) {
      const { sim, feed } = setup(persona, seed);
      const ev = types(feed(sim.run([[600_000, {}]])));
      assert.deepEqual(ev, [], `seed ${seed}: ${ev.join(',')}`);
    }
  });

  test(`[${persona}] each enabled gesture caught (holds/stop 20/20, winks/double >=18/20), never mistaken for another`, () => {
    const { sim, feed, cal } = setup(persona, 5);
    for (const g of [...EXPECT_RELIABLE[persona], 'BOTH_CLOSED']) {
      let hit = 0; const wrong = [];
      for (let i = 0; i < 20; i++) {
        const ev = types(feed([...sim.run([[700, {}]]), ...sim.run(G[g]), ...sim.run([[900, {}]])]));
        if (ev.includes(g)) hit++;
        for (const x of ev) if (x !== g) wrong.push(x);
      }
      // winks / double blink: a natural blink sometimes lands inside the gesture (measured ~97-99%, see below)
      assert.ok(hit >= (g.includes('HOLD') || g === 'BOTH_CLOSED' ? 20 : 18), `${g}: caught ${hit}/20`);
      assert.deepEqual(wrong, [], `${g} produced ${wrong.join(',')}`);
    }
  });
}

test('holds fire while still held (not on release) and HOLD_END follows on release', () => {
  const { sim, feed } = setup('typical', 6);
  sim.setNatural(false);
  const ev = feed([...sim.run([[1500, { lidR: 1 }]]), ...sim.run([[600, {}]])]);
  const hold = ev.find((e) => e.type === 'HOLD_RIGHT'), end = ev.find((e) => e.type === 'HOLD_END');
  assert.ok(hold && end && hold.t < end.t);
  assert.ok(end.t - hold.t > 500, 'hold fired well before the eye opened');
});

test('a normal single blink, even a slow one, is never an input', () => {
  const { sim, feed } = setup('typical', 7);
  sim.setNatural(false);
  for (const ms of [120, 200, 350, 600, 1200]) {
    assert.deepEqual(types(feed([...sim.run([[ms, { lidL: 1, lidR: 1 }]]), ...sim.run([[1200, {}]])])), [], `${ms} ms blink`);
  }
});

test('refractory: a bouncy wink (eye flickers open 40 ms mid-wink) counts once', () => {
  const { sim, feed } = setup('typical', 8);
  sim.setNatural(false);
  const ev = types(feed([...sim.run([[260, { lidL: 1 }]]), ...sim.run([[40, {}]]), ...sim.run([[260, { lidL: 1 }]]), ...sim.run([[900, {}]])]));
  assert.deepEqual(ev, ['WINK_LEFT']);
});

test('two deliberate winks a second apart count as two', () => {
  const { sim, feed } = setup('typical', 8);
  sim.setNatural(false);
  const ev = types(feed([...sim.run(G.WINK_LEFT), ...sim.run([[700, {}]]), ...sim.run(G.WINK_LEFT), ...sim.run([[900, {}]])]));
  assert.deepEqual(ev, ['WINK_LEFT', 'WINK_LEFT']);
});

test('closing both eyes 3 s fires even right after another gesture (safety stop)', () => {
  const { sim, feed } = setup('typical', 9);
  sim.setNatural(false);
  const ev = types(feed([...sim.run(G.WINK_RIGHT), ...sim.run([[100, {}]]), ...sim.run(G.BOTH_CLOSED), ...sim.run([[500, {}]])]));
  assert.ok(ev.includes('BOTH_CLOSED'), ev.join(','));
});

test('face lost mid-hold -> HOLD_END + FACE_LOST; a 1-frame dropout does nothing', () => {
  const { sim, feed } = setup('typical', 10);
  sim.setNatural(false);
  const a = feed([...sim.run([[1200, { lidL: 1 }]])]).map((e) => e.type);
  assert.ok(a.includes('HOLD_LEFT'));
  const b = feed(sim.run([[800, { face: false }]])).map((e) => e.type);
  assert.deepEqual(b, ['HOLD_END', 'FACE_LOST']);
  const c = feed([...sim.run([[600, {}]]), ...sim.run([[30, { face: false }]]), ...sim.run([[600, {}]])]).map((e) => e.type);
  assert.deepEqual(c, ['FACE_FOUND'], 'a 1-frame dropout must not reset anything');
});

test('glasses taken off after calibrating -> CALIBRATION_DRIFT suggestion, and no false commands', () => {
  const sim = makeSim({ seed: 11, persona: 'glasses' });
  const { cal } = fitCalibration(simCalibrationSamples(sim));
  const eng = new GestureEngine(cal);
  const bare = makeSim({ seed: 12, persona: 'typical' }); // same person, glasses off: much lower blink baseline
  const ev = bare.run([[60000, {}]]).flatMap(({ t, f }) => eng.update(f, t + 1e6));
  assert.ok(ev.some((e) => e.type === 'CALIBRATION_DRIFT'), 'no drift warning');
  assert.deepEqual(types(ev), []);
});

test('mirrored camera / swapped eye channels are corrected by calibration', () => {
  const sim = makeSim({ seed: 13 });
  const s = simCalibrationSamples(sim);
  const mirror = (f) => (f.face ? { ...f, raw: { b: { L: f.raw.b.R, R: f.raw.b.L }, r: { L: f.raw.r.R, R: f.raw.r.L } } } : f);
  for (const k of ['relaxed', 'closed']) s[k] = s[k].map(mirror);
  for (const g in s.reps) s.reps[g] = s.reps[g].map((r) => r.map(mirror));
  const { cal, report } = fitCalibration(s);
  assert.ok(cal?.swapSides, JSON.stringify(report.notes));
  const eng = new GestureEngine(cal);
  sim.setNatural(false);
  const ev = [...sim.run([[800, {}]]), ...sim.run(G.WINK_LEFT), ...sim.run([[800, {}]])].flatMap(({ t, f }) => eng.update(mirror(f), t));
  assert.deepEqual(types(ev), ['WINK_LEFT']);
});

test('calibration where the person never closes their eyes fails with a clear message', () => {
  const sim = makeSim({ seed: 14 });
  const s = simCalibrationSamples(sim);
  s.closed = s.relaxed.slice(0, 90);
  for (const g in s.reps) s.reps[g] = s.reps[g].map((r) => r.map((f) => ({ ...f, raw: s.relaxed[50].raw })));
  const { cal, report } = fitCalibration(s);
  assert.equal(cal, null);
  assert.ok(report.warnings.length > 0);
});

// ------------------------------------------------------------------ face lock
const face = (cx, cy, size, sig) => ({ cx, cy, size, sig });
const SIG_USER = [0.24, 0.62, 0.38, 0.33, 0.42, 0.36, 0.84];
const SIG_OTHER = [0.29, 0.7, 0.45, 0.28, 0.37, 0.41, 0.95];
const jit = (s, k = 0.003) => s.map((v, i) => v + k * Math.sin(i * 7.3 + v * 100));

test('face lock: caregiver leans in -> "multiple" flag, user keeps control', () => {
  const L = new FaceLock(); L.setSignature({ mean: SIG_USER, sd: SIG_USER.map(() => 0.01) });
  let r = L.update([face(0.5, 0.5, 0.3, jit(SIG_USER))], 0);
  assert.equal(r.status, 'locked');
  for (let t = 33; t < 2000; t += 33) {
    r = L.update([face(0.82, 0.4, 0.22, jit(SIG_OTHER)), face(0.5 + 0.01 * Math.sin(t), 0.5, 0.3, jit(SIG_USER))], t);
    assert.equal(r.index, 1); assert.equal(r.multiple, true); assert.equal(r.status, 'locked');
  }
});

test('face lock: faces overlap and can\'t be told apart -> ambiguous (pause), no signature', () => {
  const L = new FaceLock();
  L.update([face(0.5, 0.5, 0.3)], 0);
  const r = L.update([face(0.52, 0.5, 0.3), face(0.48, 0.5, 0.3)], 33);
  assert.equal(r.status, 'ambiguous'); assert.equal(r.index, null);
});

test('face lock: user leaves, caregiver alone in frame is NOT adopted; user returns and is re-found', () => {
  const L = new FaceLock(); L.setSignature({ mean: SIG_USER, sd: SIG_USER.map(() => 0.01) });
  L.update([face(0.5, 0.5, 0.3, jit(SIG_USER))], 0);
  L.update([], 33);
  for (let t = 66; t < 3000; t += 33) assert.equal(L.update([face(0.45, 0.5, 0.3, jit(SIG_OTHER))], t).index, null);
  const r = L.update([face(0.6, 0.55, 0.28, jit(SIG_USER)), face(0.45, 0.5, 0.3, jit(SIG_OTHER))], 3100);
  assert.equal(r.index, 0); assert.equal(r.status, 'locked');
});

test('face lock: before calibration, two similar-size faces -> wait; clearly closest face -> lock it', () => {
  assert.equal(new FaceLock().update([face(0.3, 0.5, 0.3), face(0.7, 0.5, 0.28)], 0).status, 'ambiguous');
  assert.equal(new FaceLock().update([face(0.3, 0.5, 0.2), face(0.7, 0.5, 0.36)], 0).index, 1);
});

test('large sample: 8 people x 2 calibrations x 100 tries per gesture -> >=96% caught, zero confusions', { timeout: 300000 }, () => {
  const tot = {};
  for (const persona of Object.keys(PERSONAS)) for (const seed of [3, 4]) {
    const sim = makeSim({ seed, persona });
    const { cal } = fitCalibration(simCalibrationSamples(sim));
    const eng = new GestureEngine(cal);
    for (const g of Object.keys(G)) {
      if (!cal.params.enabled[g]) continue;
      tot[g] ??= { hit: 0, n: 0, wrong: 0 };
      for (let i = 0; i < 100; i++) {
        const ev = types([...sim.run([[700, {}]]), ...sim.run(G[g]), ...sim.run([[900, {}]])].flatMap(({ t, f }) => eng.update(f, t)));
        tot[g].n++; if (ev.includes(g)) tot[g].hit++; if (ev.some((x) => x !== g)) tot[g].wrong++;
      }
    }
  }
  for (const [g, { hit, n, wrong }] of Object.entries(tot)) {
    console.log(`  ${g}: ${(100 * hit / n).toFixed(1)}% caught, ${wrong} confused (n=${n})`);
    assert.ok(hit / n >= 0.96, g); assert.equal(wrong, 0, g);
  }
});

test('LONG_BLINK (quick stop): fires ~0.5 s into a deliberate long blink, never on natural blinking', () => {
  const { sim, feed } = setup('typical', 21);
  const relaxed = feed(sim.run([[600_000, {}]])).filter((e) => e.type === 'LONG_BLINK');
  assert.equal(relaxed.length, 0, 'natural blinks produced LONG_BLINK');
  sim.setNatural(false);
  const t0 = sim.now();
  const ev = feed([...sim.run([[900, { lidL: 1, lidR: 1 }]]), ...sim.run([[600, {}]])]).filter((e) => e.type === 'LONG_BLINK');
  assert.equal(ev.length, 1);
  assert.ok(ev[0].t - t0 < 750, 'stop latency ' + (ev[0].t - t0));
});

test('an expressive eyebrow raise (even 2.5 s) does not toggle; a 4 s hold does, once', () => {
  const { sim, feed } = setup('typical', 22);
  sim.setNatural(false);
  assert.deepEqual(types(feed([...sim.run([[2500, { brow: 1 }]]), ...sim.run([[800, {}]])])), []);
  assert.deepEqual(types(feed([...sim.run([[5000, { brow: 1 }]]), ...sim.run([[800, {}]])])), ['BROW_HOLD']);
});

test('eyebrow navigation (Talk): quick raise = BROW_TAP, 1 s hold = BROW_SELECT only; off elsewhere', () => {
  const { sim, feed, eng } = setup('typical', 23);
  sim.setNatural(false);
  assert.deepEqual(types(feed([...sim.run([[400, { brow: 1 }]]), ...sim.run([[800, {}]])])), [], 'off by default');
  eng.browNav = true;
  assert.deepEqual(types(feed([...sim.run([[400, { brow: 1 }]]), ...sim.run([[800, {}]])])), ['BROW_TAP']);
  assert.deepEqual(types(feed([...sim.run([[1600, { brow: 1 }]]), ...sim.run([[800, {}]])])), ['BROW_SELECT']);
  assert.deepEqual(types(feed([...sim.run([[5000, { brow: 1 }]]), ...sim.run([[800, {}]])])), ['BROW_SELECT', 'BROW_HOLD']);
});

test('drive by looking: LOOK left/center/right from gaze; eyebrows up = BROW_START with that direction, down = BROW_END', () => {
  const { sim, feed, eng } = setup('typical', 24);
  sim.setNatural(false);
  eng.cal.gaze = { center: 0.05, left: 0.25, right: -0.15, ok: true };
  eng.lookNav = true;
  const run = (ms, o, gaze) => types(feed(sim.run([[ms, o]]).map((x) => ({ ...x, f: x.f.face ? { ...x.f, raw: { ...x.f.raw, gaze } } : x.f }))), true);
  assert.deepEqual(run(600, {}, 0.05), []);
  assert.deepEqual(run(600, {}, 0.24), ['LOOK:left']);
  assert.deepEqual(run(900, { brow: 1 }, -0.15).at(-1), 'BROW_START:left', 'direction is the one from just before the eyebrows went up');
  assert.deepEqual(run(500, {}, 0.24), ['BROW_END']);
  assert.deepEqual(run(600, {}, 0.05), ['LOOK:center']);
  assert.deepEqual(run(600, {}, -0.14), ['LOOK:right']);
  assert.deepEqual(run(600, {}, 0.09), ['LOOK:center']);
  assert.deepEqual(run(400, { brow: 1 }, 0.05), ['BROW_START:center']);
});

// ------------------------------------------------------------------ quick calibration (what the app uses)
function quickSetup(persona, seed, { reactMs = 350, winks = true } = {}) {
  const sim = makeSim({ seed, persona });
  const fr = (a) => a.map((x) => ({ t: x.t, ...x.f }));
  sim.run([[800, {}]]);
  const relaxed = fr(sim.run([[8000, {}]]));
  const closed = fr([...sim.run([[reactMs, {}]]), ...sim.run([[3500 - reactMs, { lidL: 1, lidR: 1 }]])]);
  const step = (g) => (g ? fr([...sim.run([[reactMs, {}]]), ...sim.run([[2500 - reactMs, g]]), ...sim.run([[600, {}]])]) : undefined);
  const out = quickCalibration({ relaxed, closed, ...(winks ? { winkL: step({ lidL: 1 }), winkR: step({ lidR: 1 }) } : {}) });
  sim.run([[1200, {}]]);
  return { sim, ...out };
}

test('QUICK calibration (20 s, no enrollment): every persona calibrates, even reacting 1.5 s late to "close your eyes"', () => {
  for (const persona of Object.keys(PERSONAS)) for (const reactMs of [350, 1500]) {
    const { cal, report } = quickSetup(persona, 31, { reactMs });
    assert.ok(cal, `${persona} react ${reactMs}: ${report.warnings.join(';')}`);
  }
  const never = quickCalibration({ relaxed: quickSetupFrames(8000), closed: quickSetupFrames(3500) });
  assert.equal(never.cal, null, 'eyes never closed must fail with a message');
  assert.ok(never.report.warnings[0].includes('did not see your eyes close'));
});
function quickSetupFrames(ms) { const sim = makeSim({ seed: 40 }); return sim.run([[ms, {}]]).map((x) => ({ t: x.t, ...x.f })); }

test('QUICK calibration: 10 min relaxed -> zero commands; gestures caught without any enrollment', { timeout: 300000 }, () => {
  const tot = {};
  for (const persona of ['typical', 'glasses', 'smallEyes', 'glassesSmall', 'weak', 'asymmetric', 'partialWink']) for (const seed of [31, 32]) {
    const { sim, cal } = quickSetup(persona, seed);
    const eng = new GestureEngine(cal);
    const feed = (frames) => frames.flatMap(({ t, f }) => eng.update(f, t));
    const relaxed = types(feed(sim.run([[600_000, {}]])));
    assert.deepEqual(relaxed, [], `${persona}/${seed} false: ${relaxed.join(',')}`);
    for (const g of Object.keys(G)) {
      tot[g] ??= { hit: 0, n: 0, wrong: 0 };
      for (let i = 0; i < 40; i++) {
        const ev = types(feed([...sim.run([[700, {}]]), ...sim.run(G[g]), ...sim.run([[900, {}]])]));
        tot[g].n++; if (ev.includes(g)) tot[g].hit++; if (ev.some((x) => x !== g)) { tot[g].wrong++; if (process.env.DBG) console.log('   confused', persona, g, ev.join(',')); }
      }
    }
  }
  for (const [g, { hit, n, wrong }] of Object.entries(tot)) {
    console.log(`  quick ${g}: ${(100 * hit / n).toFixed(1)}% caught, ${wrong} confused (n=${n})`);
    assert.ok(hit / n >= 0.93, g); assert.ok(wrong <= 2, g + ' confusions ' + wrong);
  }
});

// ------------------------------------------------------------------ crowd behind the user
test('face lock in a crowd: smaller faces behind the user are ignored, even when the user leaves and returns', async () => {
  const { FaceLock } = await import('../src/face-lock.js');
  const lock = new FaceLock();
  const user = { cx: 0.5, cy: 0.5, size: 0.3, sig: null }, crowd = [{ cx: 0.2, cy: 0.3, size: 0.09, sig: null }, { cx: 0.8, cy: 0.35, size: 0.12, sig: null }];
  let t = 0, r;
  for (let i = 0; i < 40; i++) r = lock.update([user], (t += 33));
  assert.equal(r.status, 'locked');
  for (let i = 0; i < 30; i++) r = lock.update([crowd[0], user, crowd[1]], (t += 33));
  assert.deepEqual([r.index, r.status, r.multiple, r.ignored], [1, 'locked', false, 2], 'user kept, crowd not even counted');
  for (let i = 0; i < 60; i++) r = lock.update(crowd, (t += 33)); // user leans out of frame
  assert.equal(r.index, null, 'nobody in the crowd takes over');
  for (let i = 0; i < 40; i++) r = lock.update([crowd[0], crowd[1], user], (t += 33));
  assert.deepEqual([r.index, r.status], [2, 'locked'], 'user picked up again');
});
