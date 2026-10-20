/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN gate-engine.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { GATE_RULES_VERSION, RC_REQUIRED_GATES, canAdvance, evaluateAll, evaluateGate, evaluateTestIntegrity, gateForCheckName, releaseManifest, statusFromCheckRun, validateEvidence } = await import("../server/gateEngine.ts");

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const ev = (o = {}) => ({ gate: 'build', checkName: 'build', status: 'PASS', commitSha: A, source: 'ci', rulesVersion: GATE_RULES_VERSION, tool: 'github-check:actions', createdAt: '2026-10-11T10:00:00Z', ...o });

test('PASS is impossible without evidence; no evidence is NOT_RUN', () => {
  assert.equal(evaluateGate('build', [], A).status, 'NOT_RUN');
  assert.equal(evaluateGate('build', [ev({ commitSha: B })], A).status, 'NOT_RUN', 'evidence of another commit does not count');
  assert.equal(evaluateGate('build', [ev({ invalidated: true })], A).status, 'NOT_RUN', 'invalidated evidence does not count');
  assert.equal(evaluateGate('build', [ev()], A).status, 'PASS');
});

test('model statements and malformed evidence are rejected', () => {
  assert.equal(validateEvidence(ev({ source: 'model' })), 'untrusted_source');
  assert.equal(validateEvidence(ev({ source: 'approval' })), 'source_not_allowed_for_gate');
  assert.equal(validateEvidence(ev({ commitSha: 'main' })), 'invalid_commit_sha');
  assert.equal(validateEvidence(ev({ rulesVersion: 'x' })), 'unknown_rules_version');
  assert.equal(validateEvidence(ev({ status: 'WAIVED' })), 'waived_requires_waiver_record');
  assert.equal(evaluateGate('build', [ev({ source: 'model' })], A).status, 'NOT_RUN');
});

test('check run conclusions map deterministically (logs are never read)', () => {
  assert.equal(statusFromCheckRun('completed', 'success'), 'PASS');
  assert.equal(statusFromCheckRun('completed', 'failure'), 'FAIL');
  for (const c of ['timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']) assert.equal(statusFromCheckRun('completed', c), 'BLOCKED');
  for (const c of ['neutral', 'skipped', null]) assert.equal(statusFromCheckRun('completed', c), 'NOT_RUN');
  assert.equal(statusFromCheckRun('in_progress', 'success'), 'NOT_RUN');
  assert.equal(gateForCheckName('Scan repository for leaked secrets'), 'security');
  assert.equal(gateForCheckName('unit tests'), 'test');
  assert.equal(gateForCheckName('Build application'), 'build');
  assert.equal(gateForCheckName('deploy preview'), null);
});

test('several checks per gate: any FAIL beats PASS; the latest result of a check wins', () => {
  const mixed = [ev({ checkName: 'a' }), ev({ checkName: 'b', status: 'FAIL' })];
  assert.equal(evaluateGate('build', mixed, A).status, 'FAIL');
  const rerun = [ev({ checkName: 'b', status: 'FAIL', createdAt: '2026-10-11T10:00:00Z' }), ev({ checkName: 'b', status: 'PASS', createdAt: '2026-10-11T10:05:00Z' })];
  assert.equal(evaluateGate('build', rerun, A).status, 'PASS');
  assert.equal(evaluateGate('build', [ev(), ev({ checkName: 'x', status: 'BLOCKED' })], A).status, 'BLOCKED');
  assert.equal(evaluateGate('build', [ev(), ev({ checkName: 'x', status: 'REAL_ONLY' })], A).status, 'REAL_ONLY');
});

test('Test Integrity: any change under tests/acceptance/** is FAIL', () => {
  assert.equal(evaluateTestIntegrity([{ filename: 'server/a.ts', status: 'modified' }]).status, 'PASS');
  for (const f of [{ filename: 'tests/acceptance/x.test.mjs', status: 'modified' }, { filename: 'tests/acceptance/x.test.mjs', status: 'removed' }, { filename: 'tests/acceptance/new.mjs', status: 'added' },
    { filename: 'tests/other.mjs', status: 'renamed', previous_filename: 'tests/acceptance/x.mjs' }, { filename: 'Tests/Acceptance/x.mjs', status: 'added' }, { filename: 'tests/acceptance/../../x', status: 'added' }]) {
    assert.equal(evaluateTestIntegrity([f]).status, 'FAIL', JSON.stringify(f));
  }
  assert.equal(evaluateTestIntegrity([], { truncated: true }).status, 'BLOCKED', 'an unreadable diff never passes');
  assert.equal(evaluateTestIntegrity([{ filename: 'tests/acceptance-notes.md', status: 'added' }]).status, 'PASS');
  // P20: paths declared in the approved Task Package do not fail integrity
  const base = evaluateTestIntegrity(
    [{ filename: 'tests/acceptance/from-package.test.mjs', status: 'added' }],
    { packageAcceptancePaths: ['tests/acceptance/from-package.test.mjs'] },
  );
  assert.equal(base.status, 'PASS');
  assert.ok(base.packageBaseline.length >= 1);
});

test('WAIVED needs a human reason and a matching commit', () => {
  const w = { gate: 'test_integrity', commitSha: A, reason: 'approved by owner', actor: 'owner' };
  const failing = [ev({ gate: 'test_integrity', checkName: 'd', status: 'FAIL', source: 'diff' })];
  assert.equal(evaluateGate('test_integrity', failing, A, [w]).status, 'WAIVED');
  assert.equal(evaluateGate('test_integrity', failing, B, [w]).status, 'NOT_RUN', 'a waiver does not carry to another commit');
  assert.equal(evaluateGate('test_integrity', failing, A, [{ ...w, reason: '  ' }]).status, 'FAIL');
});

test('Release Candidate is derived: PASS only when every other gate is PASS or WAIVED; advance is blocked otherwise', () => {
  const all = RC_REQUIRED_GATES.map((g) => ev({ gate: g, checkName: g, source: { requirements: 'approval', spec: 'approval', review: 'approval', test_integrity: 'diff' }[g] || 'ci' }));
  const full = evaluateAll(all, A);
  assert.equal(full.release_candidate.status, 'PASS');
  const m = releaseManifest(full, all, A, []);
  assert.equal(m.complete, true); assert.equal(m.commit, A); assert.equal(m.rules_version, GATE_RULES_VERSION);
  const missing = evaluateAll(all.filter((e) => e.gate !== 'security'), A);
  assert.equal(missing.release_candidate.status, 'NOT_RUN');
  assert.equal(canAdvance(missing, RC_REQUIRED_GATES).allowed, false);
  const failed = evaluateAll(all.map((e) => (e.gate === 'test' ? { ...e, status: 'FAIL' } : e)), A);
  assert.equal(failed.release_candidate.status, 'FAIL');
  assert.deepEqual(canAdvance(failed, ['test']).blockers, ['test:FAIL']);
  assert.equal(evaluateAll(all, B).release_candidate.status, 'NOT_RUN', 'code changed after the gate: evidence no longer applies');
});
}
// ===== END gate-engine.test.mjs =====

// ===== BEGIN pa01-acceptance.test.mjs =====
{
// PA-01 acceptance: gate evaluator rules (TZ 11.9, 17), evidence collector (fake fetch), workflow safety, secret hygiene. No network, no database.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { evaluateE01, evaluateGate, buildCard, renderCard, stepVerdict, scrub, GATES, G3_IF_POSITIVE, ATTEST_ALLOWED } = await import("../scripts/gate-eval.mjs");
const { collect, checkService, summaryMarkdown } = await import("../scripts/evidence-collect.mjs");

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

test('Delegation policy is in force in AGENTS.md, tiers are written down, tier 3 is not delegable', () => {
  const d = read('AGENTS.md');
  for (const t of ['Tier 0', 'Tier 1', 'Tier 2', 'Tier 3']) assert.ok(d.includes(t), t);
  assert.match(d, /Tier 3:\*\* Never decide alone/);
  assert.match(d, /merge/i);
});
}
// ===== END pa01-acceptance.test.mjs =====

// ===== BEGIN pa02-acceptance.test.mjs =====
{
/**
 * PA-02: E-01 harness shape, validation, and gate-eval consumption.
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests/pa02-fixtures.json');
const harness = path.join(root, 'scripts/e01-harness.mjs');

test('fixtures: exactly three tasks with package + modelPatch + manual', () => {
  const data = JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  assert.equal(data.tasks.length, 3);
  for (const t of data.tasks) {
    assert.ok(t.taskId);
    assert.ok(t.package?.allowedPaths);
    assert.ok(t.modelPatch?.files?.length);
    assert.ok(t.manual?.sha);
    assert.ok(String(t.manual.ciUrl).startsWith('https://'));
  }
});

test('e01-harness dry-run: writes e01-results.json with rule outcome', () => {
  const out = path.join(root, 'tests/pa02-e01-out.json');
  try {
    const r = spawnSync(process.execPath, [harness, '--fixtures', fixtures, '--out', out], {
      encoding: 'utf8',
      cwd: root,
      timeout: 15_000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(result.experiment, 'E-01');
    assert.equal(result.pairs.length, 6);
    assert.ok(['POSITIVE', 'NEGATIVE', 'NEEDS_HUMAN', 'INSUFFICIENT_EVIDENCE'].includes(result.rule.outcome));
    assert.ok(result.rule.reason);
    // Fixture model patches are valid → applied; human minutes 5*3 vs 12+18+25
    assert.equal(result.rule.outcome, 'POSITIVE');
  } finally {
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

test('e01-harness: rejects protected path in a synthetic fixture', () => {
  const bad = path.join(root, 'tests/pa02-bad-tmp.json');
  const out = path.join(root, 'tests/pa02-bad-out.json');
  const data = JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  data.tasks[0].modelPatch = {
    files: [{ path: 'tests/acceptance/hack.test.mjs', action: 'create', content: 'x\n' }],
  };
  fs.writeFileSync(bad, JSON.stringify(data));
  try {
    const r = spawnSync(process.execPath, [harness, '--fixtures', bad, '--out', out], {
      encoding: 'utf8',
      cwd: root,
      timeout: 15_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    const m1 = result.pairs.find((p) => p.taskId === 'e01-t1' && p.side === 'model_patch');
    assert.equal(m1.applied, false);
    assert.ok(result.rule.outcome === 'NEGATIVE' || result.rule.outcome === 'INSUFFICIENT_EVIDENCE');
  } finally {
    if (fs.existsSync(bad)) fs.unlinkSync(bad);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

test('gate-eval can score E-01 table when present (shape only)', async () => {
  const gatePath = path.join(root, 'scripts/gate-eval.mjs');
  assert.ok(fs.existsSync(gatePath), 'gate-eval.mjs from PA-01');
  // Minimal evidence blob with e01 embedded — gate-eval may ignore unknown keys; we only check it still runs.
  const evidence = {
    steps: {},
    e01: {
      pairs: [
        { taskId: 't1', side: 'model_patch', applied: true, ciGreenFirst: true, fixes: 0, humanMinutes: 5, costUsd: 0.01, sha: 'a'.repeat(40), ciUrl: 'https://example.com/1' },
        { taskId: 't1', side: 'manual', applied: true, ciGreenFirst: true, fixes: 0, humanMinutes: 10, costUsd: 0, sha: 'b'.repeat(40), ciUrl: 'https://example.com/2' },
      ],
    },
  };
  const evFile = path.join(root, 'tests/pa02-evidence-tmp.json');
  fs.writeFileSync(evFile, JSON.stringify(evidence));
  try {
    const r = spawnSync(process.execPath, [gatePath, '--all', '--input', evFile], {
      encoding: 'utf8',
      cwd: root,
      timeout: 15_000,
    });
    // gate-eval may exit 0 or print cards; absence of crash is enough for shape compatibility
    assert.ok(r.status === 0 || r.status === 1 || r.status === 2, `status ${r.status}: ${r.stderr}\n${r.stdout}`);
  } finally {
    if (fs.existsSync(evFile)) fs.unlinkSync(evFile);
  }
});
}
// ===== END pa02-acceptance.test.mjs =====

// ===== BEGIN pa03-acceptance.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const { collectStagingEvidence, renderSummary } = await import("../scripts/staging-drills.mjs");

const response = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('PA-03 refuses missing or non-staging service URLs without making network calls', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('must not be called'); };
  const missing = await collectStagingEvidence({ env: {}, fetcher });
  assert.equal(missing.checks.find((c) => c.id === 'staging_url').status, 'NOT_RUN');
  assert.equal(missing.scenario181.length, 12);
  assert.equal(missing.safety.writesPerformed, false);
  const production = await collectStagingEvidence({ env: { STAGING_SERVICE_URL: 'https://app.example.com' }, fetcher });
  assert.equal(production.checks.find((c) => c.id === 'staging_url').status, 'NOT_RUN');
  assert.equal(calls, 0);
});

test('PA-03 records health, readiness, authenticated ops, and bounded GET-only probe', async () => {
  const methods = [];
  const fetcher = async (url, options = {}) => {
    methods.push(options.method || 'GET');
    const u = new URL(url);
    if (u.pathname === '/health') return response(200, { status: 'ok', commit: 'abc123456789' });
    if (u.pathname === '/ready') return response(200, { status: 'ready' });
    if (u.pathname === '/api/login') return response(200, { success: true }, { 'set-cookie': 'session=synthetic; Path=/; HttpOnly' });
    if (u.pathname === '/ops') return response(200, '<h1>BiForge operations</h1>');
    if (u.pathname === '/api/ops') return response(200, { queue: { queued: 0 }, alerts: [] });
    return response(404, { error: 'not_found' });
  };
  let t = 100;
  const report = await collectStagingEvidence({
    env: { STAGING_SERVICE_URL: 'https://staging.example.com', STAGING_APP_PASSWORD: 'synthetic-test-only', GITHUB_SHA: 'abc123' },
    fetcher,
    clock: () => { t += 5; return t; },
  });
  for (const id of ['health', 'ready', 'staging_login', 'ops_html', 'ops_json', 'bounded_load']) {
    assert.equal(report.checks.find((c) => c.id === id).status, 'PASS', id);
  }
  assert.equal(report.checks.find((c) => c.id === 'bounded_load').requests, 20);
  assert.ok(methods.every((method) => method === 'GET' || method === 'POST'));
  assert.ok(methods.filter((method) => method === 'POST').length === 1, 'only login may POST');
  assert.equal(report.safety.modelCalls, 0);
  assert.equal(report.safety.restorePerformed, false);
  assert.ok(report.scenario181.every((item) => item.status === 'NOT_RUN'));
  assert.match(renderSummary(report), /Restore and rollback remain NOT_RUN/);
});

test('PA-03 reports live endpoint failures without leaking secrets', async () => {
  const report = await collectStagingEvidence({
    env: { STAGING_SERVICE_URL: 'https://staging.example.com', STAGING_APP_PASSWORD: 'do-not-print-this' },
    fetcher: async () => response(503, { error: 'unavailable' }),
  });
  assert.equal(report.checks.find((c) => c.id === 'health').status, 'FAIL');
  assert.equal(report.overall, 'FAIL');
  assert.ok(!JSON.stringify(report).includes('do-not-print-this'));
});


test('PA-03 workflow is manual, read-only at repository level, and does not deploy or write commits', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/staging-drills.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /contents:\s*read/);
  assert.doesNotMatch(workflow, /schedule:|contents:\s*write|git push|railway deploy|gh pr merge/i);
  assert.match(workflow, /STAGING_SERVICE_URL/);
  assert.match(workflow, /hostname does not identify a staging database/);
});
}
// ===== END pa03-acceptance.test.mjs =====

// ===== BEGIN pa04-acceptance.test.mjs =====
{
/**
 * PA-04: notes-merge helper (lab workflow templates may live off-repo).
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('e01-notes-merge builds NOTES and RESULTS from fixtures', () => {
  const out = path.join(root, 'tests/pa04-out-tmp');
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/e01-notes-merge.mjs'),
      '--runs',
      path.join(root, 'tests/pa04-fixtures.json'),
      '--minutes',
      't1:model:9,t1:manual:14',
      '--out-dir',
      out,
    ],
    { encoding: 'utf8', cwd: root, timeout: 15_000 },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const notes = fs.readFileSync(path.join(out, 'E01-NOTES.md'), 'utf8');
  const results = JSON.parse(fs.readFileSync(path.join(out, 'E01-RESULTS.json'), 'utf8'));
  assert.ok(notes.includes('e01-t1 model_patch') || notes.includes('e01-t1'));
  assert.equal(results.pairs.length, 2);
  assert.equal(results.pairs[0].humanMinutes, 9);
  assert.equal(results.pairs[1].humanMinutes, 14);
  fs.rmSync(out, { recursive: true, force: true });
});

test('CONCEPTS e01 lab files are optional (off-repo allowed)', () => {
  // CONCEPTS/e01-task.yml and e01-lab-SETUP.md may be removed after local backup (HISTORY_OFFREPO).
  assert.ok(fs.existsSync(path.join(root, 'scripts/e01-notes-merge.mjs')));
});
}
// ===== END pa04-acceptance.test.mjs =====
