// PI-03 (TZ-INSTRUCTIONS-01 P3): thin mode paragraph on the shared conversation prompt.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { APP_VERSION } from '../src/config.ts';
import { detectConversationMode, modeParagraph } from '../server/conversationMode.ts';

const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// --- Unit ---
{
  assert.equal(detectConversationMode('Что мне делать с этим выбором?'), 'decision');
  assert.equal(detectConversationMode('Найди прогнозы в сети'), 'research');
  assert.equal(detectConversationMode('compare these two options from sources'), 'research');
  assert.equal(detectConversationMode('Напиши unit test и acceptance criteria для API'), 'engineering');
  // MP2: unclear intent defaults to information; decision only on explicit signals.
  assert.equal(detectConversationMode('обычный текст без сигналов'), 'information');
  // Personal dilemmas without the usual keywords are decisions (MP2 follow-up).
  assert.equal(detectConversationMode('Скажи прямо: мне оставаться в городе с родителями или ехать учиться в другой?'), 'decision');
  assert.equal(detectConversationMode('Хочу поговорить с мужем, но боюсь, что он обидится.'), 'decision');
  assert.equal(detectConversationMode('Расскажи, как работать или отдыхать эффективнее'), 'information');
  assert.equal(detectConversationMode('Хочу уволиться завтра же.'), 'information');
  assert.equal(detectConversationMode('что угодно', { userAskedSearch: true }), 'research');
  assert.ok(/Decision support/i.test(modeParagraph('decision')));
  assert.ok(/Research/i.test(modeParagraph('research')));
  assert.ok(/Engineering/i.test(modeParagraph('engineering')));
  assert.ok(!/HARD BOUNDARIES/i.test(modeParagraph('decision')));
  console.log('pi03 unit OK');
}

// --- Integration ---
let answer = {}, lastPrompt = '';
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
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
const promptText = () => { try { return strings(JSON.parse(lastPrompt)).join('\n'); } catch { return lastPrompt; } };

const good = (reply, extra = {}) => ({
  reply,
  question: extra.question ?? '',
  contextSufficiency: extra.contextSufficiency ?? 'HIGH',
  triage: 'PROCEED',
  problemClear: true,
  driftDetected: false,
  notUnderstoodSignal: false,
  gain: ['HIDDEN_ASSUMPTION'],
  newOptions: [],
  newOptionTypes: [],
  options: [],
  nextStep: 'Check one fact.',
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
  return set.map((c) => c.split(';')[0]).join('; ') || '';
}

async function conv(cookie, decision, history = []) {
  const r = await fetch(`${base}/api/conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ brief: { decision }, history, state: {} }),
  });
  const j = await r.json();
  assert.equal(j.success, true, `conversation: ${j.error || ''}`);
  return j;
}

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* */ }
    await sleep(100);
  }
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.version, APP_VERSION, `health version is ${APP_VERSION}, got ${health.version}`);

  const cookie = await login();

  answer = good('Сценарий под допущениями.');
  const research = await conv(cookie, 'Найди прогнозы в сети по зиме в Альпах');
  assert.equal(research.meta?.conversation_mode, 'research', 'meta.conversation_mode research');
  const ptR = promptText();
  assert.ok(/CURRENT FOCUS: Research/i.test(ptR), 'research paragraph in prompt');
  assert.ok(/WHEN THE IDEAL ANSWER IS UNAVAILABLE/.test(ptR), 'PI-01 contract still present');

  answer = good('Ветки решения.');
  const decision = await conv(cookie, 'Что мне делать: остаться или уехать?');
  assert.equal(decision.meta?.conversation_mode, 'decision', 'meta decision');
  assert.ok(/CURRENT FOCUS: Decision support/i.test(promptText()), 'decision paragraph in prompt');

  answer = good('Требования и критерии.');
  const eng = await conv(cookie, 'Напиши acceptance criteria и unit test для этого API');
  assert.equal(eng.meta?.conversation_mode, 'engineering', 'meta engineering');
  assert.ok(/CURRENT FOCUS: Engineering/i.test(promptText()), 'engineering paragraph in prompt');

  // PI-02 ban still works under a mode
  answer = good('Ответ без вопроса.', { question: 'Уточните регион?', contextSufficiency: 'LOW' });
  const ban = await conv(cookie, 'Не задавай вопросы, просто дай прогноз');
  assert.equal(ban.data.question, '', 'PI-02 question ban still holds');

  console.log('pi03 integration OK');
} finally {
  child.kill('SIGTERM');
  fake.close();
  await sleep(50);
}
