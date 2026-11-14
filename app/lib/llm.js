// Reply suggestions via DeepSeek (OpenAI-compatible API). Runs in the Electron main process only,
// so the API key never reaches the renderer.
//
// suggest({ conversation, persona, voiceExamples }) -> { replies: string[3] (best first), ms, source }

const URL = 'https://api.deepseek.com/chat/completions';

export const FALLBACK = {
  them: ["Yes", "No", "Can you say that again?"],
  me: ["How are you?", "Thank you", "Can you help me?"],
};

export const SYSTEM_PROMPT = `You write reply options for a person with ALS who cannot speak or move. They pick one option with their eyes and it is spoken aloud in their voice. Picking costs them effort, so the FIRST option must be the reply they most likely want; they only ever see three.

Return ONLY JSON: {"replies": ["...", "...", "..."]}

Rules:
- Exactly 3 replies, ordered from most likely to least likely.
- First person, spoken style, as the user. Usually 2-10 words. Never more than 14 words.
- Make them genuinely different: usually the most likely answer, the opposite answer, and a question back or a need.
- If the last line is from the other person (Them), reply to it.
- If the last line is from the user (Me), the other person has NOT answered yet. Offer what the user might add next while waiting (a follow-up, an add-on, a new topic). Never answer the user's own question for the other person.
- For yes/no questions include both a yes and a no. For scales or numbers (e.g. pain 1-10) spread the three options across the range (low, medium, high).
- If the user's needs are urgent (pain, breathing, help), keep replies clear and literal; no jokes.
- Match the relationship and mood of the conversation. Use the user's own style from their profile and past choices.
- Never invent specific facts (times, places, names, medical details) that are not in the conversation or profile; ask instead.
- Never mention being an AI, a model, or "options".`;

export function buildMessages({ conversation = [], persona = '', voiceExamples = [] }) {
  const convo = conversation.slice(-16).map((m) => `${m.who === 'me' ? 'Me' : 'Them'}: ${m.text}`).join('\n');
  const parts = [];
  if (persona?.trim()) parts.push(`About the user:\n${persona.trim()}`);
  if (voiceExamples.length) parts.push(`Things the user chose to say before (their style):\n${voiceExamples.slice(-15).map((s) => `- ${s}`).join('\n')}`);
  parts.push(`Conversation so far:\n${convo || '(nothing yet: suggest openers)'}`);
  const last = conversation.at(-1);
  if (last) parts.push(last.who === 'me'
    ? 'The last line is the USER. Suggest what the user could say next while the other person has not replied yet.'
    : 'The last line is the OTHER PERSON. Suggest the user\'s reply to it.');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function parseReplies(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const obj = JSON.parse(t);
  let replies = Array.isArray(obj) ? obj : obj.replies;
  if (!Array.isArray(replies)) throw new Error('no replies array');
  const seen = new Set();
  replies = replies
    .map((r) => String(typeof r === 'object' && r ? r.text ?? '' : r).replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, ''))
    .filter((r) => r && r.length <= 120 && !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
  return replies;
}

export function createLLM({ apiKey, model = 'deepseek-flash', timeoutMs = 9000, fetchImpl = globalThis.fetch } = {}) {
  async function call(messages) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' }, // ~1.7 s instead of ~2.5 s+, same quality for this task
          temperature: 0.8,
          max_tokens: 200,
        }),
      });
      if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return j.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async suggest(input) {
      const t0 = Date.now();
      const last = input.conversation?.at(-1);
      const fallback = FALLBACK[last?.who === 'me' || !last ? 'me' : 'them'];
      if (!apiKey) return { replies: fallback, ms: 0, source: 'offline', error: 'DEEPSEEK_API_KEY not set' };
      const messages = buildMessages(input);
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const replies = parseReplies(await call(messages));
          if (replies.length >= 2) {
            while (replies.length < 3) replies.push(fallback.find((f) => !replies.includes(f)));
            return { replies: replies.slice(0, 3), ms: Date.now() - t0, source: model };
          }
          lastErr = new Error('too few replies');
        } catch (e) {
          lastErr = e;
          if (e.name === 'AbortError') break;
        }
      }
      return { replies: fallback, ms: Date.now() - t0, source: 'fallback', error: String(lastErr?.message || lastErr) };
    },
  };
}

// Center layout: the most likely reply sits in the middle, where the selection starts.
// [2nd, 1st, 3rd]
export function centerOut(replies) {
  return [1, 0, 2].map((i) => replies[i]).filter((x) => x !== undefined);
}
