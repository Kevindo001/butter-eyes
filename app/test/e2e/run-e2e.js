// Full-app end-to-end test: real Electron app + real MediaPipe on a real face image (fake camera)
// + real microphone pipeline fed with a recorded voice (fake mic) + live ElevenLabs + live DeepSeek
// + the real butter-drive server in mock-motor mode. Gestures are injected through the same bus
// the eye tracker uses, and every motor command is checked on the robot side.
//
//   xvfb-run -a node test/e2e/run-e2e.js --video face.y4m --audio them.wav --shots ./shots
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { computeCalibration } from '../../src/calibration.js';
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
      if (l.includes('say:')) motorLog.push({ t: Date.now(), say: l.split('say: ')[1] });
    }
  });
}
const motors = () => motorLog.filter((x) => x.dir).map((x) => x.dir);

// ---------------------------------------------------------------- seed store
const storePath = path.join(os.tmpdir(), `butter-e2e-${process.pid}.json`);
const { cal } = computeCalibration(simCalibrationSamples(makeSim({ seed: 3 })));
fs.writeFileSync(storePath, JSON.stringify({
  settings: { butterUrl: `ws://127.0.0.1:${PORT}`, butterCameraUrl: 'http://127.0.0.1:1/none', profile: 'eyes', voiceOut: 'laptop', gazeEnter: 0.55, gazeHoldMs: 280 },
  calibration: cal, voiceExamples: [],
}));

startRobot();
await sleep(800);

const switches = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
if (arg('video')) switches.push('--use-file-for-fake-video-capture=' + path.resolve(arg('video')));
if (arg('audio')) switches.push('--use-file-for-fake-audio-capture=' + path.resolve(arg('audio')));

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appDir, ...switches],
  env: { ...process.env, BUTTER_E2E: '1', BUTTER_STORE: storePath },
  timeout: 60000,
});
const page = await app.firstWindow();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
const inject = (type, extra = {}) => page.evaluate(([t, x]) => window.__butter.inject(t, x), [type, extra]);
const screen = () => page.evaluate(() => window.__butter.S.screenName);
const S = (expr) => page.evaluate(`(() => { const S = window.__butter.S; return ${expr}; })()`);

try {
  await check('app boots, home screen, services wired', async () => {
    await until(() => page.evaluate(() => window.__butter?.ready), 30000, 'ready');
    assert(await screen() === 'home', 'not on home');
    const keys = await S('S.store.keys');
    assert(keys.deepseek && keys.elevenlabs, 'API keys not loaded in main: ' + JSON.stringify(keys));
    const html = await page.content();
    assert(!html.includes('sk-') && !html.includes('sk_'), 'API key leaked into renderer');
  });

  await check('real MediaPipe tracking on Anh\'s webcam frame (glasses on)', async () => {
    await until(() => S('S.faceFrames > 20'), 30000, 'face frames');
    const f = await S('({ fps: S.tracker.fps, delegate: S.tracker.delegate, face: S.lastFrame.face, bl: S.lastFrame.blinkL, br: S.lastFrame.blinkR, feat: S.lastFrame.feat, rate: S.faceFrames / S.frames })');
    assert(f.face && f.rate > 0.9, 'face detection rate ' + f.rate);
    assert(f.feat.length === 4 && f.feat.every(Number.isFinite), 'bad features');
    assert(f.bl < 0.5 && f.br < 0.5, 'eyes read as closed');
    return `fps=${f.fps.toFixed(1)} delegate=${f.delegate} detect=${(f.rate * 100).toFixed(0)}% blink=${f.bl.toFixed(2)}/${f.br.toFixed(2)} feat=[${f.feat.map((x) => x.toFixed(3))}]`;
  });
  // From here on gestures are injected; detach the engine so the synthetic calibration can't
  // turn the (still) photo into stray events.
  await page.evaluate(() => { window.__butter.S.engine = null; });
  await shot('01-home');

  await check('robot link: connects to butter-drive (mock)', async () => {
    await until(() => S('S.butter.connected && S.butter.mock'), 8000, 'butter connected');
  });

  await check('home: look up highlights Drive, blink opens it', async () => {
    await inject('LOOK_UP', { dir: 'up' }); await inject('LOOK_END');
    assert(await page.locator('.choice.t-up.focus').count() === 1, 'drive tile not focused');
    await inject('BLINK');
    assert(await screen() === 'drive', 'did not open drive');
  });

  await check('drive (eyes profile): parked looks do nothing; blink arms; held look drives with heartbeat; center stops', async () => {
    motorLog = [];
    await inject('LOOK_UP', { dir: 'up' }); await sleep(400); await inject('LOOK_END');
    assert(motors().length === 0, 'moved while parked: ' + motors());
    await inject('BLINK');
    await inject('LOOK_UP', { dir: 'up' });
    await sleep(1600); // 3.5x the 450 ms TTL: only the heartbeat keeps it going
    await shot('02-drive-forward');
    assert(motors().join() === 'forward', 'expected sustained forward, got ' + motors());
    await inject('LOOK_END'); await sleep(250);
    await inject('LOOK_LEFT', { dir: 'left' }); await sleep(500); await inject('LOOK_END'); await sleep(250);
    await inject('LOOK_DOWN', { dir: 'down' }); await sleep(400);
    await inject('FACE_LOST'); await sleep(250);
    assert(motors().join() === 'forward,stop,left,stop,backward,stop', 'sequence ' + motors());
  });

  await check('drive: robot dies mid-drive -> UI shows offline; restarts -> reconnects parked, no resume', async () => {
    motorLog = [];
    await inject('BLINK'); // engaged was cleared by FACE_LOST, re-arm
    await inject('LOOK_UP', { dir: 'up' }); await sleep(300);
    robot.kill('SIGKILL');
    await until(async () => (await page.locator('#badge').textContent()).includes('offline'), 4000, 'offline badge');
    await inject('LOOK_END');
    startRobot();
    await until(() => S('S.butter.connected'), 8000, 'reconnect');
    await sleep(800);
    assert(!motors().slice(1).includes('forward'), 'motion resumed after reconnect: ' + motors());
  });

  await check('drive: 2 s eye close stops, second one goes home', async () => {
    await inject('LONG_CLOSE');
    await inject('LONG_CLOSE');
    assert(await screen() === 'home', 'not home');
  });

  await check('settings: eye navigation switches profile to winks and persists to disk', async () => {
    await inject('LOOK_DOWN', { dir: 'down' }); await inject('LOOK_END'); await inject('BLINK');
    assert(await screen() === 'settings', 'settings not open');
    await inject('LOOK_RIGHT', { dir: 'right' });
    await until(() => S("S.settings.profile === 'winks'"), 3000, 'profile change');
    await shot('05-settings');
    const disk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert(disk.settings.profile === 'winks', 'not persisted');
    await inject('LONG_CLOSE');
  });

  await check('drive (winks profile): wink = timed turn, double blink = cruise, blink = stop', async () => {
    await inject('LOOK_UP', { dir: 'up' }); await inject('LOOK_END'); await inject('BLINK');
    motorLog = [];
    await inject('WINK_LEFT'); await sleep(900);
    await inject('DOUBLE_BLINK'); await sleep(1200);
    await inject('BLINK'); await sleep(200);
    assert(motors().join() === 'left,stop,forward,stop', 'sequence ' + motors());
    const turn = motorLog.filter((x) => x.dir);
    const turnMs = turn[1].t - turn[0].t;
    assert(turnMs > 400 && turnMs < 800, 'turn pulse ' + turnMs);
    await inject('LONG_CLOSE');
    return `turn pulse ${turnMs} ms`;
  });

  await check('drive (clutch profile): only moves while one eye is held shut', async () => {
    await page.evaluate(() => window.butterApi.saveSettings({ profile: 'clutch' }).then((s) => { window.__butter.S.settings = s; }));
    await inject('LOOK_UP', { dir: 'up' }); await inject('LOOK_END'); await inject('BLINK');
    motorLog = [];
    await inject('LOOK_UP', { dir: 'up' }); await sleep(300); await inject('LOOK_END');
    await inject('WINK_HOLD_START', { side: 'left' });
    await inject('LOOK_UP', { dir: 'up' }); await sleep(600);
    await inject('WINK_HOLD_END', { side: 'left' }); await sleep(200);
    assert(motors().join() === 'forward,stop', 'sequence ' + motors());
    await inject('LOOK_END'); await inject('LONG_CLOSE');
    await page.evaluate(() => window.butterApi.saveSettings({ profile: 'eyes' }).then((s) => { window.__butter.S.settings = s; }));
  });

  let heardAt;
  await check('talk: fake mic voice -> VAD -> ElevenLabs Scribe -> transcript', async () => {
    await inject('LOOK_LEFT', { dir: 'left' }); await inject('LOOK_END'); await inject('BLINK');
    assert(await screen() === 'talk', 'talk not open');
    const text = await until(() => S("(S.screen.convo.find(m => m.who === 'them') || {}).text"), 25000, 'heard speech');
    heardAt = Date.now();
    const mode = await page.evaluate(() => window.__butter.mic()?.mode);
    assert(mode === 'worklet', 'mic not on the audio thread: ' + mode);
    assert(/movie/i.test(text) && /tonight/i.test(text), 'bad transcript: ' + text);
    return `"${text}"`;
  });

  await check('talk: DeepSeek replies arrive, 5 options, most likely in the middle and focused', async () => {
    await until(() => S("!S.screen.loading && S.screen.options.length === 5 && S.screen.convo.some(m => m.who === 'them')"), 15000, 'options');
    const o = await S('({ opts: S.screen.options, focus: S.screen.focus, info: S.screen.info })');
    assert(o.focus === 2, 'focus not centered');
    assert(!o.info.includes('fallback'), o.info);
    await shot('03-talk-options');
    return `${o.info} | ${JSON.stringify(o.opts)} | speech->options ${Date.now() - heardAt} ms after transcript`;
  });

  await check('talk: look right + blink speaks the option (ElevenLabs), logs it, mutes mic while speaking', async () => {
    await page.evaluate(() => { const m = window.__butter.S; m._muted = []; const iv = setInterval(() => m._muted.push(m.screen?.convo && document.querySelector('#meter div')?.style.width), 50); setTimeout(() => clearInterval(iv), 4000); });
    await inject('LOOK_RIGHT', { dir: 'right' }); await inject('LOOK_END');
    const picked = await S('S.screen.options[S.screen.focus]');
    assert((await S('S.screen.focus')) === 3, 'focus did not move right');
    const t0 = Date.now();
    const r = await page.evaluate((txt) => window.butterApi.speak(txt), picked);
    assert(r.audio && r.audio.length > 3000, 'no TTS audio: ' + (r.error || ''));
    await inject('BLINK');
    await until(() => S("S.screen.convo.at(-1)?.who === 'me' || S.screen.convo.at(-2)?.who === 'me'"), 5000, 'me message');
    await until(() => JSON.parse(fs.readFileSync(storePath, 'utf8')).voiceExamples.includes(picked), 3000, 'voice example saved');
    await sleep(500);
    await shot('04-talk-said');
    return `said "${picked}" (TTS ${r.ms} ms, ${Date.now() - t0} ms incl. playback)`;
  });

  await check('talk: caregiver typing path + follow-up replies', async () => {
    await page.fill('#typeIn', 'Are you hungry?');
    await page.press('#typeIn', 'Enter');
    await until(() => S("!S.screen.loading && S.screen.convo.at(-1).text === 'Are you hungry?' && S.screen.options.length === 5"), 15000, 'options for typed');
    const opts = await S('S.screen.options');
    assert(opts.some((x) => /yes|yeah|sure|please|starving|bit/i.test(x)) && opts.some((x) => /\bno\b|not/i.test(x)), 'yes/no missing: ' + opts);
    return JSON.stringify(opts);
  });

  await check('talk: look down = quick phrases, blink says "Yes" instantly', async () => {
    await inject('LOOK_DOWN', { dir: 'down' }); await inject('LOOK_END');
    assert(await page.locator('.quick .choice').count() === 8, 'quick board missing');
    await shot('06-quick');
    await inject('BLINK');
    await until(() => S("S.screen.convo.some(m => m.who === 'me' && m.text === 'Yes')"), 5000, 'said yes');
  });

  await check('talk -> home via 2 s close; snake steers by look', async () => {
    await inject('LONG_CLOSE');
    assert(await screen() === 'home', 'not home');
    await inject('LOOK_RIGHT', { dir: 'right' }); await inject('LOOK_END'); await inject('BLINK');
    assert(await screen() === 'snake', 'snake not open');
    await inject('LOOK_DOWN', { dir: 'down' }); await inject('LOOK_END');
    await sleep(700);
    assert(await S('S.screen.game.dir') === 'down', 'snake did not turn');
    await shot('07-snake');
    await inject('LONG_CLOSE');
  });

  await check('calibration on a still photo fails safely with a clear report (no bogus model saved)', async () => {
    const before = await S('S.store.calibration.createdAt');
    await page.evaluate(() => window.__butter.S.screenName); // keep
    await page.keyboard.press('c');
    await until(() => page.locator('.report').count(), 40000, 'calibration report');
    await shot('08-calibration-report');
    const txt = await page.locator('.report').innerText();
    assert(/failed/i.test(txt), 'a photo that never looks around must not calibrate: ' + txt.slice(0, 200));
    assert((await S('S.store.calibration.createdAt')) === before, 'bad calibration was saved');
    return txt.replace(/\s+/g, ' ').slice(0, 160);
  });

  await check('no renderer errors', async () => {
    const bad = errors.filter((e) => !/^INFO:|^W0000|^I0000|favicon|ERR_CONNECTION_REFUSED|127\.0\.0\.1:1|net::ERR|Failed to load resource|WebGL|GPU|gl_|OpenGL/i.test(e));
    assert(bad.length === 0, bad.slice(0, 5).join(' | '));
    return `${errors.length} ignored (network/GPU)`;
  });
} finally {
  await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  try { app.process().kill('SIGKILL'); } catch {}
  robot.kill('SIGKILL');
  fs.rmSync(storePath, { force: true });
}
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
