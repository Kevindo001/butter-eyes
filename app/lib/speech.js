// ElevenLabs speech: Scribe speech-to-text (what the other person says) and TTS (the user's voice).
// Main process only. A cloned voice ID can be set in Settings, so the user can speak in their own
// banked voice (ElevenLabs runs a free voice-banking program for people with ALS).
const BASE = 'https://api.elevenlabs.io/v1';
export const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

export function createSpeech({ apiKey, sttModel = 'scribe_v1', ttsModel = 'eleven_flash_v2_5', fetchImpl = globalThis.fetch } = {}) {
  const ttsCache = new Map(); // quick phrases are spoken often: cache them

  return {
    enabled: !!apiKey,

    async transcribe(wavBytes) {
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
      const t0 = Date.now();
      const form = new FormData();
      form.append('model_id', sttModel);
      form.append('language_code', 'en');
      form.append('tag_audio_events', 'false');
      form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'utt.wav');
      const r = await fetchImpl(`${BASE}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
      if (!r.ok) throw new Error(`Scribe ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return { text: String(j.text || '').trim(), ms: Date.now() - t0 };
    },

    async speak(text, voiceId = DEFAULT_VOICE) {
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
      const key = `${voiceId}|${text}`;
      if (ttsCache.has(key)) return { audio: ttsCache.get(key), ms: 0, cached: true };
      const t0 = Date.now();
      const r = await fetchImpl(`${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ttsModel, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
      });
      if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const audio = new Uint8Array(await r.arrayBuffer());
      if (text.length < 40) ttsCache.set(key, audio);
      return { audio, ms: Date.now() - t0, cached: false };
    },
  };
}
