import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplies, centerOut, createLLM, buildMessages } from '../lib/llm.js';
import { createButterClient } from '../lib/butter-client.js';
import { Vad, encodeWav, downsample } from '../src/audio.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------ LLM (offline)
test('parseReplies handles fences, prose, objects, dupes, junk', () => {
  assert.deepEqual(parseReplies('```json\n{"replies":["Yes","No","Yes"]}\n```'), ['Yes', 'No']);
  assert.deepEqual(parseReplies('Sure! {"replies":[{"text":"Hi"}, "  Hey   there "]} hope that helps'), ['Hi', 'Hey there']);
  assert.deepEqual(parseReplies('["a","b"]'), ['a', 'b']);
  assert.throws(() => parseReplies('no json here'));
});

test('centerOut puts the most likely of 3 replies in the middle', () => {
  assert.deepEqual(centerOut(['1st', '2nd', '3rd']), ['2nd', '1st', '3rd']);
});

test('LLM falls back cleanly with no key, bad JSON, HTTP error, or timeout', async () => {
  const none = await createLLM({ apiKey: '' }).suggest({ conversation: [{ who: 'them', text: 'hi' }] });
  assert.equal(none.source, 'offline'); assert.equal(none.replies.length, 3);

  let calls = 0;
  const badJson = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'oops' } }] })); };
  const r1 = await createLLM({ apiKey: 'x', fetchImpl: badJson }).suggest({ conversation: [{ who: 'them', text: 'hi' }] });
  assert.equal(r1.source, 'fallback'); assert.equal(calls, 2, 'retries once on bad JSON');

  const http = async () => new Response('rate limited', { status: 429 });
  const r2 = await createLLM({ apiKey: 'x', fetchImpl: http }).suggest({ conversation: [] });
  assert.match(r2.error, /429/);

  const hang = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t0 = Date.now();
  const r3 = await createLLM({ apiKey: 'x', fetchImpl: hang, timeoutMs: 300 }).suggest({ conversation: [] });
  assert.equal(r3.source, 'fallback'); assert.ok(Date.now() - t0 < 1000, 'timeout honored, no retry after abort');
});

test('prompt includes persona, voice examples, and only the last 16 turns', () => {
  const conversation = Array.from({ length: 30 }, (_, i) => ({ who: i % 2 ? 'me' : 'them', text: `line ${i}` }));
  const m = buildMessages({ conversation, persona: 'My name is Linh', voiceExamples: ['lol ok'] });
  assert.match(m[1].content, /Linh/); assert.match(m[1].content, /lol ok/);
  assert.doesNotMatch(m[1].content, /line 13\b/); assert.match(m[1].content, /line 29/);
});

// ------------------------------------------------------------ VAD
test('VAD: silence + noise -> nothing; speech burst -> one utterance with pre-roll', () => {
  const rate = 48000, chunk = 2048;
  const vad = new Vad(rate);
  let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  const feed = (sec, amp, tone = 0) => {
    const outs = [];
    for (let i = 0; i < (sec * rate) / chunk; i++) {
      const c = new Float32Array(chunk);
      for (let j = 0; j < chunk; j++) c[j] = rnd() * 0.004 + (tone ? amp * Math.sin((2 * Math.PI * tone * (i * chunk + j)) / rate) : 0);
      const u = vad.push(c); if (u) outs.push(u);
    }
    return outs;
  };
  assert.equal(feed(5, 0).length, 0, 'room noise must not trigger');
  assert.equal(feed(0.15, 0.3, 300).length + feed(1.5, 0).length, 0, 'a 150 ms click must not become an utterance');
  const outs = [...feed(1.2, 0.2, 220), ...feed(1.2, 0)];
  assert.equal(outs.length, 1);
  const sec = outs[0].length / rate;
  assert.ok(sec > 1.2 && sec < 2.6, `utterance length ${sec}`);
});

test('WAV encoder writes a valid 16 kHz mono header', () => {
  const wav = new DataView(encodeWav(downsample(new Float32Array(48000), 48000, 16000)));
  assert.equal(String.fromCharCode(...new Uint8Array(wav.buffer, 0, 4)), 'RIFF');
  assert.equal(wav.getUint32(24, true), 16000);
  assert.equal(wav.getUint32(40, true), 16000 * 2);
});

// ------------------------------------------------------------ Butter client <-> real drive server (mock motors)
test('butter client: connects, heartbeats keep motors on, stop is immediate, server death -> stops resending', async () => {
  const port = 18770 + Math.floor(Math.random() * 500);
  const srv = spawn('python3', [path.join(here, '../../butter-drive/server.py'), '--mock', '--port', String(port), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  srv.stderr.on('data', (d) => logs.push(...d.toString().split('\n').filter(Boolean)));
  try {
    const statuses = [];
    let c;
    for (let i = 0; i < 40; i++) { // wait for server
      await new Promise((r) => setTimeout(r, 150));
      if (logs.some((l) => l.includes('butter-drive on'))) break;
    }
    c = createButterClient({ url: `ws://127.0.0.1:${port}`, onStatus: (s) => statuses.push(s) });
    for (let i = 0; i < 30 && !c.status().connected; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(c.status().connected, 'connected');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(c.status().mock, true);

    c.drive('forward');
    await new Promise((r) => setTimeout(r, 1500)); // > 3x the TTL: only heartbeats keep it alive
    const motorLines = () => logs.filter((l) => l.includes('motors ->')).map((l) => l.split('motors -> ')[1]);
    assert.deepEqual(motorLines(), ['forward'], 'no watchdog stop while heartbeating: ' + logs.join('\n'));
    c.stop();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(motorLines(), ['forward', 'stop']);

    // timed turn (wink): stop must land ~500 ms later, timed in this process
    const n0 = logs.length;
    c.pulse('right', 500);
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(motorLines().slice(-2), ['right', 'stop']);
    const ts = logs.slice(n0).filter((l) => l.includes('motors ->')).map((l) => Date.parse(l.slice(0, 23).replace(',', '.').replace(' ', 'T')));
    assert.ok(ts[1] - ts[0] >= 450 && ts[1] - ts[0] <= 650, 'pulse length ' + (ts[1] - ts[0]));

    c.drive('left');
    await new Promise((r) => setTimeout(r, 200));
    srv.kill('SIGTERM'); // robot side dies mid-turn
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(c.status().connected, false);
    assert.equal(c.status().dir, 'stop', 'client forgets direction on disconnect (no resume on reconnect)');
    c.close();
  } finally {
    srv.kill('SIGKILL');
  }
});

// ------------------------------------------------------------ LIVE APIs (run when keys are in the environment)
const LIVE = !!(process.env.DEEPSEEK_API_KEY && process.env.ELEVENLABS_API_KEY);

test('LIVE DeepSeek: realistic conversations give 3 short, distinct, on-topic replies fast', { skip: !LIVE && 'no keys' }, async () => {
  const llm = createLLM({ apiKey: process.env.DEEPSEEK_API_KEY });
  const cases = [
    { name: 'greeting', persona: 'I am Linh, 58, ALS. My daughter is Mai.', convo: [{ who: 'them', text: 'Hi Mom! How are you feeling today?' }], expect: /good|ok|tired|well|fine|better|love|mai|you/i },
    { name: 'yes/no', persona: '', convo: [{ who: 'them', text: 'Do you want some water?' }], expect: /yes|no|please|thank|water|later/i },
    { name: 'nurse pain', persona: '', convo: [{ who: 'them', text: 'On a scale of 1 to 10, how bad is the pain right now?' }], expect: /\d|pain|bad|hurt|okay|fine/i },
    { name: 'follow-up after me', persona: '', convo: [{ who: 'them', text: 'The game is on tonight' }, { who: 'me', text: 'Who is playing?' }], expect: /./ },
    { name: 'empty -> openers', persona: 'Retired teacher, loves the Vikings.', convo: [], expect: /./ },
  ];
  const times = [];
  for (const c of cases) {
    const r = await llm.suggest({ conversation: c.convo, persona: c.persona, voiceExamples: [] });
    times.push(r.ms);
    console.log(`  [${c.name}] ${r.ms}ms ${r.source} ->`, JSON.stringify(r.replies));
    assert.equal(r.source, 'deepseek-flash', `${c.name}: fell back: ${r.error}`);
    assert.equal(r.replies.length, 3);
    assert.equal(new Set(r.replies.map((x) => x.toLowerCase())).size, 3, 'distinct');
    for (const x of r.replies) assert.ok(x.split(/\s+/).length <= 16, `too long: ${x}`);
    assert.ok(r.replies.some((x) => c.expect.test(x)), `${c.name}: off-topic ${r.replies}`);
    assert.ok(!r.replies.some((x) => /\bAI\b|language model|option/i.test(x)), 'no AI self-reference');
  }
  times.sort((a, b) => a - b);
  console.log(`  DeepSeek latency median ${times[2]} ms, max ${times[4]} ms`);
  assert.ok(times[2] < 4000, 'median under 4 s');
});

test('LIVE ElevenLabs: TTS -> 16 kHz WAV -> VAD -> Scribe round trip is word-accurate', { skip: !LIVE && 'no keys' }, async () => {
  const { createSpeech } = await import('../lib/speech.js');
  const sp = createSpeech({ apiKey: process.env.ELEVENLABS_API_KEY });
  const sentence = 'Can you please turn the lights off in the kitchen?';
  const tts = await sp.speak(sentence);
  console.log(`  TTS ${tts.ms} ms, ${tts.audio.length} bytes`);
  assert.ok(tts.audio.length > 5000);
  const again = await sp.speak(sentence);
  assert.equal(again.cached, false, 'long sentences are not cached');
  // decode mp3 -> PCM 48k, add room noise + silence, run through the app's VAD, encode like the app does
  const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { input: Buffer.from(tts.audio) });
  const speech = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const rate = 48000;
  const sig = new Float32Array(rate * 1 + speech.length + rate * 1.5);
  sig.set(speech, rate);
  for (let i = 0; i < sig.length; i++) sig[i] += (Math.random() - 0.5) * 0.004;
  const vad = new Vad(rate); let utt = null;
  for (let i = 0; i + 2048 <= sig.length; i += 2048) { const u = vad.push(sig.subarray(i, i + 2048)); if (u) utt = u; }
  assert.ok(utt, 'VAD found the sentence');
  const wav = encodeWav(downsample(utt, rate, 16000), 16000);
  const stt = await sp.transcribe(new Uint8Array(wav));
  console.log(`  Scribe ${stt.ms} ms: "${stt.text}"`);
  const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
  assert.equal(norm(stt.text), norm(sentence));
});
