// Reply suggestions via DeepSeek (OpenAI-compatible API). Runs in the Electron main process only,
// so the API key never reaches the renderer.
//
// suggest({ conversation, persona, voiceExamples }) -> { replies: string[3] (best first), ms, source }

const URL = 'https://api.deepseek.com/chat/completions';

export const FALLBACK = {
  them: ["Yes", "No", "Can you say that again?"],
  me: ["How are you?", "Thank you", "Can you help me?"],
};

export const SYSTEM_PROMPT = `You write the three things a person is most likely to want to say next. The person has ALS: they cannot speak or move, so they choose one of your three lines with their eyes and it is spoken aloud as them. They are an ordinary, sharp adult with a sense of humour, talking with friends, family and strangers. Write what a real person would actually say out loud in this exact conversation.

Return ONLY JSON: {"replies": ["...", "...", "..."]}

How to write them:
- Exactly 3 replies, most likely first. First person, as the user.
- Sound like relaxed spoken American English: contractions, short, natural. Usually 2 to 10 words, never more than 14. No stiff or formal phrasing, no therapy-speak, no filler like "That's a great question".
- Actually answer. If they are asked something, the replies ARE answers, not dodges. For small talk ("how's it going?"), give real, different answers a person might give (good / tired / a joke), and it is fine to ask back.
- For general-knowledge or pop-culture questions, answer with real, correct, well-known facts (for example name actual songs by an artist). If you are not sure of a fact, give an honest "not sure" style reply rather than making one up.
- The three must be genuinely different choices, not rewordings: typically the most likely answer, a clearly different answer (often the opposite), and a third angle (a question back, a joke, or a need).
- For a yes/no question about the user, include a clear yes and a clear no.
- For scales or numbers (pain 1-10), give one low, one middle and one high answer.
- If the last line is from the other person (Them), reply to it.
- If the last line is from the user (Me), the other person has NOT answered yet: offer what the user might add next. Never answer the user's own question for the other person.
- Match the mood: joke back when people are joking, be warm when they are warm. If it is urgent (pain, breathing, needing help), be clear and literal, no jokes.
- Never invent personal facts about the user (their plans, history, medical details, names of people they know) that are not in the conversation or profile.
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
