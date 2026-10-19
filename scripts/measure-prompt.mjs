// PERF-01: measures prompt size (chars) and tokens (if the API returns them) per request.
// Usage: BASE_URL=http://localhost:3001 APP_PASSWORD=... BYOK_KEY=<your free Gemini key> node scripts/measure-prompt.mjs
// Runs the 10 control situations (first message + second where the case has one) and one 4-turn dialogue.
// Reads only `meta` (promptChars, inputTokens, outputTokens, calls); writes perf-report.json and prints a summary.
import fs from 'node:fs';
import { CASES } from './cases.mjs';
const { BASE_URL, APP_PASSWORD = '', BYOK_KEY = '' } = process.env;
if (!BASE_URL) { console.error('Set BASE_URL.'); process.exit(1); }

async function login() {
  const r = await fetch(BASE_URL + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: APP_PASSWORD }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const cookie = await login();
async function ask(brief, history, state) {
  const r = await fetch(BASE_URL + '/api/conversation', { method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, ...(BYOK_KEY ? { 'x-byok-key': BYOK_KEY } : {}) },
    body: JSON.stringify({ brief: { decision: brief }, history, state }) });
  const j = await r.json();
  if (!j.success) throw new Error(j.error || 'request failed');
  return { reply: j.data.reply, state: j.data.state, meta: j.meta || {} };
}
const row = (label, m) => ({ label, promptChars: m.promptChars ?? null, inputTokens: m.inputTokens ?? null, outputTokens: m.outputTokens ?? null, calls: m.calls ?? null });

const rows = [];
for (const [name, first, second] of CASES) {
  let h = [{ role: 'user', content: first }];
  let o = await ask(first, h);
  rows.push(row(`${name} #1`, o.meta));
  if (second) {
    h = [...h, { role: 'assistant', content: o.reply }, { role: 'user', content: second }];
    o = await ask(first, h, o.state);
    rows.push(row(`${name} #2`, o.meta));
  }
}
// one dialogue of 4 turns: how the prompt grows with history
const turns = ['Не знаю, стоит ли мне менять работу.', 'Платят нормально, но я не вижу роста.', 'Есть предложение от другой компании, но там нужно переехать.', 'Жена не против, но дети в школе.'];
let h = [], st, o;
for (let i = 0; i < turns.length; i++) {
  h = [...h, { role: 'user', content: turns[i] }];
  o = await ask(turns[0], h, st);
  st = o.state;
  rows.push(row(`dialogue turn ${i + 1}`, o.meta));
  h = [...h, { role: 'assistant', content: o.reply }];
}
const stat = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.length ? { avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v), n: v.length } : null; };
const summary = { requests: rows.length, promptChars: stat('promptChars'), inputTokens: stat('inputTokens'), outputTokens: stat('outputTokens'), callsOverOne: rows.filter((r) => r.calls > 1).length };
fs.writeFileSync('perf-report.json', JSON.stringify({ rows, summary }, null, 1));
console.table(rows);
console.log('SUMMARY', JSON.stringify(summary));
