// Butter renderer: eyelid gestures (or the keyboard) -> one input bus -> the current screen.
// What each gesture does lives in mapping.js (provisional, one table).
import { FaceTracker } from './face-tracker.js';
import { GestureEngine } from './gesture-engine.js';
import { fitCalibration, ENROLL, REPS, RELAXED_MS, CLOSED_MS, CLOSED_CHIME_MS, READING_TEXT } from './calibration.js';
import { fitTransform, closure, closureIntervals } from './closure.js';
import { MicListener } from './audio.js';
import { centerOut } from '../lib/llm.js';
import { Snake } from './snake.js';
import { ICONS } from './icons.js';
import { actionFor, hints } from './mapping.js';

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
window.__butter = { S, mic: () => mic, screens: null, inject: (type, extra = {}) => dispatch({ type, t: performance.now(), src: 'test', ...extra }) };

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const flash = document.createElement('div'); flash.className = 'flash'; document.body.append(flash);
function pulse() { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }

const LABEL = { BROW_HOLD: 'Eyebrows', DOUBLE_BLINK: 'Double blink', WINK_LEFT: 'Wink left', WINK_RIGHT: 'Wink right', HOLD_LEFT: 'Hold left', HOLD_RIGHT: 'Hold right', BOTH_CLOSED: 'Eyes closed' };

// ============================================================ input bus
function dispatch(ev) {
  if (S.calibrating && ev.src !== 'test') return;
  if (ev.type === 'BROW_HOLD') { setControl(!S.control); pulse(); return; }
  // eye control off: nothing fires except the safety stop and status events
  if (!S.control && ev.src !== 'key' && !['BOTH_CLOSED', 'LONG_BLINK', 'FACE_LOST', 'FACE_FOUND', 'CALIBRATION_DRIFT'].includes(ev.type)) return;
  S.log.push({ type: ev.type, t: Math.round(ev.t), screen: S.screenName });
  if (S.log.length > 300) S.log.shift();
  if (LABEL[ev.type]) { pulse(); const g = $('#lastGesture'); if (g) { g.textContent = LABEL[ev.type]; g.classList.remove('show'); void g.offsetWidth; g.classList.add('show'); } }
  if (ev.type === 'CALIBRATION_DRIFT') { S.status.drift = true; paintPills(); toast('Your eyes look different from calibration (glasses on or off?). Recalibrate in Settings.', 5000); return; }
  if (S.screen?.on?.(ev)) return;
  if (ev.type === 'BOTH_CLOSED' && !['home', 'calibrate'].includes(S.screenName)) go('home');
}

function setControl(on) {
  S.control = on;
  if (!on && S.screenName === 'drive') screens.drive.stop();
  paintPills();
  if (S.screenName === 'drive') screens.drive.paint();
  toast(on ? 'Eye control on' : 'Eye control off: blink freely. Raise your eyebrows 2 s to turn it back on.', 3200);
}

// keyboard = caregiver / demo backup, same gestures
const KEYMAP = { s: 'LONG_BLINK', q: 'WINK_LEFT', ArrowLeft: 'WINK_LEFT', e: 'WINK_RIGHT', ArrowRight: 'WINK_RIGHT', ' ': 'DOUBLE_BLINK', Escape: 'BOTH_CLOSED' };
const HOLDKEYS = { a: 'left', d: 'right' };
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.repeat) return;
  const t = performance.now();
  if (KEYMAP[e.key]) { e.preventDefault(); dispatch({ type: KEYMAP[e.key], t, src: 'key' }); return; }
  if (HOLDKEYS[e.key]) { dispatch({ type: 'HOLD_' + HOLDKEYS[e.key].toUpperCase(), side: HOLDKEYS[e.key], t, src: 'key' }); return; }
  if (e.key === 'c') go('calibrate');
  if (e.key === 'b') dispatch({ type: 'BROW_HOLD', t, src: 'key' });
});
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
  S.screen.enter?.(arg);
}
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
        <div class="center"><div class="eye"><div></div></div>Wink to move around,<br>double blink to open</div>
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
  enter() { this.dir = 'stop'; this.cruise = false; this.confirmUntil = 0; this.render(); },
  exit() { this.set('stop'); clearTimeout(this.timer); },
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
    main.innerHTML = `<section class="screen drivescreen">
      <aside class="sidebar">
        <div class="sidecard" id="ctlCard">
          <small>Eye control</small><b id="ctlState"></b>
          <span>${canBrow ? 'Raise eyebrows 2 s to switch' : 'Press B to switch'}</span>
        </div>
        <div class="sidecard dim">
          <small>Mode</small><b>Blink drive</b>
          <span>Joystick mode: coming next</span>
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
          <b>Both eyes 2 s</b>: stop, exit
        </div>
      </aside>
      <div class="feed" id="feed">
        <img id="feedImg" src="${esc(cam)}" alt="" />
        <div class="offline" id="feedOff" hidden>Butter's camera is not reachable<br><small>${esc(cam)}</small></div>
        <div class="badge" id="badge"></div>
      </div>
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
    $('#mid').textContent = this.cruise ? 'cruise' : '';
    const cs = $('#ctlState'); if (cs) { cs.textContent = S.control ? 'On' : 'Off'; $('#ctlCard').classList.toggle('off', !S.control); }
  },
  on(ev) {
    if (ev.type === 'FACE_LOST') { this.stop('Face lost: stopped'); return true; }
    if (ev.type === 'LONG_BLINK') { // quick stop: stopping must be faster than starting
      if (this.dir !== 'stop' || this.cruise) { this.stop('Stopped'); this.quickStopAt = performance.now(); }
      return true;
    }
    if (ev.type === 'BOTH_CLOSED') {
      if (performance.now() - (this.quickStopAt || 0) < 2600) { this.quickStopAt = 0; return true; } // same eye-close that already stopped it
      if (this.dir !== 'stop' || this.cruise || performance.now() < this.confirmUntil) this.stop('Stopped');
      else go('home');
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
  exit() { if (mic) mic.muted = true; },
  async startMic() {
    if (mic) { mic.muted = false; return; }
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
    try { await mic.start(); } catch (e) { this.info = 'Microphone blocked: ' + e.message; mic = null; this.paintBar(); }
  },
  // new speech refreshes the replies but never closes the quick-phrase board the user just opened
  heard(text) { this.convo.push({ who: 'them', text, t: Date.now() }); this.render(); this.refresh(); },
  async refresh() {
    const id = ++this.reqId;
    this.loading = true; this.paintOptions();
    const r = await api.suggest(this.convo);
    if (id !== this.reqId) return;
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
    setTimeout(() => { if (mic && S.screenName === 'talk') mic.muted = false; }, 350);
    this.refresh();
  },
  render() {
    main.innerHTML = `<section class="screen"><div class="talk">
      <div class="convo" id="convo">${this.convo.length ? '' : '<div class="msg sys">Listening. When someone speaks to you, replies appear below.</div>'}
        ${this.convo.map((m) => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('')}</div>
      <div id="opts"></div>
      <div class="talkbar"><span class="ico">${ICONS.mic}</span><div class="meter" id="meter"><div></div></div><span id="info"></span>
        <input id="typeIn" placeholder="Caregiver: type what was said and press Enter" /></div>
      ${hintRow('talk', { prev: 'left', next: 'right', say: 'say it', quickPhrases: 'quick phrases', newReplies: 'new replies', back: 'home' })}
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
    el.querySelectorAll('.choice').forEach((o) => o.addEventListener('click', () => { if (!this.loading) this.say(this.options[+o.dataset.i]); }));
  },
  on(ev) {
    const a = actionFor('talk', ev.type);
    if (a === 'prev' || a === 'next') {
      const d = a === 'next' ? 1 : -1;
      if (this.quick) this.qfocus = (this.qfocus + d + QUICK.length) % QUICK.length;
      else this.focus = Math.max(0, Math.min(this.options.length - 1, this.focus + d));
      this.paintOptions(); return true;
    }
    if (a === 'say') {
      const text = this.quick ? QUICK[this.qfocus].t : this.loading ? null : this.options[this.focus];
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
    main.innerHTML = `<section class="screen"><div><h1>Snake</h1><h2 id="score">Score 0</h2></div>
      <div class="snakewrap"><canvas id="snake" width="840" height="560"></canvas></div>
      ${hintRow('snake', { turnLeft: 'turn left', turnRight: 'turn right', pause: 'pause / restart', back: 'home' })}</section>`;
    this.game = new Snake($('#snake'), (s) => { $('#score').textContent = `Score ${s}`; });
    this.game.start();
  },
  exit() { this.game?.stop(); },
  on(ev) {
    const a = actionFor('snake', ev.type);
    const L = { up: 'left', left: 'down', down: 'right', right: 'up' }, R = { up: 'right', right: 'down', down: 'left', left: 'up' };
    if (a === 'turnLeft') { this.game.turn(L[this.game.dir]); return true; }
    if (a === 'turnRight') { this.game.turn(R[this.game.dir]); return true; }
    if (a === 'pause') { this.game.toggle(); return true; }
    return false;
  },
};

// ---------------------------------------------------------------- settings
screens.settings = {
  row: 0,
  rows() {
    const s = S.settings;
    return [
      { k: 'driveSpeed', label: 'Drive speed', vals: [{ v: 0.25, l: 'Slow' }, { v: 0.35, l: 'Medium' }, { v: 0.5, l: 'Fast' }] },
      { k: 'voiceOut', label: 'Voice comes out of', vals: [{ v: 'laptop', l: 'Laptop' }, { v: 'butter', l: 'Butter' }, { v: 'both', l: 'Both' }] },
      { k: 'recal', label: 'Recalibrate eyes', action: () => go('calibrate') },
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
    const card = S.store.calibration?.report;
    main.innerHTML = `<section class="screen"><h1>Settings</h1><div class="settings">${rows.map((r, i) => `
      <div class="srow ${i === this.row ? 'focus' : ''}" data-i="${i}"><div>${r.label}</div><div>
      ${r.vals ? `<div class="vals">${r.vals.map((v) => `<span class="${v.v === r.cur ? 'sel' : ''}" data-v="${v.v}">${v.l}</span>`).join('')}</div>` : ''}
      ${r.action ? '<span class="act">Double blink to do it</span>' : ''}
      ${r.text ? `<input data-k="${r.k}" value="${esc(r.cur)}" placeholder="${esc(r.ph || '')}" />` : ''}
      ${r.area ? `<textarea data-k="${r.k}" placeholder="${esc(r.ph || '')}">${esc(r.cur)}</textarea>` : ''}
      </div></div>`).join('')}
      ${card ? `<div class="srow"><div>Gestures you can use</div><div class="vals">${Object.values(card.gestures).map((g) => `<span class="${g.reliable ? 'sel' : ''}">${esc(g.label)}</span>`).join('')}</div></div>` : ''}
      </div>${hintRow('settings', { prev: 'up', next: 'down', activate: 'change / do it', back: 'home' })}</section>`;
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

async function save(patch) { S.settings = await api.saveSettings(patch); }

// ---------------------------------------------------------------- calibration
const SPEED = api.calSpeed || 1; // e2e runs it faster
screens.calibrate = {
  enter() {
    this.cancelled = false; this.report = null;
    S.calibrating = true;
    main.innerHTML = `<div class="calib">
      <div class="calstep" id="calstep"></div>
      <div class="label" id="lbl">Getting ready</div><div class="sub" id="sub"></div>
      <div class="reading" id="reading" hidden></div>
      <div class="reps" id="reps"></div>
      <div class="bar"><div id="bar"></div></div></div>`;
    this.run().catch((e) => { console.error(e); $('#lbl').textContent = 'Calibration error'; $('#sub').textContent = String(e.message || e); S.calibrating = false; });
  },
  exit() { this.cancelled = true; S.calibrating = false; },
  on(ev) {
    if (this.report && (ev.type === 'DOUBLE_BLINK' || ev.type === 'BOTH_CLOSED')) { go('home'); return true; }
    return true;
  },
  collect(ms, into) {
    return new Promise((res) => {
      const off = S.tracker.onFrame((f, t) => {
        into.push(f.face ? { t, face: true, raw: f.raw } : { t, face: false });
        if (f.face && f.sig && this.sigs) this.sigs.push(f.sig);
      });
      setTimeout(() => { off(); res(into); }, ms * SPEED);
    });
  },
  set(step, label, sub = '', progress = null) {
    $('#calstep').textContent = step; $('#lbl').textContent = label; $('#sub').textContent = sub;
    if (progress !== null) $('#bar').style.width = Math.round(progress * 100) + '%';
  },
  async run() {
    if (!S.tracker) { this.set('', 'Camera not available', S.trackerError || ''); return; }
    // ---- 0. setup: one face, close enough, no glare
    S.tracker.lock.reset(); S.tracker.lock.setSignature(null);
    let good = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const off = S.tracker.onFrame((f) => {
        const issues = [];
        if (!f.face) issues.push(f.multiple ? 'Only one person in view, please' : 'Sit in front of the camera');
        else if (f.eyePx < 22) issues.push('Move a little closer to the screen');
        if (f.face && f.glare > 0.06) issues.push('Light is reflecting off your glasses. Tilt the screen down a little or dim lights behind you');
        this.set('Setup', issues[0] || 'Looking good', issues.length ? '' : 'Starting…', 0);
        good = issues.length ? 0 : good + 1;
        if (good > 30 || this.cancelled || (performance.now() - t0 > 25000 * SPEED && f.face)) { off(); res(); }
      });
    });
    if (this.cancelled) return;
    const samples = { relaxed: [], closed: [], reps: {}, sig: [] };
    this.sigs = samples.sig;
    const total = RELAXED_MS + CLOSED_MS + ENROLL.length * REPS * 3400;
    let done = 0;
    const prog = (ms) => { done += ms; $('#bar').style.width = Math.min(100, (100 * done) / total) + '%'; };

    // ---- 1. relaxed
    $('#reading').hidden = false; $('#reading').textContent = READING_TEXT;
    this.set('Step 1 of 3 · Relax', 'Read this and relax', 'Blink normally and look around. 30 seconds.');
    const tick = setInterval(() => prog(500), 500 * SPEED);
    await this.collect(RELAXED_MS, samples.relaxed);
    clearInterval(tick); done = RELAXED_MS;
    $('#reading').hidden = true;
    if (this.cancelled) return;

    // ---- 2. closed
    this.set('Step 2 of 3 · Close', 'Close both eyes', 'Keep them closed until you hear the chime');
    setTimeout(() => chime(), CLOSED_CHIME_MS * SPEED);
    await this.collect(CLOSED_MS, samples.closed);
    prog(CLOSED_MS);
    this.set('Step 2 of 3 · Close', 'Open your eyes', '');
    await sleep(900 * SPEED);
    // provisional scale, only used to skip gestures someone clearly can't do
    const okRows = (rows) => rows.filter((f) => f.face).map((f) => f.raw);
    let tf = null;
    try { tf = fitTransform(okRows(samples.relaxed), okRows(samples.closed).slice(Math.floor(okRows(samples.closed).length / 3))).tf; } catch {}

    // ---- 3. gestures
    for (const [gi, step] of ENROLL.entries()) {
      if (this.cancelled) return;
      samples.reps[step.g] = [];
      this.set(`Step 3 of 3 · ${gi + 1}/${ENROLL.length}`, step.label, step.cue);
      $('#reps').innerHTML = Array.from({ length: REPS }, (_, i) => `<i data-r="${i}"></i>`).join('');
      await sleep(2200 * SPEED);
      let blanks = 0;
      for (let r = 0; r < REPS; r++) {
        if (this.cancelled) return;
        this.set(`Step 3 of 3 · ${gi + 1}/${ENROLL.length}`, 'Now', step.cue);
        $('#reps').querySelector(`[data-r="${r}"]`).className = 'now';
        if (step.chimeMs) setTimeout(() => chime(), step.chimeMs * SPEED);
        const rep = await this.collect(step.windowMs, []);
        samples.reps[step.g].push(rep);
        $('#reps').querySelector(`[data-r="${r}"]`).className = 'done';
        prog(step.windowMs + 1000);
        this.set(`Step 3 of 3 · ${gi + 1}/${ENROLL.length}`, 'Relax', '');
        await sleep(1000 * SPEED);
        if (tf && !looksLikeTried(step.g, rep, tf)) blanks++;
        if (r === 1 && blanks === 2) { this.set('', 'Skipping this one', 'That\'s OK. Not everyone can do every gesture.'); await sleep(1500 * SPEED); break; }
      }
    }

    // ---- 4. fit + report card
    const { cal, report } = fitCalibration(samples);
    this.report = report;
    if (cal) {
      cal.report = { gestures: report.gestures };
      await api.saveCalibration(cal);
      S.store.calibration = cal;
      startEngine(cal);
      S.status.drift = false; paintPills();
    }
    S.calibrating = false;
    main.innerHTML = `<section class="screen"><div class="report">
      <h1>${cal ? 'Your eye gestures' : 'Calibration didn\'t work'}</h1>
      ${Object.values(report.gestures).map((g) => `<div class="row"><span>${esc(g.label)}</span><b class="${g.reliable ? 'ok' : 'off'}">${g.reliable ? 'Works' : 'Off'}${g.reason ? ` · ${esc(g.reason)}` : ''}</b></div>`).join('')}
      ${report.notes.map((w) => `<p class="note">${esc(w)}</p>`).join('')}
      ${report.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
      <p>${cal ? 'Double blink, or wait, to continue.' : 'Press C to try again.'}</p></div></section>`;
    if (cal) setTimeout(() => { if (S.screenName === 'calibrate' && this.report === report) go('home'); }, 10000);
  },
};

// did the person attempt this gesture at all? (used only to skip ones they can't do)
function looksLikeTried(g, rep, tf) {
  const s = rep.filter((f) => f.face).map((f) => { const c = closure(f.raw, tf); return { t: f.t, cL: c.L, cR: c.R }; });
  if (g === 'BROW_HOLD') { const b = rep.filter((f) => f.face).map((f) => f.raw.brow); return b.length > 5 && Math.max(...b) - Math.min(...b) > 0.12; }
  if (g === 'DOUBLE_BLINK') return closureIntervals(s, (x) => Math.min(x.cL, x.cR), 0.5, 0.3).length >= 2;
  return s.some((x) => Math.abs(x.cL - x.cR) > 0.35);
}

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

function paintHud(frame) {
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

async function initTracking() {
  try {
    S.tracker = new FaceTracker($('#video'));
    await S.tracker.init();
    await S.tracker.startCamera(S.settings.cameraId || undefined);
    if (S.store.calibration?.signature) S.tracker.lock.setSignature(S.store.calibration.signature);
    S.tracker.start();
    S.tracker.onFrame((frame, t) => {
      S.lastFrame = frame; S.frames++; if (frame.face) S.faceFrames++;
      paintHud(frame);
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
