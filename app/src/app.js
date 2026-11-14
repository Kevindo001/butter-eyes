// Butter renderer: one input bus (eye gestures or keyboard) -> the current screen.
import { FaceTracker } from './face-tracker.js';
import { GestureEngine } from './gesture-engine.js';
import { PHASES, computeCalibration } from './calibration.js';
import { MicListener } from './audio.js';
import { centerOut } from '../lib/llm.js';
import { Snake } from './snake.js';
import { ICONS } from './icons.js';

const api = window.butterApi;
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  store: null,
  settings: null,
  screen: null,
  screenName: '',
  engine: null,
  tracker: null,
  butter: { connected: false },
  log: [], // recent input events (debug + e2e)
};
window.__butter = { S, mic: () => mic, inject: (type, extra = {}) => dispatch({ type, t: performance.now(), src: 'test', ...extra }) };

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const flash = document.createElement('div'); flash.className = 'flash'; document.body.append(flash);
function pulse() { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }

// ============================================================ input bus
let heldDir = null; // current held gaze direction (from engine or keyboard)
function dispatch(ev) {
  if (ev.type.startsWith('LOOK_') && ev.type !== 'LOOK_END' && ev.type !== 'LOOK_REPEAT') heldDir = ev.dir || ev.type.slice(5).toLowerCase();
  if (ev.type === 'LOOK_END' || ev.type === 'FACE_LOST') heldDir = null;
  if (ev.type === 'LOOK_REPEAT' && !ev.dir) ev.dir = heldDir;
  if (!ev.dir && ev.type.startsWith('LOOK_') && ev.type !== 'LOOK_END') ev.dir = heldDir;
  S.log.push({ type: ev.type, dir: ev.dir, t: Math.round(ev.t), screen: S.screenName });
  if (S.log.length > 200) S.log.shift();
  if (['BLINK', 'DOUBLE_BLINK', 'WINK_LEFT', 'WINK_RIGHT', 'LONG_CLOSE'].includes(ev.type)) pulse();
  if (S.screen?.on?.(ev)) return;
  if (ev.type === 'LONG_CLOSE' && S.screenName !== 'home' && S.screenName !== 'calibrate') go('home');
}

// keyboard = caregiver / demo backup, same gestures
const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const keyHeld = new Set();
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  const t = performance.now();
  if (KEYS[e.key]) {
    e.preventDefault();
    if (e.repeat) return;
    keyHeld.add(e.key);
    dispatch({ type: 'LOOK_' + KEYS[e.key].toUpperCase(), dir: KEYS[e.key], t, src: 'key' });
    return;
  }
  if (e.repeat) return;
  const map = { ' ': 'BLINK', d: 'DOUBLE_BLINK', Escape: 'LONG_CLOSE', q: 'WINK_LEFT', e: 'WINK_RIGHT' };
  if (map[e.key]) { e.preventDefault(); dispatch({ type: map[e.key], t, src: 'key' }); }
  if (e.key === 'Shift') dispatch({ type: 'WINK_HOLD_START', side: 'left', t, src: 'key' });
  if (e.key === 'c' && e.metaKey === false) go('calibrate');
});
addEventListener('keyup', (e) => {
  if (KEYS[e.key] && keyHeld.delete(e.key)) dispatch({ type: 'LOOK_END', t: performance.now(), src: 'key' });
  if (e.key === 'Shift') dispatch({ type: 'WINK_HOLD_END', side: 'left', t: performance.now(), src: 'key' });
});

// ============================================================ screens
const screens = {};
function go(name, arg) {
  S.screen?.exit?.();
  S.screenName = name;
  S.screen = screens[name];
  main.innerHTML = '';
  S.screen.enter?.(arg);
}

// ---------------------------------------------------------------- home
screens.home = {
  focus: null,
  tiles: {
    up: { name: 'Drive', sub: 'Move Butter', ico: ICONS.car, to: 'drive' },
    left: { name: 'Talk', sub: 'Say it with your eyes', ico: ICONS.talk, to: 'talk' },
    right: { name: 'Play', sub: 'Snake', ico: ICONS.play, to: 'snake' },
    down: { name: 'Settings', sub: 'Calibrate, controls, voice', ico: ICONS.settings, to: 'settings' },
  },
  enter() { this.render(); },
  render() {
    main.innerHTML = `<section class="screen">
      <div><h1>What would you like to do?</h1></div>
      <div class="cross">
        ${Object.entries(this.tiles).map(([d, t]) => `<div class="choice t-${d} ${this.focus === d ? 'focus' : ''}" data-dir="${d}">
          <div class="ico">${t.ico}</div>${t.name}<small>${t.sub}</small><span class="cue">Blink to open</span></div>`).join('')}
        <div class="center"><div class="eye"><div></div></div>Look toward one,<br>then blink to open it</div>
      </div>
      <div class="hint"><span><kbd>look</kbd>choose</span><span><kbd>blink</kbd>open</span><span><kbd>close eyes 2s</kbd>back / stop</span></div>
    </section>`;
    main.querySelectorAll('.cross .choice').forEach((el) => el.addEventListener('click', () => go(this.tiles[el.dataset.dir].to)));
  },
  on(ev) {
    if (ev.type.startsWith('LOOK_') && ev.dir && this.tiles[ev.dir] && ev.type !== 'LOOK_REPEAT') { this.focus = ev.dir; this.render(); return true; }
    if (ev.type === 'BLINK' && this.focus) { const to = this.tiles[this.focus].to; this.focus = null; go(to); return true; }
    return false;
  },
};

// ---------------------------------------------------------------- drive
const LOOK_TO_DRIVE = { up: 'forward', down: 'backward', left: 'left', right: 'right' };
screens.drive = {
  enter() {
    this.engaged = false; this.dir = 'stop'; this.cruise = false;
    this.render();
  },
  exit() { this.set('stop'); clearTimeout(this.pulseT); },
  set(dir) {
    if (dir === this.dir) return;
    this.dir = dir;
    api.drive(dir);
    this.paint();
  },
  pulseTurn(dir, ms = 550) {
    this.cruise = false;
    this.dir = dir;
    api.pulse(dir, ms); // main process times the stop
    this.paint();
    clearTimeout(this.pulseT);
    this.pulseT = setTimeout(() => { if (this.dir === dir) { this.dir = 'stop'; this.paint(); } }, ms);
  },
  legend() {
    const p = S.settings.profile;
    if (p === 'winks') return `<b>Wink left / right</b> turn<br><b>Double blink</b> go forward / stop<br><b>Hold look down</b> back up<br><b>Blink</b> stop<br><b>Close eyes 2s</b> stop · exit`;
    if (p === 'clutch') return `<b>Hold one eye closed</b> to drive<br>…then <b>look</b> with the other eye<br><b>Open both eyes</b> stop instantly<br><b>Close eyes 2s</b> exit`;
    return `<b>Blink</b> start / park<br><b>Look up</b> forward · <b>down</b> back<br><b>Look left / right</b> turn<br><b>Look at center</b> stop<br><b>Close eyes 2s</b> stop · exit`;
  },
  render() {
    const cam = S.settings.butterCameraUrl;
    main.innerHTML = `<section class="screen">
      <div><h1>Drive Butter</h1></div>
      <div class="drive">
        <div class="feed" id="feed">
          <img id="feedImg" src="${esc(cam)}" alt="" />
          <div class="offline" id="feedOff" hidden>Butter's camera is not reachable<br><small>${esc(cam)}</small></div>
          <div class="badge" id="badge"></div>
        </div>
        <div class="side">
          <div class="dpad" id="dpad">
            <div></div><div data-d="forward">${ICONS.up}</div><div></div>
            <div data-d="left">${ICONS.left}</div><div class="mid" id="mid"></div><div data-d="right">${ICONS.right}</div>
            <div></div><div data-d="backward">${ICONS.down}</div><div></div>
          </div>
          <div class="legend">${this.legend()}</div>
        </div>
      </div>
    </section>`;
    const img = $('#feedImg');
    img.onerror = () => { img.hidden = true; $('#feedOff').hidden = false; };
    this.paint();
  },
  paint() {
    const b = $('#badge'); if (!b) return;
    const moving = this.dir !== 'stop';
    const names = { forward: 'Moving forward', backward: 'Backing up', left: 'Turning left', right: 'Turning right', strafe_left: 'Sliding left', strafe_right: 'Sliding right' };
    b.className = 'badge ' + (!S.butter.connected ? 'offline' : moving ? 'moving' : this.engaged ? 'ready' : 'parked');
    b.textContent = !S.butter.connected ? 'Butter offline' : moving ? names[this.dir] : this.engaged ? 'Ready: look to move' : 'Parked';
    $('#feed').classList.toggle('driving', moving);
    main.querySelectorAll('#dpad [data-d]').forEach((el) => el.classList.toggle('on', el.dataset.d === this.dir));
    $('#mid').textContent = this.cruise ? 'cruise' : '';
  },
  on(ev) {
    const p = S.settings.profile;
    if (ev.type === 'FACE_LOST') { this.engaged = false; this.cruise = false; this.set('stop'); toast('Face lost: stopped'); return true; }
    if (ev.type === 'LONG_CLOSE') {
      if (this.dir !== 'stop' || this.engaged || this.cruise) { this.engaged = false; this.cruise = false; this.set('stop'); this.paint(); toast('Stopped'); }
      else go('home');
      return true;
    }
    if (p === 'eyes') {
      if (ev.type === 'BLINK') { this.engaged = !this.engaged; if (!this.engaged) this.set('stop'); this.paint(); toast(this.engaged ? 'Ready: look to move' : 'Parked'); return true; }
      if (ev.type.startsWith('LOOK_') && ev.type !== 'LOOK_END') { if (this.engaged && ev.dir) this.set(LOOK_TO_DRIVE[ev.dir]); return true; }
      if (ev.type === 'LOOK_END') { this.set('stop'); return true; }
    }
    if (p === 'winks') {
      if (ev.type === 'WINK_LEFT') { this.pulseTurn('left'); return true; }
      if (ev.type === 'WINK_RIGHT') { this.pulseTurn('right'); return true; }
      if (ev.type === 'DOUBLE_BLINK') { this.cruise = !this.cruise; this.set(this.cruise ? 'forward' : 'stop'); this.paint(); return true; }
      if (ev.type === 'BLINK') { this.cruise = false; this.set('stop'); this.paint(); return true; }
      if (ev.type === 'LOOK_DOWN') { this.cruise = false; this.set('backward'); return true; }
      if (ev.type === 'LOOK_END' && this.dir === 'backward') { this.set('stop'); return true; }
    }
    if (p === 'clutch') {
      if (ev.type === 'WINK_HOLD_START') { this.engaged = true; this.paint(); return true; }
      if (ev.type === 'WINK_HOLD_END') { this.engaged = false; this.set('stop'); this.paint(); return true; }
      if (ev.type.startsWith('LOOK_') && ev.type !== 'LOOK_END') { if (this.engaged && ev.dir) this.set(LOOK_TO_DRIVE[ev.dir]); return true; }
      if (ev.type === 'LOOK_END') { this.set('stop'); return true; }
    }
    return true; // swallow everything else while driving
  },
};

// ---------------------------------------------------------------- talk
const QUICK = [
  { t: 'Yes' }, { t: 'No' }, { t: 'Thank you' }, { t: 'I love you' },
  { t: 'I need help', urgent: true }, { t: "I'm in pain", urgent: true }, { t: 'Water, please' }, { t: 'Please wait, I am typing with my eyes' },
];
let mic = null;
screens.talk = {
  convo: [], options: [], focus: 2, quick: false, qfocus: 0, reqId: 0, loading: false, info: '',
  enter() {
    this.render();
    this.startMic();
    if (!this.options.length) this.refresh();
  },
  exit() { if (mic) mic.muted = true; },
  async startMic() {
    if (mic) { mic.muted = false; return; }
    if (!S.store.keys.elevenlabs) { this.info = 'Speech-to-text off (no ElevenLabs key). Type below instead.'; this.paintBar(); return; }
    mic = new MicListener({
      onLevel: (lvl, speaking) => { const m = $('#meter div'); if (m) { m.style.width = Math.min(100, lvl * 900) + '%'; m.style.background = speaking ? 'var(--butter)' : 'var(--go)'; } },
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
  heard(text) {
    this.convo.push({ who: 'them', text, t: Date.now() });
    this.quick = false;
    this.render();
    this.refresh();
  },
  async refresh() {
    const id = ++this.reqId;
    this.loading = true; this.paintOptions();
    const r = await api.suggest(this.convo);
    if (id !== this.reqId) return; // a newer request superseded this one
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
    this.refresh(); // follow-ups for what they might say next
  },
  render() {
    main.innerHTML = `<section class="screen"><div class="talk">
      <div class="convo" id="convo">${this.convo.length ? '' : '<div class="msg sys">Listening. When someone speaks to you, replies appear below.</div>'}
        ${this.convo.map((m) => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('')}</div>
      <div id="opts"></div>
      <div class="talkbar"><span class="ico">${ICONS.mic}</span><div class="meter" id="meter"><div></div></div><span id="info"></span>
        <input id="typeIn" placeholder="Caregiver: type what was said and press Enter" /></div>
      <div class="hint"><span><kbd>look ← →</kbd>choose</span><span><kbd>blink</kbd>say it</span><span><kbd>look up</kbd>new options</span><span><kbd>look down</kbd>quick phrases</span><span><kbd>double blink</kbd>repeat last</span><span><kbd>close eyes 2s</kbd>home</span></div>
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
    const mid = Math.floor(this.options.length / 2);
    el.innerHTML = `<div class="options">${(this.loading && !this.options.length ? Array(5).fill('…') : this.options).map((o, i) =>
      `<div class="choice ${i === mid ? 'best' : ''} ${i === this.focus ? 'focus' : ''} ${this.loading ? 'loading' : ''}" data-i="${i}">${esc(o)}</div>`).join('')}</div>`;
    el.querySelectorAll('.choice').forEach((o) => o.addEventListener('click', () => { if (!this.loading) this.say(this.options[+o.dataset.i]); }));
  },
  on(ev) {
    const n = this.quick ? QUICK.length : this.options.length;
    const step = (d) => {
      if (this.quick) this.qfocus = (this.qfocus + d + n) % n;
      else this.focus = Math.max(0, Math.min(n - 1, this.focus + d));
      this.paintOptions();
    };
    if ((ev.type === 'LOOK_LEFT' || (ev.type === 'LOOK_REPEAT' && ev.dir === 'left'))) { step(-1); return true; }
    if ((ev.type === 'LOOK_RIGHT' || (ev.type === 'LOOK_REPEAT' && ev.dir === 'right'))) { step(1); return true; }
    if (ev.type === 'LOOK_UP') { if (this.quick) { this.quick = false; this.paintOptions(); } else this.refresh(); return true; }
    if (ev.type === 'LOOK_DOWN') { this.quick = true; this.qfocus = 0; this.paintOptions(); return true; }
    if (ev.type === 'BLINK') {
      const text = this.quick ? QUICK[this.qfocus].t : this.loading ? null : this.options[this.focus];
      if (text) { this.quick = false; this.say(text); }
      return true;
    }
    if (ev.type === 'DOUBLE_BLINK') {
      const last = [...this.convo].reverse().find((m) => m.who === 'me');
      if (last) api.speak(last.text).then((r) => playAudio(r, last.text));
      return true;
    }
    return false;
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
    // offline fallback: the Mac's built-in voice
    await new Promise((res) => { const u = new SpeechSynthesisUtterance(text); u.onend = res; u.onerror = res; speechSynthesis.speak(u); setTimeout(res, 8000); });
  }
}

// ---------------------------------------------------------------- snake
screens.snake = {
  enter() {
    main.innerHTML = `<section class="screen"><div><h1>Snake</h1><h2 id="score">Score 0</h2></div>
      <div class="snakewrap"><canvas id="snake" width="840" height="560"></canvas></div>
      <div class="hint"><span><kbd>look</kbd>steer</span><span><kbd>blink</kbd>pause / restart</span><span><kbd>close eyes 2s</kbd>home</span></div></section>`;
    this.game = new Snake($('#snake'), (s) => { $('#score').textContent = `Score ${s}`; });
    this.game.start();
  },
  exit() { this.game?.stop(); },
  on(ev) {
    if (ev.type.startsWith('LOOK_') && ev.dir && ev.type !== 'LOOK_END' && ev.type !== 'LOOK_REPEAT') { this.game.turn(ev.dir); return true; }
    if (ev.type === 'BLINK') { this.game.toggle(); return true; }
    return false;
  },
};

// ---------------------------------------------------------------- settings
const SENS = [{ v: 0.7, l: 'Low' }, { v: 0.55, l: 'Medium' }, { v: 0.42, l: 'High' }];
const HOLD = [{ v: 200, l: 'Fast' }, { v: 280, l: 'Normal' }, { v: 420, l: 'Slow' }];
screens.settings = {
  row: 0,
  rows() {
    const s = S.settings;
    return [
      { k: 'profile', label: 'Control style', vals: [{ v: 'eyes', l: 'Eyes only' }, { v: 'winks', l: 'Winks + blinks' }, { v: 'clutch', l: 'Clutch (hold one eye)' }] },
      { k: 'gazeEnter', label: 'Look sensitivity', vals: SENS },
      { k: 'gazeHoldMs', label: 'Look hold time', vals: HOLD },
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
    main.innerHTML = `<section class="screen"><h1>Settings</h1><div class="settings">${rows.map((r, i) => `
      <div class="srow ${i === this.row ? 'focus' : ''}" data-i="${i}"><div>${r.label}</div><div>
      ${r.vals ? `<div class="vals">${r.vals.map((v) => `<span class="${v.v === r.cur ? 'sel' : ''}" data-v="${v.v}">${v.l}</span>`).join('')}</div>` : ''}
      ${r.action ? '<span class="act">Blink to do it</span>' : ''}
      ${r.text ? `<input data-k="${r.k}" value="${esc(r.cur)}" placeholder="${esc(r.ph || '')}" />` : ''}
      ${r.area ? `<textarea data-k="${r.k}" placeholder="${esc(r.ph || '')}">${esc(r.cur)}</textarea>` : ''}
      </div></div>`).join('')}</div>
      <div class="hint"><span><kbd>look ↑ ↓</kbd>row</span><span><kbd>look ← →</kbd>change</span><span><kbd>blink</kbd>do it</span><span>Text fields: keyboard (caregiver)</span></div></section>`;
    main.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.k]: el.value.trim() })));
    main.querySelectorAll('.srow').forEach((el) => el.querySelectorAll('[data-v]').forEach((sp) => sp.addEventListener('click', () => {
      const r = rows[+el.dataset.i]; const v = r.vals.find((x) => String(x.v) === sp.dataset.v).v; save({ [r.k]: v }).then(() => this.render());
    })));
    main.querySelectorAll('.srow').forEach((el) => el.addEventListener('click', () => { const r = rows[+el.dataset.i]; if (r.action) r.action(); }));
  },
  on(ev) {
    const rows = this.rows().filter((r) => !r.text && !r.area);
    if (ev.type === 'LOOK_UP' || (ev.type === 'LOOK_REPEAT' && ev.dir === 'up')) { this.row = (this.row - 1 + rows.length) % rows.length; this.render(); return true; }
    if (ev.type === 'LOOK_DOWN' || (ev.type === 'LOOK_REPEAT' && ev.dir === 'down')) { this.row = (this.row + 1) % rows.length; this.render(); return true; }
    const r = rows[this.row];
    if ((ev.type === 'LOOK_LEFT' || ev.type === 'LOOK_RIGHT') && r.vals) {
      const i = r.vals.findIndex((v) => v.v === r.cur);
      const n = (i + (ev.type === 'LOOK_RIGHT' ? 1 : -1) + r.vals.length) % r.vals.length;
      save({ [r.k]: r.vals[n].v }).then(() => this.render());
      return true;
    }
    if (ev.type === 'BLINK' && r.action) { r.action(); return true; }
    return false;
  },
};

async function save(patch) {
  S.settings = await api.saveSettings(patch);
  applySettings();
}
function applySettings() {
  const names = { eyes: 'Eyes only', winks: 'Winks + blinks', clutch: 'Clutch' };
  $('#pillProfile').textContent = names[S.settings.profile] || S.settings.profile;
  if (S.engine) { S.engine.o.gazeEnter = S.settings.gazeEnter; S.engine.o.gazeExit = Math.min(0.35, S.settings.gazeEnter - 0.15); S.engine.o.gazeHoldMs = S.settings.gazeHoldMs; }
}

// ---------------------------------------------------------------- calibration
screens.calibrate = {
  enter() {
    this.cancelled = false;
    main.innerHTML = `<div class="calib"><div class="target" id="tgt" style="left:50%;top:50%"></div>
      <div class="label" id="lbl">Center your face in the camera</div><div class="sub" id="sub">Sit how you normally sit. Keep your head still and move only your eyes.</div>
      <div class="bar"><div id="bar"></div></div></div>`;
    this.run();
  },
  exit() { this.cancelled = true; },
  on(ev) {
    if (this.report && ev.type === 'BLINK') { go('home'); return true; }
    return true;
  },
  async run() {
    const sub = $('#sub'), lbl = $('#lbl'), tgt = $('#tgt'), bar = $('#bar');
    if (!S.tracker) { lbl.textContent = 'Camera not available'; sub.textContent = S.trackerError || ''; return; }
    // wait for a face for 1 s
    let seen = 0;
    await new Promise((res) => {
      const off = S.tracker.onFrame((f) => { seen = f.face ? seen + 1 : 0; if (seen > 25 || this.cancelled) { off(); res(); } });
    });
    if (this.cancelled) return;
    const pos = { center: [50, 50], center2: [50, 50], left: [6, 50], right: [94, 50], up: [50, 8], down: [50, 92], closed: [50, 50], winkL: [50, 50], winkR: [50, 50] };
    const samples = {};
    const total = PHASES.reduce((a, p) => a + p.settle + p.collect, 0);
    let done = 0;
    for (const ph of PHASES) {
      if (this.cancelled) return;
      lbl.textContent = ph.label;
      sub.textContent = ph.optional ? 'Optional. If you can\'t, just keep both eyes open.' : '';
      const [x, y] = pos[ph.id];
      tgt.style.left = x + '%'; tgt.style.top = y + '%';
      tgt.style.opacity = ['closed', 'winkL', 'winkR'].includes(ph.id) ? 0.25 : 1;
      tgt.classList.remove('collect');
      await sleep(ph.settle);
      tgt.classList.add('collect');
      const rows = [];
      const off = S.tracker.onFrame((f) => rows.push({ face: f.face, blinkL: f.blinkL, blinkR: f.blinkR, feat: f.feat }));
      await sleep(ph.collect);
      off();
      samples[ph.id] = rows;
      done += ph.settle + ph.collect;
      bar.style.width = (100 * done) / total + '%';
      if (ph.id === 'closed') chime();
    }
    const { cal, report } = computeCalibration(samples);
    this.report = report;
    if (cal) {
      await api.saveCalibration(cal);
      S.store.calibration = cal;
      startEngine(cal);
      if (!cal.winks && S.settings.profile !== 'eyes') await save({ profile: 'eyes' });
    }
    main.innerHTML = `<section class="screen"><div class="report">
      <h1>${cal ? 'Calibrated' : 'Calibration failed'}</h1>
      <p>How clearly the camera can tell each eye direction apart (higher is better, under 2 is disabled):</p>
      ${Object.entries(report.dirs).map(([d, v]) => `<div class="row"><span>Look ${d}</span><b>${v}</b></div>`).join('')}
      <div class="row"><span>Winks</span><b>${report.winks ? 'detected' : 'off'}</b></div>
      ${report.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
      <p>${cal ? 'Blink to continue.' : 'Press C to try again.'}</p></div></section>`;
    if (cal) setTimeout(() => { if (S.screenName === 'calibrate') go('home'); }, 8000);
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chime() {
  try {
    const c = new AudioContext(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.15, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.6);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.6);
  } catch {}
}

// ============================================================ tracking + HUD
function startEngine(cal) {
  S.engine = new GestureEngine(cal, { gazeEnter: S.settings.gazeEnter, gazeHoldMs: S.settings.gazeHoldMs });
  applySettings();
}

function paintHud(frame) {
  $('#pillFace').classList.toggle('on', !!frame.face);
  const puck = $('#puck');
  const st = S.engine?.state;
  if (st) {
    const sc = st.scores || {};
    const x = ((sc.right || 0) - (sc.left || 0)) / 2, y = ((sc.down || 0) - (sc.up || 0)) / 2;
    const lim = (v) => Math.max(-1, Math.min(1, v));
    puck.style.left = 50 + lim(x) * 40 + '%';
    puck.style.top = 50 + lim(y) * 40 + '%';
    puck.className = 'puck ' + (st.eyes !== 'open' ? 'closed' : st.held ? 'held' : st.cand ? 'cand' : '');
  }
  // eye dots on the camera thumbnail
  const cv = $('#camOverlay');
  const ctx = cv.getContext('2d');
  if (cv.width !== 208) { cv.width = 208; cv.height = 116; }
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (frame.landmarks) {
    ctx.fillStyle = '#ffc94a';
    for (const i of [468, 473]) { const p = frame.landmarks[i]; ctx.beginPath(); ctx.arc(p.x * cv.width, p.y * cv.height, 3, 0, 7); ctx.fill(); }
  }
}

async function initTracking() {
  try {
    S.tracker = new FaceTracker($('#video'));
    await S.tracker.init();
    await S.tracker.startCamera(S.settings.cameraId || undefined);
    S.tracker.start();
    S.tracker.onFrame((frame, t) => {
      S.lastFrame = frame; S.frames = (S.frames || 0) + 1; if (frame.face) S.faceFrames = (S.faceFrames || 0) + 1;
      paintHud(frame);
      if (!S.engine) return;
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
  applySettings();
  $('#pillAi').classList.toggle('on', S.store.keys.deepseek && S.store.keys.elevenlabs);
  $('#pillAi').classList.toggle('warn', S.store.keys.deepseek !== S.store.keys.elevenlabs);
  api.onButterStatus((s) => {
    S.butter = s;
    $('#pillButter').classList.toggle('on', s.connected);
    $('#pillButter b').textContent = s.connected ? (s.mock ? 'Butter (mock)' : 'Butter') : 'Butter offline';
    if (S.screenName === 'drive') screens.drive.paint();
  });
  S.butter = await api.butterStatus();
  if (S.store.calibration) startEngine(S.store.calibration);
  await initTracking();
  go(S.store.calibration || api.e2e ? 'home' : 'calibrate');
  window.__butter.ready = true;
})();
