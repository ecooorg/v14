/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN p56-feature-guard.test.mjs =====
{
/**
 * P56: regression guard for the whole product (owner rule: later patches only improve and fix, they never silently remove a function).
 *  1. Every test file is wired into an npm script, and every test:* script is part of `npm run check` (or is one of the separate CI steps).
 *  2. The public surface listed in tests/feature-manifest.json (API routes, modules, key screens and controls, check chain) is still there.
 * Removing something on purpose: edit tests/feature-manifest.json in the same patch and explain it in CHANGELOG.md.
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;

const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const pkg = JSON.parse(read('package.json')).scripts;
const manifest = JSON.parse(read('tests/feature-manifest.json'));
const hint = 'If this removal is intentional, update tests/feature-manifest.json in the same patch and explain it in CHANGELOG.md.';

// Test scripts that run as their own CI step (they need PostgreSQL, a browser or network), not inside `npm run check`.
const SEPARATE_CI_STEPS = new Set(['lint', 'test', 'test:live', 'test:ui', 'verify:connections', 'test:database:live', 'test:bx06:api']);

function currentRoutes() {
  const files = ['server.ts', ...fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.ts')).map((f) => `server/${f}`)];
  const out = new Set();
  for (const f of files) for (const m of read(f).matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  return out;
}

test('P56 every test file is run by some npm script (no silent orphans)', () => {
  const scripts = Object.values(pkg).join(' ');
  const files = fs.readdirSync(path.join(root, 'tests')).filter((f) => /\.(test\.)?mjs$/.test(f) && f !== 'ui-check.mjs');
  const orphans = files.filter((f) => !scripts.includes(`tests/${f}`));
  assert.deepEqual(orphans, [], `These test files are not run by any npm script, so CI never runs them: ${orphans.join(', ')}`);
});

test('P56 every test script is part of the check chain or a separate CI step', () => {
  const chain = new Set([...pkg.check.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
  for (const name of Object.keys(pkg)) {
    if (!/^(test|lint|typecheck|verify)/.test(name) || name === 'check') continue;
    assert.ok(chain.has(name) || SEPARATE_CI_STEPS.has(name), `npm script ${name} is not in "check" and is not a listed separate CI step`);
  }
  for (const name of chain) assert.ok(pkg[name], `"check" runs npm run ${name}, but the script does not exist`);
  for (const name of SEPARATE_CI_STEPS) assert.ok(pkg[name], `separate CI step ${name} is missing`);
});

test('P56 no npm script uses --test-force-exit (it silently drops tests that register after an await)', () => {
  // The grouped test files register tests after top-level `await import(...)`. --test-force-exit kills the process as soon as the
  // tests registered so far finish, so a varying share of the suite never ran (and never failed) in CI.
  const bad = Object.entries(pkg).filter(([, cmd]) => /--test-force-exit/.test(String(cmd))).map(([name]) => name);
  assert.deepEqual(bad, [], `Remove --test-force-exit from: ${bad.join(', ')}`);
});

test('P56 nothing was dropped from the check chain', () => {
  const chain = new Set([...pkg.check.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
  const dropped = manifest.checkChain.filter((n) => !chain.has(n));
  assert.deepEqual(dropped, [], `These checks used to run in "check" and no longer do: ${dropped.join(', ')}. ${hint}`);
});

test('P56 every API route of the manifest is still registered', () => {
  const now = currentRoutes();
  const gone = manifest.routes.filter((r) => !now.has(r));
  assert.deepEqual(gone, [], `API routes removed or renamed: ${gone.join(', ')}. ${hint}`);
  assert.ok(manifest.routes.length >= 70, 'the manifest must keep covering the API');
});

test('P56 every module of the manifest still exists', () => {
  const gone = manifest.modules.filter((m) => !exists(m));
  assert.deepEqual(gone, [], `Modules removed or renamed: ${gone.join(', ')}. ${hint}`);
});

test('P56 key screens and controls are still in the code', () => {
  const gone = [];
  for (const [file, needles] of Object.entries(manifest.ui)) {
    const text = read(file);
    for (const n of needles) if (!text.includes(n)) gone.push(`${file}: ${n}`);
  }
  assert.deepEqual(gone, [], `Controls or wiring removed: ${gone.join(' | ')}. ${hint}`);
  assert.ok(Object.keys(manifest.ui).length >= 5);
});

test('P56 the manifest itself is current enough: new routes and modules do not need a manifest edit, removals do', () => {
  assert.equal(typeof manifest._about, 'string');
  assert.ok(new Set(manifest.routes).size === manifest.routes.length, 'no duplicate routes in the manifest');
  assert.ok(manifest.routes.every((r) => /^(GET|POST|PUT|PATCH|DELETE) (\/|\*)/.test(r)));
});
}
// ===== END p56-feature-guard.test.mjs =====

// ===== BEGIN regression.test.mjs =====
{
// QA-02: 10 control situations. Real server.ts + fake Gemini returning a fixed (deliberately messy) model answer.
// Checks server-side processing only; live answer quality is checked in stage 2 (S2-06).
const assert = (await import("node:assert/strict")).default;
const http = (await import("node:http")).default;
const net = (await import("node:net")).default;
const { readFileSync } = await import("node:fs");
const { spawn } = await import("node:child_process");
const CASES = JSON.parse(readFileSync(new URL('./regression.json', import.meta.url), 'utf8'));
const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let answer = {}, retryAnswer = null, hits = 0;
const fake = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { hits++; res.setHeader('Content-Type', 'application/json');
  const responseAnswer = hits > 1 && retryAnswer ? retryAnswer : answer;
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(responseAnswer) }] }, finishReason: 'STOP' }] })); }); });
await new Promise((r) => fake.listen(0, r));
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS,
  SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_ROUND_PAUSE_MS: '10' } });
const MARKUP = /\*\*|__|^#{1,6}\s|`|^\s*[*•]\s/m, LABELS = /USER[ _]FACT|GENERAL[ _]KNOWLEDGE|HYPOTHESIS|problemClear|driftDetected|notUnderstoodSignal|\(Source:|USER_DATA|GENERAL_PATTERN/;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(250); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  for (const c of CASES) {
    answer = c.model; retryAnswer = c.retryModel || null; hits = 0;
    let history = [{ role: 'user', content: c.first }];
    if (c.second) history = [...history, { role: 'assistant', content: c.previousAssistant || 'ok' }, { role: 'user', content: c.second }];
    const r = await (await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ brief: { decision: c.first }, history, state: c.previousAssistant ? { facts: [], hypotheses: [] } : undefined }) })).json();
    assert.equal(r.success, true, c.id + ': ' + JSON.stringify(r));
    const reply = r.data.reply, e = c.expect;
    const qn = (reply.match(/[?？]/g) || []).length;
    assert.ok(qn <= e.maxQuestions, `${c.id}: ${qn} questions > ${e.maxQuestions}\n${reply}`);
    if (e.noMarkup) assert.ok(!MARKUP.test(reply), `${c.id}: markup in reply\n${reply}`);
    if (e.noLabels) assert.ok(!LABELS.test(JSON.stringify(r.data)), `${c.id}: service label leaked`);
    for (const f of e.factsAbsent) assert.ok(!r.data.state.facts.includes(f), `${c.id}: hypothesis in facts`);
    assert.ok(reply.trim().length > 20, c.id + ': empty reply');
    // v19 (PERF-01): meta.calls counts every model call of the request, including the quality retry
    assert.equal(r.meta.calls, e.calls, `${c.id}: model calls ${r.meta.calls}`);
    assert.equal(hits, r.meta.calls, `${c.id}: meta.calls ${r.meta.calls} != real model hits ${hits}`);
    console.log('ok -', c.id);
  }
  console.log(CASES.length + ' tests passed');
} finally { child.kill(); fake.close(); }
}
// ===== END regression.test.mjs =====
