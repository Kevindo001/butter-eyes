// Full-app end-to-end test: real Electron app + real MediaPipe on a real face image (fake camera)
// + real microphone pipeline fed with a recorded voice (fake mic) + live ElevenLabs + live DeepSeek
// + the real butter-drive server in mock-motor mode. Eye gestures are injected through the same bus
// the gesture engine uses, and every motor command is checked on the robot side.
//
//   xvfb-run -a node test/e2e/run-e2e.js --video face.y4m --audio them.wav --video2 twofaces.y4m --shots ./shots
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fitCalibration } from '../../src/calibration.js';
import { makeSim, simCalibrationSamples } from '../sim.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SHOTS = arg('shots', path.join(os.tmpdir(), 'butter-shots'));
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try { const note = await fn(); results.push(`PASS ${name}${note ? '  ' + note : ''} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; results.push(`FAIL ${name}: ${e.message}`); }
  console.log(results.at(-1));
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error('timeout waiting for ' + what);
}

// ---------------------------------------------------------------- mock robot
const PORT = 18771;
let robot, motorLog = [];
function startRobot() {
  robot = spawn('python3', [path.join(appDir, '../butter-drive/server.py'), '--mock', '--port', String(PORT), '--host', '127.0.0.1']);
  robot.stderr.on('data', (d) => {
    for (const l of d.toString().split('\n')) {
      const m = l.match(/motors -> (\w+)/); if (m) motorLog.push({ t: Date.now(), dir: m[1] });
    }
  });
}
const motors = () => motorLog.filter((x) => x.dir).map((x) => x.dir);

// ---------------------------------------------------------------- seed store: a v3 calibration
const storePath = path.join(os.tmpdir(), `butter-e2e-${process.pid}.json`);
const { cal, report } = fitCalibration(simCalibrationSamples(makeSim({ seed: 3 })));
cal.report = { gestures: report.gestures };
const seed = () => fs.writeFileSync(storePath, JSON.stringify({
  settings: { butterUrl: `ws://127.0.0.1:${PORT}`, butterCameraUrl: 'http://127.0.0.1:1/none', voiceOut: 'laptop', driveMode: 'blink', navWith: 'wink' },
  calibration: cal, voiceExamples: [],
}));
seed();
startRobot();
await sleep(800);

async function launch(video, audio, extraEnv = {}) {
  const switches = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  if (video) switches.push('--use-file-for-fake-video-capture=' + path.resolve(video));
  if (audio) switches.push('--use-file-for-fake-audio-capture=' + path.resolve(audio));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [appDir, ...switches],
    env: { ...process.env, BUTTER_E2E: '1', BUTTER_STORE: storePath, ...extraEnv },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { app, page, errors };
}
async function close(app) { await Promise.race([app.close().catch(() => {}), sleep(4000)]); try { app.process().kill('SIGKILL'); } catch {} }

let { app, page, errors } = await launch(arg('video'), arg('audio'), { BUTTER_CAL_SPEED: '0.3' });
const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
const inject = (type, extra = {}) => page.evaluate(([t, x]) => window.__butter.inject(t, x), [type, extra]);
const screen = () => page.evaluate(() => window.__butter.S.screenName);
const S = (expr) => page.evaluate(`(() => { const S = window.__butter.S; const screens = window.__butter.screens; return ${expr}; })()`);

try {
  await check('app boots on home with a v3 calibration, services wired, no keys in renderer', async () => {
    await until(() => page.evaluate(() => window.__butter?.ready), 30000, 'ready');
    assert(await screen() === 'home', 'not on home');
    assert(await S('!!S.engine'), 'gesture engine not started');
    const keys = await S('S.store.keys');
    assert(keys.deepseek && keys.elevenlabs, 'API keys not loaded in main');
    const html = await page.content();
    assert(!/sk-[a-f0-9]{20}|sk_[a-f0-9]{20}/.test(html), 'API key leaked into renderer');
  });

  await check('real MediaPipe on Anh\'s webcam frame (glasses): face locked, eyes open, lid ratio + blink score sane', async () => {
    await until(() => S('S.faceFrames > 20'), 30000, 'face frames');
    const f = await S('({ fps: S.tracker.fps, delegate: S.tracker.delegate, lock: S.lastFrame.lock, multiple: S.lastFrame.multiple, raw: S.lastFrame.raw, eyePx: S.lastFrame.eyePx, glare: S.lastFrame.glare, rate: S.faceFrames / S.frames })');
    assert(f.lock === 'locked' && !f.multiple, 'lock ' + f.lock);
    assert(f.rate > 0.9, 'detection rate ' + f.rate);
    for (const e of ['L', 'R']) {
      assert(f.raw.b[e] < 0.5, 'blink score says closed: ' + f.raw.b[e]);
      assert(f.raw.r[e] > 0.12 && f.raw.r[e] < 0.5, 'lid ratio out of range: ' + f.raw.r[e]);
    }
    assert(f.eyePx > 22, 'eye too small: ' + f.eyePx);
    return `fps=${f.fps.toFixed(1)} ${f.delegate} detect=${(f.rate * 100).toFixed(0)}% blink=${f.raw.b.L.toFixed(2)}/${f.raw.b.R.toFixed(2)} lid=${f.raw.r.L.toFixed(3)}/${f.raw.r.R.toFixed(3)} eye=${f.eyePx.toFixed(0)}px glare=${(f.glare * 100).toFixed(1)}%`;
  });
  // From here on gestures are injected; detach the engine so a synthetic calibration can't misread the photo.
  await page.evaluate(() => { window.__butter.S.engine = null; });
  await shot('01-home');

  await check('robot link: connects to butter-drive (mock)', async () => { await until(() => S('S.butter.connected && S.butter.mock'), 8000, 'butter connected'); });

  await check('home: winks move the highlight around, double blink opens', async () => {
    await inject('WINK_RIGHT');
    assert(await page.locator('.choice.t-right.focus').count() === 1, 'wink right did not move to Play');
    await inject('WINK_LEFT');
    assert(await page.locator('.choice.t-up.focus').count() === 1, 'wink left did not move back to Drive');
    await inject('DOUBLE_BLINK');
    assert(await screen() === 'drive', 'did not open drive');
  });

  await check('drive: 1st double blink only asks to confirm; 2nd drives (heartbeat holds it); 3rd stops', async () => {
    motorLog = [];
    await inject('DOUBLE_BLINK'); await sleep(300);
    assert(motors().length === 0, 'moved without confirmation');
    assert((await page.locator('#badge').textContent()).includes('again'), 'no confirm prompt');
    await shot('02-drive-confirm');
    await inject('DOUBLE_BLINK'); await sleep(1600);
    await shot('03-drive-forward');
    await inject('DOUBLE_BLINK'); await sleep(250);
    assert(motors().join() === 'forward,stop', 'sequence ' + motors());
  });

  await check('drive: confirmation expires after 3 s (a stray double blink never starts it later)', async () => {
    motorLog = [];
    await inject('DOUBLE_BLINK'); await sleep(3300);
    await inject('DOUBLE_BLINK'); await sleep(300);
    assert(motors().length === 0, 'started from an expired confirmation: ' + motors());
    await inject('BOTH_CLOSED'); // clear the fresh prompt
  });

  await check('drive: you turn toward your open eye; wink = short timed turn, hold = turn while held, face lost = stop', async () => {
    motorLog = [];
    await inject('WINK_LEFT'); await sleep(900);
    await inject('HOLD_RIGHT', { side: 'right' }); await sleep(800); await inject('HOLD_END', { side: 'right' }); await sleep(200);
    await inject('DOUBLE_BLINK'); await inject('DOUBLE_BLINK'); await sleep(400);
    await inject('FACE_LOST'); await sleep(250);
    const turn = motorLog.filter((x) => x.dir);
    assert(motors().join() === 'right,stop,left,stop,forward,stop', 'sequence ' + motors() + ' (closing the left eye must turn right)');
    const pulse = turn[1].t - turn[0].t, hold = turn[3].t - turn[2].t;
    assert(pulse > 400 && pulse < 800, 'wink turn ' + pulse);
    assert(hold > 650 && hold < 1100, 'hold turn ' + hold);
    return `wink turn ${pulse} ms, hold turn ${hold} ms`;
  });

  await check('drive: long blink is a quick stop, and the same eye-close reaching 2 s does not also exit', async () => {
    motorLog = [];
    await inject('DOUBLE_BLINK'); await inject('DOUBLE_BLINK'); await sleep(400);
    await inject('LONG_BLINK'); await sleep(200);
    assert(motors().join() === 'forward,stop', 'sequence ' + motors());
    await inject('BOTH_CLOSED');
    assert(await screen() === 'drive', 'exited drive on the same eye close');
  });

  await check('eye control off (eyebrow hold): gestures ignored and Butter stops; safety stop still works; on again restores', async () => {
    motorLog = [];
    await inject('DOUBLE_BLINK'); await inject('DOUBLE_BLINK'); await sleep(300);
    await inject('BROW_HOLD'); await sleep(250);
    assert(motors().join() === 'forward,stop', 'turning control off must stop: ' + motors());
    assert(await page.locator('#pillControl').isVisible(), 'no "Eye control off" badge');
    assert((await page.locator('#ctlState').textContent()) === 'Off', 'sidebar not Off');
    await shot('03b-control-off');
    await inject('DOUBLE_BLINK'); await inject('DOUBLE_BLINK'); await inject('WINK_LEFT'); await sleep(400);
    assert(motors().join() === 'forward,stop', 'moved while eye control was off: ' + motors());
    await inject('BROW_HOLD');
    assert(await page.locator('#pillControl').isHidden(), 'badge still shown');
    await inject('WINK_LEFT'); await sleep(900);
    assert(motors().join() === 'forward,stop,right,stop', 'control did not come back: ' + motors());
  });

  await check('drive: robot dies mid-drive -> offline badge; restarts -> reconnects stopped, no resume', async () => {
    motorLog = [];
    await inject('DOUBLE_BLINK'); await inject('DOUBLE_BLINK'); await sleep(300);
    robot.kill('SIGKILL');
    await until(async () => (await page.locator('#badge').textContent()).includes('offline'), 4000, 'offline badge');
    startRobot();
    await until(() => S('S.butter.connected'), 8000, 'reconnect');
    await sleep(800);
    assert(!motors().slice(1).includes('forward'), 'motion resumed after reconnect: ' + motors());
    await inject('DOUBLE_BLINK'); // stop the cruise state in the UI
  });

  await check('drive: eyes closed 2 s stops; again goes home', async () => {
    await inject('BOTH_CLOSED'); await inject('BOTH_CLOSED');
    assert(await screen() === 'home', 'not home');
  });

  await check('settings: winks pick a row, double blink changes it, saved to disk; gestures card shown', async () => {
    await page.evaluate(() => { window.__butter.screens.home.i = 2; window.__butter.screens.home.render(); });
    await inject('DOUBLE_BLINK');
    assert(await screen() === 'settings', 'settings not open');
    await inject('DOUBLE_BLINK'); // row 0: drive speed 10% -> 20%
    await until(() => S('S.settings.driveSpeed === 0.2'), 3000, 'setting change');
    assert(JSON.parse(fs.readFileSync(storePath, 'utf8')).settings.driveSpeed === 0.2, 'not persisted');
    assert((await page.content()).includes('Practice gestures'), 'no practice row');
    await shot('07-settings');
    await page.evaluate(() => window.butterApi.saveSettings({ driveSpeed: 0.1 }).then((s) => { window.__butter.S.settings = s; }));
    await inject('BOTH_CLOSED');
  });

  let heardAt;
  await check('menus by eyebrows (Settings > Navigate with): quick raise moves on and wraps, winks do nothing, double blink opens; wink style restores winks', async () => {
    const setNav = (v) => page.evaluate((v) => window.butterApi.saveSettings({ navWith: v }).then((s) => { window.__butter.S.settings = s; window.__butter.go('home'); }), v);
    await setNav('brow');
    const i0 = await S('screens.home.i');
    await inject('WINK_RIGHT'); await inject('WINK_LEFT');
    assert(await S('screens.home.i') === i0, 'a wink moved the menu in eyebrow style');
    const seen = [];
    for (let k = 0; k < 4; k++) { await inject('BROW_TAP'); seen.push(await S('screens.home.i')); }
    assert(seen[3] === i0 && new Set(seen).size === 4, 'eyebrow cycle wrong: ' + seen);
    const hint = await page.locator('.hint').textContent();
    assert(/eyebrow/i.test(hint) && !/wink/i.test(hint), 'hints not updated: ' + hint);
    await shot('02b-home-eyebrows');
    await page.evaluate(() => { window.__butter.screens.home.i = 2; window.__butter.screens.home.render(); });
    await inject('DOUBLE_BLINK');
    assert(await screen() === 'settings', 'double blink did not open');
    const r0 = await S('screens.settings.row');
    await inject('WINK_RIGHT'); assert(await S('screens.settings.row') === r0, 'wink moved a settings row');
    await inject('BROW_TAP'); assert(await S('screens.settings.row') === r0 + 1, 'eyebrow did not move a settings row');
    await setNav('wink');
    await inject('BROW_TAP'); assert(await S('screens.home.i') === (await S('screens.home.i')), 'noop');
    const i1 = await S('screens.home.i');
    await inject('BROW_TAP'); assert(await S('screens.home.i') === i1, 'eyebrow moved the menu in wink style');
    await inject('WINK_RIGHT'); assert(await S('screens.home.i') !== i1, 'wink did not move the menu in wink style');
    await page.evaluate(() => window.__butter.go('home'));
  });

  await check('Blink Drive: an eyebrow raise does not move Butter (no reverse)', async () => {
    await page.evaluate(() => window.__butter.go('drive'));
    await inject('BROW_TAP');
    assert(await S('screens.drive.dir') === 'stop', 'eyebrow raise moved Butter');
    await page.evaluate(() => window.__butter.go('home'));
  });

  await check('drive (look + eyebrows): look left + eyebrows up turns left, eyebrows down stops, forward when looking ahead; 4 s eyebrows does not switch control off', async () => {
    await page.evaluate(() => window.butterApi.saveSettings({ driveMode: 'look' }).then((s) => { window.__butter.S.settings = s; window.__butter.go('drive'); }));
    assert(await page.locator('#looks [data-l]').count() === 3, 'look targets missing');
    await inject('LOOK', { dir: 'left' });
    assert(await page.locator('#looks .look').getAttribute('data-l') === 'left', 'look highlight');
    assert(await S('screens.drive.dir') === 'stop', 'looking alone moved Butter');
    await inject('BROW_START', { look: 'left' });
    assert(await S('screens.drive.dir') === 'left', 'did not turn left');
    await inject('BROW_HOLD');
    assert(await S('S.control') === true, 'eyebrow hold switched control off while driving');
    await shot('05b-lookdrive');
    await inject('BROW_END');
    assert(await S('screens.drive.dir') === 'stop', 'did not stop on release');
    await inject('LOOK', { dir: 'center' }); await inject('BROW_START', { look: 'center' });
    assert(await S('screens.drive.dir') === 'forward', 'did not go forward');
    await inject('WINK_LEFT');
    assert(await S('screens.drive.dir') === 'forward', 'a wink changed direction in look mode');
    await inject('LONG_BLINK');
    assert(await S('screens.drive.dir') === 'stop', 'long blink did not stop');
    await inject('BROW_START', { look: 'center' });
    await inject('DOUBLE_BLINK');
    assert(await S('S.control') === false && await S('screens.drive.dir') === 'stop', 'double blink did not switch eye control off and stop');
    await inject('BROW_START', { look: 'center' });
    assert(await S('screens.drive.dir') === 'stop', 'moved with eye control off');
    await inject('DOUBLE_BLINK');
    assert(await S('S.control') === true, 'double blink did not switch eye control back on');
    await sleep(3300); // a fresh eye-close, not the one that just stopped it
    await inject('BOTH_CLOSED');
    assert(await screen() === 'home', 'closing both eyes did not exit look drive');
    await page.evaluate(() => window.butterApi.saveSettings({ driveMode: 'blink' }).then((s) => { window.__butter.S.settings = s; window.__butter.go('home'); }));
  });

  await check('dev tab: clicking Dev shows live rows for frown / squint; snake fills the window', async () => {
    await page.click('#devBtn');
    assert(await screen() === 'dev', 'dev tab did not open');
    assert(await page.locator('.devrow').count() === 6, 'dev rows');
    await sleep(2600);
    const txt = await page.locator('.devrow[data-k="browDown"] small').textContent();
    assert(/neutral \d/.test(txt), 'no neutral level measured: ' + txt);
    await shot('11-dev');
    await page.click('#devBtn');
    assert(await screen() === 'home', 'dev tab did not close');
    await page.evaluate(() => window.__butter.go('snake'));
    const fill = await page.evaluate(() => { const c = document.querySelector('#snake').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return [c.width / m.width, c.height / m.height]; });
    assert(fill[0] > 0.9 && fill[1] > 0.85, 'snake not full screen: ' + fill);
    await shot('12-snake-full');
    await page.evaluate(() => window.__butter.go('home'));
    return fill.map((x) => x.toFixed(2)).join(' x ');
  });

  await check('key 0 turns the webcam off (stream stopped, Butter stopped, no frames) and on again', async () => {
    await page.evaluate(() => window.__butter.go('drive'));
    await inject('DOUBLE_BLINK'); await inject('DOUBLE_BLINK');
    assert(await S('screens.drive.dir') === 'forward', 'setup: not driving');
    await page.keyboard.press('0');
    await sleep(400);
    assert(await S('S.tracker.cameraOn') === false && await S('S.cameraOff') === true, 'camera still on');
    assert(await S('screens.drive.dir') === 'stop', 'Butter kept moving with the webcam off');
    assert(/Webcam off/.test(await page.locator('#pillFace').textContent()), 'no webcam-off label');
    const n = await S('S.frames'); await sleep(700);
    assert(await S('S.frames') === n, 'frames still arriving with the webcam off');
    await shot('13-webcam-off');
    await page.keyboard.press('0');
    await until(() => S('S.tracker.cameraOn === true'), 5000, 'camera back on');
    const m = await S('S.frames'); await until(async () => (await S('S.frames')) > m + 5, 5000, 'frames resume');
    await page.evaluate(() => window.__butter.go('home'));
  });

  await check('talk: fake mic voice -> VAD (audio thread) -> ElevenLabs Scribe -> transcript', async () => {
    await page.evaluate(() => { window.__butter.screens.home.i = 3; window.__butter.screens.home.render(); });
    await inject('DOUBLE_BLINK');
    assert(await screen() === 'talk', 'talk not open');
    // push-to-listen: nothing is heard until the spacebar is held
    await sleep(5000);
    assert(await S("screens.talk.convo.filter(m => m.who === 'them').length") === 0, 'heard speech without the spacebar held');
    await page.keyboard.down('Space'); await sleep(7500); await page.keyboard.up('Space');
    const text = await until(() => S("(screens.talk.convo.find(m => m.who === 'them') || {}).text"), 25000, 'heard speech');
    heardAt = Date.now();
    assert(await page.evaluate(() => window.__butter.mic()?.mode) === 'worklet', 'mic not on the audio thread');
    assert(/movie/i.test(text) && /tonight/i.test(text), 'bad transcript: ' + text);
    return `"${text}"`;
  });

  await check('talk: 3 DeepSeek replies, most likely in the middle and selected', async () => {
    await until(() => S("!screens.talk.loading && screens.talk.options.length === 3 && screens.talk.convo.some(m => m.who === 'them')"), 15000, 'options');
    const o = await S('({ opts: screens.talk.options, focus: screens.talk.focus, info: screens.talk.info })');
    assert(o.focus === 1, 'focus not on the middle');
    assert(!o.info.includes('fallback'), o.info);
    await shot('04-talk-options');
    return `${o.info} | ${JSON.stringify(o.opts)} | ${Date.now() - heardAt} ms after transcript`;
  });

  await check('talk: wink right + double blink says it (ElevenLabs), remembered as the user\'s style', async () => {
    await inject('WINK_RIGHT');
    assert(await S('screens.talk.focus') === 2, 'focus did not move right');
    const picked = await S('screens.talk.options[2]');
    await inject('DOUBLE_BLINK');
    await until(() => S("screens.talk.convo.some(m => m.who === 'me')"), 5000, 'me message');
    await until(() => JSON.parse(fs.readFileSync(storePath, 'utf8')).voiceExamples.includes(picked), 3000, 'voice example saved');
    const r = await page.evaluate((txt) => window.butterApi.speak(txt), picked);
    assert(r.audio && r.audio.length > 3000, 'no TTS audio: ' + (r.error || ''));
    await sleep(400); await shot('05-talk-said');
    return `said "${picked}" (TTS ${r.ms} ms)`;
  });

  await check('talk: caregiver typing gets 3 fresh replies with a yes and a no', async () => {
    await page.fill('#typeIn', 'Are you hungry?');
    await page.press('#typeIn', 'Enter');
    await until(() => S("!screens.talk.loading && screens.talk.convo.at(-1).text === 'Are you hungry?' && screens.talk.options.length === 3"), 15000, 'options for typed');
    const opts = await S('screens.talk.options');
    assert(opts.some((x) => /yes|yeah|yep|sure|starving|bit|please|i'm in/i.test(x)) && opts.some((x) => /\bno\b|not|nah/i.test(x)), 'yes/no missing: ' + opts);
    return JSON.stringify(opts);
  });

  await check('talk: hold left = quick phrases, double blink says "Yes"; hold right no longer re-rolls', async () => {
    await inject('HOLD_LEFT', { side: 'left' }); await inject('HOLD_END', { side: 'left' });
    assert(await page.locator('.quick .choice').count() === 8, 'quick board missing');
    await shot('06-quick');
    await inject('DOUBLE_BLINK');
    await until(() => S("screens.talk.convo.some(m => m.who === 'me' && m.text === 'Yes')"), 5000, 'said yes');
    await sleep(3000); // let the refresh that follows saying "Yes" finish first
    await page.evaluate(() => { const m = window.__butter.mic(); if (m) m.muted = true; }); // the looping test voice also refreshes replies
    await sleep(1500);
    const before = await S('screens.talk.reqId');
    await inject('HOLD_RIGHT', { side: 'right' }); await inject('HOLD_END', { side: 'right' });
    assert(await S('screens.talk.reqId') === before, 'hold right must not re-roll replies any more');
    await page.evaluate(() => { const m = window.__butter.mic(); if (m) m.muted = false; });
  });

  await check('talk: eyebrow raise cycles the 3 options (wraps), eyebrow hold says the focused one', async () => {
    await page.evaluate(() => window.butterApi.saveSettings({ navWith: 'brow' }).then((s) => { window.__butter.S.settings = s; window.__butter.go('talk'); }));
    await until(() => S('!screens.talk.loading && screens.talk.options.length === 3'), 15000, 'replies');
    const f0 = await S('screens.talk.focus');
    const seen = [];
    for (let i = 0; i < 3; i++) { await inject('BROW_TAP'); seen.push(await S('screens.talk.focus')); }
    assert(seen[2] === f0 && new Set(seen).size === 3, 'cycle wrong: ' + f0 + ' -> ' + seen);
    await inject('BROW_TAP');
    const want = await S('screens.talk.options[screens.talk.focus]');
    await inject('BROW_SELECT');
    await until(() => S(`screens.talk.convo.some(m => m.who === 'me' && m.text === ${JSON.stringify(want)})`), 5000, 'said by eyebrow hold');
    await page.evaluate(() => window.butterApi.saveSettings({ navWith: 'wink' }).then((s) => { window.__butter.S.settings = s; window.__butter.go('talk'); }));
    return want;
  });

  await check('talk: key R resets the conversation and learned phrases, then offers fresh openers', async () => {
    assert(await S('screens.talk.convo.length') > 0, 'setup: no conversation to reset');
    await page.keyboard.press('r');
    await until(() => S('screens.talk.convo.length === 0'), 3000, 'conversation cleared');
    assert(JSON.parse(fs.readFileSync(storePath, 'utf8')).voiceExamples.length === 0, 'learned phrases not cleared');
    await until(() => S('!screens.talk.loading && screens.talk.options.length === 3'), 15000, 'fresh replies');
    await page.fill('#typeIn', 'r r r'); // typing an r in the caregiver box must not reset anything
    assert(await page.inputValue('#typeIn') === 'r r r', 'typing r was swallowed');
    await page.fill('#typeIn', '');
  });

  await check('talk -> home (eyes closed 2 s); snake turns relative to its heading on winks', async () => {
    await inject('BOTH_CLOSED');
    assert(await screen() === 'home', 'not home');
    await page.evaluate(() => { window.__butter.screens.home.i = 1; window.__butter.screens.home.render(); });
    await inject('DOUBLE_BLINK');
    assert(await screen() === 'snake', 'snake not open');
    await inject('WINK_RIGHT'); await sleep(700);
    assert(await S('screens.snake.game.dir') === 'down', 'snake did not turn right from heading right');
    await shot('08-snake');
    await inject('BOTH_CLOSED');
  });

  await check('HUD: both eyes shown, no multiple-faces badge for one face', async () => {
    assert(await page.locator('#eyeL').count() === 1 && await page.locator('#eyeR').count() === 1, 'eye display missing');
    assert(await page.locator('#pillMulti').isHidden(), 'multiple-faces badge shown for one face');
  });

  await check('calibration on a still photo (fast mode): spoken flow runs, fails safely with a clear message, keeps old calibration', async () => {
    const before = await S('S.store.calibration.createdAt');
    await page.keyboard.press('c');
    await until(async () => (await page.locator('#lbl').textContent()).includes('Follow the circle'), 20000, 'follow-the-circle step');
    await shot('09-cal-circle');
    await until(async () => (await page.locator('#lbl').textContent()).includes('try that again'), 60000, 'failure message');
    await shot('10-cal-failed');
    const txt = await page.locator('#sub').textContent();
    assert(/not visible|did not see your eyes close/.test(txt), 'unexpected message: ' + txt);
    assert((await S('S.store.calibration.createdAt')) === before, 'bad calibration was saved');
    return txt;
  });

  await check('practice screen: gestures light up and count; Enter goes home', async () => {
    await page.evaluate(() => window.__butter.go('practice'));
    await inject('WINK_LEFT'); await inject('WINK_LEFT'); await inject('BROW_HOLD'); await inject('BOTH_CLOSED');
    assert(await screen() === 'practice', 'a gesture left the practice screen');
    assert((await page.locator('[data-g="WINK_LEFT"] .count').textContent()) === 'Seen 2x', 'count wrong');
    assert(await page.locator('.practice .choice.seen').count() === 3, 'seen tiles');
    assert(await page.locator('#pillControl').isHidden(), 'eyebrows toggled control during practice');
    await shot('10b-practice');
    await page.keyboard.press('Enter');
    assert(await screen() === 'home', 'Enter did not finish');
  });

  await check('no renderer errors', async () => {
    const bad = errors.filter((e) => !/^INFO:|^W0000|^I0000|favicon|ERR_CONNECTION_REFUSED|127\.0\.0\.1:1|net::ERR|Failed to load resource|WebGL|GPU|gl_|OpenGL/i.test(e));
    assert(bad.length === 0, bad.slice(0, 5).join(' | '));
  });
  await close(app);

  if (arg('video2')) {
    seed();
    ({ app, page, errors } = await launch(arg('video2'), null));
    await check('two real faces in view: locks the closer one, small "Multiple faces detected" badge', async () => {
      await until(() => page.evaluate(() => window.__butter?.ready), 30000, 'ready');
      await until(() => page.evaluate(() => window.__butter.S.faceFrames > 15), 30000, 'face frames');
      const f = await page.evaluate(() => ({ lock: window.__butter.S.lastFrame.lock, faces: window.__butter.S.lastFrame.faces, multiple: window.__butter.S.lastFrame.multiple, cx: window.__butter.S.lastFrame.landmarks?.[1]?.x }));
      assert(f.faces === 2 && f.multiple, 'expected 2 faces, got ' + JSON.stringify(f));
      assert(f.lock === 'locked' && f.cx < 0.5, 'did not lock the larger (left) face: ' + JSON.stringify(f));
      await until(() => page.locator('#pillMulti').isVisible(), 3000, 'badge');
      assert((await page.locator('#pillMulti').innerText()).includes('Multiple faces detected'));
      await page.screenshot({ path: path.join(SHOTS, '11-two-faces.png') });
      return JSON.stringify(f);
    });
  }
} finally {
  await close(app);
  robot.kill('SIGKILL');
  fs.rmSync(storePath, { force: true });
}
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
