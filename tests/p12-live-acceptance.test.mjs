// P12 live expectations (PostgreSQL). Protected by Test Integrity. Expected to FAIL until P12 is implemented.
// Every test works in its own project and scopes claimJob/recoverExpired/worker by projectId (other test files share the database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../server/projectRepository.ts';
import { getPool, closeDatabase } from '../server/database.ts';
import { TaskError } from '../server/taskMachine.ts';
import { QueueError } from '../server/queueMachine.ts';
import { createTask, getTask, transitionTask, enqueueTask, startRun, finishRun, listRuns, listTaskEvents } from '../server/taskService.ts';
import { claimJob, heartbeatJob, completeJob, recoverExpired, getJob, getJobByRun } from '../server/queueService.ts';
import { createWorker } from '../server/worker.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const A = 'ci';
const LEASE = 60_000;
const t0 = new Date('2030-01-01T00:00:00Z');
const at = (ms) => new Date(t0.getTime() + ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const project = () => createProject({ name: `P12 ${uid()}` });
const reject = (p, c, Cls = QueueError) => assert.rejects(p, (e) => e instanceof Cls && e.code === c, c);
async function queuedIn(p, label = 't') {
  const { task } = await createTask({ projectId: p.id, idempotencyKey: `k-${uid()}`, title: label,
    input: { task: `${label}-${uid()}`, artifactRefs: [], stateVersion: null, profile: null, profileVersion: null, criteria: [] }, actor: A });
  const t1 = await transitionTask({ taskId: task.id, expectedVersion: task.version, to: 'READY', actor: A });
  const q = await enqueueTask({ taskId: t1.id, expectedVersion: t1.version, idempotencyKey: `r-${uid()}`, actor: A });
  return { task: q.task, run: q.run };
}
const claim = (p, o = {}) => claimJob({ workerId: 'w1', projectId: p.id, now: t0, leaseMs: LEASE, ...o });

test('migration 006 created jobs; enqueueTask creates exactly one job per Run', async () => {
  const pool = await getPool();
  assert.equal((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'jobs'")).rows.length, 1);
  const p = await project(); const { task, run } = await queuedIn(p);
  const job = await getJobByRun(run.id);
  assert.equal(job.status, 'QUEUED'); assert.equal(job.taskId, task.id); assert.equal(job.projectId, p.id); assert.equal(job.runId, run.id);
  assert.equal(job.claims, 0); assert.equal(job.leaseOwner, null); assert.equal(job.leaseUntil, null); assert.equal(job.finishedAt, null);
  const again = await enqueueTask({ taskId: task.id, expectedVersion: 1, idempotencyKey: run.idempotencyKey, actor: A });
  assert.equal(again.created, false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE run_id = $1', [run.id])).rows[0].n, 1);
  assert.equal(await getJobByRun('no-such-run'), null); assert.equal(await getJob('no-such-job'), null);
});

test('claimJob leases the job and starts the Run and the Task', async () => {
  const p = await project(); const { task, run } = await queuedIn(p);
  const c = await claim(p);
  assert.ok(c); assert.equal(c.job.status, 'LEASED'); assert.equal(c.job.leaseOwner, 'w1'); assert.equal(c.job.claims, 1);
  assert.equal(c.job.leaseUntil.getTime(), t0.getTime() + LEASE); assert.equal(c.job.heartbeatAt.getTime(), t0.getTime());
  assert.equal(c.run.id, run.id); assert.equal(c.run.status, 'RUNNING'); assert.ok(c.run.startedAt); assert.equal(c.task.state, 'RUNNING');
  assert.equal((await getTask(task.id)).state, 'RUNNING');
  assert.equal(await claim(p, { workerId: 'w2' }), null);
  const ev = await listTaskEvents(task.id);
  assert.ok(ev.some((e) => e.eventType === 'run.started')); assert.ok(ev.some((e) => e.eventType === 'task.transition' && e.toState === 'RUNNING'));
});

test('jobs are claimed oldest first', async () => {
  const p = await project();
  const a = await queuedIn(p, 'a'); const b = await queuedIn(p, 'b'); const c = await queuedIn(p, 'c');
  const got = [];
  for (let i = 0; i < 3; i++) got.push((await claim(p, { workerId: `w${i}` })).run.id);
  assert.deepEqual(got, [a.run.id, b.run.id, c.run.id]);
  assert.equal(await claim(p), null);
});

test('concurrent claims never give one job to two workers (SKIP LOCKED)', async () => {
  const p = await project();
  const runs = []; for (let i = 0; i < 4; i++) runs.push((await queuedIn(p, `n${i}`)).run.id);
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(p, { workerId: `w${i}` })));
  const got = rs.filter(Boolean);
  assert.equal(got.length, 4); assert.equal(rs.length - got.length, 4);
  assert.deepEqual(got.map((g) => g.run.id).sort(), [...runs].sort());
  assert.equal(new Set(got.map((g) => g.job.leaseOwner)).size, 4);
});

test('heartbeat extends the lease; a stranger or an expired lease is LEASE_LOST', async () => {
  const p = await project(); await queuedIn(p);
  const c = await claim(p);
  const h = await heartbeatJob({ jobId: c.job.id, workerId: 'w1', now: at(30_000), leaseMs: LEASE });
  assert.equal(h.leaseUntil.getTime(), t0.getTime() + 30_000 + LEASE); assert.equal(h.heartbeatAt.getTime(), t0.getTime() + 30_000); assert.equal(h.status, 'LEASED');
  await reject(heartbeatJob({ jobId: c.job.id, workerId: 'other', now: at(31_000) }), 'LEASE_LOST');
  await reject(heartbeatJob({ jobId: c.job.id, workerId: 'w1', now: at(30_000 + LEASE + 1) }), 'LEASE_LOST');
  await reject(heartbeatJob({ jobId: 'no-such-job', workerId: 'w1', now: t0 }), 'NOT_FOUND');
  assert.equal((await getJob(c.job.id)).leaseUntil.getTime(), t0.getTime() + 30_000 + LEASE);
});

test('completeJob finishes the Run and closes the job; stale or foreign completions change nothing', async () => {
  const p = await project(); const { task, run } = await queuedIn(p);
  const c = await claim(p);
  await reject(completeJob({ jobId: c.job.id, workerId: 'w2', status: 'SUCCEEDED', now: at(1000) }), 'LEASE_LOST');
  await reject(completeJob({ jobId: c.job.id, workerId: 'w1', status: 'SUCCEEDED', now: at(LEASE + 1) }), 'LEASE_LOST');
  await reject(completeJob({ jobId: c.job.id, workerId: 'w1', status: 'ABANDONED', now: at(1000) }), 'INVALID_STATUS');
  await reject(completeJob({ jobId: c.job.id, workerId: 'w1', status: 'RUNNING', now: at(1000) }), 'INVALID_STATUS');
  assert.equal((await listRuns(task.id))[0].status, 'RUNNING'); assert.equal((await getJob(c.job.id)).status, 'LEASED');
  const d = await completeJob({ jobId: c.job.id, workerId: 'w1', status: 'SUCCEEDED', providerId: 'p', modelId: 'm', evidence: ['ledger:1'], now: at(1000) });
  assert.equal(d.run.status, 'SUCCEEDED'); assert.equal(d.run.providerId, 'p'); assert.deepEqual(d.run.evidence, ['ledger:1']);
  assert.equal(d.task.state, 'VALIDATING'); assert.equal(d.job.status, 'DONE'); assert.ok(d.job.finishedAt);
  await reject(completeJob({ jobId: c.job.id, workerId: 'w1', status: 'SUCCEEDED', now: at(2000) }), 'LEASE_LOST');
  await reject(completeJob({ jobId: 'no-such-job', workerId: 'w1', status: 'SUCCEEDED', now: t0 }), 'NOT_FOUND');
  assert.equal(run.id, d.run.id);
});

test('restart recovery: an expired lease gives ABANDONED and BLOCKED(recovery), never PASS; a human may retry', async () => {
  const p = await project(); const { task, run } = await queuedIn(p);
  const c = await claim(p);                                                    // the worker "dies" here: no heartbeat, no completion
  assert.deepEqual(await recoverExpired({ projectId: p.id, now: at(30_000) }), []);
  assert.equal((await getTask(task.id)).state, 'RUNNING');
  const rec = await recoverExpired({ projectId: p.id, now: at(LEASE + 1000) });
  assert.deepEqual(rec, [{ jobId: c.job.id, runId: run.id, taskId: task.id }]);
  const t = await getTask(task.id);
  assert.equal(t.state, 'BLOCKED'); assert.equal(t.blockedReason, 'recovery');
  assert.equal((await listRuns(task.id))[0].status, 'ABANDONED'); assert.equal((await getJob(c.job.id)).status, 'ABANDONED');
  await reject(completeJob({ jobId: c.job.id, workerId: 'w1', status: 'SUCCEEDED', now: at(1000) }), 'LEASE_LOST');   // the late worker cannot revive the Run
  await reject(transitionTask({ taskId: task.id, expectedVersion: t.version, to: 'PASS', actor: 'human', validation: { passed: true, evidence: ['x'] } }), 'INVALID_TRANSITION', TaskError);
  assert.equal((await getTask(task.id)).state, 'BLOCKED');
  assert.deepEqual(await recoverExpired({ projectId: p.id, now: at(LEASE + 2000) }), []);
  const ev = await listTaskEvents(task.id);
  assert.ok(ev.some((e) => e.eventType === 'run.finished' && e.details.status === 'ABANDONED'));
  // human decision: back to READY, a new Run with a new job
  const ready = await transitionTask({ taskId: task.id, expectedVersion: t.version, to: 'READY', actor: 'human' });
  assert.equal(ready.blockedReason, null);
  const q2 = await enqueueTask({ taskId: task.id, expectedVersion: ready.version, idempotencyKey: `retry-${uid()}`, actor: A });
  assert.equal(q2.run.attempt, 2); assert.equal((await getJobByRun(q2.run.id)).status, 'QUEUED');
  const c2 = await claim(p, { workerId: 'w9', now: at(LEASE + 5000) });
  assert.equal(c2.run.id, q2.run.id);
  assert.deepEqual((await listRuns(task.id)).map((r) => [r.attempt, r.status]), [[1, 'ABANDONED'], [2, 'RUNNING']]);
});

test('concurrent recovery abandons a Run exactly once', async () => {
  const p = await project(); const { task } = await queuedIn(p);
  await claim(p);
  const rs = await Promise.all([1, 2, 3].map(() => recoverExpired({ projectId: p.id, now: at(LEASE + 1000) })));
  assert.equal(rs.flat().length, 1);
  assert.equal((await listTaskEvents(task.id)).filter((e) => e.eventType === 'run.finished' && e.details.status === 'ABANDONED').length, 1);
});

test('a cancelled Run closes its job; a directly started Run is never claimable', async () => {
  const p = await project();
  const a = await queuedIn(p, 'a');
  const c = await finishRun({ runId: a.run.id, status: 'CANCELLED', actor: A });
  assert.equal(c.task.state, 'CANCELLED'); const ja = await getJobByRun(a.run.id);
  assert.equal(ja.status, 'CANCELLED'); assert.ok(ja.finishedAt);
  const b = await queuedIn(p, 'b');
  await startRun({ runId: b.run.id, actor: A });
  assert.equal((await getJobByRun(b.run.id)).status, 'QUEUED');
  assert.equal(await claim(p), null);
  await finishRun({ runId: b.run.id, status: 'SUCCEEDED', actor: A });
  assert.equal((await getJobByRun(b.run.id)).status, 'DONE');
});

test('worker.tick: success completes the Run; an empty queue is idle', async () => {
  const p = await project(); const { task, run } = await queuedIn(p);
  let seen = null;
  const w = createWorker({ workerId: 'w-ok', projectId: p.id, handler: async (ctx) => { seen = ctx; return { status: 'SUCCEEDED', providerId: 'p', modelId: 'm', evidence: ['e1'] }; } });
  assert.equal(await w.tick(), 'done');
  assert.equal(seen.run.id, run.id); assert.equal(seen.task.id, task.id); assert.equal(seen.job.leaseOwner, 'w-ok'); assert.ok(seen.signal instanceof AbortSignal);
  const r = (await listRuns(task.id))[0];
  assert.equal(r.status, 'SUCCEEDED'); assert.equal(r.providerId, 'p'); assert.deepEqual(r.evidence, ['e1']);
  assert.equal((await getTask(task.id)).state, 'VALIDATING'); assert.equal((await getJobByRun(run.id)).status, 'DONE');
  assert.equal(await w.tick(), 'idle');
});

test('worker.tick: a throwing handler fails the Run and leaks no message', async () => {
  const p = await project(); const { task } = await queuedIn(p);
  const w = createWorker({ workerId: 'w-err', projectId: p.id, handler: async () => { throw new Error('boom-secret'); } });
  assert.equal(await w.tick(), 'done');
  const r = (await listRuns(task.id))[0];
  assert.equal(r.status, 'FAILED'); assert.deepEqual(r.evidence, ['worker:handler_error']);
  assert.equal((await getTask(task.id)).state, 'FAIL');
  assert.ok(!JSON.stringify(await listTaskEvents(task.id)).includes('boom-secret'));
});

test('worker heartbeat keeps a long handler alive; another recovery pass leaves it alone', async () => {
  const p = await project(); const { task } = await queuedIn(p);
  const w = createWorker({ workerId: 'w-hb', projectId: p.id, leaseMs: 1000, heartbeatMs: 200, handler: async () => { await sleep(2500); return { status: 'SUCCEEDED', evidence: ['ok'] }; } });
  const tick = w.tick();
  await sleep(1800);                                                           // longer than one lease: only heartbeats keep it valid
  assert.deepEqual(await recoverExpired({ projectId: p.id }), []);
  assert.equal(await tick, 'done');
  assert.equal((await listRuns(task.id))[0].status, 'SUCCEEDED');
});

test('worker that lost its lease aborts the handler and writes nothing', async () => {
  const p = await project(); const { task } = await queuedIn(p);
  let aborted = false;
  const w = createWorker({ workerId: 'w-lost', projectId: p.id, leaseMs: 1000, heartbeatMs: 200, handler: ({ signal }) => new Promise((resolve) => {
    const done = () => resolve({ status: 'SUCCEEDED', evidence: ['late'] });
    signal.addEventListener('abort', () => { aborted = true; done(); }); setTimeout(done, 8000);
  }) });
  const tick = w.tick();
  await sleep(500);
  const rec = await recoverExpired({ projectId: p.id, now: new Date(Date.now() + 3_600_000) });   // somebody decides the worker is gone
  assert.equal(rec.length, 1);
  assert.equal(await tick, 'lease_lost');
  assert.equal(aborted, true);
  const r = (await listRuns(task.id))[0]; const t = await getTask(task.id);
  assert.equal(r.status, 'ABANDONED'); assert.equal(t.state, 'BLOCKED'); assert.equal(t.blockedReason, 'recovery');
});

test('worker.start recovers a job left by a dead worker before polling', async () => {
  const p = await project(); const { task } = await queuedIn(p);
  const dead = await claimJob({ workerId: 'dead', projectId: p.id, leaseMs: 1 });   // the worker dies; its 1 ms lease is over at once
  assert.ok(dead); await sleep(50);
  const w = createWorker({ workerId: 'w-new', projectId: p.id, pollMs: 50, handler: async () => { throw new Error('must not run'); } });
  await w.start(); await w.stop();
  const t = await getTask(task.id);
  assert.equal((await listRuns(task.id))[0].status, 'ABANDONED'); assert.equal(t.state, 'BLOCKED'); assert.equal(t.blockedReason, 'recovery');
});

test.after(async () => { await closeDatabase(); });
