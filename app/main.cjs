// Electron main process: window, app:// protocol, secrets, and the services the UI calls over IPC.
const { app, BrowserWindow, ipcMain, protocol, net, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
// The app was renamed to BLINC; keep using the original data folder so saved calibration and settings survive.
app.setPath('userData', path.join(app.getPath('appData'), 'Butter'));

// ---------- .env (keys stay in this process; never sent to the renderer)
function loadEnv() {
  for (const p of [path.join(ROOT, '.env'), path.join(ROOT, '..', '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
loadEnv();

// ---------- settings store (userData/butter.json)
const DEFAULT_SETTINGS = {
  butterUrl: process.env.BUTTER_URL || 'ws://100.127.78.50:8770',
  butterCameraUrl: process.env.BUTTER_CAMERA_URL || 'http://100.127.78.50:5600/',
  voiceOut: 'laptop',       // laptop | butter | both
  navWith: 'brow',          // menus: brow = quick eyebrow raise moves on | wink = winks move
  driveMode: 'look',        // look = eyes pick direction, eyebrows move | blink = double blink / winks
  driveSpeed: 0.1,          // motor power 0.05-1.0
  voiceId: '',
  persona: '',
  cameraId: '',
};
let storePath;
let store = { settings: { ...DEFAULT_SETTINGS }, calibration: null, voiceExamples: [] };
function loadStore() {
  storePath = process.env.BUTTER_STORE || path.join(app.getPath('userData'), 'butter.json');
  try {
    const s = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    store = { ...store, ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) } };
  } catch {}
  // start.sh passes these to point the app at the mock robot or a specific Jetson for this run
  if (process.env.BUTTER_URL) store.settings.butterUrl = process.env.BUTTER_URL;
  if (process.env.BUTTER_CAMERA_URL) store.settings.butterCameraUrl = process.env.BUTTER_CAMERA_URL;
}
function saveStore() {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

// ---------- app:// protocol so fetch(), wasm and ES modules work (file:// blocks fetch)
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win, llm, speech, butter;
const log = (...a) => console.log('[main]', ...a);

async function initServices() {
  const { createLLM } = await import('./lib/llm.js');
  const { createSpeech, DEFAULT_VOICE } = await import('./lib/speech.js');
  const { createButterClient } = await import('./lib/butter-client.js');
  llm = createLLM({ apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' });
  speech = createSpeech({ apiKey: process.env.ELEVENLABS_API_KEY });
  speech.defaultVoice = DEFAULT_VOICE;
  butter = createButterClient({
    url: store.settings.butterUrl,
    onStatus: (s) => win?.webContents.send('butter:status', s),
  });
  if (!store.settings.speedV4) { store.settings.driveSpeed = 0.1; store.settings.speedV4 = true; store.settings.speedV3 = true; } // team: back up to 10%
  if (!store.settings.speedV3) { store.settings.driveSpeed = 0.05; store.settings.speedV3 = true; store.voiceExamples = []; } // one-time: team asked for 5% and a clean Talk memory
  butter.setSpeed(store.settings.driveSpeed);
  log('services: llm', !!process.env.DEEPSEEK_API_KEY, 'speech', speech.enabled, 'butter', store.settings.butterUrl);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#0b0d10',
    title: 'BLINC',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: !process.env.BUTTER_HEADLESS,
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep tracking even if the window is behind another one
    },
  });
  win.loadURL('app://butter/src/index.html');
  win.webContents.on('console-message', (_e, level, message) => {
    if (process.env.BUTTER_LOG_RENDERER) console.log('[renderer]', message);
  });
}

app.whenReady().then(async () => {
  loadStore();
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const p = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
    if (!p.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'audioCapture', 'videoCapture'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'audioCapture', 'videoCapture'].includes(perm));
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('camera'); await systemPreferences.askForMediaAccess('microphone'); } catch {}
  }
  await initServices();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { butter?.close(); app.quit(); });
app.on('before-quit', () => butter?.close());

// ---------- IPC
ipcMain.handle('store:get', () => ({ ...store, keys: { deepseek: !!process.env.DEEPSEEK_API_KEY, elevenlabs: !!process.env.ELEVENLABS_API_KEY } }));
ipcMain.handle('store:settings', (_e, patch) => {
  const before = store.settings.butterUrl;
  store.settings = { ...store.settings, ...patch };
  saveStore();
  if (store.settings.butterUrl !== before) butter.setUrl(store.settings.butterUrl);
  if ('driveSpeed' in patch) butter.setSpeed(store.settings.driveSpeed);
  return store.settings;
});
ipcMain.handle('store:calibration', (_e, cal) => { store.calibration = cal; saveStore(); return true; });
ipcMain.handle('store:clearTalk', () => { store.voiceExamples = []; saveStore(); return true; });
ipcMain.handle('store:voiceExample', (_e, text) => {
  store.voiceExamples = [...store.voiceExamples.filter((t) => t !== text), text].slice(-40);
  saveStore();
  return true;
});

ipcMain.handle('llm:suggest', (_e, conversation) =>
  llm.suggest({ conversation, persona: store.settings.persona, voiceExamples: store.voiceExamples }));

ipcMain.handle('speech:transcribe', async (_e, wav) => {
  try { return await speech.transcribe(Buffer.from(wav)); } catch (e) { return { text: '', error: e.message }; }
});
ipcMain.handle('speech:speak', async (_e, text) => {
  const out = store.settings.voiceOut;
  let res = null;
  try { res = await speech.speak(text, store.settings.voiceId || speech.defaultVoice); } catch (e) { res = { error: e.message }; }
  if (out === 'butter' || out === 'both') butter.say(text, res?.audio ? Buffer.from(res.audio).toString('base64') : undefined);
  // renderer plays the audio only if the laptop is an output; null audio => renderer falls back to system TTS
  return { audio: out === 'butter' ? null : res?.audio || null, ms: res?.ms, error: res?.error, playLocal: out !== 'butter' };
});

// raw readings from the last calibration / practice, for debugging real-eye problems (never committed)
ipcMain.handle('debug:save', (_e, name, data) => {
  if (process.env.BUTTER_E2E) return false;
  try {
    const dir = path.join(ROOT, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${String(name).replace(/[^a-z]/g, '')}.json`), JSON.stringify(data));
    return true;
  } catch { return false; }
});
ipcMain.handle('butter:drive', (_e, dir) => { butter.drive(dir); return true; });
ipcMain.handle('butter:pulse', (_e, dir, ms) => { butter.pulse(dir, ms); return true; });
ipcMain.handle('butter:status', () => butter.status());
