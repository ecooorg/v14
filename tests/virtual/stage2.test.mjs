// Stage 2: real server.ts against a scripted fake Gemini (v20: 195 earlier checks + ROB-01 section K): auth, preconditions, chat invariants, crisis, model failures,
// request-wide call budget (S-4), synthesis format (S-5), headers, all 12 extended endpoints. Prints failures only.
import http from 'node:http'; import net from 'node:net'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
import { SUPPORT_CONTACTS, DISTRESS_MARKERS, hasDistressMarker } from '../../src/config/support.ts';
import { fileURLToPath } from 'node:url';
const BE = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, ''), PASS = 'pw-123456';
const CASES = JSON.parse(fs.readFileSync(BE + '/tests/fixtures/regression.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
// ---------- bridge ----------
let script = () => ({ json: {} }), recs = [];
const bridge = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => {
  let b = {}; try { b = JSON.parse(Buffer.concat(ch)); } catch {}
  const rec = { n: recs.length + 1, model: (/models\/([^:/]+):/.exec(req.url) || [])[1], key: req.headers['x-goog-api-key'],
    system: b.systemInstruction?.parts?.[0]?.text || '', prompt: b.contents?.[0]?.parts?.[0]?.text || '' };
  recs.push(rec); const o = script(rec) || {};
  if (o.status) { res.statusCode = o.status; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: { code: o.status, message: o.message || 'err', status: o.st || 'ERR' } })); }
  const text = o.raw ?? JSON.stringify(o.json ?? {}); res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: o.usage || { promptTokenCount: 10, candidatesTokenCount: 5 } }));
}); });
await new Promise((r) => bridge.listen(0, r)); const BURL = `http://127.0.0.1:${bridge.address().port}`;
// ---------- server ----------
async function srv(env = {}) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`; let logs = '';
  const child = spawn('tsx', ['server.ts'], { cwd: BE, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS, SESSION_SECRET: 'x'.repeat(40),
    GEMINI_API_KEY: 'server-key', GEMINI_BASE_URL: BURL, GOOGLE_GEMINI_BASE_URL: BURL, LLM_ROUND_PAUSE_MS: '10', RATE_LIMIT_PER_HOUR: '100000', DAILY_CALL_CAP: '100000',
    MODEL_CASCADE_STRONG: 'm1,m2,m3', MODEL_CASCADE_LIGHT: 'm1,m2,m3', ...env } });
  child.stdout.on('data', (d) => logs += d); child.stderr.on('data', (d) => logs += d);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(150); }
  const l = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (l.headers.get('set-cookie') || '').split(';')[0];
  const post = async (p, body, h = {}, ck = cookie) => { let r; try { r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}), ...h }, body: JSON.stringify(body) }); } catch (e) { return { s: 0, j: { error: 'FETCH FAILED; server logs tail: ' + logs.slice(-600) } }; } let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  return { base, post, cookie, logs: () => logs, stop: () => child.kill() };
}
// ---------- results ----------
const R = []; const T = (id, ok, note = '') => { R.push({ id, ok: !!ok, note: String(note).slice(0, 300) }); };
const withSrv = async (env, fn) => { if (process.env.ONLY && !process.env.ONLY.split(',').includes(fn.name)) return; const s = await srv(env); recs = []; try { await fn(s); } catch (e) { T('EXC ' + fn.name, false, e.stack?.split('\n').slice(0, 3).join(' | ')); } finally { s.stop(); await sleep(100); } };
const GOOD = (o = {}) => ({ reply: 'Зимняя тяжесть — это одно, переезд — один из способов. Можно проверить зиму в тёплом месте на три недели.', question: 'В какие месяцы тяжелее всего?', contextSufficiency: 'MEDIUM', triage: 'PROCEED',
  problemClear: true, driftDetected: false, notUnderstoodSignal: false, gain: ['REFRAMED_QUESTION'], newOptions: [], state: { coreProblem: 'Решение', facts: [], hypotheses: [] }, ...o });
const conv = (s, text, extra = {}, h = {}) => s.post('/api/conversation', { brief: { decision: text }, history: [{ role: 'user', content: text }], ...extra }, h);
const qn = (t) => (String(t).match(/[?？]/g) || []).length;
const MARKUP = /\*\*|__|^#{1,6}\s|`|^\s*[*•+]\s/m, LABELS = /USER[ _]FACT|GENERAL[ _]KNOWLEDGE|HYPOTHESIS\)|\[HYPOTHESIS|problemClear|driftDetected|notUnderstoodSignal|\(Source:|USER_DATA|GENERAL_PATTERN/;
const ctxOf = (prompt) => { const i = prompt.indexOf('"context":'); if (i < 0) return null; let d = 0, st = -1; for (let k = prompt.indexOf('{', i); k < prompt.length; k++) { if (prompt[k] === '{') { if (st < 0) st = k; d++; } else if (prompt[k] === '}' && --d === 0) { try { return JSON.parse(prompt.slice(st, k + 1)); } catch { return null; } } } return null; };

// ===== A. entry, auth, 410, EVPI, preconditions =====
await withSrv({ LOGIN_MAX_FAILS: '3' }, async function A(s) {
  script = () => ({ json: GOOD() });
  T('A1 health open', (await fetch(s.base + '/api/health')).status === 200);
  const nologin = await s.post('/api/conversation', { brief: { decision: 'x' } }, {}, ''); T('A2 401 without login', nologin.s === 401, nologin.s);
  const un = await s.post('/api/neutralize', { brief: { decision: 'x' } }, {}, ''); T('A2b 401 neutralize', un.s === 401, un.s);
  for (const p of ['/api/analyze-full', '/api/radar-legacy']) { const r = await s.post(p, {}); T('A3 410 ' + p, r.s === 410 && r.j?.code === 'GONE', r.s); }
  const e = await s.post('/api/evpi', { p: 40, G: 100, L: 50, c: 5 }); T('A4 EVPI 10/40/30', e.j?.data?.evOpen === 10 && e.j?.data?.evPerfect === 40 && e.j?.data?.evpi === 30, JSON.stringify(e.j?.data));
  const e2 = await s.post('/api/evpi', { p: 0.4, G: 100, L: 50 }); T('A4b EVPI p as fraction', e2.j?.data?.evpi === 30, JSON.stringify(e2.j?.data));
  const pre = [['/api/conversation', {}], ['/api/conversation', { brief: {} }], ['/api/neutralize', { brief: {} }], ['/api/radar', { brief: { decision: 'x' } }], ['/api/radar', { brief: { decision: 'x' }, neutralization: [] }],
    ['/api/understand', {}], ['/api/expand', { brief: { decision: 'x' } }], ['/api/expand', { radar: {} }], ['/api/redteam-pair', { firstOption: { id: 'a' } }], ['/api/redteam', { brief: {} }],
    ['/api/premortem', { brief: {} }], ['/api/premortem', { redTeamRounds: [{ objections: [{}] }, { objections: [] }] }], ['/api/experiment-draft', { hypotheses: [] }], ['/api/experiment-draft', { hypotheses: [1, 2, 3, 4].map((i) => ({ selectedByUser: true })) }],
    ['/api/forecast-wording', {}], ['/api/knowledge-map', { radar: { unknowns: [{ critical: true, id: 'u1' }] } }]];
  for (const [p, b] of pre) { const r = await s.post(p, b); T(`A5 400 ${p} ${JSON.stringify(b).slice(0, 40)}`, r.s === 400 && r.j?.success === false, `${r.s} ${r.j?.code}`); }
  T('A5z no model call on precondition fail', recs.length === 0, recs.length);
  const sess = await fetch(s.base + '/api/session', { headers: { cookie: s.cookie } }); T('A6 session', sess.status === 200, sess.status);
  const bad = []; for (let i = 0; i < 4; i++) bad.push((await fetch(s.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' + i }) })).status);
  T('A7 login: wrong=401, then lockout 429', bad[0] === 401 && bad[3] === 429, bad.join(','));
});

// ===== B. chat invariants (fuzz over 10 situations x mutations) =====
await withSrv({}, async function B(s) {
  const muts = {
    twoQ: (r) => ({ reply: r.reply.replace(/\?/g, '.') + ' Что для вас важнее? А если подумать иначе? Когда решать?', question: 'Какой месяц хуже всего?' }),
    markdown: (r) => ({ reply: '**Ключевое:** тяжело.\n## Заголовок\n* пункт один\n+ пункт два\nОбычный `код` текст. Попробуйте на три недели.' }),
    labels: (r) => ({ reply: 'Зимой тяжело (USER FACT). Переезд — гипотеза (HYPOTHESIS). Проверьте (Source: USER_DATA) на практике. problemClear: true; driftDetected: false.' }),
    labelDot: (r) => ({ reply: 'Стоит проверить зиму в тёплом месте. (GENERAL_PATTERN). Затем решайте.' }),
    es: (r) => ({ reply: 'Esto es una parte. ¿Qué piensas realmente? Esto importa más de lo que parece. ¿Y si pruebas tres semanas?', question: '¿Qué mes es peor?' }),
    qInReplyOnly: (r) => ({ reply: 'Первая часть. Что именно тяжело? Это важно для выбора.', question: '' }),
    qMid: (r) => ({ reply: 'Сначала про свет. А что с настроением? Потом про деньги.', question: 'Что тяжелее?' }),
  };
  let n = 0;
  for (const c of CASES) for (const [mn, m] of Object.entries(muts)) {
    n++; const model = GOOD({ ...m(c.model) }); script = () => ({ json: model });
    const hist = [{ role: 'user', content: c.first }]; if (c.second) hist.push({ role: 'assistant', content: c.previousAssistant || 'ok' }, { role: 'user', content: c.second });
    const r = await s.post('/api/conversation', { brief: { decision: c.first }, history: hist });
    const id = `B ${c.id}/${mn}`; if (r.s !== 200) { T(id, false, `status ${r.s} ${r.j?.error}`); continue; }
    const rep = r.j.data.reply; const bad = [];
    if (qn(rep) > 1) bad.push('questions=' + qn(rep));
    if (MARKUP.test(rep)) bad.push('markup'); if (LABELS.test(JSON.stringify(r.j.data))) bad.push('label');
    if (/[a-zа-яё][.!][A-ZА-ЯЁÁÉÍÓÚ¿]/.test(rep)) bad.push('glued'); if (/(^|[^.])\.\.([^.]|$)/.test(rep)) bad.push('double-dot'); if (/\s\.(\s|$)/.test(rep)) bad.push('space-dot');
    if (/(problemClear|driftDetected|notUnderstood)/.test(JSON.stringify(r.j))) bad.push('service field in response');
    T(id, !bad.length, bad.join(',') + ' | ' + rep.replace(/\n/g, '\\n').slice(0, 140));
  }
  recs = []; { const big = await s.post('/api/conversation', { brief: { decision: 'x' }, history: [{ role: 'user', content: 'y'.repeat(300000) }] }); T('F7 oversize body -> 413, no model call', big.s === 413 && recs.length === 0, `${big.s} hits=${recs.length}`); }
  T('B-count', n === 70, n);
  // "ты меня не понял" -> LOW, service fields not leaked
  script = () => ({ json: GOOD({ notUnderstoodSignal: true, contextSufficiency: 'HIGH', problemClear: true }) });
  let r = await conv(s, 'Ты меня не понял, я говорил про другое'); T('C1 not-understood -> LOW', r.j?.data?.contextSufficiency === 'LOW', r.j?.data?.contextSufficiency);
  script = () => ({ json: GOOD({ problemClear: false, contextSufficiency: 'HIGH' }) }); r = await conv(s, 'Помоги'); T('C2 problemClear=false -> LOW', r.j?.data?.contextSufficiency === 'LOW', r.j?.data?.contextSufficiency);
  // hypothesis trap
  script = () => ({ json: GOOD({ state: { coreProblem: 'Работа', facts: ['Выгорание'], hypotheses: [] } }) });
  r = await s.post('/api/conversation', { brief: { decision: 'Не знаю, уходить ли с работы, устал' }, history: [{ role: 'user', content: 'Не знаю, уходить ли с работы, устал' }, { role: 'assistant', content: 'Похоже, это выгорание.' }, { role: 'user', content: 'Может быть, не уверен' }], state: { facts: [], hypotheses: [] } });
  T('D1 "Выгорание" in hypotheses, not facts', r.j?.data?.state?.hypotheses?.some((x) => /выгорание/i.test(x)) && !r.j?.data?.state?.facts?.some((x) => /выгорание/i.test(x)), JSON.stringify(r.j?.data?.state));
  // question policy by sufficiency
  script = () => ({ json: GOOD({ contextSufficiency: 'HIGH' }) }); r = await conv(s, 'Решаю между двумя офферами, 120 и 150 тысяч'); T('E1 HIGH -> no question', qn(r.j?.data?.reply) === 0 && r.j?.data?.question === '', `${qn(r.j?.data?.reply)} "${r.j?.data?.question}"`);
  script = () => ({ json: GOOD({ contextSufficiency: 'LOW' }) }); r = await conv(s, 'Решаю между двумя офферами'); T('E2 LOW -> exactly one question', qn(r.j?.data?.reply) === 1, qn(r.j?.data?.reply));
  // context passed to the model
  const probe = async (body) => { recs = []; script = () => ({ json: GOOD() }); await s.post('/api/conversation', body); return ctxOf(recs[0]?.prompt || ''); };
  const H = (k) => Array.from({ length: k }, (_, i) => [{ role: 'user', content: 'u' + i }, { role: 'assistant', content: 'a' + i }]).flat();
  let c = await probe({ brief: { decision: 'x' }, history: H(4).concat([{ role: 'user', content: 'u4' }]) }); T('F1 userTurns=5', c?.userTurns === 5, JSON.stringify(c));
  c = await probe({ brief: { decision: 'x' }, history: [{ role: 'user', content: 'x' }], returningAfterDays: 5 }); T('F2 returningAfterDays=5', c?.returningAfterDays === 5, JSON.stringify(c));
  c = await probe({ brief: { decision: 'x' }, history: [{ role: 'user', content: 'x' }], returningAfterDays: 1000 }); T('F2b cap 365', c?.returningAfterDays === 365, JSON.stringify(c));
  c = await probe({ brief: { decision: 'x' }, history: [{ role: 'user', content: 'x' }], returningAfterDays: 0 }); T('F2c 0 dropped', c?.returningAfterDays === undefined, JSON.stringify(c));
  c = await probe({ brief: { decision: 'x' }, history: [{ role: 'user', content: 'x' }], returningAfterDays: 'abc' }); T('F2d junk dropped', c?.returningAfterDays === undefined, JSON.stringify(c));
  c = await probe({ brief: { decision: 'x' }, history: [{ role: 'user', content: 'x' }], intent: 'NOTE' }); T('F3 intent NOTE', c?.intent === 'NOTE', JSON.stringify(c));
  c = await probe({ brief: { decision: 'x' }, history: [{ role: 'user', content: 'x' }], intent: 'HACK' }); T('F3b bad intent dropped', c?.intent === undefined, JSON.stringify(c));
  const p0 = recs[0]?.prompt + recs[0]?.system; for (const k of ['HIGH', 'LIGHT', 'NOTE', 'returningAfterDays', 'CRISIS', 'distressMarkerDetected']) T('F4 prompt mentions ' + k, p0.includes(k));
  T('F5 prompt size sane', p0.length > 5000 && p0.length < 60000, p0.length);
  // history is capped to 12 messages and 8000 chars each
  recs = []; await s.post('/api/conversation', { brief: { decision: 'x' }, history: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'M' + i + 'y'.repeat(3000) })) });
  const pr = recs[0]?.prompt || ''; T('F6 history capped 12', !pr.includes('"M17y') && pr.includes('"M18y') && pr.includes('"M29y'), 'len ' + pr.length);
});

// ===== G. crisis ru/es + every marker =====
await withSrv({}, async function G(s) {
  script = () => ({ json: GOOD({ triage: 'PROCEED', contextSufficiency: 'LOW', question: 'Что вас беспокоит больше всего?', reply: 'Понимаю. Давайте разберём работу. Что именно вас тревожит?' }) });
  for (const [lang, t] of [['ru', 'Не хочу жить, и не знаю, увольняться ли с работы'], ['es', 'Quiero morir, no sé si dejar mi trabajo'], ['ru-late', 'Решаю про работу. Потом, в середине разговора, скажу: хочу умереть']]) {
    const hist = lang === 'ru-late' ? [{ role: 'user', content: 'Решаю про работу' }, { role: 'assistant', content: 'Слушаю.' }, { role: 'user', content: 'Иногда мне кажется, что я хочу умереть' }] : [{ role: 'user', content: t }];
    const r = await s.post('/api/conversation', { brief: { decision: t }, history: hist }); const rep = r.j?.data?.reply || '';
    T('G1 crisis ' + lang, r.s === 200 && qn(rep) === 0 && r.j.data.question === '' && SUPPORT_CONTACTS.every((c) => rep.includes(c.value)), `s${r.s} q=${qn(rep)} contacts=${SUPPORT_CONTACTS.every((c) => rep.includes(c.value))}`);
  }
  script = () => ({ json: GOOD({ triage: 'CRISIS', question: 'Вопрос?' }) }); let r = await conv(s, 'Мне тяжело, не знаю что делать'); T('G2 model triage CRISIS -> contacts, no question', SUPPORT_CONTACTS.every((c) => r.j?.data?.reply.includes(c.value)) && qn(r.j.data.reply) === 0, qn(r.j?.data?.reply));
  script = () => ({ json: GOOD() }); const miss = DISTRESS_MARKERS.filter((m) => !hasDistressMarker('Я думаю: ' + m + ' и ещё про работу')); T('G3 every marker detected', !miss.length, miss.join('|'));
  const upper = hasDistressMarker('НЕ ХОЧУ ЖИТЬ'); T('G3b case-insensitive', upper);
  r = await conv(s, 'Обычный вопрос про отпуск'); T('G4 no false crisis', !SUPPORT_CONTACTS.some((c) => r.j?.data?.reply.includes(c.value)));
  let prompts = 0; recs = []; await conv(s, 'Не хочу жить'); T('G5 distress flag in model context', ctxOf(recs[0]?.prompt || '')?.distressMarkerDetected === true);
});

// ===== H. model failures (fresh server each) =====
const okc = (r) => r.s === 200 && r.j?.success;
await withSrv({}, async function H1(s) { script = (q) => q.n === 1 ? { raw: 'not json {{' } : { json: GOOD() }; const r = await conv(s, 'Менять ли работу');
  T('H1 bad JSON -> retry on next model', okc(r) && r.j.meta.calls === 2 && recs[0].model === 'm1' && recs[1].model === 'm2' && r.j.meta.model === 'm2', `${r.s} calls=${r.j?.meta?.calls} ${recs.map((x) => x.model)}`); });
await withSrv({}, async function H2(s) { script = (q) => q.n === 1 ? { json: GOOD({ reply: 'Шанс успеха около 73%. Стоит подумать.' }) } : { json: GOOD() }; const r = await conv(s, 'Менять ли работу');
  T('H2 invented % -> retry on next model', okc(r) && r.j.meta.calls === 2 && recs[1].model === 'm2' && !/73/.test(r.j.data.reply), `${r.s} calls=${r.j?.meta?.calls} ${r.j?.data?.reply?.slice(0, 60)}`); });
await withSrv({}, async function H2b(s) { script = () => ({ json: GOOD({ reply: 'Вы назвали 73%. Это важная цифра для решения.' }) }); const r = await conv(s, 'Шанс получить повышение 73%, менять ли работу');
  T('H2b % from user input accepted w/o retry', okc(r) && r.j.meta.calls === 1, `${r.s} calls=${r.j?.meta?.calls}`); });
await withSrv({}, async function H3(s) { script = () => ({ raw: 'broken' }); const r = await conv(s, 'Менять ли работу'); T('H3 two bad answers -> clean error, no walk through the chain', r.s >= 400 && recs.length === 2, `${r.s} hits=${recs.length} ${r.j?.error}`); });
for (const st of [429, 503]) await withSrv({}, async function H4(s) { script = (q) => q.model === 'm1' ? { status: st, message: st === 429 ? 'RESOURCE_EXHAUSTED rate limit' : 'UNAVAILABLE overloaded' } : { json: GOOD() }; const r = await conv(s, 'Менять ли работу');
  T(`H4 ${st} on m1 -> m2`, okc(r) && r.j.meta.model === 'm2' && r.j.meta.fallback === true, `${r.s} ${r.j?.meta?.model}`);
  recs = []; await conv(s, 'ещё раз'); T(`H4b ${st}: m1 on cooldown for next request`, recs[0]?.model === 'm2', recs.map((x) => x.model).join(',')); });
await withSrv({}, async function H5(s) { script = (q) => q.model === 'm1' ? { status: 404, message: 'model not found' } : { json: GOOD() }; const r = await conv(s, 'Менять ли работу'); T('H5 404 model skipped', okc(r) && r.j.meta.model === 'm2', `${r.s}`); });
await withSrv({}, async function H6(s) { script = () => ({ status: 429, message: 'RESOURCE_EXHAUSTED' }); const r = await conv(s, 'Менять ли работу'); T('H6 all models 429 -> 429 + code', r.s === 429 && /RATE_LIMIT|QUOTA/.test(r.j?.code || ''), `${r.s} ${r.j?.code} hits=${recs.length}`); });
await withSrv({}, async function H6b(s) { script = () => ({ status: 429, message: 'Quota exceeded: daily quota per day' }); const r = await conv(s, 'Менять ли работу'); T('H6b daily quota -> 429 GEMINI_QUOTA', r.s === 429 && r.j?.code === 'GEMINI_QUOTA', `${r.s} ${r.j?.code} hits=${recs.length}`); });
await withSrv({}, async function H7(s) { // quality retry
  const weak = GOOD({ gain: [], newOptions: [] }); script = (q) => q.n === 1 ? { json: weak, usage: { promptTokenCount: 100, candidatesTokenCount: 10 } } : { json: GOOD(), usage: { promptTokenCount: 120, candidatesTokenCount: 20 } };
  const r = await conv(s, 'Менять ли работу'); const m = r.j?.meta || {}; const chars = recs.reduce((a, x) => a + x.system.length + x.prompt.length, 0);
  T('H7 quality fail -> retry on reserve model', okc(r) && recs.length === 2 && recs[1].model === 'm2' && m.model === 'm2', `${r.s} ${recs.map((x) => x.model)}`);
  T('H7b meta sums calls', m.calls === 2, m.calls); T('H7c meta sums promptChars', m.promptChars === chars, `${m.promptChars} vs ${chars}`); T('H7d meta sums tokens 220/30', m.inputTokens === 220 && m.outputTokens === 30, `${m.inputTokens}/${m.outputTokens}`); });
await withSrv({}, async function H8(s) { script = (q) => q.n === 1 ? { json: GOOD({ gain: [] }) } : { status: 503, message: 'UNAVAILABLE' }; const r = await conv(s, 'Менять ли работу'); T('H8 retry fails -> first draft returned', okc(r) && !!r.j.data.reply, `${r.s} calls=${r.j?.meta?.calls}`); });
await withSrv({ MAX_MODEL_CALLS: '2' }, async function H9(s) { script = (q) => q.n === 1 ? { raw: 'bad' } : q.n === 2 ? { json: GOOD({ gain: [] }) } : { json: GOOD() }; const r = await conv(s, 'Менять ли работу');
  T('H9 [S-4 probe] request-wide model budget (MAX_MODEL_CALLS=2)', recs.length <= 2, `real model hits=${recs.length}, meta.calls=${r.j?.meta?.calls}`); });
await withSrv({}, async function H10(s) { script = () => ({ json: { paragraphs: ['один два три', 'четыре', 'пять', 'шесть', 'семь'], derived_numbers: [], open_gaps: [], needs_external_check: [] } }); const r = await s.post('/api/synthesis', { brief: { decision: 'x' } });
  T('H10 [S-5 probe] synthesis rejects 5 short paragraphs (<250 words)', recs.length > 1 || r.s !== 200, `status ${r.s}, hits=${recs.length}`);
  recs = []; script = () => ({ json: { paragraphs: ['a b', 'c d', 'e f', 'g h'], derived_numbers: [] } }); const r2 = await s.post('/api/synthesis', { brief: { decision: 'x' } }); T('H10b [S-5 probe] 4 paragraphs rejected', recs.length > 1 || r2.s !== 200, `status ${r2.s}, hits=${recs.length}`);
  T('H10c failed format -> 200 with meta.warnings, calls summed', r.s === 200 && r.j?.meta?.warnings?.length && r.j.meta.calls === 2, JSON.stringify(r.j?.meta?.warnings) + ' calls=' + r.j?.meta?.calls);
  const para = (n) => Array.from({ length: n }, (_, i) => 'слово '.repeat(60).trim()); recs = []; script = () => ({ json: { paragraphs: para(5), derived_numbers: [] } }); const r3 = await s.post('/api/synthesis', { brief: { decision: 'x' } });
  T('H10d valid 5x60=300 words: no retry, no warnings', r3.s === 200 && recs.length === 1 && !r3.j.meta.warnings, `hits=${recs.length} ${JSON.stringify(r3.j?.meta?.warnings)}`);
  recs = []; script = (q) => q.n === 1 ? { json: { paragraphs: para(4) } } : { json: { paragraphs: para(5), derived_numbers: [] } }; const r4 = await s.post('/api/synthesis', { brief: { decision: 'x' } });
  T('H10e bad then good: retry used, no warnings', r4.s === 200 && recs.length === 2 && !r4.j.meta.warnings && r4.j.data.paragraphs.length === 5, `hits=${recs.length} ${JSON.stringify(r4.j?.meta?.warnings)}`); });

// ===== I. headers =====
await withSrv({}, async function I(s) { script = () => ({ json: GOOD() });
  recs = []; await conv(s, 'Менять ли работу', {}, { 'x-model-preference': 'm3' }); T('I1 x-model-preference m3 first', recs[0]?.model === 'm3', recs.map((x) => x.model).join(','));
  recs = []; await conv(s, 'Менять ли работу', {}, { 'x-model-preference': 'evil-model' }); T('I2 unknown preference ignored', recs[0]?.model === 'm1', recs[0]?.model);
  const SECRET = 'AIzaSECRET-KEY-XYZ-98765'; recs = []; const r = await conv(s, 'Менять ли работу', {}, { 'x-byok-key': SECRET });
  T('I3 BYOK key reaches model', recs[0]?.key === SECRET, recs[0]?.key); T('I3b server key used otherwise', (await (async () => { recs = []; await conv(s, 'ещё'); return recs[0]?.key; })()) === 'server-key');
  script = () => ({ status: 503, message: 'UNAVAILABLE ' }); await conv(s, 'Менять ли работу', {}, { 'x-byok-key': SECRET }); script = () => ({ raw: 'bad' }); await conv(s, 'Менять ли работу', {}, { 'x-byok-key': SECRET });
  T('I4 BYOK key not in logs (ok + failure paths)', !s.logs().includes(SECRET), 'logs ' + s.logs().length + ' chars'); T('I4b BYOK key not in response', !JSON.stringify(r.j).includes(SECRET));
  T('I5 llm_usage logged', /"type":"llm_usage"/.test(s.logs()));
});

// ===== J. 12 extended endpoints: happy path + 429 mapping =====
const B0 = { decision: 'Менять ли работу' }; const OPT = (id) => ({ id, title: 'Вариант ' + id });
const ANS = { expand: { options: ['HYBRID_OR_PILOT', 'REVERSIBLE_STEP', 'GET_FACT_FIRST'].map((k, i) => ({ id: 'o' + i, kind: k, title: 't' + i })) }, 'redteam-pair': { rounds: [{ role: 'PREFERRED', objections: [] }, { role: 'OPPOSITE', objections: [] }] } };
const EP = {
  neutralize: { brief: B0 }, radar: { brief: B0, neutralization: ['x'] }, understand: { brief: B0 }, 'knowledge-map': { brief: B0, radar: { unknowns: [] } },
  expand: { brief: B0, radar: { unknowns: [] }, myOptions: [] }, 'redteam-pair': { brief: B0, firstOption: OPT('a'), secondOption: OPT('b'), radar: {}, knowledgeMap: {} },
  redteam: { brief: B0, option: OPT('a'), role: 'A' }, premortem: { brief: B0, preferredOption: OPT('a'), redTeamRounds: [{ objections: [{ response: { verdict: 'accepted', reason: 'r' } }] }, { objections: [] }] },
  'experiment-draft': { brief: B0, hypotheses: [{ id: 'h1', text: 'гипотеза', selectedByUser: true }] }, 'forecast-wording': { experiment: { id: 'e', title: 't' } }, synthesis: { brief: B0 }, review: { journalEntry: { id: 'j', decision: 'x' }, brief: B0 },
};
await withSrv({ MODEL_CASCADE_STRONG: 'm1', MODEL_CASCADE_LIGHT: 'm1' }, async function J(s) {
  T('J0 12 endpoints listed', Object.keys(EP).length === 12);
  for (const [ep, body] of Object.entries(EP)) { script = () => ({ json: ANS[ep] || { items: [], note: 'ok' } }); const r = await s.post('/api/' + ep, body);
    T('J1 200 ' + ep, r.s === 200 && r.j?.success === true && !!r.j?.meta, `${r.s} ${r.j?.error || ''} ${r.j?.code || ''}`); }
  for (const [ep, body] of Object.entries(EP)) { script = () => ({ status: 429, message: 'RESOURCE_EXHAUSTED' }); const r = await s.post('/api/' + ep, body); T('J2 429 mapped on ' + ep, r.s === 429, `got ${r.s} ${r.j?.code || ''}`); }
  for (const ep of Object.keys(EP)) { script = (q) => q.n % 2 ? { raw: 'bad json' } : { json: ANS[ep] || { note: 'ok' } }; recs = []; const r = await s.post('/api/' + ep, EP[ep]); if (r.s === 200) T('J3 bad JSON retried ' + ep, true); else T('J3 bad JSON retried ' + ep, false, `${r.s} hits=${recs.length}`); }
});
await withSrv({ MODEL_CASCADE_STRONG: 'm1,m2', MODEL_CASCADE_LIGHT: 'm1,m2' }, async function J4(s) { // invented numbers on non-chat endpoints
  for (const ep of ['radar', 'redteam', 'synthesis']) { const P5 = { paragraphs: Array.from({ length: 5 }, () => 'слово '.repeat(60).trim()), derived_numbers: [] }; script = (q) => q.n === 1 ? { json: { ...P5, note: 'шанс 91%' } } : { json: { ...P5, note: 'ok' } }; recs = []; const r = await s.post('/api/' + ep, EP[ep]); T('J4 invented % retried ' + ep, r.s === 200 && recs.length === 2, `${r.s} hits=${recs.length}`); }
});

// ===== K. ROB-01: wrong answer shape on /api/expand and /api/redteam-pair gets one retry inside the call budget =====
const BAD = { expand: { options: [{ id: 'o0', kind: 'OTHER', title: 'x' }] }, 'redteam-pair': { rounds: [{ role: 'PREFERRED', objections: [] }] } };
await withSrv({ MODEL_CASCADE_STRONG: 'm1,m2', MODEL_CASCADE_LIGHT: 'm1,m2' }, async function K(s) {
  for (const ep of ['expand', 'redteam-pair']) {
    script = (q) => ({ json: q.n === 1 ? BAD[ep] : ANS[ep] }); recs = [];
    let r = await s.post('/api/' + ep, EP[ep]);
    T('K1 wrong shape then good -> 200 on ' + ep, r.s === 200 && recs.length === 2 && r.j?.meta?.calls === 2, `${r.s} hits=${recs.length} calls=${r.j?.meta?.calls}`);
    T('K2 retry went to the reserve model on ' + ep, recs.length === 2 && recs[0].model !== recs[1].model, `${recs.map((x) => x.model)}`);
    script = () => ({ json: BAD[ep] }); recs = [];
    r = await s.post('/api/' + ep, EP[ep]);
    T('K3 wrong twice -> 500 SCHEMA after exactly 2 calls on ' + ep, r.s === 500 && r.j?.code === 'SCHEMA' && recs.length === 2, `${r.s} ${r.j?.code} hits=${recs.length}`);
  }
});
await withSrv({ MODEL_CASCADE_STRONG: 'm1,m2', MODEL_CASCADE_LIGHT: 'm1,m2', MAX_MODEL_CALLS: '1' }, async function K4(s) {
  script = () => ({ json: BAD.expand }); recs = [];
  const r = await s.post('/api/expand', EP.expand);
  T('K4 MAX_MODEL_CALLS=1: no retry, SCHEMA error', r.s === 500 && r.j?.code === 'SCHEMA' && recs.length === 1, `${r.s} ${r.j?.code} hits=${recs.length}`);
});

const f = R.filter((x) => !x.ok); console.log(`\nSTAGE 2: ${R.length - f.length}/${R.length} passed, ${f.length} failed`); for (const x of f) console.log('FAIL', x.id, '-', x.note);
bridge.close(); process.exit(f.length ? 1 : 0);
