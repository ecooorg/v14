// PI-01 (TZ-INSTRUCTIONS-01 P1): the uncertainty contract is in the conversation prompt, and the six-step
// "winter in Switzerland" dialog passes through the real server.ts (fake Gemini) without breaking honesty
// guards. The fake model cannot prove live answer quality; this test proves the prompt and the server path.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let answer = {}, lastPrompt = '', hits = 0;
const fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  hits++; lastPrompt = b; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] })); }); });
await new Promise((r) => fake.listen(0, r));
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS,
  SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_ROUND_PAUSE_MS: '10' } });

// Text of the prompt actually sent to the model (the request body is JSON; read the user content out of it).
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const promptText = () => strings(JSON.parse(lastPrompt)).join('\n');
const MARKUP = /\*\*|__|^#{1,6}\s|`/m;
const claimsSearch = /\b(I searched|I have searched|I found online|I checked the (web|sources|bulletins))\b|я (поискал|нашёл в сети|нашел в сети|проверил источники)/i;

// A reply of the shape the contract asks for: one sentence on what is unavailable, then a scenario with its basis.
const good = (reply, extra = {}) => ({ reply, question: '', contextSufficiency: 'HIGH', triage: 'PROCEED', problemClear: true,
  driftDetected: false, notUnderstoodSignal: false, gain: ['HIDDEN_ASSUMPTION'], newOptions: [], newOptionTypes: [], options: [],
  nextStep: 'Open the national weather service seasonal outlook and compare it with this scenario.',
  factsToCheck: ['Seasonal outlook of the national weather service for the coming winter'], derived_numbers: [],
  state: { coreProblem: 'Winter outlook for Switzerland', facts: ['Region: Switzerland'], hypotheses: ['Milder than the old average at low altitude'] }, ...extra });

const STEPS = [
  { say: 'Регион: Швейцария. Какие климатические изменения ожидаются на зиму 2026-2027?',
    reply: 'Точный сезонный прогноз на такой горизонт недоступен: надёжных прогнозов погоды на зиму так далеко вперёд не существует. Лучший доступный результат: сценарий по долгим трендам. Он опирается на общее потепление последних десятилетий, а не на проверенные данные. Вероятнее мягче старой нормы на низких высотах, снег на высоте менее надёжен. Это сценарий, а не прогноз.' },
  { say: 'не задавай мне вопросы просто дай прогноз',
    reply: 'Прогноза в смысле обещания нет. Приблизительная оценка: сценарий с более короткой снежной порой на низких высотах и частыми оттепелями. Это допущение из тренда, не факт. Главная неопределённость: сезонные колебания атмосферы, которые заранее не видны.' },
  { say: 'дай свою аналитику какой будет эта зима',
    reply: 'Аналитика при явных допущениях: если сохраняется тренд потепления, зима вероятнее мягкая внизу; если случится холодное вторжение, сценарий меняется. Проверить можно по сезонному бюллетеню метеослужбы, когда он выйдет. Пока это гипотеза.' },
  { say: 'найди прогнозы которые на эту зиму есть в сети',
    reply: 'Поиск в сети здесь не выполнялся, поэтому ничего не проверено и пересказать найденное я не могу. Что можно проверить самому: сезонный бюллетень национальной метеослужбы и обзоры европейского центра среднесрочных прогнозов. Сравните их с моим сценарием.' },
  { say: 'я тебе запрещаю говорить ни о чём дай мне ответ',
    reply: 'Ответ: сценарий мягкой зимы внизу и менее надёжного снега в среднегорье. Основа: тренд, не проверка источников. Уверенность низкая.' },
  { say: 'ты увиливаешь, дай образец запроса и выполни его',
    reply: 'Другой подход: образец запроса для проверки. Какие индикаторы сезонного прогноза для Швейцарии на зиму: аномалия температуры, осадки, снеговая линия. Выполнить его я не могу, потому что поиска нет; по индикаторам можно сравнить бюллетень со сценарием выше.' },
];

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(250); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  let history = [], state;
  for (const [n, step] of STEPS.entries()) {
    history = [...history, { role: 'user', content: step.say }];
    answer = good(step.reply); hits = 0;
    const r = await (await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ brief: { decision: STEPS[0].say }, history, state }) })).json();
    assert.equal(r.success, true, `step ${n + 1}: ${JSON.stringify(r)}`);
    const p = promptText();
    // 1. The contract reaches the model on every turn, once, between HARD BOUNDARIES and BEFORE ANSWERING.
    const c = p.indexOf('WHEN THE IDEAL ANSWER IS UNAVAILABLE');
    assert.ok(c > 0, `step ${n + 1}: contract missing from the prompt`);
    assert.equal(p.split('WHEN THE IDEAL ANSWER IS UNAVAILABLE').length - 1, 1, `step ${n + 1}: contract duplicated`);
    // MP2: the light information prompt has no BEFORE ANSWERING ritual; the contract must then precede the files section.
    const upper = [p.indexOf('BEFORE ANSWERING (silent)'), p.indexOf('FILES THE PERSON ATTACHES')].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), Infinity);
    assert.ok(p.indexOf('HARD BOUNDARIES') < c && c < upper, `step ${n + 1}: contract misplaced`);
    assert.ok(p.includes(step.say), `step ${n + 1}: the user's text is not in the prompt`);
    // 2. Server path: no markup, no service labels, honest numbers, no crisis, no model-call surprises.
    const reply = r.data.reply;
    assert.ok(reply.trim().length > 20, `step ${n + 1}: empty reply`);
    assert.ok(!MARKUP.test(reply), `step ${n + 1}: markup`);
    assert.ok(!claimsSearch.test(reply), `step ${n + 1}: claims a search that was not made`);
    assert.ok(!/\d+\s?%/.test(reply), `step ${n + 1}: invented percentage`);
    assert.notEqual(r.data.triage, 'CRISIS', `step ${n + 1}: triage CRISIS without distress markers`);
    assert.ok(!r.data.derived_numbers?.length, `step ${n + 1}: derived_numbers not empty`);
    assert.equal(r.meta.calls, hits, `step ${n + 1}: meta.calls ${r.meta.calls} != model hits ${hits}`);
    assert.ok(hits <= 2, `step ${n + 1}: more than one retry (${hits} calls)`);
    state = r.data.state;
    history = [...history, { role: 'assistant', content: reply }];
  }
  console.log('ok - contract in the prompt on all 6 dialog turns; server path keeps honesty guards');

  // 3. Contract wording keeps the hard limits and does not touch the answer schema.
  const text = promptText();
  for (const must of ['State in one sentence what is unavailable', 'Do not invent precise figures, percentages, probabilities, citations or live findings', 'Never claim to have searched', 'change the approach'])
    assert.ok(text.includes(must), 'contract wording lost: ' + must);
  const schema = text.slice(text.indexOf('Return JSON only:'));
  for (const key of ['reply', 'question', 'contextSufficiency', 'triage', 'gain', 'newOptions', 'nextStep', 'factsToCheck', 'document', 'derived_numbers', 'state'])
    assert.ok(schema.includes(`"${key}"`), 'schema key missing: ' + key);
  assert.ok(!/"(uncertainty|forecastType|searchExpected|search_expected)"/.test(schema), 'a new field leaked into the JSON schema');
  console.log('ok - contract wording present; JSON schema has no new fields');
  console.log('2 tests passed');
} finally { child.kill(); fake.close(); }
