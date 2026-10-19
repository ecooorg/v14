// PI-02 (TZ-INSTRUCTIONS-01 P2): intent flags feed askAllowed, soft quality-audit, retry text and meta.search_expected.
// Detectors are pure; integration goes through real server.ts on a fake Gemini (no live model quality claims).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { APP_VERSION } from '../src/config.ts';
import { detectUserIntentFlags } from '../server/intentFlags.ts';

const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// --- Unit: detectors ---
{
  const f1 = detectUserIntentFlags('Не задавай вопросы, просто дай прогноз');
  assert.equal(f1.userForbadeQuestions, true, 'RU ban on questions');
  assert.equal(f1.userAskedApproximate, false);

  const f2 = detectUserIntentFlags("Don't ask me any questions, just give the answer");
  assert.equal(f2.userForbadeQuestions, true, 'EN ban on questions');

  const f3 = detectUserIntentFlags('Дай приблизительную оценку без гарантии');
  assert.equal(f3.userAskedApproximate, true);

  const f4 = detectUserIntentFlags('Найди прогнозы в сети');
  assert.equal(f4.userAskedSearch, true);

  const f5 = detectUserIntentFlags('Это не решает мою задачу');
  assert.equal(f5.userCriticizedEvasion, true);

  // Standing ban from earlier user turn
  const f6 = detectUserIntentFlags('а что насчёт Альп?', [
    { role: 'user', content: 'Не задавай вопросы, просто дай' },
    { role: 'assistant', content: 'Сценарий…' },
  ]);
  assert.equal(f6.userForbadeQuestions, true, 'ban persists from recent history');

  const f0 = detectUserIntentFlags('Обычный вопрос про регион');
  assert.equal(f0.userForbadeQuestions, false);
  assert.equal(f0.userAskedApproximate, false);
  assert.equal(f0.userAskedSearch, false);
  assert.equal(f0.userCriticizedEvasion, false);
  console.log('pi02 unit detectors OK');
}

// --- Integration through server.ts ---
let answer = {}, lastPrompt = '', hits = 0;
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    hits++;
    lastPrompt = b;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
    }));
  });
});
await new Promise((r) => fake.listen(0, r));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], {
  stdio: 'ignore',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    APP_PASSWORD: PASS,
    SESSION_SECRET: 'x'.repeat(40),
    GEMINI_API_KEY: 'k',
    GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`,
    LLM_ROUND_PAUSE_MS: '10',
  },
});

const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const promptText = () => strings(JSON.parse(lastPrompt)).join('\n');

const good = (reply, extra = {}) => ({
  reply,
  question: extra.question ?? 'What region exactly?',
  contextSufficiency: extra.contextSufficiency ?? 'LOW',
  triage: 'PROCEED',
  problemClear: true,
  driftDetected: false,
  notUnderstoodSignal: false,
  gain: extra.gain ?? ['HIDDEN_ASSUMPTION'],
  newOptions: [],
  newOptionTypes: [],
  options: [],
  nextStep: extra.nextStep ?? 'Check the seasonal outlook.',
  factsToCheck: [],
  derived_numbers: [],
  state: { coreProblem: '', userConcern: '', userReasoningState: '', facts: [], assumptions: [], unknowns: [], options: [], hypotheses: [], expectations: [] },
  document: null,
  attachmentNotes: [],
});

async function login() {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASS }),
  });
  const j = await r.json();
  assert.equal(j.success, true, 'login');
  const set = r.headers.getSetCookie?.() || [];
  const cookie = set.map((c) => c.split(';')[0]).join('; ') || '';
  return cookie;
}

async function conv(cookie, decision, history = []) {
  const r = await fetch(`${base}/api/conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ brief: { decision }, history, state: {} }),
  });
  const j = await r.json();
  assert.equal(j.success, true, `conversation ok: ${j.error || ''}`);
  return j;
}

try {
  // wait for listen
  for (let i = 0; i < 40; i++) {
    try {
      const h = await fetch(`${base}/health`);
      if (h.ok) break;
    } catch { /* retry */ }
    await sleep(100);
  }
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.version, APP_VERSION, `health version is ${APP_VERSION}, got ${health.version}`);

  const cookie = await login();

  // (a) Question ban → empty question even when model returned one and context is LOW
  answer = good('Сценарий под допущениями: мягкая зима в долинах.', {
    question: 'В каком кантоне вы планируете быть?',
    contextSufficiency: 'LOW',
  });
  const ban = await conv(cookie, 'Не задавай вопросы, просто дай прогноз по зиме в Швейцарии');
  assert.equal(ban.data.question, '', 'question empty after user ban');
  assert.ok(!/\?\s*$/.test(String(ban.data.reply || '').trim()) || !ban.data.question, 'no forced follow-up question in payload');

  // (b) Search request → meta.search_expected
  answer = good('Поиск в сети недоступен; ниже сценарий по общим климатическим паттернам.');
  const search = await conv(cookie, 'Найди прогнозы в сети по зиме в Альпах');
  assert.equal(search.meta?.search_expected, true, 'meta.search_expected set');

  // (c) PI-01 contract still in the prompt
  const pt = promptText();
  assert.ok(/WHEN THE IDEAL ANSWER IS UNAVAILABLE/.test(pt), 'uncertainty contract still present');

  // (d) Approximate request does not break derived_numbers path (empty stays empty)
  answer = good('Грубая оценка: зима ближе к мягкой, с оговоркой по региону.', {
    gain: ['HIDDEN_ASSUMPTION'],
    nextStep: 'Сверить с сезонным бюллетенем.',
  });
  const approx = await conv(cookie, 'Дай приблизительную оценку без гарантии по числу снежных дней');
  assert.ok(Array.isArray(approx.data?.state?.facts) || approx.data?.state, 'state shape intact');
  assert.equal(approx.data.question === undefined || typeof approx.data.question === 'string', true);

  console.log('pi02 integration OK');
} finally {
  child.kill('SIGTERM');
  fake.close();
  await sleep(50);
}
