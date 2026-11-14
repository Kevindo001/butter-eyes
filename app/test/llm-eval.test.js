// LIVE quality eval: 12 realistic scenarios, DeepSeek generates replies, a separate DeepSeek call
// grades them against a rubric. Plus hard rule checks in code. Run with keys in the env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../lib/llm.js';

const KEY = process.env.DEEPSEEK_API_KEY;

const SCENARIOS = [
  { id: 'daughter-hello', persona: 'Linh, 58, ALS for 3 years. Daughter Mai visits on weekends.', convo: [['them', 'Hi Mom! How are you feeling today?']] },
  { id: 'water', convo: [['them', 'Do you want some water?']], rule: (r) => r.some((x) => /^(yes|yeah|sure|please)/i.test(x)) && r.some((x) => /\b(no|not)\b/i.test(x)), ruleName: 'has a yes and a no' },
  { id: 'pain-scale', convo: [['them', 'On a scale of 1 to 10, how bad is the pain right now?']], rule: (r) => { const W = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }; const n = r.map((x) => { const m = x.toLowerCase().match(/\b(10|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten)\b/); return m ? (W[m[1]] || +m[1]) : 0; }).filter(Boolean); return n.length >= 2 && Math.max(...n) - Math.min(...n) >= 4; }, ruleName: 'numbers spread across the scale' },
  { id: 'own-question', convo: [['them', 'The game is on tonight'], ['me', 'Who is playing?']], rule: (r) => !r.some((x) => /^(the |it'?s the |i think)/i.test(x)), ruleName: 'does not answer own question' },
  { id: 'doctor', convo: [['them', "I'm going to adjust your feeding tube now, is that okay?"]] },
  { id: 'breathing', convo: [['them', 'You look uncomfortable. Is it your breathing?']], rule: (r) => !r.some((x) => /lol|haha|😂/i.test(x)), ruleName: 'no jokes when urgent' },
  { id: 'grandkid', persona: 'Grandpa Tom, loves fishing and the Twins.', convo: [['them', 'Grandpa! I caught my first fish today!']] },
  { id: 'friend-bad-news', convo: [['them', 'I got laid off today. Sorry to dump this on you.']] },
  { id: 'caregiver-tv', convo: [['them', 'Want me to put something on TV?'], ['me', 'Yes please'], ['them', 'Movie or the news?']] },
  { id: 'openers', persona: 'Retired nurse, two cats, loves gardening.', convo: [] },
  { id: 'spouse-love', persona: 'Married 30 years to Dan.', convo: [['them', 'I love you so much. I hate seeing you like this.']] },
  { id: 'plans', convo: [['them', 'What do you want to do this weekend?']], rule: (r) => !r.some((x) => /\b(on saturday at|at \d|o'?clock)\b/i.test(x)), ruleName: 'does not invent specific times' },
];

const JUDGE = `You grade reply options for an AAC (augmentative communication) app used by a person with ALS. The user picks ONE option by eye and it is spoken in first person.
Score the SET of 3 options from 1 to 5 (the user only ever sees these three):
5 = the best option is exactly what most people would want to say; options are natural, short, distinct, cover different intents, fit who is talking and the mood; nothing invented.
3 = usable but generic, repetitive, or one clear miss.
1 = wrong speaker/perspective, off-topic, inappropriate, or invents facts.
If the LAST line is from "Me (user)", the other person has not replied yet: good options are things the user would add while waiting, and answering the user's own question would be WRONG.
Return ONLY JSON: {"score": n, "problem": "<short, or empty>"}`;

async function judge(convo, replies) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'system', content: JUDGE }, { role: 'user', content: `Conversation:\n${convo.map(([w, t]) => `${w === 'me' ? 'Me (user)' : 'Them'}: ${t}`).join('\n') || '(none: openers)'}\n\nOptions (best first):\n${replies.map((x, i) => `${i + 1}. ${x}`).join('\n')}` }],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      temperature: 0,
      max_tokens: 150,
    }),
  });
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

test('LIVE reply quality eval (12 scenarios, LLM judge + hard rules)', { skip: !KEY && 'no DEEPSEEK_API_KEY', timeout: 180000 }, async () => {
  const llm = createLLM({ apiKey: KEY });
  const results = await Promise.all(SCENARIOS.map(async (s) => {
    const conversation = s.convo.map(([who, text]) => ({ who, text }));
    const r = await llm.suggest({ conversation, persona: s.persona || '', voiceExamples: [] });
    const g = await judge(s.convo, r.replies);
    const ruleOk = s.rule ? s.rule(r.replies) : true;
    return { ...s, r, g, ruleOk };
  }));
  let sum = 0;
  const fails = [];
  for (const x of results) {
    sum += x.g.score;
    console.log(`  ${x.g.score}/5 ${x.ruleOk ? '' : 'RULE FAIL (' + x.ruleName + ') '}[${x.id}] ${x.r.ms}ms ${JSON.stringify(x.r.replies)}${x.g.problem ? '  -- ' + x.g.problem : ''}`);
    if (x.r.source !== 'deepseek-flash') fails.push(`${x.id}: fallback ${x.r.error}`);
    if (!x.ruleOk) fails.push(`${x.id}: ${x.ruleName}`);
    if (x.g.score <= 2) fails.push(`${x.id}: judge ${x.g.score} ${x.g.problem}`);
  }
  const mean = sum / results.length;
  console.log(`  MEAN JUDGE SCORE ${mean.toFixed(2)} / 5`);
  assert.deepEqual(fails, []);
  assert.ok(mean >= 4.0, `mean ${mean}`);
});
