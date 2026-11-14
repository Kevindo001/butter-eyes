// Laptop -> Butter (Jetson) link over WebSocket. Safety first:
//  - every drive command carries a TTL; the Jetson stops the motors if no fresh command arrives
//  - while a direction is held we resend every 150 ms (heartbeat); anything else = stop
//  - on disconnect we forget the direction so reconnecting never resumes motion
import WebSocket from 'ws';

export const DIRECTIONS = ['forward', 'backward', 'left', 'right', 'strafe_left', 'strafe_right', 'stop'];

export function createButterClient({ url, onStatus = () => {}, heartbeatMs = 150, ttlMs = 450, WS = WebSocket } = {}) {
  let ws = null, dir = 'stop', hb = null, retry = null, closed = false, speed = null;
  let status = { connected: false, url, dir: 'stop', lastAck: null, error: null, mock: null };
  const set = (p) => { status = { ...status, ...p }; onStatus(status); };

  function send(obj) {
    if (ws && ws.readyState === WS.OPEN) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  function connect() {
    if (closed || !url) return;
    try { ws = new WS(url, { handshakeTimeout: 2500 }); } catch (e) { set({ error: e.message }); return schedule(); }
    ws.on('open', () => { set({ connected: true, error: null }); send({ cmd: 'hello', client: 'butter-eyes' }); if (speed) send({ cmd: 'speed', value: speed }); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') set({ mock: !!m.mock, robot: m.robot });
      if (m.type === 'ack') set({ lastAck: Date.now(), motors: m.dir });
      if (m.type === 'watchdog') set({ motors: 'stop', watchdog: Date.now() });
    });
    ws.on('close', () => { stopHeartbeat(); dir = 'stop'; set({ connected: false, dir: 'stop' }); schedule(); });
    ws.on('error', (e) => set({ error: e.message }));
  }
  function schedule() { clearTimeout(retry); if (!closed) retry = setTimeout(connect, 1500); }
  function stopHeartbeat() { clearInterval(hb); hb = null; }

  let pulseTimer = null;
  function drive(newDir) {
    if (!DIRECTIONS.includes(newDir)) throw new Error('bad direction ' + newDir);
    clearTimeout(pulseTimer);
    dir = newDir;
    set({ dir });
    stopHeartbeat();
    send({ cmd: 'drive', dir, ttl: ttlMs });
    if (dir !== 'stop') hb = setInterval(() => send({ cmd: 'drive', dir, ttl: ttlMs }), heartbeatMs);
  }

  connect();
  return {
    drive,
    stop: () => drive('stop'),
    // timed move (e.g. a wink = a short turn). Timed here, not in the UI thread, so face-tracking
    // load can't stretch the turn.
    pulse(d, ms) { drive(d); pulseTimer = setTimeout(() => drive('stop'), Math.min(ms, 3000)); },
    say: (text, mp3Base64) => send({ cmd: 'say', text, mp3: mp3Base64 || undefined }),
    status: () => status,
    setSpeed(v) { speed = v; send({ cmd: 'speed', value: v }); },
    setUrl(u) { url = u; set({ url }); try { ws?.close(); } catch {} },
    close() { closed = true; stopHeartbeat(); send({ cmd: 'drive', dir: 'stop' }); clearTimeout(retry); try { ws?.close(); } catch {} },
  };
}
