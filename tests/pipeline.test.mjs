/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN mp2.test.mjs =====
{
// MP2: shared prompt core + light Simple/information contract.
// Unit: classification, prompt assembly (information vs decision/research/engineering), Expert/Project instructions kept.
// Integration: real server.ts against a fake Gemini (no key, no network).
const assert = (await import("node:assert/strict")).default;
const http = (await import("node:http")).default;
const net = (await import("node:net")).default;
const { readFileSync } = await import("node:fs");
const { spawn } = await import("node:child_process");
const { detectConversationMode, modeParagraph } = await import("../server/conversationMode.ts");
const { buildSimpleConversationPrompt, EXPERT_STEP_PREFIX } = await import("../server/promptPacks.ts");
const { buildPromptCore } = await import("../server/promptCore.ts");
const { ANALYST_INSTRUCTION } = await import("../server/contextBuilder.ts");

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
}
// ===== END mp2.test.mjs =====

// ===== BEGIN mp3.test.mjs =====
{
// MP3: information-mode output quality guard, soft retry, mode regression fixtures.
// Unit only: informationSoftFail / informationRetryHint; classification; server wiring via source read.
// Does not call live models; does not change tests/regression.json.
const assert = (await import("node:assert/strict")).default;
const { readFileSync } = await import("node:fs");
const { detectUserIntentFlags, informationSoftFail, informationRetryHint, isLimitationOnlyReply } = await import("../server/intentFlags.ts");
const { detectConversationMode, modeParagraph } = await import("../server/conversationMode.ts");
const { buildPromptCore } = await import("../server/promptCore.ts");

const emptyFlags = detectUserIntentFlags('');
const directFlags = detectUserIntentFlags('Просто ответь, не поучай и без методики');
const evasionFlags = detectUserIntentFlags('Это не решает мою задачу, ты уклоняешься');
const approxFlags = detectUserIntentFlags('Дай приблизительную оценку');

// ---------- Soft-fail: limitation-only / methodology preamble / invented precision ----------
{
  assert.equal(informationSoftFail({ reply: '' }, emptyFlags), true, 'empty reply fails');
  assert.equal(
    informationSoftFail({ reply: 'К сожалению, точный прогноз невозможен без актуальных данных.' }, emptyFlags),
    true,
    'limitation-only fails',
  );
  assert.equal(
    informationSoftFail({ reply: 'Before I can answer, it is important to understand the limitations of the model.' }, emptyFlags),
    true,
    'methodology preamble fails',
  );
  assert.equal(
    informationSoftFail({ reply: 'Для точного ответа нужны актуальные измерения и живые источники.' }, emptyFlags),
    true,
    'invented precision fails',
  );
  const good = {
    reply:
      'Зимой в Граубюндене обычно холодно: в долинах около −5…0 °C, в высокогорье часто −10…−15 °C. Снег лежит с декабря по март; в Давосе и Санкт-Морице много солнечных дней. Это ориентир из общих климатических сведений, стоит сверить с актуальным прогнозом.',
  };
  assert.equal(informationSoftFail(good, emptyFlags), false, 'substance-first winter answer passes');
  console.log('mp3 soft-fail detectors OK');
}

// ---------- Soft-fail respects intent flags ----------
{
  const lecture = { reply: 'As an AI language model I cannot give exact forecasts. Methodology requires live data.' };
  assert.equal(informationSoftFail(lecture, emptyFlags), true, 'AI lecture fails even without flags');
  assert.equal(informationSoftFail(lecture, directFlags), true, 'lecture after direct demand fails');
  assert.equal(informationSoftFail(lecture, evasionFlags), true, 'lecture after evasion critique fails');
  const okAfterDirect = {
    reply: 'В феврале в Граубюндене типичны −5…0 °C в долинах и устойчивый снежный покров в горах.',
  };
  assert.equal(informationSoftFail(okAfterDirect, directFlags), false, 'direct substance passes with direct flags');
  console.log('mp3 intent-flag soft-fail OK');
}

// ---------- Retry hint stays in information mode ----------
{
  const hint = informationRetryHint(directFlags);
  assert.ok(/information mode/i.test(hint), 'hint labels information mode');
  assert.ok(!/STEP 0|SECOND TEST|structure operations|newOptionTypes|\bgain\b/i.test(hint), 'hint does not switch to decision package');
  assert.ok(/direct answer|methodology/i.test(hint), 'hint mentions direct/methodology constraint');
  const approxHint = informationRetryHint(approxFlags);
  assert.ok(/approximate|preliminary|rough/i.test(approxHint), 'approx hint present');
  console.log('mp3 retry hint OK');
}

// ---------- Mode regression fixtures (offline) ----------
{
  const graubunden = 'Расскажи про зиму в Граубюндене';
  assert.equal(detectConversationMode(graubunden), 'information');
  const para = modeParagraph('information');
  assert.ok(/CURRENT FOCUS: Information request/i.test(para));
  assert.ok(!/STEP 0|SECOND TEST|homework/i.test(para));
  assert.ok(buildPromptCore('2026-10-14').includes('CURRENT DATE'));

  const serverSrc = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(serverSrc.includes('informationSoftFail'), 'server wires informationSoftFail');
  assert.ok(serverSrc.includes('informationRetryHint'), 'server wires informationRetryHint');
  assert.ok(/infoRetry/.test(serverSrc), 'server has information retry branch');
  assert.ok(serverSrc.includes('conversationGainAudit'), 'gain-audit retained for non-information');
  assert.ok(serverSrc.includes('EXPERT_STEP_PREFIX + prompt'), 'Expert path still prefixes its steps');

  // Expert / Project string contracts (read from source files without loading full module graphs).
  const packs = readFileSync(new URL('../server/promptPacks.ts', import.meta.url), 'utf8');
  assert.ok(packs.includes('Do not choose or rank options for the person') && packs.includes('explicit assumptions'));
  const ctx = readFileSync(new URL('../server/contextBuilder.ts', import.meta.url), 'utf8');
  assert.ok(ctx.includes('Prefer operational precision') && ctx.includes('Do not chat or coach'));
  console.log('mp3 mode fixtures OK');
}

// ---------- isLimitationOnlyReply still works for non-information path ----------
{
  const auditEmpty = { substantiveGain: [], structuralNew: [], hasNextStep: false };
  assert.equal(isLimitationOnlyReply({ reply: 'Точный прогноз невозможен' }, auditEmpty), true);
  assert.equal(
    isLimitationOnlyReply({ reply: 'Примерно −5 °C в долинах' }, { substantiveGain: ['CALC'], structuralNew: [], hasNextStep: false }),
    false,
  );
  console.log('mp3 limitation helper OK');
}

console.log('mp3 all unit checks passed');
}
// ===== END mp3.test.mjs =====

// ===== BEGIN p55-test-round1.test.mjs =====
{
const __rawTest = (await import("node:test")).default;
// These tests replace globalThis.fetch with a fake Drive and install browser shims. The grouped file continues with blocks that talk
// to a real spawned server through fetch, so every test restores fetch when it ends and the block waits for all of its tests
// before the next block starts. Without this, later blocks (perf, pi01, stage2) silently got the fake fetch.
const __realFetch = globalThis.fetch;
const __had = { window: 'window' in globalThis, sessionStorage: 'sessionStorage' in globalThis, localStorage: 'localStorage' in globalThis };
const __pending = [];
const test = (name, fn) => { __pending.push(__rawTest(name, async (...args) => { try { return await fn(...args); } finally { globalThis.fetch = __realFetch; } })); };
const assert = (await import("node:assert/strict")).default;
const { readFileSync } = await import("node:fs");

// ---- browser shims (Node has no window / storage) ----
const mk = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.sessionStorage = mk();
globalThis.localStorage = mk();
globalThis.window = new EventTarget();

const client = await import('../src/driveClient.ts');
const mirror = await import('../src/driveMirror.ts');
const { briefSections, BRIEF_EMPTY_TEXT } = await import('../src/briefView.ts');
client._setDriveClientIdForTests('test-client-id');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('src/index.css');
const app = read('src/App.tsx');
const pm = read('src/ProjectMode.tsx');
const wp = read('src/WorkspacePanel.tsx');
const cf = read('src/ConversationFiles.tsx');
const ud = read('src/useDrive.ts');

// ---- a fake Google Drive ----
function fakeDrive() {
  const folders = new Map();           // id -> {name, parent, trashed}
  const calls = []; const uploads = [];
  let n = 0; let failWith = null;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); const method = (init.method || 'GET').toUpperCase();
    calls.push(`${method} ${u.pathname}${u.search.slice(0, 60)}`);
    if (failWith) { const f = failWith; return json(f.body, f.status); }
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = decodeURIComponent(u.searchParams.get('q') || '');
      const name = q.match(/name='((?:[^'\\]|\\.)*)'/)?.[1];
      const parent = q.match(/'([^']+)' in parents/)?.[1] || null;
      const hit = [...folders.entries()].find(([, f]) => f.name === name && f.parent === parent && !f.trashed);
      return json({ files: hit ? [{ id: hit[0], name }] : [] });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const b = JSON.parse(init.body); const id = `fold${++n}`;
      folders.set(id, { name: b.name, parent: b.parents?.[0] || null, trashed: false }); return json({ id });
    }
    const one = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one && method === 'GET') { const f = folders.get(one[1]); return f ? json({ id: one[1], trashed: f.trashed, mimeType: 'application/vnd.google-apps.folder' }) : json({ error: { message: 'not found' } }, 404); }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(await init.body.get('metadata').text()); uploads.push(meta); return json({ id: `file${uploads.length}`, webViewLink: `https://drive.test/f${uploads.length}` });
    }
    return json({}, 500);
  };
  return { fetchImpl, folders, calls, uploads, fail: (status, body) => { failWith = { status, body }; }, ok: () => { failWith = null; } };
}
const events = []; window.addEventListener(mirror.DRIVE_STATUS_EVENT, (e) => events.push(e.detail));
const FILE_SCOPE = client.DRIVE_FILE_SCOPE; const APPDATA = client.DRIVE_APPDATA_SCOPE;
const connectToken = (scope = `${APPDATA} ${FILE_SCOPE}`) => mirror.storeMirrorToken({ token: 'tok-abcdefgh', expiresAt: Date.now() + 3_600_000, scope });
const reset = () => { sessionStorage.clear(); localStorage.clear(); mirror._resetMirrorForTests(); events.length = 0; };
const blob = (t = 'hello') => new Blob([t]);

test('P55 a file attached before Drive is connected waits and is saved right after Connect', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl;
  const r = await mirror.mirrorBlobDetailed({ name: 'brief.pdf', data: blob('abc'), localKey: 'k1' });
  assert.equal(r.ok, false); assert.equal(r.reason, 'not_connected'); assert.equal(r.queued, true);
  assert.equal(mirror.pendingMirrorCount(), 1);
  assert.equal(d.calls.length, 0, 'nothing is sent without a token');
  assert.equal(events.at(-1).kind, 'pending'); assert.match(events.at(-1).message, /after you connect/);
  connectToken();
  assert.equal(await mirror.flushMirrorQueue(), 1);
  assert.equal(mirror.pendingMirrorCount(), 0);
  assert.equal(d.uploads.length, 1); assert.equal(d.uploads[0].name, 'brief.pdf');
  assert.equal(events.at(-1).kind, 'saved'); assert.match(events.at(-1).message, /BiForge\/Simple\/brief\.pdf/);
  const names = [...d.folders.values()].map((f) => f.name);
  assert.deepEqual(names, ['BiForge', 'Simple']);
  const [bf, simple] = [...d.folders.entries()];
  assert.equal(bf[1].parent, null); assert.equal(simple[1].parent, bf[0], 'Simple is inside BiForge');
  assert.deepEqual(d.uploads[0].parents, [simple[0]]);
});

test('P55 the folder follows the mode; Project files go into a project subfolder', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  mirror.setMirrorMode('expert');
  const e = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('1'), localKey: 'e1' });
  assert.equal(e.folder, 'BiForge/Expert');
  const p = await mirror.mirrorBlobDetailed({ name: 'spec.md', data: blob('22'), mode: 'project', subfolder: 'My / Plan', localKey: 'p1' });
  assert.equal(p.folder, 'BiForge/Project/My Plan', 'path separators are removed from a project name');
  mirror.setMirrorMode('simple');
  assert.equal((await mirror.mirrorBlobDetailed({ name: 'b.txt', data: blob('333'), localKey: 's1' })).folder, 'BiForge/Simple');
  assert.equal(mirror.folderPathFor('library').join('/'), 'BiForge/Library');
});

test('P55 remembered folders are reused, and a deleted or trashed folder is created again', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  await mirror.mirrorBlobDetailed({ name: 'one.txt', data: blob('1'), localKey: 'a' });
  const created = [...d.folders.keys()].length;
  await mirror.mirrorBlobDetailed({ name: 'two.txt', data: blob('22'), localKey: 'b' });
  assert.equal([...d.folders.keys()].length, created, 'no new folders for the second file');
  // the person trashes the BiForge folder; a new session still remembers its id
  for (const f of d.folders.values()) f.trashed = true;
  mirror._resetMirrorForTests();
  const r = await mirror.mirrorBlobDetailed({ name: 'three.txt', data: blob('333'), localKey: 'c' });
  assert.equal(r.ok, true, 'saved even though the remembered folder was trashed');
  assert.equal([...d.folders.values()].filter((f) => !f.trashed).length, 2, 'BiForge and Simple exist again');
  // and a folder that no longer exists at all
  d.folders.clear(); mirror._resetMirrorForTests();
  assert.equal((await mirror.mirrorBlobDetailed({ name: 'four.txt', data: blob('4444'), localKey: 'd' })).ok, true);
});

test('P55 every failure is announced with its real reason (no silent no-op)', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  d.fail(403, { error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } });
  let r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x1' });
  assert.equal(r.reason, 'no_file_scope'); assert.match(events.at(-1).message, /file access was not granted/); assert.equal(events.at(-1).kind, 'error');
  assert.ok(mirror.getMirrorToken(), 'a scope problem does not throw the session away');
  d.fail(403, { error: { message: 'Google Drive API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } });
  r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x2' });
  assert.equal(r.reason, 'api_disabled'); assert.match(events.at(-1).message, /switched off for this app/);
  d.fail(403, { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } });
  assert.equal((await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x3' })).reason, 'quota');
  d.fail(500, {}); 
  r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x4' });
  assert.equal(r.reason, 'failed'); assert.match(events.at(-1).message, /x\.txt/);
  d.fail(401, { error: { message: 'Invalid Credentials' } });
  r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x5' });
  assert.equal(r.reason, 'expired'); assert.equal(mirror.getMirrorToken(), null, 'an expired session is dropped');
  assert.match(events.at(-1).message, /reconnect/i);
  for (const m of events.map((e) => e.message)) assert.doesNotMatch(m, /DRIVE_|VITE_|undefined|\[object/);
});

test('P55 a token that lacks the file permission is reported before any request is sent', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken(APPDATA);
  assert.equal(mirror.hasFileScope(mirror.getMirrorToken()), false);
  const r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'n1' });
  assert.equal(r.reason, 'no_file_scope'); assert.equal(d.calls.length, 0);
  assert.equal(mirror.hasFileScope({ token: 't', expiresAt: 1 }), true, 'an unknown scope is not treated as a refusal');
});

test('P55 the same file is not uploaded twice; the waiting list is bounded', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('same'), localKey: 'dup' });
  const again = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('same'), localKey: 'dup' });
  assert.equal(again.ok, true); assert.equal(again.reused, true); assert.equal(d.uploads.length, 1);
  const changed = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('a longer text'), localKey: 'dup' });
  assert.equal(changed.reused, false); assert.equal(d.uploads.length, 2, 'changed content is saved again');
  reset(); globalThis.fetch = d.fetchImpl;
  for (let i = 0; i < 30; i++) await mirror.mirrorBlobDetailed({ name: `f${i}.txt`, data: blob('x'), localKey: `q${i}` });
  assert.equal(mirror.pendingMirrorCount(), 25);
  assert.match(events.at(-1).message, /Press Drive/, 'a file that cannot wait says so');
});

test('P55 without a Google client id the mirror stays silent and does nothing', async () => {
  reset(); client._setDriveClientIdForTests(''); const d = fakeDrive(); globalThis.fetch = d.fetchImpl;
  const r = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('x'), localKey: 'z' });
  assert.equal(r.reason, 'not_configured'); assert.equal(events.length, 0); assert.equal(d.calls.length, 0);
  client._setDriveClientIdForTests('test-client-id');
});

test('P55 text files keep a sensible name and type; compatible wrappers still work', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  const e = await mirror.mirrorTextFile('Spec', 'hello', 'project', 'tk', 'Proj');
  assert.equal(e.name, 'Spec.txt');
  assert.equal((await mirror.mirrorTextFile('notes.md', 'x', 'project', 'tk2', 'Proj')).name, 'notes.md');
  assert.equal(await mirror.mirrorBlob({ name: 'ok.bin', data: blob('1'), localKey: 'w1' }).then((x) => x.name), 'ok.bin');
  d.fail(500, {});
  assert.equal(await mirror.mirrorBlob({ name: 'bad.bin', data: blob('2'), localKey: 'w2' }), null);
});

// ---- Decision brief (item 3) ----
test('P55 decision brief shows plain sections, not stored JSON', () => {
  const brief = { decision: 'Move the team', goal: 'Ship in Q4', facts: ['Two engineers left'], unknowns: ['Budget'], assumptions: [], values: ['Calm'], constraints: ['No new hires'],
    myOptions: [{ id: 'o1', title: 'Hire' }, { id: 'o2', title: 'Wait' }], leaningOptionId: 'o2', errorCost: { final: 'HIGH', note: 'Delays the launch' }, reversibility: { final: 'TWO_WAY', exitCost: 'small' }, reviewDates: ['2026-12-01'], minimalMode: false };
  const s = briefSections(brief);
  assert.deepEqual(s.map((x) => x.title), ['Decision', 'Goal', 'Facts', 'Unknowns', 'What matters to you', 'Limits', 'Your options', 'You lean towards', 'Risk', 'When to look again']);
  assert.deepEqual(s.find((x) => x.title === 'You lean towards').items, ['Wait']);
  assert.ok(s.find((x) => x.title === 'Risk').items.includes('Cost of a mistake: high'));
  assert.ok(s.find((x) => x.title === 'Risk').items.includes('Reversibility: easy to undo'));
  assert.doesNotMatch(JSON.stringify(s), /minimalMode|leaningOptionId|errorCost|"NONE"|ONE_WAY|TWO_WAY/);
});

test('P55 an empty brief says so instead of printing empty fields', () => {
  const empty = { decision: '', facts: [], unknowns: [], assumptions: [], values: [], constraints: [], myOptions: [], leaningOptionId: 'NONE', errorCost: {}, reversibility: {}, reviewDates: [], minimalMode: true };
  assert.deepEqual(briefSections(empty), []);
  assert.deepEqual(briefSections(null), []);
  assert.match(BRIEF_EMPTY_TEXT, /Nothing is recorded/);
  const only = briefSections({ ...empty, decision: 'какая погода прогнозируется в швейцарии' });
  assert.deepEqual(only, [{ title: 'Decision', items: ['какая погода прогнозируется в швейцарии'] }]);
});

test('P55 the brief panel is a real dialog with its own layout and no JSON dump', () => {
  const panel = app.slice(app.indexOf('function BriefPanel('), app.indexOf('function BriefPanel(') + 1800);
  assert.doesNotMatch(panel, /JSON\.stringify/);
  assert.doesNotMatch(panel, /className="privacy"/, 'it no longer reuses the toast layout that squeezed the Close button');
  assert.match(panel, /role="dialog"/); assert.match(panel, /briefSections\(d\.brief\)/);
  assert.match(css, /\.brief-panel\{[^}]*max-height:85vh;overflow:auto/);
  assert.match(css, /\.brief-head \.ghost\{[^}]*white-space:nowrap/);
});

// ---- header menu (item 4) ----
test('P55 More is a closed dropdown at every width', () => {
  assert.match(css, /\.hdr-more-btn\{display:inline-flex/);
  assert.doesNotMatch(css, /@media\(min-width:901px\)\{\s*\.hdr-more-wrap \.hdr-secondary\{display:contents/);
  assert.match(css, /\n\.hdr-more-wrap \.hdr-secondary\{display:none !important;position:absolute;right:0/);
  assert.match(css, /\n\.hdr-more-wrap \.hdr-secondary\.open\{display:flex !important\}/);
  assert.match(app, /document\.addEventListener\('touchstart', onDoc/);
  assert.match(app, /aria-expanded=\{moreOpen\}/);
  assert.match(app, /useState\(false\);\n  const \[sub, setSub\]/, 'the menu starts closed');
});

// ---- wiring (items 1 and 2) ----
test('P55 every upload path reaches Drive: Attach files, conversation files, exports, agent documents', () => {
  assert.match(wp, /import \{ mirrorBlob, mirrorUserFile \} from '\.\/driveMirror\.ts'/);
  assert.match(wp, /void mirrorUserFile\(f\)/);
  assert.match(wp, /webkitRelativePath/, 'a whole folder is not copied file by file');
  assert.match(wp, /void mirrorBlob\(\{ name: result\.filename/);
  assert.match(cf, /void mirrorUserFile\(f\)/);
  assert.doesNotMatch(cf, /mirrorUserFile\(f, 'simple'\)/);
  assert.match(app, /setMirrorMode\(expertMode \? 'expert' : 'simple'\)/);
  assert.doesNotMatch(app, /mirrorUserFile\(file, 'expert'\)/);
  assert.match(read('src/programFiles.ts'), /'unknown',\s*\/\/ the folder follows the mode/);
});

test('P55 connecting Drive saves the waiting files and reports a missing permission', () => {
  assert.match(ud, /storeMirrorToken\(t\)/);
  assert.match(ud, /flushMirrorQueue\(\)/);
  assert.match(ud, /hasFileScope\(t\)/);
  assert.match(ud, /addEventListener\(DRIVE_STATUS_EVENT/);
});

test('P55 Project mode has Drive buttons and nothing uploads silently', () => {
  for (const label of ['Connect Google Drive', 'Save all files to Google Drive', 'Save to Google Drive', 'Save ZIP to Google Drive']) assert.ok(pm.includes(label), label);
  assert.match(pm, /connectDriveFiles\(\)/);
  assert.match(pm, /addEventListener\(DRIVE_STATUS_EVENT/);
  assert.match(pm, /BiForge \/ Project \//);
  assert.match(pm, /Google Drive is not set up on this server/);
  assert.doesNotMatch(pm, /void mirrorTextFile\(meta/, 'opening a file no longer uploads it behind the person\'s back');
  assert.match(pm, /mirrorTextFile\(a\.filename, t\.text \|\| '', 'project'/);
});
await Promise.all(__pending);
globalThis.fetch = __realFetch;
for (const k of ['window', 'sessionStorage', 'localStorage']) if (!__had[k]) delete globalThis[k];
}
// ===== END p55-test-round1.test.mjs =====

// ===== BEGIN perf.test.mjs =====
{
// PERF-01: prompt size and token counts are reported in meta; nothing of it reaches the reply text.
const assert = (await import("node:assert/strict")).default;
const http = (await import("node:http")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let withUsage = true; let calls = 0; let requestBodies = [];
const answer = { reply: 'Plain text reply.', question: 'Which city?', contextSufficiency: 'MEDIUM', triage: 'PROCEED', problemClear: true,
  gain: ['HIDDEN_ASSUMPTION'], newOptions: [], state: { coreProblem: 'Move or stay' } };
const fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  calls++; requestBodies.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
    ...(withUsage ? { usageMetadata: { promptTokenCount: 4321, candidatesTokenCount: 210, cachedContentTokenCount: 123, totalTokenCount: 4531 } } : {}) })); }); });
await new Promise((r) => fake.listen(0, r));
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS,
  SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_ROUND_PAUSE_MS: '10' } });
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(250); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const ask = async () => (await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ brief: { decision: 'Should I move?' }, history: [{ role: 'user', content: 'Should I move?' }] }) })).json();

  let r = await ask();
  assert.equal(r.success, true);
  assert.ok(r.meta.promptChars > 3000, 'promptChars should include the system instruction and prompt, got ' + r.meta.promptChars);
  assert.ok(r.meta.inputTokens > 0 && r.meta.outputTokens > 0, 'token counts expected when the API returns them');
  assert.equal(r.meta.inputTokens, 4321 * r.meta.calls, 'tokens are summed over all model responses of the request');
  assert.equal(r.meta.cachedTokens, 123 * r.meta.calls, 'cached tokens are reported in meta');
  assert.ok(!/promptChars|inputTokens|outputTokens|cachedTokens/.test(JSON.stringify(r.data)), 'size data must not be in the answer data');
  assert.ok(!/promptChars|inputTokens|outputTokens|cachedTokens/.test(r.data.reply), 'size data must not be in the reply text');
  console.log('ok - promptChars, token counts and cached tokens are in meta, not in the reply');

  // Token Economy v1.6: the server keeps the full dialogue locally but sends only the last 8 raw turns to Gemini.
  withUsage = true; requestBodies.length = 0; calls = 0;
  const longHistory = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `TURN-${i}-${'x'.repeat(200)}` }));
  r = await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ brief: { decision: 'Should I move?' }, history: longHistory }) }).then(x => x.json());
  assert.equal(r.success, true);
  const sentText = requestBodies.at(-1)?.contents?.[0]?.parts?.[0]?.text || '';
  const turns = sentText.match(/TURN-\d+/g) || [];
  assert.deepEqual(turns, ['TURN-12','TURN-13','TURN-14','TURN-15','TURN-16','TURN-17','TURN-18','TURN-19'], 'only the last 8 turns should reach Gemini');
  assert.equal(r.meta.cachedTokens, 123, 'cached tokens remain visible after compaction');
  console.log('ok - Token Economy compacts the raw transcript to the last 8 turns');

  withUsage = false;
  r = await ask();
  assert.equal(r.success, true);
  assert.ok(r.meta.promptChars > 3000);
  assert.equal('inputTokens' in r.meta, false);
  assert.equal('outputTokens' in r.meta, false);
  console.log('ok - without usageMetadata only promptChars is reported');
  console.log('2 tests passed');
} finally { child.kill(); fake.close(); }
}
// ===== END perf.test.mjs =====

// ===== BEGIN pi01.test.mjs =====
{
// PI-01 (TZ-INSTRUCTIONS-01 P1): the uncertainty contract is in the conversation prompt, and the six-step
// "winter in Switzerland" dialog passes through the real server.ts (fake Gemini) without breaking honesty
// guards. The fake model cannot prove live answer quality; this test proves the prompt and the server path.
const assert = (await import("node:assert/strict")).default;
const http = (await import("node:http")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
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
}
// ===== END pi01.test.mjs =====

// ===== BEGIN pi02.test.mjs =====
{
// PI-02 (TZ-INSTRUCTIONS-01 P2): intent flags feed askAllowed, soft quality-audit, retry text and meta.search_expected.
// Detectors are pure; integration goes through real server.ts on a fake Gemini (no live model quality claims).
const assert = (await import("node:assert/strict")).default;
const http = (await import("node:http")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
const { APP_VERSION } = await import("../src/config.ts");
const { detectUserIntentFlags } = await import("../server/intentFlags.ts");

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
}
// ===== END pi02.test.mjs =====

// ===== BEGIN pi03.test.mjs =====
{
// PI-03 (TZ-INSTRUCTIONS-01 P3): thin mode paragraph on the shared conversation prompt.
const assert = (await import("node:assert/strict")).default;
const http = (await import("node:http")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
const { APP_VERSION } = await import("../src/config.ts");
const { detectConversationMode, modeParagraph } = await import("../server/conversationMode.ts");

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
}
// ===== END pi03.test.mjs =====

// ===== BEGIN stage2.test.mjs =====
{
const __groupOriginalProcessExit = process.exit;
process.exit = (code = 0) => { if (code) throw new Error("Grouped test module stage2.test.mjs requested process.exit" + `(${code})`); };
try {
// Stage 2: real server.ts against a scripted fake Gemini (v20: 195 earlier checks + ROB-01 section K): auth, preconditions, chat invariants, crisis, model failures,
// request-wide call budget (S-4), synthesis format (S-5), headers, all 12 extended endpoints. Prints failures only.
const http = (await import("node:http")).default; const net = (await import("node:net")).default; const fs = (await import("node:fs")).default; const { spawn } = await import("node:child_process");
const { SUPPORT_CONTACTS, DISTRESS_MARKERS, hasDistressMarker } = await import("../src/support.ts");
const { fileURLToPath } = await import("node:url");
const BE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''), PASS = 'pw-123456';
const CASES = JSON.parse(fs.readFileSync(BE + '/tests/regression.json', 'utf8'));
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
  // model input keeps the latest 8 messages; each message is capped at 6000 chars
  recs = []; await s.post('/api/conversation', { brief: { decision: 'x' }, history: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'M' + i + 'y'.repeat(3000) })) });
  const pr = recs[0]?.prompt || ''; T('F6 history capped 8', !pr.includes('"M21y') && pr.includes('"M22y') && pr.includes('"M29y'), 'len ' + pr.length);
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
await withSrv({}, async function H3(s) { script = () => ({ raw: 'broken' }); const r = await conv(s, 'Менять ли работу'); T('H3 two bad answers -> clean error, no walk through the chain', r.s === 200 && r.j?.meta?.stage === 'conversation-fallback' && recs.length === 2, `${r.s} hits=${recs.length} ${r.j?.meta?.stage}`); });
for (const st of [429, 503]) await withSrv({}, async function H4(s) { script = (q) => q.model === 'm1' ? { status: st, message: st === 429 ? 'RESOURCE_EXHAUSTED rate limit' : 'UNAVAILABLE overloaded' } : { json: GOOD() }; const r = await conv(s, 'Менять ли работу');
  T(`H4 ${st} on m1 -> m2`, okc(r) && r.j.meta.model === 'm2' && r.j.meta.fallback === true, `${r.s} ${r.j?.meta?.model}`);
  recs = []; await conv(s, 'ещё раз'); T(`H4b ${st}: m1 on cooldown for next request`, recs[0]?.model === 'm2', recs.map((x) => x.model).join(',')); });
await withSrv({}, async function H5(s) { script = (q) => q.model === 'm1' ? { status: 404, message: 'model not found' } : { json: GOOD() }; const r = await conv(s, 'Менять ли работу'); T('H5 404 model skipped', okc(r) && r.j.meta.model === 'm2', `${r.s}`); });
await withSrv({}, async function H6(s) { script = () => ({ status: 429, message: 'RESOURCE_EXHAUSTED' }); const r = await conv(s, 'Менять ли работу'); T('H6 all models 429 -> 429 + code', r.s === 200 && r.j?.meta?.stage === 'conversation-fallback' && /RATE_LIMIT|QUOTA/.test(r.j?.meta?.errorCode || ''), `${r.s} ${r.j?.meta?.errorCode} hits=${recs.length}`); });
await withSrv({}, async function H6b(s) { script = () => ({ status: 429, message: 'Quota exceeded: daily quota per day' }); const r = await conv(s, 'Менять ли работу'); T('H6b daily quota -> 429 GEMINI_QUOTA', r.s === 200 && r.j?.meta?.errorCode === 'GEMINI_QUOTA', `${r.s} ${r.j?.meta?.errorCode} hits=${recs.length}`); });
await withSrv({}, async function H6c(s) { // quota on one model must not stop the chain; that model is parked for later requests
  script = (q) => q.model === 'm1' ? { status: 429, message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 20' } : { json: GOOD() };
  const r = await conv(s, 'Менять ли работу'); T('H6c quota on m1 -> answered by m2', okc(r) && r.j.meta.model === 'm2', `${r.s} ${r.j?.meta?.model} ${r.j?.meta?.errorCode}`);
  recs = []; await conv(s, 'ещё раз'); T('H6d quota: m1 skipped on next request', recs.length >= 1 && recs[0]?.model === 'm2', recs.map((x) => x.model).join(',')); });
await withSrv({}, async function H7(s) { // quality retry
  const weak = GOOD({ gain: [], newOptions: [] }); script = (q) => q.n === 1 ? { json: weak, usage: { promptTokenCount: 100, candidatesTokenCount: 10 } } : { json: GOOD(), usage: { promptTokenCount: 120, candidatesTokenCount: 20 } };
  const r = await conv(s, 'Стоит ли менять работу'); const m = r.j?.meta || {}; const chars = recs.reduce((a, x) => a + x.system.length + x.prompt.length, 0);
  T('H7 quality fail -> retry on reserve model', okc(r) && recs.length === 2 && recs[1].model === 'm2' && m.model === 'm2', `${r.s} ${recs.map((x) => x.model)}`);
  T('H7b meta sums calls', m.calls === 2, m.calls); T('H7c meta sums promptChars', m.promptChars === chars, `${m.promptChars} vs ${chars}`); T('H7d meta sums tokens 220/30', m.inputTokens === 220 && m.outputTokens === 30, `${m.inputTokens}/${m.outputTokens}`); });
await withSrv({}, async function H8(s) { script = (q) => q.n === 1 ? { json: GOOD({ gain: [] }) } : { status: 503, message: 'UNAVAILABLE' }; const r = await conv(s, 'Стоит ли менять работу'); T('H8 retry fails -> first draft returned', okc(r) && !!r.j.data.reply, `${r.s} calls=${r.j?.meta?.calls}`); });
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
});
// Isolate each failure scenario in a fresh server process so the adaptive model
// cooldown from one synthetic 429 cannot contaminate the next endpoint's test.
for (const [ep, body] of Object.entries(EP)) {
  await withSrv({ MODEL_CASCADE_STRONG: 'm1', MODEL_CASCADE_LIGHT: 'm1' }, async function J2(s) {
    script = () => ({ status: 429, message: 'RESOURCE_EXHAUSTED' });
    const r = await s.post('/api/' + ep, body);
    T('J2 429 mapped on ' + ep, r.s === 429, `got ${r.s} ${r.j?.code || ''}`);
  });
}
for (const ep of Object.keys(EP)) {
  await withSrv({ MODEL_CASCADE_STRONG: 'm1', MODEL_CASCADE_LIGHT: 'm1' }, async function J3(s) {
    script = (q) => q.n % 2 ? { raw: 'bad json' } : { json: ANS[ep] || { note: 'ok' } };
    const r = await s.post('/api/' + ep, EP[ep]);
    T('J3 bad JSON retried ' + ep, r.s === 200, `${r.s} hits=${recs.length}`);
  });
}
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
} finally {
  process.exit = __groupOriginalProcessExit;
}
}
// ===== END stage2.test.mjs =====

// ===== BEGIN state-pipeline.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { applyStatePatch, compactState, isEstablishedFact, estimateTokens, stateItemsSchema } = await import("../server/statePipeline.ts");
const { stateSchemaWithPassport } = await import("../server/contracts.ts");

const agent = { actor: 'agent', sourceRef: 'run:1', now: new Date('2026-10-10T10:00:00Z') };
const human = { actor: 'human', sourceRef: 'ui:1', now: new Date('2026-10-10T11:00:00Z') };
const add = (section, item) => ({ ops: [{ op: 'add', section, item }] });
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.state; };

test('model items are always proposed, ids and provenance are assigned by the system', () => {
  const s = ok(applyStatePatch({}, { ops: [
    { op: 'add', section: 'facts', item: { text: 'Budget is 10k' } },
    { op: 'add', section: 'hypotheses', item: { text: 'Users prefer mobile' } },
    { op: 'add', section: 'risks', item: { text: 'Vendor lock-in', severity: 'high' } },
  ] }, agent));
  assert.deepEqual([s.items.facts[0].id, s.items.facts[0].status, s.items.facts[0].author, s.items.facts[0].source], ['F-1', 'proposed', 'agent', 'run:1']);
  assert.equal(s.items.hypotheses[0].origin, 'model');
  assert.equal(s.items.risks[0].review, 'proposed');
  assert.equal(s.items.facts[0].at, '2026-10-10T10:00:00.000Z');
});

test('policy: a model cannot confirm, cannot touch decisions, cannot set system fields', () => {
  for (const patch of [
    add('facts', { text: 'x', status: 'confirmed' }),
    add('decisions', { text: 'We use X' }),
    add('facts', { text: 'x', author: 'human' }),
    add('facts', { text: 'x', id: 'F-99' }),
  ]) assert.equal(applyStatePatch({}, patch, agent).ok, false);
  const withFact = ok(applyStatePatch({}, add('facts', { text: 'x' }), agent));
  const r = applyStatePatch(withFact, { ops: [{ op: 'update', section: 'facts', id: 'F-1', changes: { status: 'confirmed' } }] }, agent);
  assert.equal(r.errors[0].code, 'POLICY_STATUS');
});

test('decisions: only a human; a hypothesis never becomes a decision by itself', () => {
  const s = ok(applyStatePatch({}, add('decisions', { text: 'Use PostgreSQL', rationale: 'ADR-01' }), human));
  assert.deepEqual([s.items.decisions[0].id, s.items.decisions[0].decided_by], ['D-1', 'human']);
  const r = applyStatePatch(s, { ops: [{ op: 'update', section: 'decisions', id: 'D-1', changes: { text: 'Use MySQL' } }] }, agent);
  assert.equal(r.errors[0].code, 'POLICY_DECISIONS_HUMAN_ONLY');
  assert.equal(applyStatePatch(s, { ops: [{ op: 'reject', section: 'decisions', id: 'D-1' }] }, human).errors[0].code, 'UNSUPPORTED');
});

test('human confirms a proposed item; a model cannot change a confirmed one', () => {
  let s = ok(applyStatePatch({}, add('hypotheses', { text: 'H' }), agent));
  s = ok(applyStatePatch(s, { ops: [{ op: 'update', section: 'hypotheses', id: 'H-1', changes: { status: 'confirmed' } }] }, human));
  assert.deepEqual([s.items.hypotheses[0].status, s.items.hypotheses[0].confirmedBy, s.items.hypotheses[0].updatedBy], ['confirmed', 'human', 'human']);
  const r = applyStatePatch(s, { ops: [{ op: 'reject', section: 'hypotheses', id: 'H-1' }] }, agent);
  assert.equal(r.errors[0].code, 'POLICY_CONFIRMED_IMMUTABLE');
});

test('fact without ref is unverified and not established; artifact+quote is the one rule-based confirmation', () => {
  let s = ok(applyStatePatch({}, add('facts', { text: 'No source' }), human));
  assert.equal(s.items.facts[0].unverified, true);
  assert.equal(isEstablishedFact(s.items.facts[0]), false);   // confirmed by a human, but no source
  s = ok(applyStatePatch(s, { ops: [{ op: 'update', section: 'facts', id: 'F-1', changes: { ref: 'msg:42' } }] }, human));
  assert.equal(isEstablishedFact(s.items.facts[0]), true);
  const a = ok(applyStatePatch({}, add('facts', { text: 'Limit 5 MB', ref: 'artifact:A1@1', quote: 'max 5 MB' }), agent));
  assert.deepEqual([a.items.facts[0].status, a.items.facts[0].confirmedBy], ['confirmed', 'rule:artifact_quote']);
  const b = ok(applyStatePatch({}, add('facts', { text: 'Limit', ref: 'msg:1' }), agent));
  assert.equal(b.items.facts[0].status, 'proposed');
  const c = ok(applyStatePatch({}, add('facts', { text: 'Limit', ref: 'artifact:A1@1', quote: 'q' }), { ...agent, policy: { autoConfirmArtifactQuote: false } }));
  assert.equal(c.items.facts[0].status, 'proposed');
});

test('patch is atomic: one refused operation applies nothing; input state is not mutated', () => {
  const start = { goal: 'g' };
  const r = applyStatePatch(start, { ops: [{ op: 'add', section: 'facts', item: { text: 'ok' } }, { op: 'add', section: 'decisions', item: { text: 'no' } }] }, agent);
  assert.equal(r.ok, false);
  assert.deepEqual(start, { goal: 'g' });
  assert.equal(applyStatePatch({}, { ops: [] }, agent).errors[0].code, 'SCHEMA');
  assert.equal(applyStatePatch({}, { ops: [{ op: 'update', section: 'facts', id: 'F-9', changes: {} }] }, agent).errors[0].code, 'NOT_FOUND');
});

test('model rejects only its own proposed items; ids keep growing', () => {
  let s = ok(applyStatePatch({}, add('unknowns', { text: 'Who pays?', impact: 'high' }), agent));
  s = ok(applyStatePatch(s, { ops: [{ op: 'reject', section: 'unknowns', id: 'U-1', reason: 'duplicate' }, { op: 'add', section: 'unknowns', item: { text: 'Next', impact: 'low' } }] }, agent));
  assert.deepEqual([s.items.unknowns[0].review, s.items.unknowns[1].id], ['rejected', 'U-2']);
});

test('State schema: invalid items are refused wherever State is written', () => {
  assert.equal(stateSchemaWithPassport.safeParse({ items: { facts: [{ id: 'bad' }] } }).success, false);
  assert.equal(stateSchemaWithPassport.safeParse({ goal: 'x' }).success, true);
});

test('compaction: protected classes keep IDs and full text; low priority is shortened first', () => {
  const long = (t) => `${t} ` + 'x'.repeat(900);
  const mk = (n, extra) => Array.from({ length: n }, (_, i) => ({ text: long(`f${i}`), ...extra }));
  let s = {};
  s = ok(applyStatePatch(s, { ops: [
    ...mk(6, {}).map((item) => ({ op: 'add', section: 'facts', item: { ...item, ref: 'msg:1' } })),
    { op: 'add', section: 'decisions', item: { text: long('decision'), rationale: long('why') } },
    { op: 'add', section: 'requirements', item: { text: long('req'), acceptance: long('accept') } },
    { op: 'add', section: 'risks', item: { text: long('high risk'), severity: 'high' } },
    { op: 'add', section: 'risks', item: { text: long('low risk'), severity: 'low' } },
  ] }, human));
  // make one fact rejected and one proposed: they must be shortened before confirmed ones
  s = ok(applyStatePatch(s, { ops: [{ op: 'reject', section: 'facts', id: 'F-1' }, { op: 'update', section: 'facts', id: 'F-2', changes: { status: 'proposed' } }] }, human));
  const before = structuredClone(s.items);
  const limits = { facts: 900, risks: 300, decisions: 1, requirements: 1 };
  const c = compactState(s, limits);
  assert.equal(c.ok, true); assert.equal(c.changed, true);
  const after = c.state.items;
  for (const sec of ['decisions', 'requirements']) assert.deepEqual(after[sec], before[sec]);   // never compressed
  assert.deepEqual(after.risks.find((r) => r.severity === 'high'), before.risks.find((r) => r.severity === 'high'));
  for (const sec of Object.keys(before)) assert.deepEqual(after[sec].map((x) => x.id), before[sec].map((x) => x.id));   // no ID lost
  assert.equal(after.risks.find((r) => r.severity === 'low').compacted, true);
  const firstTwo = c.compacted.filter((x) => x.section === 'facts').slice(0, 2).map((x) => x.id);
  assert.deepEqual(firstTwo, ['F-1', 'F-2']);   // rejected, then proposed, before confirmed
  assert.ok(estimateTokens(after.facts) < estimateTokens(before.facts));
  assert.equal(stateItemsSchema.safeParse(after).success, true);
  assert.deepEqual(before, structuredClone(s.items));   // input untouched
  assert.equal(compactState({}, limits).changed, false);
});
}
// ===== END state-pipeline.test.mjs =====
