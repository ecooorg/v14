import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_RULES_VERSION, RC_REQUIRED_GATES, canAdvance, evaluateAll, evaluateGate, evaluateTestIntegrity, gateForCheckName, releaseManifest, statusFromCheckRun, validateEvidence,
} from '../server/gateEngine.ts';

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
