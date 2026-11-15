// Butter renderer: eyelid gestures (or the keyboard) -> one input bus -> the current screen.
// What each gesture does lives in mapping.js (provisional, one table).
import { FaceTracker } from './face-tracker.js';
import { GestureEngine } from './gesture-engine.js';
import { quickCalibration, QUICK as QCAL } from './calibration.js';
import { MicListener } from './audio.js';
import { centerOut } from '../lib/llm.js';
import { Snake } from './snake.js';
import { ICONS } from './icons.js';
import { actionFor, hints, setNav, browMenus } from './mapping.js';

const api = window.butterApi;
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  store: null, settings: null, screen: null, screenName: '',
  engine: null, tracker: null, calibrating: false,
  butter: { connected: false },
  log: [], lastFrame: null, frames: 0, faceFrames: 0,
  status: { multiple: false, lock: 'searching', close: false, glare: false, drift: false },
  control: true, // eye control on/off (eyebrow hold toggles it); off = blink freely, nothing fires
};
let mic = null;
window.__butter = { S, mic: () => mic, screens: null, go: (n) => go(n), inject: (type, extra = {}) => dispatch({ type, t: performance.now(), src: 'test', ...extra }) };

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const flash = document.createElement('div'); flash.className = 'flash'; document.body.append(flash);
// ---- tones: every recognised input makes a sound, so you know it landed without reading the screen
let actx = null;
function beep(freq = 880, ms = 250, delay = 0, vol = 0.2) {
  try {
    actx ??= new AudioContext();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime + delay / 1000, o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + ms / 1000);
  } catch {}
}
const TONES = {
  nav: () => beep(700, 70),                                   // moved to another option
  select: () => { beep(880, 90); beep(1320, 150, 90); },      // chose / activated something
  hold: () => beep(600, 160),                                 // one-eye hold registered
  back: () => { beep(520, 120); beep(390, 200, 120); },       // exit / home
  stop: () => beep(300, 180),                                 // quick stop
  on: () => { beep(660, 110); beep(990, 180, 110); },         // eye control on
  off: () => { beep(990, 110); beep(660, 180, 110); },        // eye control off
};
const TONE_FOR = { BROW_START: 'hold', BROW_TAP: 'nav', WINK_LEFT: 'nav', WINK_RIGHT: 'nav', BROW_SELECT: 'select', DOUBLE_BLINK: 'select', HOLD_LEFT: 'hold', HOLD_RIGHT: 'hold', BOTH_CLOSED: 'back', LONG_BLINK: 'stop' };

function pulse() { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }

const LABEL = { BROW_TAP: 'Eyebrow raise', BROW_SELECT: 'Eyebrow hold', BROW_HOLD: 'Eyebrows', DOUBLE_BLINK: 'Double blink', WINK_LEFT: 'Wink left', WINK_RIGHT: 'Wink right', HOLD_LEFT: 'Hold left', HOLD_RIGHT: 'Hold right', BOTH_CLOSED: 'Eyes closed' };

// ============================================================ input bus
function dispatch(ev) {
  if (S.calibrating && ev.src !== 'test') return;
  if (ev.type === 'BROW_HOLD' && S.screenName === 'drive' && lookDrive() && ev.src !== 'key') return; // eyebrows are the throttle there
  // ...so in that mode a slow double blink is what turns eye control off and on (nothing else uses it there)
  if (ev.type === 'DOUBLE_BLINK' && S.screenName === 'drive' && lookDrive()) { setControl(!S.control); TONES[S.control ? 'on' : 'off'](); pulse(); return; }
  if (ev.type === 'BROW_HOLD' && S.screenName !== 'practice') { setControl(!S.control); TONES[S.control ? 'on' : 'off'](); pulse(); return; }
  // eye control off: nothing fires except the safety stop and status events
  if (!S.control && ev.src !== 'key' && !['BOTH_CLOSED', 'LONG_BLINK', 'FACE_LOST', 'FACE_FOUND', 'CALIBRATION_DRIFT'].includes(ev.type)) return;
  S.log.push({ type: ev.type, t: Math.round(ev.t), screen: S.screenName });
  if (TONE_FOR[ev.type] && !(ev.type === 'LONG_BLINK' && S.screenName !== 'drive')) TONES[TONE_FOR[ev.type]]();
  if (S.log.length > 300) S.log.shift();
  if (LABEL[ev.type]) { pulse(); const g = $('#lastGesture'); if (g) { g.textContent = LABEL[ev.type]; g.classList.remove('show'); void g.offsetWidth; g.classList.add('show'); } }
  if (ev.type === 'CALIBRATION_DRIFT') { S.status.drift = true; paintPills(); toast('Your eyes look different from calibration (glasses on or off?). Recalibrate in Settings.', 5000); return; }
  if (S.screen?.on?.(ev)) return;
  if (ev.type === 'BOTH_CLOSED' && !['home', 'calibrate', 'practice'].includes(S.screenName)) go('home');
}

const lookDrive = () => (S.settings.driveMode || 'look') === 'look';
function setControl(on) {
  S.control = on;
  if (!on && S.screenName === 'drive') screens.drive.stop();
  paintPills();
  if (S.screenName === 'drive') screens.drive.paint();
  toast(on ? 'Eye control on' : S.screenName === 'drive' && lookDrive() ? 'Eye control off. Slow double blink to turn it back on.' : 'Eye control off: blink freely. Raise your eyebrows 4 s to turn it back on.', 3200);
}

// keyboard = caregiver / demo backup, same gestures
const KEYMAP = { ArrowUp: 'BROW_TAP', ArrowDown: 'BROW_SELECT', s: 'LONG_BLINK', q: 'WINK_LEFT', ArrowLeft: 'WINK_LEFT', e: 'WINK_RIGHT', ArrowRight: 'WINK_RIGHT', ' ': 'DOUBLE_BLINK', Escape: 'BOTH_CLOSED' };
const HOLDKEYS = { a: 'left', d: 'right' };
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.repeat) return;
  const t = performance.now();
  if (e.key === ' ' && S.screenName === 'talk') return; // in Talk the spacebar is push-to-listen
  if (KEYMAP[e.key]) { e.preventDefault(); dispatch({ type: KEYMAP[e.key], t, src: 'key' }); return; }
  if (HOLDKEYS[e.key]) { dispatch({ type: 'HOLD_' + HOLDKEYS[e.key].toUpperCase(), side: HOLDKEYS[e.key], t, src: 'key' }); return; }
  if (e.key === 'c') go('calibrate');
  if (e.key === 'b') dispatch({ type: 'BROW_HOLD', t, src: 'key' });
});
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.repeat || S.screenName !== 'drive') return;
  const t = performance.now(), look = { j: 'left', k: 'center', l: 'right' }[e.key];
  if (look) dispatch({ type: 'LOOK', dir: look, t, src: 'key' });
  if (e.key === 'w') dispatch({ type: 'BROW_START', look: screens.drive.look, t, src: 'key' });
});
addEventListener('keyup', (e) => { if (e.key === 'w' && S.screenName === 'drive') dispatch({ type: 'BROW_END', t: performance.now(), src: 'key' }); });
addEventListener('keyup', (e) => {
  if (HOLDKEYS[e.key] && !e.target.matches('input, textarea')) dispatch({ type: 'HOLD_END', side: HOLDKEYS[e.key], t: performance.now(), src: 'key' });
});

// ============================================================ screens
const screens = {};
window.__butter.screens = screens;
function go(name, arg) {
  S.screen?.exit?.();
  S.screenName = name;
  S.screen = screens[name];
  main.innerHTML = '';
  syncNav();
  S.screen.enter?.(arg);
}
// menus are moved through by eyebrow raise or by winks (Settings > Navigate with)
function syncNav() { setNav(S.settings?.navWith); if (S.engine) S.engine.browNav = browMenus(S.screenName); }
const enabled = () => S.engine?.p?.enabled || {};
const hintRow = (screen, labels) => `<div class="hint">${hints(screen, labels, enabled()).map(([g, a]) => `<span><kbd>${esc(g)}</kbd>${esc(a)}</span>`).join('')}</div>`;

// ---------------------------------------------------------------- home
screens.home = {
  order: ['up', 'right', 'down', 'left'],
  i: 0,
  tiles: {
    up: { name: 'Drive', sub: 'Move Butter', ico: ICONS.car, to: 'drive' },
    right: { name: 'Play', sub: 'Snake', ico: ICONS.play, to: 'snake' },
    down: { name: 'Settings', sub: 'Calibrate, voice', ico: ICONS.settings, to: 'settings' },
    left: { name: 'Talk', sub: 'Say it with your eyes', ico: ICONS.talk, to: 'talk' },
  },
  enter() { this.render(); },
  render() {
    const focus = this.order[this.i];
    main.innerHTML = `<section class="screen">
      <div><h1>What would you like to do?</h1></div>
      <div class="cross">
        ${Object.entries(this.tiles).map(([d, t]) => `<div class="choice t-${d} ${focus === d ? 'focus' : ''}" data-dir="${d}">
          <div class="ico">${t.ico}</div>${t.name}<small>${t.sub}</small><span class="cue">Double blink to open</span></div>`).join('')}
        <div class="center"><div class="eye"><div></div></div>${browMenus("home") ? "Raise your eyebrows to move," : "Wink to move around,"}<br>double blink to open</div>
      </div>
      ${hintRow('home', { prev: 'previous', next: 'next', open: 'open', back: 'stop' })}
    </section>`;
    main.querySelectorAll('.cross .choice').forEach((el) => el.addEventListener('click', () => go(this.tiles[el.dataset.dir].to)));
  },
  on(ev) {
    const a = actionFor('home', ev.type);
    if (a === 'next' || a === 'prev') { this.i = (this.i + (a === 'next' ? 1 : 3)) % 4; this.render(); return true; }
    if (a === 'open') { go(this.tiles[this.order[this.i]].to); return true; }
    return false;
  },
};

// ---------------------------------------------------------------- drive
screens.drive = {
  enter() {
    this.dir = 'stop'; this.cruise = false; this.confirmUntil = 0; this.look = 'center';
    if (S.engine) { S.engine.lookNav = lookDrive(); if (lookDrive()) S.engine.recentreGaze(performance.now()); }
    // keep the readings from this drive so steering can be tuned on real eyes (saved to app/debug)
    this.rec = { frames: [], events: [], t0: performance.now() };
    this.off = S.tracker?.onFrame((f, t) => {
      if (this.rec.frames.length < 5400) this.rec.frames.push(f.face ? { t: Math.round(t - this.rec.t0), g: f.raw.gaze, y: f.raw.yaw, b: f.raw.brow, gz: S.engine?.state.gaze, look: S.engine?.state.look, dir: this.dir } : { t: Math.round(t - this.rec.t0), face: false });
    });
    this.render();
  },
  exit() { this.set('stop'); clearTimeout(this.timer); if (S.engine) S.engine.lookNav = false; this.off?.(); api.saveDebug('drive', { gazeCal: S.engine?.cal?.gaze, browCal: S.engine?.cal?.brow, ...this.rec }); },
  set(dir) { if (dir === this.dir) return; this.dir = dir; api.drive(dir); this.paint(); },
  nudge(dir) {
    clearTimeout(this.timer);
    this.dir = dir; api.pulse(dir, 550); this.paint();
    this.timer = setTimeout(() => { this.dir = 'stop'; if (this.cruise) this.set('forward'); else this.paint(); }, 600);
  },
  stop(msg) { clearTimeout(this.timer); this.cruise = false; this.confirmUntil = 0; this.set('stop'); this.paint(); if (msg) toast(msg); },
  render() {
    const cam = S.settings.butterCameraUrl;
    const canBrow = enabled().BROW_HOLD !== false && !!S.engine?.cal?.brow;
    const feed = `<div class="feed" id="feed">
        <img id="feedImg" src="${esc(cam)}" alt="" />
        <div class="offline" id="feedOff" hidden>Butter's camera is not reachable<br><small>${esc(cam)}</small></div>
        <div class="badge" id="badge"></div>
        ${lookDrive() ? `<div class="looks" id="looks">
          <div data-l="left">${ICONS.left}<span>Left</span></div><div data-l="center">${ICONS.up}<span>Forward</span></div><div data-l="right">${ICONS.right}<span>Right</span></div>
        </div>
        <div class="drivehint"><b>Look</b> at a direction, <b>raise eyebrows</b> to move, relax to stop. <b>Slow double blink</b>: eye control off / on. <b>Both eyes 3 s</b>: exit. <span id="ctlState"></span></div>` : ''}
      </div>`;
    main.innerHTML = lookDrive() ? `<section class="screen drivescreen wide">${feed}</section>` : `<section class="screen drivescreen">
      <aside class="sidebar">
        <div class="sidecard" id="ctlCard">
          <small>Eye control</small><b id="ctlState"></b>
          <span>${canBrow ? 'Raise eyebrows 4 s to switch' : 'Press B to switch'}</span>
        </div>
        <div class="sidecard dim">
          <small>Mode</small><b>Blink Drive</b>
          <span>Change in Settings</span>
        </div>
        <div class="dpad" id="dpad">
          <div></div><div data-d="forward">${ICONS.up}</div><div></div>
          <div data-d="left">${ICONS.left}</div><div class="mid" id="mid"></div><div data-d="right">${ICONS.right}</div>
          <div></div><div data-d="backward">${ICONS.down}</div><div></div>
        </div>
        <div class="legend">
          <b>Slow double blink</b> twice: go<br>
          <b>Double blink</b> or <b>long blink</b>: stop<br>
          <b>Close left eye</b>: turn right<br>
          <b>Close right eye</b>: turn left<br>
          <b>Both eyes 3 s</b>: stop, exit
        </div>
      </aside>
      ${feed}
    </section>`;
    const img = $('#feedImg');
    img.onerror = () => { img.hidden = true; $('#feedOff').hidden = false; };
    this.paint();
  },
  paint() {
    const b = $('#badge'); if (!b) return;
    const names = { forward: 'Moving forward', backward: 'Backing up', left: 'Turning left', right: 'Turning right' };
    const moving = this.dir !== 'stop';
    const confirming = performance.now() < this.confirmUntil;
    b.className = 'badge ' + (!S.butter.connected ? 'offline' : moving ? 'moving' : confirming ? 'ready' : 'parked');
    b.textContent = !S.butter.connected ? 'Butter offline' : !S.control ? 'Eye control off' : moving ? names[this.dir] : confirming ? 'Double blink again to go' : 'Parked';
    $('#feed').classList.toggle('driving', moving);
    main.querySelectorAll('#dpad [data-d]').forEach((el) => el.classList.toggle('on', el.dataset.d === this.dir));
    const mid = $('#mid'); if (mid) mid.textContent = this.cruise ? 'cruise' : '';
    const want = { left: 'left', right: 'right', forward: 'center' }[this.dir];
    main.querySelectorAll('#looks [data-l]').forEach((el) => { el.classList.toggle('look', el.dataset.l === this.look); el.classList.toggle('on', el.dataset.l === want); });
    const cs = $('#ctlState'); if (cs) { cs.textContent = lookDrive() ? (S.control ? '' : 'Eye control is OFF: slow double blink to turn on') : S.control ? 'On' : 'Off'; $('#ctlCard')?.classList.toggle('off', !S.control); }
  },
  on(ev) {
    if (ev.type === 'FACE_LOST') { this.stop('Face lost: stopped'); return true; }
    if (ev.type === 'LONG_BLINK') { // quick stop: stopping must be faster than starting
      if (this.dir !== 'stop' || this.cruise) { this.stop('Stopped'); this.quickStopAt = performance.now(); }
      return true;
    }
    if (ev.type === 'BOTH_CLOSED') {
      if (performance.now() - (this.quickStopAt || 0) < 3100) { this.quickStopAt = 0; return true; } // same eye-close that already stopped it
      if (this.dir !== 'stop' || this.cruise || performance.now() < this.confirmUntil) this.stop('Stopped');
      else go('home');
      return true;
    }
    if (this.rec && this.rec.events.length < 2000) this.rec.events.push({ t: Math.round(performance.now() - this.rec.t0), type: ev.type, d: ev.dir || ev.look });
    if (lookDrive()) { // eyes pick the direction, eyebrows are the throttle (release = stop)
      if (ev.type === 'LOOK') { this.look = ev.dir; this.paint(); }
      else if (ev.type === 'BROW_START') { this.look = ev.look || this.look; this.set({ left: 'left', right: 'right', center: 'forward' }[this.look]); }
      else if (ev.type === 'BROW_END') this.set('stop');
      return true;
    }
    if (ev.type === 'HOLD_END') { if (!this.cruise && (this.dir === 'left' || this.dir === 'right')) this.set('stop'); else if (this.cruise) this.set('forward'); return true; }
    const a = actionFor('drive', ev.type);
    if (a === 'goStop') {
      if (this.cruise || this.dir !== 'stop') { this.stop(); return true; }
      if (performance.now() < this.confirmUntil) { this.confirmUntil = 0; this.cruise = true; this.set('forward'); return true; }
      this.confirmUntil = performance.now() + 3000; // costly action: confirm
      this.paint(); setTimeout(() => this.paint(), 3050);
      return true;
    }
    if (a === 'nudgeLeft' || a === 'nudgeRight') { this.nudge(a === 'nudgeLeft' ? 'left' : 'right'); return true; }
    if (a === 'spinLeft' || a === 'spinRight') { clearTimeout(this.timer); this.set(a === 'spinLeft' ? 'left' : 'right'); return true; }
    return true;
  },
};

// ---------------------------------------------------------------- talk
const QUICK = [
  { t: 'Yes' }, { t: 'No' }, { t: 'Thank you' }, { t: 'I love you' },
  { t: 'I need help', urgent: true }, { t: "I'm in pain", urgent: true }, { t: 'Water, please' }, { t: 'Please wait, I am answering with my eyes' },
];
screens.talk = {
  convo: [], options: [], focus: 1, quick: false, qfocus: 0, reqId: 0, loading: false, info: '',
  enter() { this.render(); this.startMic(); if (!this.options.length) this.refresh(); },
  exit() { listenStop(); if (mic) mic.muted = true; },
  async startMic() {
    if (mic) { mic.muted = true; return; } // only listens while the spacebar is held
    if (!S.store.keys.elevenlabs) { this.info = 'Speech-to-text off (no ElevenLabs key). Type below instead.'; this.paintBar(); return; }
    mic = new MicListener({
      onLevel: (lvl, speaking) => { const m = $('#meter div'); if (m) { m.style.width = Math.min(100, lvl * 900) + '%'; m.style.background = speaking ? 'var(--lamp-deep)' : 'var(--go)'; } },
      onUtterance: async (wav) => {
        this.info = 'Transcribing…'; this.paintBar();
        const r = await api.transcribe(wav);
        if (r.text && !/^\(.*\)$/.test(r.text)) { this.heard(r.text); this.info = `Heard in ${r.ms} ms`; }
        else this.info = r.error ? 'Transcription error: ' + r.error : 'Didn\'t catch that';
        this.paintBar();
      },
    });
    mic.muted = true; // background voices are never transcribed: the spacebar decides what counts
    try { await mic.start(); } catch (e) { this.info = 'Microphone blocked: ' + e.message; mic = null; this.paintBar(); }
  },
  // new speech refreshes the replies but never closes the quick-phrase board the user just opened
  heard(text) { this.convo.push({ who: 'them', text, t: Date.now() }); this.render(); this.refresh(); },
  async refresh() {
    const id = ++this.reqId;
    const choosing = performance.now() - (this.lastNav || 0) < 4000 && this.options.length;
    if (!choosing) { this.loading = true; this.paintOptions(); }
    const r = await api.suggest(this.convo);
    if (id !== this.reqId) return;
    // never swap the replies out from under someone who is in the middle of choosing
    while (performance.now() - (this.lastNav || 0) < 4000) { await sleep(300); if (id !== this.reqId) return; }
    this.loading = false;
    this.options = centerOut(r.replies);
    this.focus = Math.floor(this.options.length / 2);
    this.info = r.error ? `Using fallback replies (${r.error.slice(0, 60)})` : `Suggested in ${(r.ms / 1000).toFixed(1)} s`;
    this.paintOptions(); this.paintBar();
  },
  async say(text) {
    this.convo.push({ who: 'me', text, t: Date.now() });
    api.addVoiceExample(text);
    this.render();
    if (mic) mic.muted = true;
    const r = await api.speak(text);
    await playAudio(r, text);

    this.refresh();
  },
  render() {
    main.innerHTML = `<section class="screen"><div class="talk">
      <div class="convo" id="convo">${this.convo.length ? '' : '<div class="msg sys">Hold the spacebar while someone speaks to you. Let go when they finish, and replies appear below.</div>'}
        ${this.convo.map((m) => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('')}</div>
      <div id="opts"></div>
      <div class="talkbar"><span class="ico">${ICONS.mic}</span><div class="meter" id="meter"><div></div></div><span id="info"></span>
        <input id="typeIn" placeholder="Caregiver: type what was said and press Enter" /></div>
      ${hintRow('talk', { cycle: 'next option', prev: 'left', next: 'right', say: 'say it', quickPhrases: 'quick phrases', newReplies: 'new replies', back: 'home' })}
    </div></section>`;
    const c = $('#convo'); c.scrollTop = c.scrollHeight;
    $('#typeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { this.heard(e.target.value.trim()); e.target.value = ''; } });
    this.paintOptions(); this.paintBar();
  },
  paintBar() { const i = $('#info'); if (i) i.textContent = this.info; },
  paintOptions() {
    const el = $('#opts'); if (!el) return;
    if (this.quick) {
      el.innerHTML = `<div class="quick">${QUICK.map((q, i) => `<div class="choice ${q.urgent ? 'urgent' : ''} ${i === this.qfocus ? 'focus' : ''}">${esc(q.t)}</div>`).join('')}</div>`;
      return;
    }
    const list = this.loading && !this.options.length ? ['…', '…', '…'] : this.options;
    el.innerHTML = `<div class="options">${list.map((o, i) =>
      `<div class="choice ${i === 1 ? 'best' : ''} ${i === this.focus ? 'focus' : ''} ${this.loading ? 'loading' : ''}" data-i="${i}">${esc(o)}</div>`).join('')}</div>`;
    el.querySelectorAll('.choice').forEach((o) => o.addEventListener('click', () => { if (this.options[+o.dataset.i]) this.say(this.options[+o.dataset.i]); }));
  },
  on(ev) {
    const a = actionFor('talk', ev.type);
    if (a === 'cycle' || a === 'prev' || a === 'next') this.lastNav = performance.now();
    if (a === 'cycle') { // eyebrows: step through the options, wrapping round
      if (this.quick) this.qfocus = (this.qfocus + 1) % QUICK.length;
      else if (this.options.length) this.focus = (this.focus + 1) % this.options.length;
      this.paintOptions(); return true;
    }
    if (a === 'prev' || a === 'next') {
      const d = a === 'next' ? 1 : -1;
      if (this.quick) this.qfocus = (this.qfocus + d + QUICK.length) % QUICK.length;
      else this.focus = Math.max(0, Math.min(this.options.length - 1, this.focus + d));
      this.paintOptions(); return true;
    }
    if (a === 'say') {
      // replies on screen can always be said, even while newer ones are being fetched (a busy room
      // keeps the mic refreshing; the person must never be locked out of answering)
      const text = this.quick ? QUICK[this.qfocus].t : this.options[this.focus];
      if (text) { this.quick = false; this.say(text); }
      return true;
    }
    if (a === 'quickPhrases') { this.quick = !this.quick; this.qfocus = 0; this.paintOptions(); return true; }
    if (a === 'newReplies') { this.quick = false; this.refresh(); return true; }
    return ev.type === 'HOLD_END';
  },
};

let currentAudio = null;
async function playAudio(r, text) {
  if (r && r.playLocal === false) return;
  if (r?.audio) {
    const url = URL.createObjectURL(new Blob([r.audio], { type: 'audio/mpeg' }));
    currentAudio?.pause();
    currentAudio = new Audio(url);
    await new Promise((res) => { currentAudio.onended = res; currentAudio.onerror = res; currentAudio.play().catch(res); });
    URL.revokeObjectURL(url);
  } else {
    await new Promise((res) => { const u = new SpeechSynthesisUtterance(text); u.onend = res; u.onerror = res; speechSynthesis.speak(u); setTimeout(res, 8000); });
  }
}

// ---------------------------------------------------------------- snake
screens.snake = {
  enter() {
    main.innerHTML = `<section class="screen snakefull"><canvas id="snake"></canvas><div class="snakescore" id="score">Score 0</div>
      <div class="snakehint">Wink left / right to turn. Double blink: pause. Both eyes 3 s: home.</div></section>`;
    // fill the whole window with square cells
    const box = main.getBoundingClientRect(), cell = 46;
    const cols = Math.max(12, Math.floor((box.width - 8) / cell)), rows = Math.max(9, Math.floor((box.height - 8) / cell));
    const cv = $('#snake'); cv.width = cols * cell; cv.height = rows * cell;
    this.game = new Snake(cv, (s) => { $('#score').textContent = `Score ${s}`; }, { cols, rows });
    this.game.start();
    this.rec = { t0: performance.now(), events: [], frames: [] }; // winks are being tuned on Snake: keep the readings
    this.off = S.tracker?.onFrame((f, t) => { if (this.rec.frames.length < 5400) this.rec.frames.push(f.face ? { t, face: true, raw: f.raw } : { t, face: false }); });
  },
  exit() { this.game?.stop(); this.off?.(); api.saveDebug('snake', { cal: S.engine?.cal?.params, ...this.rec }); },
  on(ev) {
    if (this.rec.events.length < 3000) this.rec.events.push({ t: Math.round(ev.t), type: ev.type });
    const a = actionFor('snake', ev.type);
    const L = { up: 'left', left: 'down', down: 'right', right: 'up' }, R = { up: 'right', right: 'down', down: 'left', left: 'up' };
    if (a === 'turnLeft') { this.game.turn(L[this.game.dir]); return true; }
    if (a === 'turnRight') { this.game.turn(R[this.game.dir]); return true; }
    if (a === 'pause') { this.game.toggle(); return true; }
    return false;
  },
};

// ---------------------------------------------------------------- dev: watch raw face readings live
// For trying out new signals (frown / squint) before they control anything. Click "Dev" in the top bar.
const DEV = [
  { k: 'browDown', label: 'Frown (eyebrows down / together)', color: '#d1495b' },
  { k: 'eyeSquint', label: 'Eye squint', color: '#e09f3e' },
  { k: 'cheekSquint', label: 'Cheek squint', color: '#8d6a9f' },
  { k: 'noseSneer', label: 'Nose scrunch', color: '#577590' },
  { k: 'browUp', label: 'Eyebrows up (for comparison)', color: '#2a9d8f' },
  { k: 'blink', label: 'Eyes closed (for comparison)', color: '#555' },
];
screens.dev = {
  enter() {
    this.hist = []; this.rest = null; this.peak = {}; this.t0 = performance.now(); this.count = {}; this.active = {};
    main.innerHTML = `<section class="screen"><div><h1>Dev: face readings</h1>
      <h2>Keep a neutral face for 2 seconds, then try a frown or a squint. A row turns green when it rises clearly above your neutral level.</h2></div>
      <div class="devrows">${DEV.map((d) => `<div class="devrow" data-k="${d.k}"><div class="devname"><b>${d.label}</b><small></small></div><canvas width="900" height="70"></canvas><div class="devnum"></div></div>`).join('')}</div>
      <div class="hint"><span><kbd>R</kbd>reset neutral</span><span><kbd>Esc</kbd>home</span><span>Readings are saved to app/debug/dev.json when you leave</span></div></section>`;
    this.off = S.tracker?.onFrame((f, t) => this.frame(f, t));
    this.key = (e) => { if (e.key === 'r') { this.rest = null; this.t0 = performance.now(); this.hist = []; this.peak = {}; this.count = {}; } };
    addEventListener('keydown', this.key);
  },
  exit() { this.off?.(); removeEventListener('keydown', this.key); api.saveDebug('dev', { rest: this.rest, peak: this.peak, count: this.count, frames: this.hist }); },
  frame(f, t) {
    if (!f.face || !f.dev) return;
    this.hist.push({ t: Math.round(t - this.t0), ...Object.fromEntries(DEV.map((d) => [d.k, +f.dev[d.k].toFixed(3)])) });
    if (this.hist.length > 9000) this.hist.shift();
    if (!this.rest && t - this.t0 > 2000) { // neutral level and its normal wobble, from the first 2 s
      this.rest = {};
      for (const d of DEV) { const v = this.hist.map((h) => h[d.k]).sort((a, b) => a - b); this.rest[d.k] = { m: v[Math.floor(v.length / 2)], hi: v[Math.floor(v.length * 0.95)] }; }
    }
    const recent = this.hist.slice(-300);
    for (const d of DEV) {
      const row = main.querySelector(`.devrow[data-k="${d.k}"]`); if (!row) return;
      const v = f.dev[d.k], r = this.rest?.[d.k];
      this.peak[d.k] = Math.max(this.peak[d.k] || 0, v);
      // "clearly above neutral": more than 0.15 over the neutral level and over its normal wobble
      const thr = r ? Math.max(r.m + 0.15, r.hi + 0.1) : null, on = thr !== null && v > thr;
      if (on && !this.active[d.k]) this.count[d.k] = (this.count[d.k] || 0) + 1;
      this.active[d.k] = on;
      row.classList.toggle('on', on);
      row.querySelector('.devnum').textContent = v.toFixed(2);
      row.querySelector('small').textContent = r ? `neutral ${r.m.toFixed(2)} · peak ${this.peak[d.k].toFixed(2)} · seen ${this.count[d.k] || 0}x` : 'measuring neutral…';
      const cv = row.querySelector('canvas'), ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (thr !== null) { ctx.strokeStyle = '#bbb'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(0, cv.height * (1 - thr)); ctx.lineTo(cv.width, cv.height * (1 - thr)); ctx.stroke(); ctx.setLineDash([]); }
      ctx.strokeStyle = d.color; ctx.lineWidth = 3; ctx.beginPath();
      recent.forEach((h, i) => { const x = (i / 299) * cv.width, y = cv.height * (1 - Math.min(1, h[d.k])); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }
  },
  on(ev) { return ev.type !== 'BOTH_CLOSED'; }, // gestures do nothing here, except closing both eyes to leave
};
document.getElementById('devBtn')?.addEventListener('click', () => go(S.screenName === 'dev' ? 'home' : 'dev'));

// ---------------------------------------------------------------- settings
screens.settings = {
  row: 0,
  rows() {
    const s = S.settings;
    return [
      { k: 'driveSpeed', label: 'Drive speed', vals: [{ v: 0.05, l: '5%' }, { v: 0.1, l: '10%' }, { v: 0.2, l: '20%' }] },
      { k: 'driveMode', label: 'Drive with', vals: [{ v: 'look', l: 'Look Drive (look + eyebrows)' }, { v: 'blink', l: 'Blink Drive' }] },
      { k: 'navWith', label: 'Navigate with', vals: [{ v: 'brow', l: 'Eyebrows (quick raise = next)' }, { v: 'wink', l: 'Winks (left / right)' }] },
      { k: 'voiceOut', label: 'Voice comes out of', vals: [{ v: 'laptop', l: 'Laptop' }, { v: 'butter', l: 'Butter' }, { v: 'both', l: 'Both' }] },
      { k: 'recal', label: 'Recalibrate eyes', action: () => go('calibrate') },
      { k: 'practice', label: 'Practice gestures', action: () => go('practice') },
      { k: 'clearTalk', label: 'Clear conversation and learned phrases', action: async () => { await api.clearTalk(); screens.talk.convo = []; screens.talk.options = []; toast('Conversation cleared'); } },
      { k: 'back', label: 'Back to home', action: () => go('home') },
      { k: 'butterUrl', label: 'Butter address', text: true },
      { k: 'butterCameraUrl', label: 'Butter camera URL', text: true },
      { k: 'voiceId', label: 'ElevenLabs voice ID', text: true, ph: 'blank = default voice; paste a cloned voice ID' },
      { k: 'persona', label: 'About me (for the AI)', area: true, ph: 'Name, family, how I talk, things I care about…' },
    ].map((r) => ({ ...r, cur: s[r.k] }));
  },
  enter() { this.row = 0; this.render(); },
  render() {
    const rows = this.rows();
    main.innerHTML = `<section class="screen"><h1>Settings</h1><div class="settings">${rows.map((r, i) => `
      <div class="srow ${i === this.row ? 'focus' : ''}" data-i="${i}"><div>${r.label}</div><div>
      ${r.vals ? `<div class="vals">${r.vals.map((v) => `<span class="${v.v === r.cur ? 'sel' : ''}" data-v="${v.v}">${v.l}</span>`).join('')}</div>` : ''}
      ${r.action ? '<span class="act">Double blink to do it</span>' : ''}
      ${r.text ? `<input data-k="${r.k}" value="${esc(r.cur)}" placeholder="${esc(r.ph || '')}" />` : ''}
      ${r.area ? `<textarea data-k="${r.k}" placeholder="${esc(r.ph || '')}">${esc(r.cur)}</textarea>` : ''}
      </div></div>`).join('')}
      </div>${hintRow('settings', { prev: 'up', next: 'next row', activate: 'change / do it', back: 'home' })}</section>`;
    main.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.k]: el.value.trim() })));
    main.querySelectorAll('.srow[data-i]').forEach((el) => el.querySelectorAll('[data-v]').forEach((sp) => sp.addEventListener('click', () => {
      const r = rows[+el.dataset.i]; save({ [r.k]: r.vals.find((x) => String(x.v) === sp.dataset.v).v }).then(() => this.render());
    })));
    main.querySelectorAll('.srow[data-i]').forEach((el) => el.addEventListener('click', () => { const r = rows[+el.dataset.i]; if (r?.action) r.action(); }));
  },
  on(ev) {
    const rows = this.rows().filter((r) => !r.text && !r.area);
    const a = actionFor('settings', ev.type);
    if (a === 'prev' || a === 'next') { this.row = (this.row + (a === 'next' ? 1 : rows.length - 1)) % rows.length; this.render(); return true; }
    if (a === 'activate') {
      const r = rows[this.row];
      if (r.action) r.action();
      else if (r.vals) { const i = r.vals.findIndex((v) => v.v === r.cur); save({ [r.k]: r.vals[(i + 1) % r.vals.length].v }).then(() => this.render()); }
      return true;
    }
    return false;
  },
};

async function save(patch) { S.settings = await api.saveSettings(patch); syncNav(); }

// ---------------------------------------------------------------- calibration (about 20 s, spoken)
const SPEED = api.calSpeed || 1; // e2e runs it faster
// say it out loud, so nobody has to read (or open their eyes) to know what to do
function speak(text) {
  return new Promise((res) => {
    if (SPEED < 1 || !window.speechSynthesis) return setTimeout(res, 300 * SPEED);
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.onend = res; u.onerror = res;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
    setTimeout(res, 6000);
  });
}
screens.calibrate = {
  enter() {
    this.cancelled = false; this.spotX = 50; this.spotAt = performance.now();
    S.calibrating = true;
    main.innerHTML = `<div class="calib">
      <div class="target" id="tgt"><div></div></div>
      <div class="label" id="lbl">Getting ready</div><div class="sub" id="sub"></div>
    </div>`;
    this.run().catch((e) => { console.error(e); this.set('Calibration error', String(e.message || e)); S.calibrating = false; });
  },
  exit() { this.cancelled = true; S.calibrating = false; window.speechSynthesis?.cancel(); },
  on() { return true; },
  collect(ms, into) {
    return new Promise((res) => {
      const off = S.tracker.onFrame((f, t) => {
        into.push(f.face ? { t, face: true, raw: f.raw, x: this.spotX, settled: performance.now() - this.spotAt > 750 * SPEED } : { t, face: false });
        if (f.face && f.sig && this.sigs) this.sigs.push(f.sig);
      });
      setTimeout(() => { off(); res(into); }, ms * SPEED);
    });
  },
  // instruction text sits right under the circle: one place to look
  set(label, sub = '') { const l = $('#lbl'); if (l) { l.textContent = label; $('#sub').textContent = sub; } },
  circle(x, y, ringMs = 0) {
    const t = $('#tgt'); if (!t) return;
    t.style.left = x + '%'; t.style.top = y + '%';
    const c = main.querySelector('.calib'); c.style.setProperty('--tx', x + '%'); c.style.setProperty('--ty', y + '%');
    t.classList.remove('fill'); void t.offsetWidth;
    if (ringMs) { t.style.setProperty('--ring-ms', ringMs * SPEED + 'ms'); t.classList.add('fill'); }
  },
  async run() {
    if (!S.tracker) { this.set('Camera not available', S.trackerError || ''); return; }
    S.tracker.lock.reset(); S.tracker.lock.setSignature(null);
    this.circle(50, 42);
    // ---- setup: one face, close enough, no glare
    let good = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const off = S.tracker.onFrame((f) => {
        const issue = !f.face ? (f.multiple ? 'Only one person in view, please' : 'Sit in front of the camera')
          : f.eyePx < 22 ? 'Move a little closer to the screen'
          : f.glare > 0.06 ? 'Light is reflecting off your glasses: tilt the screen down a little' : '';
        this.set(issue || 'Ready?', issue ? '' : 'Calibration takes about 40 seconds');
        good = issue ? 0 : good + 1;
        if (good > 15 || this.cancelled || (performance.now() - t0 > 20000 * SPEED && f.face)) { off(); res(); }
      });
    });
    if (this.cancelled) return;
    const samples = { relaxed: [], closed: [], sig: [] };
    this.sigs = samples.sig;

    // ---- 1. relaxed: follow the circle
    this.set('Follow the circle', 'Blink normally');
    await speak('Follow the circle with your eyes. Blink normally.');
    if (this.cancelled) return;
    beep(660, 150);
    const spots = [[50, 42], [12, 42], [88, 42], [12, 42], [88, 42], [50, 42]]; // far left / right also teach it where you look to steer
    const relaxed = this.collect(QCAL.RELAXED_MS, samples.relaxed);
    for (const [x, y] of spots) { this.circle(x, y); this.spotX = x; this.spotAt = performance.now(); await sleep((QCAL.RELAXED_MS / spots.length) * SPEED); if (this.cancelled) return; }
    await relaxed;

    // ---- 2. closed: voice in, beep out (no reading with your eyes shut)
    this.set('Close both eyes', 'Keep them closed until the beep');
    await speak('Now close both eyes, and keep them closed until you hear the beep.');
    if (this.cancelled) return;
    this.circle(50, 42, QCAL.CLOSED_MS);
    await this.collect(QCAL.CLOSED_MS, samples.closed);
    beep(880, 500);
    this.set('Open your eyes', '');
    await sleep(700 * SPEED);

    // ---- 3. eyebrows: how high do THIS person's eyebrows go (they are the throttle in Drive)
    samples.brow = [];
    this.set('Raise your eyebrows', 'Hold them up until the beep');
    await speak('Last one. Raise your eyebrows, and hold them up until the beep.');
    if (this.cancelled) return;
    this.circle(50, 42, QCAL.BROW_MS);
    await this.collect(QCAL.BROW_MS, samples.brow);
    beep(880, 500);
    await sleep(500 * SPEED);
    // ---- 4. winks: each side, because most people have a weaker side
    for (const [key, side] of [['winkL', 'left'], ['winkR', 'right']]) {
      samples[key] = [];
      this.set(`Wink your ${side} eye`, 'Keep it closed until the beep');
      await speak(`Now close only your ${side} eye, and keep it closed until the beep.`);
      if (this.cancelled) return;
      this.circle(50, 42, QCAL.WINK_MS);
      await this.collect(QCAL.WINK_MS, samples[key]);
      beep(880, 400);
      await sleep(600 * SPEED);
    }
    this.set('Done', '');
    await sleep(400 * SPEED);

    const { cal, report } = quickCalibration(samples);
    api.saveDebug('calibration', { report, samples });
    S.calibrating = false;
    if (!cal) {
      this.circle(50, 42);
      this.set('Let\'s try that again', report.warnings[0] || '');
      speak(report.warnings[0] || 'That did not work. Let us try again.');
      $('#sub').insertAdjacentHTML('afterend', '<div class="again">Press C to retry</div>');
      return;
    }
    await api.saveCalibration(cal);
    S.store.calibration = cal;
    startEngine(cal);
    S.status.drift = false; paintPills();
    go('practice');
  },
};

// ---------------------------------------------------------------- practice: try each gesture, see it register
const PRACTICE = [
  { g: 'DOUBLE_BLINK', label: 'Slow double blink', how: 'Two slow, firm blinks' },
  { g: 'WINK_LEFT', label: 'Wink left', how: 'Close only your left eye, a quick wink' },
  { g: 'WINK_RIGHT', label: 'Wink right', how: 'Close only your right eye, a quick wink' },
  { g: 'HOLD_LEFT', label: 'Hold left', how: 'Keep your left eye closed 1 second' },
  { g: 'HOLD_RIGHT', label: 'Hold right', how: 'Keep your right eye closed 1 second' },
  { g: 'BROW_HOLD', label: 'Eyebrows', how: 'Raise your eyebrows 4 seconds' },
  { g: 'BOTH_CLOSED', label: 'Both eyes closed', how: 'Close both eyes 3 seconds' },
];
screens.practice = {
  enter() {
    this.counts = {}; this.frames = []; this.events = []; this.t0 = performance.now();
    this.off = S.tracker?.onFrame((f, t) => { if (this.frames.length < 2400) this.frames.push(f.face ? { t, face: true, raw: f.raw } : { t, face: false }); });
    this.render();
    speak('Now try each gesture. It lights up when I see it.');
  },
  exit() { this.off?.(); api.saveDebug('practice', { counts: this.counts, events: this.events, frames: this.frames }); },
  render() {
    main.innerHTML = `<section class="screen">
      <div><h1>Try each gesture</h1><h2>Each one lights up when BLINC sees it. Press Enter when you're done.</h2></div>
      <div class="practice">${PRACTICE.map((p) => `<div class="choice ${this.counts[p.g] ? 'seen' : ''}" data-g="${p.g}">
        <b>${p.label}</b><small>${p.how}</small><span class="count">${this.counts[p.g] ? 'Seen ' + this.counts[p.g] + 'x' : 'Not yet'}</span></div>`).join('')}
      </div>
      <div class="hint"><span><kbd>Enter</kbd>finish</span><span><kbd>C</kbd>recalibrate</span><span>Gestures that never light up: tell Claude which ones</span></div>
    </section>`;
  },
  on(ev) {
    this.events.push({ type: ev.type, t: Math.round(ev.t - this.t0), src: ev.src });
    if (PRACTICE.some((p) => p.g === ev.type)) {
      this.counts[ev.type] = (this.counts[ev.type] || 0) + 1;
      if (ev.type === 'BROW_HOLD') TONES.select();
      this.render();
      const el = main.querySelector(`[data-g="${ev.type}"]`); el?.classList.add('focus'); setTimeout(() => el?.classList.remove('focus'), 600);
    }
    return true;
  },
};
addEventListener('keydown', (e) => { if (e.key === 'Enter' && S.screenName === 'practice') go('home'); });
// Talk: hold the spacebar while the other person speaks (push-to-listen). In a crowd, an open mic
// transcribes everyone; this way only what is said while the key is down becomes "what was said".
function listenStart(e) {
  if (e.key !== ' ' || S.screenName !== 'talk' || e.target.matches('input, textarea')) return;
  e.preventDefault();
  if (e.repeat || !mic || mic.capturing) return;
  mic.startCapture();
  const t = screens.talk; t.info = 'Listening… let go of the spacebar when they finish'; t.paintBar();
  $('.talkbar')?.classList.add('listening');
}
function listenStop() {
  if (!mic?.capturing) return;
  const r = mic.stopCapture();
  $('.talkbar')?.classList.remove('listening');
  const t = screens.talk;
  if (r !== 'sent') { t.info = r === 'quiet' ? 'Heard nothing. Hold the spacebar while they speak.' : 'Too short. Hold the spacebar while they speak.'; t.paintBar(); }
}
addEventListener('keydown', listenStart);
addEventListener('keyup', (e) => { if (e.key === ' ') listenStop(); });
addEventListener('blur', listenStop);

// Talk: R wipes the conversation and what it learned, and starts again from nothing
addEventListener('keydown', async (e) => {
  if (e.key !== 'r' || S.screenName !== 'talk' || e.target.matches('input, textarea') || e.repeat) return;
  const t = screens.talk;
  t.reqId++; t.convo = []; t.options = []; t.quick = false; t.lastNav = 0; t.loading = false;
  await api.clearTalk();
  t.info = 'Conversation reset'; t.render(); t.refresh();
  TONES.back(); toast('Conversation reset: starting from scratch', 2500);
});

function chime() {
  try {
    const c = new AudioContext(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.15, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.6);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.6);
  } catch {}
}

// ============================================================ tracking + HUD
function startEngine(cal) {
  S.engine = new GestureEngine(cal);
  syncNav();
  S.engine.lookNav = S.screenName === 'drive' && lookDrive();
  if (cal.signature) S.tracker?.lock.setSignature(cal.signature);
}

function paintPills() {
  const st = S.status;
  const set = (id, show, text) => { const el = $('#' + id); if (!el) return; el.hidden = !show; if (text) el.querySelector('b').textContent = text; };
  set('pillMulti', st.multiple, st.lock === 'ambiguous' ? 'Multiple faces: paused' : 'Multiple faces detected');
  set('pillClose', st.close);
  set('pillGlare', st.glare);
  set('pillDrift', st.drift);
  set('pillControl', !S.control);
}

// the thumbnail shows only the locked face, zoomed in
function paintFace(frame) {
  const cv = $('#camOverlay'), v = $('#video');
  if (!cv || !v.videoWidth) return;
  if (cv.width !== 720) { cv.width = 720; cv.height = 280; }
  const ctx = cv.getContext('2d');
  if (!frame.face || !frame.landmarks) { ctx.fillStyle = '#2a2420'; ctx.fillRect(0, 0, cv.width, cv.height); return; }
  // just the part BLINC reads: forehead, eyebrows and eyes (landmarks: 10 = top of forehead,
  // 234 / 454 = sides of the face, 145 / 374 = lower eyelids)
  const P = frame.landmarks, W = v.videoWidth, H = v.videoHeight;
  const faceW = Math.abs(P[454].x - P[234].x) * W;
  const top = P[10].y * H - 0.06 * faceW, bottom = Math.max(P[145].y, P[374].y) * H + 0.14 * faceW;
  const cx = ((P[234].x + P[454].x) / 2) * W, cy = (top + bottom) / 2;
  // keep the canvas shape: grow whichever side is short so nothing is stretched
  let h = bottom - top, w = h * (cv.width / cv.height);
  if (w < faceW * 1.08) { w = faceW * 1.08; h = w * (cv.height / cv.width); }
  ctx.drawImage(v, cx - w / 2, cy - h / 2, w, h, 0, 0, cv.width, cv.height);
}

function paintHud(frame) {
  paintFace(frame);
  if (paintHud.face !== !!frame.face) { paintHud.face = !!frame.face; $('#pillFace').classList.toggle('on', paintHud.face); $('#pillFace b').textContent = paintHud.face ? 'Face found' : 'No face'; }
  const st = S.status;
  const ch = st.multiple !== frame.multiple || st.lock !== frame.lock || st.close !== (frame.face && frame.eyePx < 22) || st.glare !== (frame.face && frame.glare > 0.06);
  st.multiple = !!frame.multiple; st.lock = frame.lock;
  st.close = !!(frame.face && frame.eyePx < 22); st.glare = !!(frame.face && frame.glare > 0.06);
  if (ch) paintPills();
  const e = S.engine?.state;
  for (const side of ['L', 'R']) {
    const el = $('#eye' + side); if (!el) continue;
    const c = e && frame.face ? Math.max(0, Math.min(1, e.c[side])) : 0;
    el.style.setProperty('--lid', (c * 100).toFixed(0) + '%');
    const holding = e?.hold && (e.hold.side === 'left') === (side === 'L');
    el.style.setProperty('--hold', holding ? (e.hold.frac * 360).toFixed(0) + 'deg' : '0deg');
    el.classList.toggle('lost', !frame.face);
  }
  const both = $('#bothRing'); if (both) both.style.setProperty('--both', (Math.max(e?.both || 0, e?.brow || 0) * 360).toFixed(0) + 'deg');
}

// Key 0: webcam off / on. Off means off: the stream is stopped, nothing is read, Butter stops.
async function toggleCamera() {
  if (!S.tracker || S.calibrating) return;
  if (S.tracker.cameraOn) {
    if (S.screenName === 'drive') screens.drive.stop();
    S.tracker.stopCamera();
    if (S.engine) { S.engine.reset(); syncNav(); }
    S.cameraOff = true;
    TONES.off(); toast('Webcam off. Press 0 to turn it back on.', 4000);
  } else {
    try {
      await S.tracker.startCamera(S.settings.cameraId || undefined);
      S.tracker.lock.reset();
      S.tracker.start();
      S.cameraOff = false;
      TONES.on(); toast('Webcam on', 2000);
    } catch (e) { toast('Could not turn the webcam on: ' + (e.message || e), 5000); }
  }
  paintHud.face = undefined;
  const p = $('#pillFace'); p.classList.toggle('on', false); p.querySelector('b').textContent = S.cameraOff ? 'Webcam off (0)' : 'No face';
}
addEventListener('keydown', (e) => { if (e.key === '0' && !e.target.matches('input, textarea') && !e.repeat) toggleCamera(); });

async function initTracking() {
  try {
    S.tracker = new FaceTracker($('#video'));
    await S.tracker.init();
    await S.tracker.startCamera(S.settings.cameraId || undefined);
    if (S.store.calibration?.signature) S.tracker.lock.setSignature(S.store.calibration.signature);
    S.tracker.start();
    S.tracker.onFrame((frame, t) => {
      S.lastFrame = frame; S.frames++; if (frame.face) S.faceFrames++;
      if (!frame.cameraOff) paintHud(frame);
      if (!S.engine || S.calibrating) return;
      for (const ev of S.engine.update(frame, t)) dispatch(ev);
    });
  } catch (e) {
    console.error('tracking init failed', e);
    S.trackerError = String(e.message || e);
    S.tracker = null;
    toast('Camera/eye tracking unavailable: ' + S.trackerError, 5000);
  }
}

// ============================================================ boot
(async function boot() {
  S.store = await api.getStore();
  S.settings = S.store.settings;
  $('#pillAi').classList.toggle('on', S.store.keys.deepseek && S.store.keys.elevenlabs);
  $('#pillAi').classList.toggle('warn', S.store.keys.deepseek !== S.store.keys.elevenlabs);
  $('#pillAi b').textContent = S.store.keys.deepseek && S.store.keys.elevenlabs ? 'Voice + AI ready' : 'Voice + AI: key missing';
  api.onButterStatus((s) => {
    S.butter = s;
    $('#pillButter').classList.toggle('on', s.connected);
    $('#pillButter b').textContent = s.connected ? (s.mock ? 'Butter connected (mock)' : 'Butter connected') : 'Butter offline';
    if (S.screenName === 'drive') screens.drive.paint();
  });
  S.butter = await api.butterStatus();
  const cal = S.store.calibration?.version === 3 ? S.store.calibration : null; // older calibrations are re-done
  await initTracking();
  if (cal) startEngine(cal);
  paintPills();
  go(cal || api.e2e ? 'home' : 'calibrate');
  window.__butter.ready = true;
})();
