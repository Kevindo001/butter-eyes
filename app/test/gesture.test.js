import test from 'node:test';
import assert from 'node:assert/strict';
import { GestureEngine } from '../src/gesture-engine.js';
import { computeCalibration } from '../src/calibration.js';
import { makeSim, simCalibrationSamples } from './sim.js';

function setup(opts = {}) {
  const sim = makeSim(opts);
  const { cal, report } = computeCalibration(simCalibrationSamples(sim, opts));
  assert.ok(cal, 'calibration failed: ' + report.warnings.join('; '));
  const eng = new GestureEngine(cal);
  const feed = (frames) => frames.flatMap(({ t, f }) => eng.update(f, t));
  sim.run([[1500, {}]]).forEach(({ t, f }) => eng.update(f, t)); // warm up
  return { sim, eng, feed, cal, report };
}
const types = (ev) => ev.map((e) => e.type).filter((x) => x !== 'FACE_FOUND' && x !== 'FACE_LOST');

test('calibration finds all 4 directions and winks', () => {
  const { report } = setup();
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report.dirs).sort(), ['down', 'left', 'right', 'up']);
  assert.equal(report.winks, true);
});

test('JITTER: 10 minutes of relaxed staring with natural blinks, drift, spikes, dropped frames -> zero commands', () => {
  for (const seed of [1, 2, 3]) {
    const { sim, feed } = setup({ seed });
    const ev = types(feed(sim.run([[600_000, {}]])));
    assert.deepEqual(ev, [], `seed ${seed} false events: ${ev.join(',')}`);
  }
});

test('JITTER at 1.5x noise: still no false commands over 5 minutes', () => {
  const { sim, feed } = setup({ seed: 11, noise: 1.5 });
  const ev = types(feed(sim.run([[300_000, {}]])));
  assert.deepEqual(ev, []);
});

test('each look direction fires exactly once, within 600 ms, and ends', () => {
  const { sim, feed } = setup({ seed: 4 });
  for (const d of ['left', 'right', 'up', 'down']) {
    const start = sim.now();
    const ev = feed(sim.run([[800, { gaze: d }]]));
    const look = ev.find((e) => e.type === 'LOOK_' + d.toUpperCase());
    assert.ok(look, `no LOOK_${d}`);
    assert.ok(look.t - start < 600, `LOOK_${d} latency ${look.t - start}`);
    assert.equal(ev.filter((e) => e.type.startsWith('LOOK_') && e.type !== 'LOOK_REPEAT').length, 1);
    const end = feed(sim.run([[700, {}]]));
    assert.ok(end.some((e) => e.type === 'LOOK_END'), `no LOOK_END after ${d}`);
  }
});

test('a quick glance (150 ms) does not fire', () => {
  const { sim, feed } = setup({ seed: 5 });
  const ev = types(feed(sim.run([[150, { gaze: 'left' }], [800, {}]])));
  assert.deepEqual(ev, []);
});

test('held look repeats for continuous drive, and stays held through a natural blink', () => {
  const { sim, feed, eng } = setup({ seed: 6 });
  const ev = feed(sim.run([[3000, { gaze: 'up' }]]));
  assert.ok(ev.filter((e) => e.type === 'LOOK_REPEAT').length >= 2);
  assert.equal(ev.filter((e) => e.type === 'LOOK_END').length, 0, 'gaze dropped while holding (natural blinks must not end it)');
  assert.equal(eng.state.held, 'up');
});

test('deliberate blink (500 ms) -> BLINK; natural 150 ms blink -> nothing', () => {
  const { sim, feed } = setup({ seed: 8, naturalBlinks: false });
  assert.deepEqual(types(feed(sim.run([[500, { lidL: 1, lidR: 1 }], [500, {}]]))), ['BLINK']);
  assert.deepEqual(types(feed(sim.run([[150, { lidL: 1, lidR: 1 }], [900, {}]]))), []);
});

test('double blink -> DOUBLE_BLINK (not BLINK)', () => {
  const { sim, feed } = setup({ seed: 9, naturalBlinks: false });
  const ev = types(feed(sim.run([[180, { lidL: 1, lidR: 1 }], [200, {}], [180, { lidL: 1, lidR: 1 }], [700, {}]])));
  assert.deepEqual(ev, ['DOUBLE_BLINK']);
});

test('eyes closed 2 s -> LONG_CLOSE once', () => {
  const { sim, feed } = setup({ seed: 10, naturalBlinks: false });
  const ev = types(feed(sim.run([[2600, { lidL: 1, lidR: 1 }], [500, {}]])));
  assert.deepEqual(ev, ['LONG_CLOSE']);
});

test('winks left/right, and a held wink acts as a clutch', () => {
  const { sim, feed } = setup({ seed: 12, naturalBlinks: false });
  assert.deepEqual(types(feed(sim.run([[400, { lidL: 1 }], [500, {}]]))), ['WINK_LEFT']);
  assert.deepEqual(types(feed(sim.run([[400, { lidR: 1 }], [500, {}]]))), ['WINK_RIGHT']);
  assert.deepEqual(types(feed(sim.run([[1500, { lidR: 1 }], [500, {}]]))), ['WINK_HOLD_START', 'WINK_HOLD_END']);
});

test('mirrored MediaPipe eye channels are auto-corrected by calibration', () => {
  // simulate a camera where the "left" channel is really the right eye
  const sim = makeSim({ seed: 13, naturalBlinks: false });
  const swapF = (fr) => fr.map(({ t, f }) => ({ t, f: f.face ? { ...f, blinkL: f.blinkR, blinkR: f.blinkL } : f }));
  const s = simCalibrationSamples(sim);
  for (const k of Object.keys(s)) s[k] = swapF(s[k].map((f) => ({ t: 0, f }))).map((x) => x.f);
  const { cal } = computeCalibration(s);
  assert.equal(cal.swapEyes, true);
  const eng = new GestureEngine(cal);
  const ev = swapF(sim.run([[1000, {}], [400, { lidL: 1 }], [500, {}]])).flatMap(({ t, f }) => eng.update(f, t));
  assert.deepEqual(types(ev), ['WINK_LEFT']);
});

test('face lost -> FACE_LOST and any held gaze ends (robot must stop)', () => {
  const { sim, feed } = setup({ seed: 14 });
  feed(sim.run([[800, { gaze: 'up' }]]));
  const ev = feed(sim.run([[800, { face: false }]])).map((e) => e.type);
  assert.ok(ev.includes('LOOK_END') && ev.includes('FACE_LOST'), ev.join(','));
});

test('weak vertical gaze gets disabled with a warning instead of misfiring', () => {
  const sim = makeSim({ seed: 15 });
  const s = simCalibrationSamples(sim);
  s.up = s.center.slice(0, 40); // user could not move eyes up
  const { cal, report } = computeCalibration(s);
  assert.ok(report.warnings.some((w) => w.includes('up')));
  const eng = new GestureEngine(cal);
  assert.equal(eng.dirVecs.up, undefined);
});

test('a face that never moves its eyes (photo / no effort) does NOT calibrate', () => {
  const sim = makeSim({ seed: 16 });
  const s = simCalibrationSamples(sim);
  for (const d of ['left', 'right', 'up', 'down']) s[d] = s.center.slice(0, 48);
  const { cal, report } = computeCalibration(s);
  assert.equal(cal, null);
  assert.equal(report.ok, false);
});
