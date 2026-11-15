// Microphone -> utterances (WAV) for speech-to-text.
// Vad + encodeWav are pure (unit tested in Node); MicListener wires them to Web Audio.

export function downsample(x, inRate, outRate = 16000) {
  if (inRate === outRate) return Float32Array.from(x);
  const ratio = inRate / outRate;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { // box filter: average the input samples covering each output sample
    const a = Math.floor(i * ratio), b = Math.min(x.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += x[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

export function encodeWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/**
 * Energy VAD with an adaptive noise floor.
 * push(chunk) -> returns a Float32Array utterance when one just ended, else null.
 */
export class Vad {
  constructor(rate, o = {}) {
    this.rate = rate;
    this.o = { startMs: 120, endSilenceMs: 800, preRollMs: 350, minSpeechMs: 350, maxMs: 15000, ratio: 3.0, minRms: 0.008, ...o };
    this.floor = 0.003;
    this.reset();
  }
  reset() { this.pre = []; this.preLen = 0; this.buf = null; this.speechMs = 0; this.silenceMs = 0; this.loudMs = 0; this.level = 0; }
  push(chunk) {
    const ms = (chunk.length / this.rate) * 1000;
    let e = 0;
    for (let i = 0; i < chunk.length; i++) e += chunk[i] * chunk[i];
    const rms = Math.sqrt(e / chunk.length);
    this.level = rms;
    const loud = rms > Math.max(this.o.minRms, this.floor * this.o.ratio);
    if (!this.buf) {
      if (!loud) this.floor = 0.95 * this.floor + 0.05 * rms; // learn room noise only while quiet
      this.pre.push(chunk); this.preLen += chunk.length;
      while (this.preLen - this.pre[0].length > (this.o.preRollMs / 1000) * this.rate) this.preLen -= this.pre.shift().length;
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs >= this.o.startMs) { this.buf = [...this.pre]; this.speechMs = this.loudMs; this.silenceMs = 0; this.pre = []; this.preLen = 0; }
      return null;
    }
    this.buf.push(chunk);
    if (loud) { this.speechMs += ms; this.silenceMs = 0; } else this.silenceMs += ms;
    const total = this.buf.reduce((a, c) => a + c.length, 0) / this.rate * 1000;
    if (this.silenceMs >= this.o.endSilenceMs || total >= this.o.maxMs) {
      const parts = this.buf; const speech = this.speechMs;
      this.reset();
      if (speech < this.o.minSpeechMs) return null; // a cough / door click
      const out = new Float32Array(parts.reduce((a, c) => a + c.length, 0));
      let o = 0; for (const c of parts) { out.set(c, o); o += c.length; }
      return out;
    }
    return null;
  }
  get speaking() { return !!this.buf; }
}

export class MicListener {
  constructor({ onUtterance, onLevel }) { this.onUtterance = onUtterance; this.onLevel = onLevel; this.muted = false; }
  get capturing() { return !!this.capture; }
  startCapture() { if (!this.ctx || this.capture) return; this.capture = []; this.captureLen = 0; this.capturePeak = 0; }
  // returns 'sent', 'short' (under 0.4 s) or 'quiet' (nothing but silence)
  stopCapture() {
    if (!this.capture) return 'short';
    const parts = this.capture, len = this.captureLen, peak = this.capturePeak;
    this.capture = null; this.onLevel?.(0, false);
    if (len / this.ctx.sampleRate < 0.4) return 'short';
    if (peak < 0.008) return 'quiet';
    const out = new Float32Array(len); let o = 0; for (const c of parts) { out.set(c, o); o += c.length; }
    this.onUtterance(encodeWav(downsample(out, this.ctx.sampleRate, 16000), 16000));
    return 'sent';
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.vad = new Vad(this.ctx.sampleRate);
    const onChunk = (chunk) => {
      // push-to-listen: while the key is held, keep everything; nothing else in the room is heard
      if (this.capture) {
        this.capture.push(chunk); this.captureLen += chunk.length;
        let e = 0; for (let i = 0; i < chunk.length; i++) e += chunk[i] * chunk[i];
        const rms = Math.sqrt(e / chunk.length); this.capturePeak = Math.max(this.capturePeak, rms);
        this.onLevel?.(rms, true);
        if (this.captureLen / this.ctx.sampleRate > 20) this.stopCapture(); // safety: a stuck key
        return;
      }
      if (this.muted) { this.vad.reset(); this.onLevel?.(0, false); return; }
      const utt = this.vad.push(chunk);
      this.onLevel?.(this.vad.level, this.vad.speaking);
      if (utt) this.onUtterance(encodeWav(downsample(utt, this.ctx.sampleRate, 16000), 16000));
    };
    try {
      // audio thread: immune to main-thread stalls from face tracking
      await this.ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.ctx, 'mic-tap');
      this.node.port.onmessage = (e) => onChunk(e.data);
      const sink = this.ctx.createGain(); sink.gain.value = 0; // keep the node pulled by the graph, output silent
      src.connect(this.node).connect(sink).connect(this.ctx.destination);
      this.mode = 'worklet';
    } catch (e) {
      console.warn('AudioWorklet unavailable, falling back to ScriptProcessor', e);
      this.node = this.ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (ev) => onChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
      src.connect(this.node);
      this.node.connect(this.ctx.destination);
      this.mode = 'script';
    }
  }
  stop() { try { this.node?.disconnect(); this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close(); } catch {} }
}
