// P11 live expectations (PostgreSQL). Protected by Test Integrity. Expected to FAIL until P11 is implemented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../server/projectRepository.ts';
import { getPool, closeDatabase } from '../server/database.ts';
import { TaskError } from '../server/taskMachine.ts';
import { createTask, getTask, transitionTask, changeTaskInput, enqueueTask, startRun, finishRun, listRuns, listTaskEvents } from '../server/taskService.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const A = 'ci';
const input = (task = 'analyse', extra = {}) => ({ task, artifactRefs: ['artifact:a@1'], stateVersion: 2, profile: 'analyst', profileVersion: '1', criteria: ['c1'], ...extra });
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const project = () => createProject({ name: `P11 ${uid()}` });
const reject = (p, c) => assert.rejects(p, (e) => e instanceof TaskError && e.code === c, c);
async function newTask(extra = {}) {
  const p = await project();
  const { task } = await createTask({ projectId: p.id, idempotencyKey: `k-${uid()}`, title: 't', input: input(), actor: A, ...extra });
  return { p, task };
}
const ready = async (t) => transitionTask({ taskId: t.id, expectedVersion: t.version, to: 'READY', actor: A });

test('migration 005 created the tables', async () => {
  const pool = await getPool();
  const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('tasks','runs','task_events')");
  assert.equal(r.rows.length, 3);
});

test('createTask is idempotent by key and fingerprint; the key is per project', async () => {
  const p = await project(); const key = `k-${uid()}`;
  const a = await createTask({ projectId: p.id, idempotencyKey: key, title: 't', input: input(), actor: A });
  assert.equal(a.created, true); assert.equal(a.task.state, 'DRAFT'); assert.equal(a.task.version, 1); assert.equal(a.task.maxAttempts, 3);
  const b = await createTask({ projectId: p.id, idempotencyKey: key, title: 't', input: input('analyse', { criteria: ['c1'] }), actor: A });
  assert.equal(b.created, false); assert.equal(b.task.id, a.task.id);
  await reject(createTask({ projectId: p.id, idempotencyKey: key, title: 't', input: input('other'), actor: A }), 'IDEMPOTENCY_CONFLICT');
  const c = await createTask({ projectId: p.id, idempotencyKey: `k-${uid()}`, title: 't', input: input(), actor: A });
  assert.notEqual(c.task.id, a.task.id);
  const other = await project();
  const d = await createTask({ projectId: other.id, idempotencyKey: key, title: 't', input: input('other'), actor: A });
  assert.equal(d.created, true);
});

test('full path: READY, QUEUED, RUNNING, VALIDATING, PASS; the Run keeps its context; every step is an event', async () => {
  const { task } = await newTask();
  const t1 = await ready(task);
  const q = await enqueueTask({ taskId: t1.id, expectedVersion: t1.version, idempotencyKey: 'run-1', actor: A });
  assert.equal(q.created, true); assert.equal(q.task.state, 'QUEUED'); assert.equal(q.run.status, 'QUEUED'); assert.equal(q.run.attempt, 1);
  assert.equal(q.run.profile, 'analyst'); assert.equal(q.run.profileVersion, '1'); assert.equal(q.run.inputFingerprint, q.task.inputFingerprint); assert.deepEqual(q.run.inputRefs, ['artifact:a@1']);
  assert.equal(q.run.providerId, null); assert.equal(q.run.modelId, null);
  const s = await startRun({ runId: q.run.id, actor: A });
  assert.equal(s.task.state, 'RUNNING'); assert.equal(s.run.status, 'RUNNING'); assert.ok(s.run.startedAt);
  const f = await finishRun({ runId: q.run.id, status: 'SUCCEEDED', actor: A, providerId: 'p', modelId: 'm', policyVersion: 'router-v1/units-v1', budget: { units: 5 }, evidence: ['ledger:1'] });
  assert.equal(f.task.state, 'VALIDATING'); assert.equal(f.run.status, 'SUCCEEDED'); assert.ok(f.run.finishedAt);
  assert.equal(f.run.providerId, 'p'); assert.equal(f.run.policyVersion, 'router-v1/units-v1'); assert.deepEqual(f.run.evidence, ['ledger:1']);
  await reject(transitionTask({ taskId: task.id, expectedVersion: f.task.version, to: 'PASS', actor: A }), 'VALIDATION_REQUIRED');
  assert.equal((await getTask(task.id)).state, 'VALIDATING');
  const pass = await transitionTask({ taskId: task.id, expectedVersion: f.task.version, to: 'PASS', actor: 'human', validation: { passed: true, evidence: ['ci:1'] } });
  assert.equal(pass.state, 'PASS'); assert.equal(pass.validatedFingerprint, pass.inputFingerprint);
  const ev = await listTaskEvents(task.id);
  assert.deepEqual(ev.filter((e) => e.eventType === 'task.transition').map((e) => e.toState), ['READY', 'QUEUED', 'RUNNING', 'VALIDATING', 'PASS']);
  assert.ok(ev.every((e) => e.actor)); assert.equal(ev[0].eventType, 'task.created');
  assert.ok(['run.queued', 'run.started', 'run.finished'].every((t) => ev.some((e) => e.eventType === t)));
});

test('direct moves into QUEUED/RUNNING are refused and nothing changes', async () => {
  const { task } = await newTask();
  const t1 = await ready(task);
  await reject(transitionTask({ taskId: t1.id, expectedVersion: t1.version, to: 'QUEUED', actor: A }), 'RUN_API_REQUIRED');
  await reject(transitionTask({ taskId: t1.id, expectedVersion: t1.version, to: 'PASS', actor: A }), 'INVALID_TRANSITION');
  assert.equal((await getTask(task.id)).version, t1.version);
});

test('enqueue is idempotent by key, also under concurrency: one Run', async () => {
  const { task } = await newTask();
  const t1 = await ready(task);
  const rs = await Promise.all(Array.from({ length: 5 }, () => enqueueTask({ taskId: t1.id, expectedVersion: t1.version, idempotencyKey: 'same', actor: A })));
  assert.equal(rs.filter((r) => r.created).length, 1);
  assert.equal(new Set(rs.map((r) => r.run.id)).size, 1);
  assert.equal((await listRuns(task.id)).length, 1);
  const again = await enqueueTask({ taskId: t1.id, expectedVersion: 999, idempotencyKey: 'same', actor: A });   // a replay returns the Run before any version check
  assert.equal(again.created, false); assert.equal(again.run.id, rs[0].run.id);
});

test('optimistic version: of several concurrent moves with the same version exactly one wins', async () => {
  const { task } = await newTask();
  const rs = await Promise.allSettled(Array.from({ length: 4 }, () => transitionTask({ taskId: task.id, expectedVersion: task.version, to: 'READY', actor: A })));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of rs.filter((x) => x.status === 'rejected')) assert.ok(r.reason instanceof TaskError && r.reason.code === 'VERSION_CONFLICT');
  await reject(transitionTask({ taskId: task.id, expectedVersion: task.version, to: 'CANCELLED', actor: A }), 'VERSION_CONFLICT');
});

test('retry makes a new Run; earlier Runs stay; attempts are limited', async () => {
  const { task } = await newTask({ maxAttempts: 2 });
  let t = await ready(task);
  const r1 = await enqueueTask({ taskId: t.id, expectedVersion: t.version, idempotencyKey: 'a1', actor: A });
  await startRun({ runId: r1.run.id, actor: A });
  const f1 = await finishRun({ runId: r1.run.id, status: 'FAILED', actor: A });
  assert.equal(f1.task.state, 'FAIL');
  t = await transitionTask({ taskId: task.id, expectedVersion: f1.task.version, to: 'READY', actor: 'human' });
  const r2 = await enqueueTask({ taskId: t.id, expectedVersion: t.version, idempotencyKey: 'a2', actor: A });
  assert.equal(r2.run.attempt, 2);
  await startRun({ runId: r2.run.id, actor: A });
  const f2 = await finishRun({ runId: r2.run.id, status: 'TIMED_OUT', actor: A });
  assert.equal(f2.task.state, 'FAIL');
  await reject(transitionTask({ taskId: task.id, expectedVersion: f2.task.version, to: 'READY', actor: 'human' }), 'ATTEMPTS_EXHAUSTED');
  const runs = await listRuns(task.id);
  assert.deepEqual(runs.map((r) => [r.attempt, r.status]), [[1, 'FAILED'], [2, 'TIMED_OUT']]);
});

test('a lost Run (ABANDONED) blocks the task for recovery and never becomes PASS', async () => {
  const { task } = await newTask();
  const t = await ready(task);
  const q = await enqueueTask({ taskId: t.id, expectedVersion: t.version, idempotencyKey: 'lost', actor: A });
  await startRun({ runId: q.run.id, actor: A });
  const f = await finishRun({ runId: q.run.id, status: 'ABANDONED', actor: 'system' });
  assert.equal(f.task.state, 'BLOCKED'); assert.equal(f.task.blockedReason, 'recovery'); assert.equal(f.run.status, 'ABANDONED');
  await reject(transitionTask({ taskId: task.id, expectedVersion: f.task.version, to: 'PASS', actor: 'human', validation: { passed: true, evidence: ['x'] } }), 'INVALID_TRANSITION');
  const back = await transitionTask({ taskId: task.id, expectedVersion: f.task.version, to: 'READY', actor: 'human' });
  assert.equal(back.blockedReason, null);
});

test('a final Run cannot be finished again; a queued Run can only be cancelled', async () => {
  const { task } = await newTask();
  const t = await ready(task);
  const q = await enqueueTask({ taskId: t.id, expectedVersion: t.version, idempotencyKey: 'x', actor: A });
  await reject(finishRun({ runId: q.run.id, status: 'SUCCEEDED', actor: A }), 'INVALID_TRANSITION');
  const c = await finishRun({ runId: q.run.id, status: 'CANCELLED', actor: A });
  assert.equal(c.task.state, 'CANCELLED');
  await reject(finishRun({ runId: q.run.id, status: 'FAILED', actor: A }), 'INVALID_TRANSITION');
  await reject(startRun({ runId: q.run.id, actor: A }), 'INVALID_TRANSITION');
});

test('changed input: allowed in DRAFT, locks while running, invalidates PASS', async () => {
  const { task } = await newTask();
  const d = await changeTaskInput({ taskId: task.id, expectedVersion: task.version, input: input('changed'), actor: A });
  assert.notEqual(d.inputFingerprint, task.inputFingerprint); assert.equal(d.state, 'DRAFT');
  let t = await ready(d);
  const q = await enqueueTask({ taskId: t.id, expectedVersion: t.version, idempotencyKey: 'c', actor: A });
  await reject(changeTaskInput({ taskId: task.id, expectedVersion: q.task.version, input: input('again'), actor: A }), 'INPUT_LOCKED');
  await startRun({ runId: q.run.id, actor: A });
  const f = await finishRun({ runId: q.run.id, status: 'SUCCEEDED', actor: A });
  const pass = await transitionTask({ taskId: task.id, expectedVersion: f.task.version, to: 'PASS', actor: 'human', validation: { passed: true, evidence: ['ci:2'] } });
  const inv = await changeTaskInput({ taskId: task.id, expectedVersion: pass.version, input: input('changed', { criteria: ['c1', 'c2'] }), actor: A });
  assert.equal(inv.state, 'VALIDATING'); assert.notEqual(inv.inputFingerprint, pass.validatedFingerprint);
  assert.ok((await listTaskEvents(task.id)).some((e) => e.eventType === 'task.pass_invalidated'));
  await reject(transitionTask({ taskId: task.id, expectedVersion: inv.version, to: 'PASS', actor: 'human' }), 'VALIDATION_REQUIRED');
});

test('unknown ids give NOT_FOUND', async () => {
  await reject(transitionTask({ taskId: 'no-such-task', expectedVersion: 1, to: 'READY', actor: A }), 'NOT_FOUND');
  await reject(startRun({ runId: 'no-such-run', actor: A }), 'NOT_FOUND');
  assert.equal(await getTask('no-such-task'), null);
});

test.after(async () => { await closeDatabase(); });
