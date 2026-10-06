// S2-06 blind acceptance on a LIVE model: runs the 10 situations on two servers and writes a BLIND sheet.
// Usage (two servers started from two archives, e.g. ports 3001 = v16.5, 3002 = v17):
//   A_URL=http://localhost:3001 B_URL=http://localhost:3002 A_LABEL=v18 B_LABEL=v19 APP_PASSWORD=... BYOK_KEY=<your free Gemini key> node scripts/acceptance-s2-06.mjs
// A = the reference build (v18, or v17.5 / v17.0), B = the build under test (v19, or v19 with a shortened prompt).
// Your own key (x-byok-key) is not counted in the server's daily cap. ~10-12 calls per server.
// Output: acceptance-blind.md (read and rate it) and acceptance-key.json (open ONLY after rating).
import fs from 'node:fs';
const { A_URL, B_URL, APP_PASSWORD = '', BYOK_KEY = '', A_LABEL = 'v18', B_LABEL = 'v19' } = process.env;
if (!A_URL || !B_URL) { console.error('Set A_URL (reference) and B_URL (build under test).'); process.exit(1); }

import { CASES } from './cases.mjs';

async function login(base) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: APP_PASSWORD }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function ask(base, cookie, brief, history, state) {
  const r = await fetch(base + '/api/conversation', { method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, ...(BYOK_KEY ? { 'x-byok-key': BYOK_KEY } : {}) },
    body: JSON.stringify({ brief: { decision: brief }, history, state }) });
  const j = await r.json();
  if (!j.success) return { reply: '[ERROR] ' + j.error, state, meta: {} };
  return { reply: j.data.reply, state: j.data.state, meta: j.meta || {} };
}
async function run(base, cookie, [, first, second]) {
  let h = [{ role: 'user', content: first }];
  let o = await ask(base, cookie, first, h);
  let chars = o.meta.promptChars || 0, tokens = o.meta.inputTokens || 0;
  if (second) { h = [...h, { role: 'assistant', content: o.reply }, { role: 'user', content: second }]; o = await ask(base, cookie, first, h, o.state); chars += o.meta.promptChars || 0; tokens += o.meta.inputTokens || 0; }
  return { reply: o.reply, chars, tokens };
}
const flags = (t, size = {}) => ({ chars: size.chars, tokens: size.tokens, words: t.split(/\s+/).length, questions: (t.match(/[?？]/g) || []).length,
  markdown: /(\*\*|^#{1,6}\s|`|^\s*\*\s)/m.test(t), labels: /(USER FACT|HYPOTHESIS|problemClear|driftDetected|\b(?:UNDERSTAND|EXPAND|ATTACK)\b)/.test(t) });

const [ca, cb] = [await login(A_URL), await login(B_URL)];
let md = '# Blind comparison (S2-06)\nFor each case rate X and Y: shorter and more precise? no retelling of the question? no invented numbers/facts? max one question related to the problem? no markup or service labels? Then: does one of them feel different from an ordinary chat assistant? Compare also with an ordinary chat assistant answering the same situations.\n\n';
const key = [];
let i = 0;
for (const c of CASES) {
  i++;
  const [oa, ob] = [await run(A_URL, ca, c), await run(B_URL, cb, c)];
  const [ra, rb] = [oa.reply, ob.reply];
  const swap = Math.random() < 0.5;            // hide which is which
  const [x, y] = swap ? [rb, ra] : [ra, rb];
  md += `## ${i}. ${c[1]}${c[2] ? '\n(then the person writes: ' + c[2] + ')' : ''}\n\n### X\n${x}\n\n### Y\n${y}\n\nRating: \n\n`;
  key.push({ case: i, name: c[0], X: swap ? B_LABEL : A_LABEL, Y: swap ? A_LABEL : B_LABEL, auto: { [A_LABEL]: flags(ra, oa), [B_LABEL]: flags(rb, ob) } });
  console.log('done', i);
}
fs.writeFileSync('acceptance-blind.md', md);
fs.writeFileSync('acceptance-key.json', JSON.stringify(key, null, 1));
const sum = (v, f) => key.reduce((n, k) => n + f(k.auto[v]), 0);
for (const v of [A_LABEL, B_LABEL]) console.log(v, 'avg prompt chars', Math.round(sum(v, (a) => a.chars || 0) / key.length), 'avg input tokens', Math.round(sum(v, (a) => a.tokens || 0) / key.length), 'avg words', Math.round(sum(v, (a) => a.words) / key.length), 'questions>1:', key.filter((k) => k.auto[v].questions > 1).length, 'markdown:', key.filter((k) => k.auto[v].markdown).length, 'labels:', key.filter((k) => k.auto[v].labels).length);
