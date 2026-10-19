// MP2: shared prompt core + light Simple/information contract.
// Unit: classification, prompt assembly (information vs decision/research/engineering), Expert/Project instructions kept.
// Integration: real server.ts against a fake Gemini (no key, no network).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { detectConversationMode, modeParagraph } from '../server/conversationMode.ts';
import { buildSimpleConversationPrompt, EXPERT_STEP_PREFIX } from '../server/promptPacks.ts';
import { buildPromptCore } from '../server/promptCore.ts';
import { ANALYST_INSTRUCTION } from '../server/contextBuilder.ts';

const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---------- Unit: classification ----------
{
  const info = [
    'Расскажи про зиму в Граубюндене', 'Объясни, как работает ипотека', 'Подскажи, какая погода бывает в феврале в Альпах',
    'Какая температура зимой в Граубюндене?', 'Сколько снега выпадает в Давосе', 'Где лучше всего видно северное сияние',
    'Tell me about winters in Graubünden', 'Explain how a mortgage works', 'What is a bifurcation diagram',
    'обычный текст без сигналов', 'Короче, всё сложно.',
  ];
  for (const t of info) assert.equal(detectConversationMode(t), 'information', `information: ${t}`);
  const decision = [
    'Что мне делать с этим выбором?', 'Стоит ли переезжать в другую страну?', 'Не могу выбрать между двумя вариантами',
    'Скажи прямо: мне оставаться в городе или ехать учиться в другой?', 'Расскажи, стоит ли мне менять профессию', 'Should I take the offer?',
  ];
  for (const t of decision) assert.equal(detectConversationMode(t), 'decision', `decision: ${t}`);
  assert.equal(detectConversationMode('Найди прогнозы погоды в сети'), 'research');
  assert.equal(detectConversationMode('Напиши unit test для API'), 'engineering');
  assert.equal(detectConversationMode('что угодно', { userAskedSearch: true }), 'research');
  // The paragraph no longer refers to rituals that the information prompt does not contain.
  assert.ok(!/STEP 0|SECOND TEST|homework/i.test(modeParagraph('information')));
  console.log('mp2 classification OK');
}

// ---------- Unit: prompt assembly ----------
const RITUALS = ['STEP 0 - TRIAGE', 'STEP 1 - FIND THE REAL QUESTION', 'STEP 2 - LABEL THE CONTEXT', 'STEP 3 - CHANGE THE SHAPE', 'STEP 4 - FIND THE DECISIVE UNKNOWN', 'STEP 5 - CRITIQUE SYMMETRICALLY', 'STEP 6 - COMPUTE WHEN NUMBERS EXIST',
  'SECOND TEST:', 'NO HOMEWORK:', 'WHAT THE PERSON SHOULD EXPERIENCE', 'BEFORE ANSWERING (silent)', 'V17 LAYER'];
const UNIVERSAL = ['CURRENT DATE (server-provided): 2026-10-14', 'LANGUAGE', 'HONESTY ABOUT FACTS AND SEARCH', 'SAFETY', 'WHEN THE IDEAL ANSWER IS UNAVAILABLE',
  'Never claim to have searched', 'FILES THE PERSON ATTACHES', 'DOCUMENTS AND FILES YOU HAND OVER', 'HARD BOUNDARIES', 'Return JSON only', 'User brief and conversation:\nQ-INPUT'];
{
  const build = (mode, withMode = true) => buildSimpleConversationPrompt('Q-INPUT', '', modeParagraph(mode), '2026-10-14', ...(withMode ? [mode] : []));
  const info = build('information');
  const heavy = { decision: build('decision'), research: build('research'), engineering: build('engineering'), noMode: build('decision', false) };
  for (const k of UNIVERSAL) assert.ok(info.includes(k), `information prompt keeps: ${k}`);
  for (const k of RITUALS) assert.ok(!info.includes(k), `information prompt drops: ${k}`);
  assert.ok(info.includes('CURRENT FOCUS: Information request'), 'information paragraph present');
  assert.ok(info.includes('CRISIS'), 'crisis triage kept for information');
  assert.ok(info.startsWith(buildPromptCore('2026-10-14')), 'shared core first');
  for (const [name, p] of Object.entries(heavy)) {
    for (const k of [...RITUALS, ...UNIVERSAL.filter((x) => !x.startsWith('User brief'))]) assert.ok(p.includes(k), `${name} prompt keeps: ${k}`);
    assert.ok(p.includes('Never choose, rank, recommend'), `${name}: decision boundary kept`);
    assert.ok(p.startsWith(buildPromptCore('2026-10-14')), `${name}: shared core first`);
  }
  assert.ok(heavy.decision.includes('CURRENT FOCUS: Decision support') && heavy.research.includes('CURRENT FOCUS: Research') && heavy.engineering.includes('CURRENT FOCUS: Engineering'));
  assert.equal(heavy.noMode, heavy.decision, 'omitting mode keeps the full decision body');
  // Size: the information prompt must be clearly lighter than the full one.
  const sizes = { information: info.length, decision: heavy.decision.length, research: heavy.research.length, engineering: heavy.engineering.length };
  assert.ok(sizes.information < sizes.decision * 0.6, `information prompt is much smaller: ${JSON.stringify(sizes)}`);
  console.log('mp2 prompt size (chars):', JSON.stringify(sizes));
  // Expert and Project instructions are untouched.
  assert.ok(EXPERT_STEP_PREFIX.includes('Do not choose or rank options for the person') && EXPERT_STEP_PREFIX.includes('explicit assumptions'));
  assert.ok(ANALYST_INSTRUCTION.includes('Prefer operational precision') && ANALYST_INSTRUCTION.includes('Do not chat or coach'));
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(server.includes('EXPERT_STEP_PREFIX + prompt'), 'Expert path still prefixes its steps');
  console.log('mp2 prompt assembly OK');
}

// ---------- Integration: fake Gemini ----------
let answer = {}, lastPrompt = '', hits = 0;
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    hits++; lastPrompt = b;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }));
  });
});
await new Promise((r) => fake.listen(0, r));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], {
  stdio: 'ignore',
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS, SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_ROUND_PAUSE_MS: '10' },
});
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const promptText = () => { try { return strings(JSON.parse(lastPrompt)).join('\n'); } catch { return lastPrompt; } };

async function login() {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  assert.equal((await r.json()).success, true, 'login');
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}
async function conv(cookie, text) {
  hits = 0;
  const r = await fetch(`${base}/api/conversation`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ brief: { decision: text }, history: [{ role: 'user', content: text }], state: {} }) });
  const j = await r.json();
  assert.equal(j.success, true, `conversation: ${j.error || ''}`);
  return j;
}
// A light answer: no gain / options / newOptions / nextStep / derived_numbers at all.
const light = (reply, extra = {}) => ({ reply, question: '', contextSufficiency: 'HIGH', triage: 'PROCEED', problemClear: true, driftDetected: false, notUnderstoodSignal: false, document: null, attachmentNotes: [], state: { facts: [], hypotheses: [] }, ...extra });

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* */ } await sleep(100); }
  const cookie = await login();

  // 1. Information request: light prompt, light answer accepted, one model call, compatible response shape.
  answer = light('Зимой в Граубюндене обычно холодно и снежно; в долинах слабее, чем на высоте. Это общий ориентир, его стоит проверить по свежему прогнозу.');
  const info = await conv(cookie, 'Расскажи про зиму в Граубюндене');
  assert.equal(info.meta.conversation_mode, 'information');
  assert.equal(info.meta.calls, 1, 'information: no quality retry');
  assert.equal(hits, 1);
  const pi = promptText();
  assert.ok(/CURRENT FOCUS: Information/.test(pi) && !/STEP 0 - TRIAGE|SECOND TEST|NO HOMEWORK|BEFORE ANSWERING/.test(pi), 'information prompt reaches the model without rituals');
  assert.ok(/WHEN THE IDEAL ANSWER IS UNAVAILABLE/.test(pi) && /HONESTY ABOUT FACTS AND SEARCH/.test(pi), 'core + unavailable-answer contract reach the model');
  const d = info.data;
  assert.equal(typeof d.reply, 'string');
  for (const k of ['gain', 'options', 'newOptions', 'newOptionTypes', 'factsToCheck']) assert.ok(Array.isArray(d[k]) && d[k].length === 0, `backward-compatible field ${k} is an empty array`);
  assert.equal(d.nextStep, '');
  assert.equal(d.triage, 'PROCEED');
  assert.ok(d.state && Array.isArray(d.state.facts), 'state is present');

  // 2. Information request answered with the old full shape still works.
  answer = light('Короткий ответ по существу.', { gain: [], options: [], newOptions: [], newOptionTypes: [], nextStep: '', factsToCheck: ['Свежий прогноз'], derived_numbers: [] });
  const info2 = await conv(cookie, 'Объясни, как работает ипотека');
  assert.equal(info2.meta.calls, 1);
  assert.deepEqual(info2.data.factsToCheck, ['Свежий прогноз']);

  // 3. Decision request: full method in the prompt; a weak draft is still retried (decision contract not weakened).
  answer = light('Ветки решения.', { gain: [], newOptions: [] });
  const dec = await conv(cookie, 'Стоит ли мне переезжать в другую страну?');
  assert.equal(dec.meta.conversation_mode, 'decision');
  assert.ok(/STEP 0 - TRIAGE/.test(promptText()) && /SECOND TEST/.test(promptText()), 'decision prompt keeps the full method');
  assert.equal(dec.meta.calls, 2, 'decision: quality retry preserved');

  // 4. Crisis path still works for an information-shaped message.
  answer = light('Мне важно, чтобы рядом был живой человек.', { triage: 'CRISIS' });
  const crisis = await conv(cookie, 'Расскажи, как справляться, когда всё безнадёжно');
  assert.equal(crisis.data.triage, 'CRISIS');
  assert.ok(/immediate danger/i.test(crisis.data.reply), 'crisis block appended');

  console.log('mp2 integration OK');
} finally {
  child.kill('SIGTERM');
  fake.close();
  await sleep(50);
}
