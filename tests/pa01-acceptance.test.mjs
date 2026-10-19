// PA-01 acceptance: gate evaluator rules (TZ 11.9, 17), evidence collector (fake fetch), workflow safety, secret hygiene. No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateE01, evaluateGate, buildCard, renderCard, stepVerdict, scrub, GATES, G3_IF_POSITIVE, ATTEST_ALLOWED } from '../scripts/gate-eval.mjs';
import { collect, checkService, summaryMarkdown } from '../scripts/evidence-collect.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const fx = JSON.parse(read('tests/pa01-fixtures.json'));
const REC = 'https://github.com/example/bf/actions/runs/1';
const allPass = (ids) => Object.fromEntries(ids.map((id) => [id, { status: 'PASS', record: REC }]));

test('E-01 rule: the three outcomes of TZ 11.9 and the owner-judgement case', () => {
  assert.equal(evaluateE01(fx.positive).result, 'POSITIVE');
  assert.equal(evaluateE01(fx.negative).result, 'NEGATIVE');
  assert.equal(evaluateE01(fx.both_failed).result, 'BOTH_FAILED');
  assert.equal(evaluateE01(fx.needs_human).result, 'NEEDS_HUMAN');
});

test('E-01 rule: 3 fixes is not a success (limit is 2); unapplied patch is not a success', () => {
  const r = evaluateE01(fx.too_many_fixes);
  assert.equal(r.mp, 0);
  assert.notEqual(r.result, 'POSITIVE');
  const rows = structuredClone(fx.positive).map((p) => (p.executor === 'model_patch' ? { ...p, applies: false } : p));
  assert.notEqual(evaluateE01(rows).result, 'POSITIVE');
});

test('E-01 rule: incomplete evidence never yields a branch', () => {
  assert.equal(evaluateE01([]).result, 'INSUFFICIENT_EVIDENCE');
  assert.equal(evaluateE01(undefined).result, 'INSUFFICIENT_EVIDENCE');
  assert.equal(evaluateE01(fx.positive.slice(1)).result, 'INSUFFICIENT_EVIDENCE');
  const noSha = structuredClone(fx.positive); noSha[0].sha = 'zz';
  assert.equal(evaluateE01(noSha).result, 'INSUFFICIENT_EVIDENCE');
  const noLink = structuredClone(fx.positive); noLink[1].ci_url = 'http://insecure';
  assert.equal(evaluateE01(noLink).result, 'INSUFFICIENT_EVIDENCE');
  const dup = [...fx.positive.slice(0, 5), { ...fx.positive[5], task: 't1' }];
  assert.equal(evaluateE01(dup).result, 'INSUFFICIENT_EVIDENCE');
});

test('Gates: all required steps with records give POSITIVE; a gate is never accepted with a non-satisfying row', () => {
  for (const g of Object.keys(GATES)) {
    assert.equal(evaluateGate(g, { steps: allPass(GATES[g]) }).result, 'POSITIVE', g);
    for (const bad of ['NOT_RUN', 'BLOCKED', 'REAL_ONLY', 'PARTIAL']) {
      const steps = allPass(GATES[g]); steps[GATES[g][0]] = { status: bad, record: REC };
      assert.notEqual(evaluateGate(g, { steps }).result, 'POSITIVE', `${g} with ${bad}`);
    }
    const missing = allPass(GATES[g]); delete missing[GATES[g][0]];
    assert.equal(evaluateGate(g, { steps: missing }).result, 'INSUFFICIENT_EVIDENCE');
    const failed = allPass(GATES[g]); failed[GATES[g][0]] = { status: 'FAIL', record: REC };
    assert.equal(evaluateGate(g, { steps: failed }).result, 'NEGATIVE');
  }
});

test('PASS without a record counts as NOT_RUN (docs/NEXT.md rule 2)', () => {
  assert.equal(stepVerdict('RM-B4', { status: 'PASS' }).ok, false);
  assert.equal(stepVerdict('RM-B4', { status: 'PASS', record: '  ' }).ok, false);
  assert.equal(stepVerdict('RM-B4', { status: 'PASS', record: REC }).ok, true);
});

test('Attestation closes only owner-judgement steps; WAIVED needs owner and reason; scripted steps carry a deviation', () => {
  assert.ok(ATTEST_ALLOWED.has('RM-B1'));
  assert.equal(stepVerdict('RM-B1', { status: 'OWNER_ATTESTED', record: 'docs/ADR-10-code-executor.md' }).ok, true);
  assert.equal(stepVerdict('RM-B4', { status: 'OWNER_ATTESTED', record: 'docs/ADR-10-code-executor.md' }).ok, false);
  assert.equal(stepVerdict('RM-B5', { status: 'OWNER_ATTESTED', record: 'x' }).ok, false);
  assert.equal(stepVerdict('RM-E1', { status: 'WAIVED', reason: 'r' }).ok, false);
  assert.equal(stepVerdict('RM-E1', { status: 'WAIVED', by: 'owner' }).ok, false);
  assert.equal(stepVerdict('RM-E1', { status: 'WAIVED', by: 'owner', reason: 'r', record: 'x' }).ok, true);
  const s = stepVerdict('RM-B4', { status: 'SCRIPTED_HUMAN_STEP', record: REC });
  assert.ok(s.ok && /scripted/.test(s.deviation));
  const card = buildCard('G2', { steps: { 'RM-B4': { status: 'SCRIPTED_HUMAN_STEP', record: REC }, 'RM-B5': { status: 'PASS', record: REC }, 'RM-B6': { status: 'PASS', record: REC } } });
  assert.equal(card.recommendation, 'ACCEPT');
  assert.equal(card.deviations.length, 1);
});

test('G3 requires stage C steps only after a POSITIVE E-01', () => {
  const steps = allPass(GATES.G3);
  assert.equal(evaluateGate('G3', { steps }).result, 'POSITIVE');
  assert.equal(evaluateGate('G3', { steps, e01: fx.negative }).result, 'POSITIVE');
  assert.equal(evaluateGate('G3', { steps, e01: fx.positive }).result, 'INSUFFICIENT_EVIDENCE');
  assert.equal(evaluateGate('G3', { steps: { ...steps, ...allPass(G3_IF_POSITIVE) }, e01: fx.positive }).result, 'POSITIVE');
});

test('Cards: fields of the template, recommendations, no recommendation when the owner must judge', () => {
  const c = renderCard(buildCard('ADR-10', { date: '2026-10-13', commit: 'abc1234', ci: REC, e01: fx.positive }));
  for (const f of ['CARD: ADR-10', 'DATE:', 'RULE:', 'EVIDENCE:', 'RULE RESULT: POSITIVE', 'RECOMMENDATION: ACCEPT', 'DEVIATIONS FROM THE TZ:', 'IF ACCEPTED, THE AI ASSISTANT WILL:', 'IF REJECTED:', 'REPLY: "ok ADR-10"']) assert.ok(c.includes(f), f);
  assert.match(renderCard(buildCard('ADR-10', { e01: fx.needs_human })), /RECOMMENDATION: NO_RECOMMENDATION/);
  assert.match(renderCard(buildCard('ADR-10', {})), /RECOMMENDATION: COLLECT_MORE/);
  assert.match(renderCard(buildCard('G2', {})), /RECOMMENDATION: COLLECT_MORE/);
  assert.match(renderCard(buildCard('G3', { steps: { 'RM-D1': { status: 'FAIL', record: REC } } })), /RECOMMENDATION: REJECT/);
});

test('Secrets never reach a card, a summary or collector output', async () => {
  const secret = 'S3cr3t-value-123456';
  const env = { ...process.env, PA01_TEST_API_KEY: secret };
  Object.assign(process.env, { PA01_TEST_API_KEY: secret });
  try {
    const card = renderCard(buildCard('G2', { steps: { 'RM-B4': { status: 'NOT_RUN', note: `leak ${secret}`, record: `https://x/${secret}` } } }));
    assert.ok(!card.includes(secret));
    assert.ok(!scrub(`key AIza${'a'.repeat(30)} and ghp_${'b'.repeat(30)}`).match(/AIza|ghp_/));
    const fetcher = async () => { throw new Error(secret); };
    const r = await collect({ env: { SERVICE_URL: 'https://svc.example', EXPECTED_SHA: 'abc1234', PA01_TEST_API_KEY: secret }, fetcher, skipConnections: true });
    assert.ok(!JSON.stringify(r).includes(secret));
    assert.ok(!summaryMarkdown(r).includes(secret));
    void env;
  } finally { delete process.env.PA01_TEST_API_KEY; }
});

const okFetch = (commit, ready = true) => async (url) => {
  const u = String(url);
  if (u.endsWith('/health')) return { status: 200, json: async () => ({ status: 'ok', version: '24', commit }) };
  if (u.endsWith('/ready')) return ready ? { status: 200, json: async () => ({ status: 'ready' }) } : { status: 503, json: async () => ({ status: 'not_ready', reason: 'database_unavailable' }) };
  if (u.endsWith('/api/login')) return { ok: true, status: 200, headers: { get: () => 'sid=abc; Path=/' }, json: async () => ({}) };
  if (u.endsWith('/api/conversation')) return { status: 200, json: async () => ({ success: true, data: { reply: 'ok' } }) };
  throw new Error('unexpected ' + u);
};

test('Collector: /health commit equals expected main commit -> PASS; mismatch -> FAIL; no URL -> NOT_RUN', async () => {
  assert.equal((await checkService({ SERVICE_URL: 'https://s', EXPECTED_SHA: 'abcdef1234567' }, okFetch('abcdef1'))).health.status, 'PASS');
  assert.equal((await checkService({ SERVICE_URL: 'https://s', EXPECTED_SHA: 'abcdef1234567' }, okFetch('1234567'))).health.status, 'FAIL');
  assert.equal((await checkService({ SERVICE_URL: 'https://s' }, okFetch('abcdef1'))).health.status, 'NOT_RUN');
  assert.equal((await checkService({}, okFetch('x'))).health.status, 'NOT_RUN');
  assert.equal((await checkService({ SERVICE_URL: 'https://s', EXPECTED_SHA: 'abcdef1' }, okFetch('abcdef1', false))).ready.status, 'FAIL');
});

test('Collector: RM-A3 is PARTIAL without the answer smoke and PASS with it; PASS carries the run record', async () => {
  const base = { SERVICE_URL: 'https://s', EXPECTED_SHA: 'abcdef1234567', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' };
  const verifyOk = (only) => ({ results: only.map((c) => ({ connector: c, check: 'x', status: 'OK' })) });
  const keys = { GEMINI_API_KEY: 'g'.repeat(10), GROQ_API_KEY: 'q'.repeat(10) };
  const r1 = await collect({ env: { ...base, ...keys }, fetcher: okFetch('abcdef1'), verify: verifyOk });
  assert.equal(r1.steps['RM-A3'].status, 'PARTIAL');
  assert.equal(r1.steps['RM-A4'].status, 'PASS');
  assert.equal(r1.steps['RM-B2'].status, 'PARTIAL'); // registry record and real smoke are not covered
  assert.equal(r1.steps['RM-D1'].status, 'NOT_RUN');
  assert.match(r1.steps['RM-A4'].record, /actions\/runs\/9$/);
  const r2 = await collect({ env: { ...base, ...keys, APP_PASSWORD: 'p'.repeat(10) }, fetcher: okFetch('abcdef1'), verify: verifyOk });
  assert.equal(r2.steps['RM-A3'].status, 'PASS');
  // PARTIAL never closes a gate
  assert.notEqual(evaluateGate('G1', { steps: r2.steps }).result, 'POSITIVE');
});

test('Collector: a failing connection is FAIL; a verify run that cannot start is BLOCKED; no record outside Actions', async () => {
  const keys = { GEMINI_API_KEY: 'g'.repeat(10), GROQ_API_KEY: 'q'.repeat(10) };
  const bad = (only) => ({ results: only.map((c) => ({ connector: c, check: 'list_models', status: c === 'groq' ? 'FAIL' : 'OK' })) });
  const r = await collect({ env: { SERVICE_URL: 'https://s', EXPECTED_SHA: 'abcdef1', ...keys }, fetcher: okFetch('abcdef1'), verify: bad });
  assert.equal(r.steps['RM-B2'].status, 'FAIL');
  assert.equal(r.steps['RM-A4'].status, 'FAIL');
  const b = await collect({ env: { SERVICE_URL: 'https://s', EXPECTED_SHA: 'abcdef1', ...keys }, fetcher: okFetch('abcdef1'), verify: () => null });
  assert.equal(b.steps['RM-A4'].status, 'BLOCKED');
  assert.equal(r.steps['RM-A3'].record, null);
});

test('Workflow evidence.yml is read-only, manual and writes nothing', () => {
  const y = read('.github/workflows/evidence.yml');
  assert.match(y, /^on:\s*workflow_dispatch\s*$/m);
  assert.doesNotMatch(y, /^\s*(push|pull_request|schedule):/m);
  assert.match(y, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(y, /contents:\s*write|issues:\s*write|pull-requests:\s*write|git push|git commit|gh pr|gh api/);
  for (const m of y.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) assert.match(m[1], /^(secrets\.[A-Z_]+|vars\.[A-Z_]+|github\.sha)$/, m[1]);
});

test('Delegation policy is in force, tiers are written down, tier 3 is not delegable', () => {
  const d = read('docs/DELEGATION.md');
  for (const t of ['Tier 0', 'Tier 1', 'Tier 2', 'Tier 3']) assert.ok(d.includes(t) || d.includes(t.replace('Tier ', '| ')), t);
  assert.match(d, /merge/i);
  assert.match(d, /Silence never means consent/);
  assert.match(read('AGENTS.md'), /docs\/DELEGATION\.md/);
});
