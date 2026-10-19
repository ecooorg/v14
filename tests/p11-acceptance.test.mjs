// P11 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P11-SPEC.md and are expected to FAIL until P11 is implemented. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  TASK_STATES, RUN_STATES, DEFAULT_MAX_ATTEMPTS, TaskError, canRunTransition, assertTaskTransition, runEffectOnTask, taskFingerprint,
} from '../server/taskMachine.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof TaskError, `TaskError expected, got ${e}`); return e.code; } return null; };
const ok = (from, to, ctx = {}) => assert.equal(code(() => assertTaskTransition(from, to, ctx)), null, `${from} -> ${to}`);
const bad = (from, to, expected, ctx = {}) => assert.equal(code(() => assertTaskTransition(from, to, ctx)), expected, `${from} -> ${to}`);
const run = { via: 'run' };
const validation = { passed: true, evidence: ['ci:1'] };

test('states and defaults', () => {
  assert.deepEqual(TASK_STATES, ['DRAFT', 'READY', 'QUEUED', 'RUNNING', 'VALIDATING', 'PASS', 'FAIL', 'BLOCKED', 'CANCELLED']);
  assert.deepEqual(RUN_STATES, ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED']);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
});

test('task: the main path and the allowed side exits', () => {
  ok('DRAFT', 'READY'); ok('READY', 'QUEUED', run); ok('QUEUED', 'RUNNING', run); ok('RUNNING', 'VALIDATING', run); ok('VALIDATING', 'PASS', { validation });
  ok('DRAFT', 'CANCELLED'); ok('READY', 'CANCELLED'); ok('READY', 'BLOCKED'); ok('QUEUED', 'FAIL', run); ok('RUNNING', 'FAIL', run);
  ok('RUNNING', 'BLOCKED', run); ok('RUNNING', 'CANCELLED', run); ok('VALIDATING', 'FAIL'); ok('VALIDATING', 'BLOCKED'); ok('VALIDATING', 'CANCELLED');
  ok('BLOCKED', 'READY'); ok('BLOCKED', 'FAIL'); ok('BLOCKED', 'CANCELLED'); ok('FAIL', 'CANCELLED'); ok('FAIL', 'READY', { attemptsUsed: 1, maxAttempts: 3 });
});

test('task: everything else is an INVALID_TRANSITION (exhaustive)', () => {
  const allowed = new Set(['DRAFT>READY', 'DRAFT>CANCELLED', 'READY>QUEUED', 'READY>BLOCKED', 'READY>CANCELLED', 'QUEUED>RUNNING', 'QUEUED>BLOCKED', 'QUEUED>CANCELLED', 'QUEUED>FAIL',
    'RUNNING>VALIDATING', 'RUNNING>FAIL', 'RUNNING>BLOCKED', 'RUNNING>CANCELLED', 'VALIDATING>PASS', 'VALIDATING>FAIL', 'VALIDATING>BLOCKED', 'VALIDATING>CANCELLED',
    'PASS>VALIDATING', 'FAIL>READY', 'FAIL>CANCELLED', 'BLOCKED>READY', 'BLOCKED>FAIL', 'BLOCKED>CANCELLED']);
  for (const a of TASK_STATES) for (const b of TASK_STATES) {
    if (allowed.has(`${a}>${b}`)) continue;
    assert.equal(code(() => assertTaskTransition(a, b, { ...run, validation, attemptsUsed: 0, maxAttempts: 3, reason: 'input_changed' })), 'INVALID_TRANSITION', `${a} -> ${b}`);
  }
});

test('task: moves into or out of QUEUED/RUNNING belong to the Run API', () => {
  bad('READY', 'QUEUED', 'RUN_API_REQUIRED'); bad('QUEUED', 'RUNNING', 'RUN_API_REQUIRED'); bad('RUNNING', 'VALIDATING', 'RUN_API_REQUIRED');
  bad('RUNNING', 'CANCELLED', 'RUN_API_REQUIRED'); bad('QUEUED', 'CANCELLED', 'RUN_API_REQUIRED');
});

test('PASS is impossible without a validation with evidence', () => {
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED');
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED', { validation: { passed: false, evidence: ['x'] } });
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED', { validation: { passed: true, evidence: [] } });
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED', { validation: { passed: true, evidence: [''] } });
  for (const from of TASK_STATES) if (from !== 'VALIDATING') assert.equal(code(() => assertTaskTransition(from, 'PASS', { ...run, validation })), 'INVALID_TRANSITION', from);
});

test('PASS returns to VALIDATING only when the input changed; retry is limited by attempts', () => {
  bad('PASS', 'VALIDATING', 'INVALID_TRANSITION'); ok('PASS', 'VALIDATING', { reason: 'input_changed' });
  bad('FAIL', 'READY', 'ATTEMPTS_EXHAUSTED', { attemptsUsed: 3, maxAttempts: 3 });
  bad('FAIL', 'READY', 'ATTEMPTS_EXHAUSTED', { attemptsUsed: 5, maxAttempts: 3 });
});

test('run: transitions', () => {
  assert.equal(canRunTransition('QUEUED', 'RUNNING'), true); assert.equal(canRunTransition('QUEUED', 'CANCELLED'), true);
  for (const to of ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED']) assert.equal(canRunTransition('RUNNING', to), true, to);
  assert.equal(canRunTransition('QUEUED', 'SUCCEEDED'), false); assert.equal(canRunTransition('QUEUED', 'ABANDONED'), false); assert.equal(canRunTransition('RUNNING', 'QUEUED'), false);
  for (const final of ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED']) for (const to of RUN_STATES) assert.equal(canRunTransition(final, to), false, `${final} -> ${to}`);
});

test('run effect on the task: no run status ever leads to PASS; a lost run is BLOCKED(recovery)', () => {
  assert.deepEqual(runEffectOnTask('SUCCEEDED'), { state: 'VALIDATING' });
  assert.deepEqual(runEffectOnTask('FAILED'), { state: 'FAIL' }); assert.deepEqual(runEffectOnTask('TIMED_OUT'), { state: 'FAIL' });
  assert.deepEqual(runEffectOnTask('CANCELLED'), { state: 'CANCELLED' });
  assert.deepEqual(runEffectOnTask('ABANDONED'), { state: 'BLOCKED', blockedReason: 'recovery' });
  for (const s of RUN_STATES.filter((x) => !['QUEUED', 'RUNNING'].includes(x))) assert.notEqual(runEffectOnTask(s).state, 'PASS');
});

test('fingerprint: stable, order-insensitive for keys and artifact refs, sensitive to content', () => {
  const a = { task: 't', artifactRefs: ['artifact:a@1', 'artifact:b@2'], stateVersion: 2, profile: 'analyst', profileVersion: '1', criteria: ['c1'] };
  const f = taskFingerprint(a);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(taskFingerprint({ criteria: ['c1'], profileVersion: '1', profile: 'analyst', stateVersion: 2, artifactRefs: ['artifact:b@2', 'artifact:a@1'], task: 't' }), f);
  for (const change of [{ task: 'u' }, { artifactRefs: ['artifact:a@1'] }, { stateVersion: 3 }, { profile: 'x' }, { profileVersion: '2' }, { criteria: ['c2'] }, { criteria: ['c1', 'c2'] }]) assert.notEqual(taskFingerprint({ ...a, ...change }), f, JSON.stringify(change));
});

test('TaskError carries a code and an HTTP status', () => {
  const st = { NOT_FOUND: 404, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, INVALID_TRANSITION: 409, RUN_API_REQUIRED: 409, VALIDATION_REQUIRED: 409, ATTEMPTS_EXHAUSTED: 409, INPUT_LOCKED: 409 };
  for (const [c, s] of Object.entries(st)) { const e = new TaskError(c, 'm'); assert.equal(e.code, c); assert.equal(e.status, s); assert.ok(e instanceof Error); }
});

test('migration 005 and npm scripts', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations/005_tasks_runs.sql'), 'utf8');
  for (const t of ['tasks', 'runs', 'task_events']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
  assert.match(sql, /UNIQUE\s*\(\s*project_id\s*,\s*idempotency_key\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*task_id\s*,\s*attempt\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*task_id\s*,\s*idempotency_key\s*\)/i);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:p11']); assert.ok(pkg.scripts.check.includes('npm run test:p11'));
  assert.ok(pkg.scripts['test:database:live'].includes('tests/p11-live-acceptance.test.mjs'));
});
