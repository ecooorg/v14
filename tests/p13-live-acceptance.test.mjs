// P13 live expectations (PostgreSQL). Every test works in its own project and scopes the worker by projectId.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../server/projectRepository.ts';
import { getPool } from '../server/database.ts';
import { PlanError } from '../server/planMachine.ts';
import { createTask, getTask, transitionTask, enqueueTask, listTaskEvents } from '../server/taskService.ts';
import { claimJob, completeJob } from '../server/queueService.ts';
import { createWorker } from '../server/worker.ts';
import {
  createPlan, getPlan, listPlanTasks, decideApproval, listApprovals, requestApproval, setBudget, getBudget, guardModelCall, enqueuePlanTask,
  setProjectSettings, getProjectSettings,
} from '../server/planService.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const H = { actorKind: 'human', decidedBy: 'owner' };
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const project = () => createProject({ name: `P13 ${uid()}` });
const code = (p, c) => assert.rejects(p, (e) => e instanceof PlanError && e.code === c, c);
const n = (key, deps = [], extra = {}) => ({ key, title: key, task: `do ${key}`, deps, ...extra });
async function approved(p, nodes) {
  const { plan, approval } = await createPlan({ projectId: p.id, source: 'human', nodes, actor: 'model' });
  await decideApproval({ approvalId: approval.id, decision: 'APPROVED', ...H });
  const tasks = Object.fromEntries((await listPlanTasks(plan.id)).map((t) => [t.nodeKey, t.taskId]));
  return { plan, tasks };
}
const enq = async (taskId, extra = {}) => { const t = await getTask(taskId); return enqueuePlanTask({ taskId, expectedVersion: t.version, idempotencyKey: `r-${uid()}`, actor: 'ci', ...extra }); };
const ledger = async (runId, tokens) => (await getPool()).query(
  "INSERT INTO usage_ledger(id,run_id,provider_id,model_id,input_tokens,output_tokens,status,units) VALUES($1,$2,'p','m',$3,0,'ok',$4)", [`l-${uid()}`, runId, tokens, Math.ceil(tokens / 1000)]);

test('migration 007 created the tables; plan_tasks, plans and approvals exist', async () => {
  const pool = await getPool();
  const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('budgets','project_settings','plans','plan_tasks','approvals')");
  assert.equal(r.rows.length, 5);
});

test('a plan does not start without a human approval; the model proposal creates no tasks', async () => {
  const p = await project();
  const { plan, approval } = await createPlan({ projectId: p.id, source: 'template', template: 'spec_arch_review_approval', goal: 'G', actor: 'model' });
  assert.equal(plan.status, 'PENDING'); assert.equal(plan.version, 1); assert.equal(approval.status, 'PENDING'); assert.equal(approval.kind, 'plan');
  assert.deepEqual(await listPlanTasks(plan.id), []);
  await code(decideApproval({ approvalId: approval.id, decision: 'APPROVED', decidedBy: 'model', actorKind: 'agent' }), 'HUMAN_REQUIRED');
  assert.equal((await getPlan(plan.id)).status, 'PENDING');
  const done = await decideApproval({ approvalId: approval.id, decision: 'APPROVED', ...H });
  assert.equal(done.status, 'APPROVED'); assert.equal(done.decidedBy, 'owner');
  assert.equal((await getPlan(plan.id)).status, 'APPROVED');
  const tasks = await listPlanTasks(plan.id);
  assert.equal(tasks.length, 4); assert.ok(tasks.every((t) => t.state === 'READY'));
  await code(decideApproval({ approvalId: approval.id, decision: 'REJECTED', ...H }), 'APPROVAL_CLOSED');
  assert.equal((await getProjectSettings(p.id)).maxConcurrentRuns, 2);
});

test('a rejected plan creates no tasks; invalid plans are refused and not stored', async () => {
  const p = await project();
  const { plan, approval } = await createPlan({ projectId: p.id, source: 'model', nodes: [n('a')], actor: 'model' });
  await decideApproval({ approvalId: approval.id, decision: 'REJECTED', ...H });
  assert.equal((await getPlan(plan.id)).status, 'REJECTED'); assert.deepEqual(await listPlanTasks(plan.id), []);
  await assert.rejects(createPlan({ projectId: p.id, source: 'model', nodes: [n('a', ['b']), n('b', ['a'])], actor: 'model' }), (e) => e.code === 'PLAN_INVALID' && e.details.reason === 'cycle');
  assert.equal((await (await getPool()).query('SELECT count(*)::int AS c FROM plans WHERE project_id=$1', [p.id])).rows[0].c, 1);
  await setBudget({ projectId: p.id, scope: 'project', scopeId: p.id, limits: { max_cost_units: 5 }, actor: 'owner', actorKind: 'human' });
  await assert.rejects(createPlan({ projectId: p.id, source: 'template', template: 'spec_arch_review_approval', goal: 'G', actor: 'model' }), (e) => e.code === 'PLAN_INVALID' && e.details.reason === 'budget');
});

test('dependencies: a task starts only after its dependencies are PASS; the plan must be approved', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a'), n('b', ['a'])]);
  await code(enq(tasks.b), 'DEPENDENCY_NOT_READY');
  const { run } = await enq(tasks.a);
  const c = await claimJob({ workerId: 'w', projectId: p.id });
  assert.equal(c.run.id, run.id);
  await completeJob({ jobId: c.job.id, workerId: 'w', status: 'SUCCEEDED', evidence: ['e'] });
  await code(enq(tasks.b), 'DEPENDENCY_NOT_READY');   // VALIDATING is not PASS
  const t = await getTask(tasks.a);
  await transitionTask({ taskId: t.id, expectedVersion: t.version, to: 'PASS', actor: 'ci', validation: { passed: true, evidence: ['e'] } });
  assert.equal((await enq(tasks.b)).created, true);
  const lone = (await createTask({ projectId: p.id, idempotencyKey: `k-${uid()}`, title: 'x', actor: 'ci', input: { task: 'x', artifactRefs: [], stateVersion: null, profile: null, profileVersion: null, criteria: [] } })).task;
  await code(enqueuePlanTask({ taskId: lone.id, expectedVersion: lone.version, idempotencyKey: 'k', actor: 'ci' }), 'NOT_IN_PLAN');
});

test('a plan version is a new plan and needs its own approval; the previous approved plan is superseded', async () => {
  const p = await project();
  const first = await approved(p, [n('a'), n('b')]);
  const { plan: v2, approval } = await createPlan({ projectId: p.id, source: 'model', nodes: [n('a'), n('c', ['a'])], actor: 'model' });
  assert.equal(v2.version, 2);
  assert.equal((await getPlan(first.plan.id)).status, 'APPROVED');   // still the approved one until a human decides
  await decideApproval({ approvalId: approval.id, decision: 'APPROVED', ...H });
  assert.equal((await getPlan(first.plan.id)).status, 'SUPERSEDED');
  assert.ok((await listPlanTasks(first.plan.id)).every((t) => t.state === 'CANCELLED'));
  await code(enq(first.tasks.a), 'PLAN_NOT_APPROVED');
});

test('two active tasks never write the same artifact', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a', [], { writesArtifact: 'spec.md' }), n('b', [], { writesArtifact: 'spec.md' }), n('c', [], { writesArtifact: 'other.md' })]);
  await enq(tasks.a);
  await code(enq(tasks.b), 'ARTIFACT_WRITE_CONFLICT');
  assert.equal((await enq(tasks.c)).created, true);
});

test('concurrency: at most 2 runs per project, also for parallel claimers; configurable by a human only', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a'), n('b'), n('c'), n('d')]);
  for (const k of ['a', 'b', 'c', 'd']) await enq(tasks[k]);
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => claimJob({ workerId: `w${i}`, projectId: p.id })));
  const got = rs.filter(Boolean);
  assert.equal(got.length, 2);
  assert.equal(await claimJob({ workerId: 'w9', projectId: p.id }), null);
  await completeJob({ jobId: got[0].job.id, workerId: got[0].job.leaseOwner, status: 'SUCCEEDED', evidence: ['e'] });
  assert.ok(await claimJob({ workerId: 'w9', projectId: p.id }));
  await code(setProjectSettings({ projectId: p.id, actorKind: 'agent', maxConcurrentRuns: 5 }), 'HUMAN_REQUIRED');
  assert.equal((await setProjectSettings({ projectId: p.id, actorKind: 'human', maxConcurrentRuns: 3 })).maxConcurrentRuns, 3);
  assert.ok(await claimJob({ workerId: 'w10', projectId: p.id }));
  await assert.rejects(setProjectSettings({ projectId: p.id, actorKind: 'human', approvalMode: 'autonomous' }));
});

test('budget at enqueue: over budget -> BLOCKED(budget), one approval request, no Run; only a human raises it', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a')]);
  await setBudget({ projectId: p.id, scope: 'task', scopeId: tasks.a, limits: { max_model_calls: 0 }, actor: 'owner', actorKind: 'human' });
  await assert.rejects(enq(tasks.a), (e) => e.code === 'BUDGET_EXCEEDED' && e.details.violations[0].limit === 'max_model_calls');
  const t = await getTask(tasks.a);
  assert.equal(t.state, 'BLOCKED'); assert.equal(t.blockedReason, 'budget');
  const open = await listApprovals({ projectId: p.id, status: 'PENDING' });
  assert.equal(open.length, 1); assert.equal(open[0].kind, 'budget'); assert.equal(open[0].subjectId, tasks.a);
  const limits = { scope: 'task', scopeId: tasks.a, limits: { max_model_calls: 5 } };
  await code(setBudget({ projectId: p.id, ...limits, actor: 'model', actorKind: 'agent' }), 'HUMAN_REQUIRED');
  await code(decideApproval({ approvalId: open[0].id, decision: 'APPROVED', decidedBy: 'x', actorKind: 'agent', budgetLimits: limits }), 'HUMAN_REQUIRED');
  await code(decideApproval({ approvalId: open[0].id, decision: 'APPROVED', ...H }), 'BUDGET_LIMITS_REQUIRED');
  await decideApproval({ approvalId: open[0].id, decision: 'APPROVED', ...H, budgetLimits: limits });
  assert.deepEqual(await getBudget(p.id, 'task', tasks.a), { max_model_calls: 5 });
  assert.equal((await getTask(tasks.a)).state, 'READY');
  assert.equal((await enq(tasks.a)).created, true);
  await setBudget({ projectId: p.id, ...limits, limits: { max_model_calls: 1 }, actor: 'model', actorKind: 'agent' });   // lowering is allowed for anyone
});

test('budget before every model call: the guard blocks, the worker ends the Run, the Task is BLOCKED(budget), never PASS', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a')]);
  await setBudget({ projectId: p.id, scope: 'task', scopeId: tasks.a, limits: { max_tokens: 1000 }, actor: 'owner', actorKind: 'human' });
  await enq(tasks.a);
  let runId;
  const w = createWorker({ workerId: 'w-b', projectId: p.id, handler: async ({ run, task }) => {
    runId = run.id;
    await guardModelCall({ taskId: task.id, runId: run.id, request: { tokens: 800 }, actor: 'w-b' });   // fits
    await ledger(run.id, 800);
    await guardModelCall({ taskId: task.id, runId: run.id, request: { tokens: 800 }, actor: 'w-b' });   // 1600 > 1000
    return { status: 'SUCCEEDED', evidence: ['must not happen'] };
  } });
  assert.equal(await w.tick(), 'done');
  const t = await getTask(tasks.a);
  assert.equal(t.state, 'BLOCKED'); assert.equal(t.blockedReason, 'budget');
  const runs = (await (await getPool()).query('SELECT status, evidence FROM runs WHERE id=$1', [runId])).rows[0];
  assert.equal(runs.status, 'FAILED'); assert.deepEqual(runs.evidence, ['worker:budget_exceeded']);
  assert.equal((await listApprovals({ projectId: p.id, status: 'PENDING' })).length, 1);
  const ev = await listTaskEvents(tasks.a);
  assert.ok(ev.some((e) => e.toState === 'BLOCKED') && !ev.some((e) => e.toState === 'PASS'));
});

test('the budget is checked on the project, task and run scopes', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a')]);
  await enq(tasks.a);
  const c = await claimJob({ workerId: 'w', projectId: p.id });
  await setBudget({ projectId: p.id, scope: 'run', scopeId: c.run.id, limits: { max_model_calls: 1 }, actor: 'owner', actorKind: 'human' });
  await guardModelCall({ taskId: tasks.a, runId: c.run.id, actor: 'w' });
  await ledger(c.run.id, 10);
  await assert.rejects(guardModelCall({ taskId: tasks.a, runId: c.run.id, actor: 'w' }), (e) => e.code === 'BUDGET_EXCEEDED' && e.details.violations[0].scope === 'run');
  await setBudget({ projectId: p.id, scope: 'project', scopeId: p.id, limits: { max_cost_units: 0 }, actor: 'owner', actorKind: 'human' });
  await assert.rejects(guardModelCall({ taskId: tasks.a, actor: 'w', request: { units: 1 } }), (e) => e.details.violations.some((v) => v.scope === 'project' && v.limit === 'max_cost_units'));
});

test('wall clock and attempts are budgets too', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a')]);
  await setBudget({ projectId: p.id, scope: 'task', scopeId: tasks.a, limits: { max_wall_clock_ms: 1000 }, actor: 'owner', actorKind: 'human' });
  await enq(tasks.a);
  const c = await claimJob({ workerId: 'w', projectId: p.id, now: new Date('2030-01-01T00:00:00Z') });
  await assert.rejects(guardModelCall({ taskId: tasks.a, runId: c.run.id, actor: 'w', now: new Date(Date.now() + 5000) }), (e) => e.details.violations.some((v) => v.limit === 'max_wall_clock_ms'));
  const q = await project();
  const x = await approved(q, [n('a')]);
  await setBudget({ projectId: q.id, scope: 'task', scopeId: x.tasks.a, limits: { max_attempts: 1 }, actor: 'owner', actorKind: 'human' });
  const first = await enq(x.tasks.a);
  const cc = await claimJob({ workerId: 'w', projectId: q.id });
  await completeJob({ jobId: cc.job.id, workerId: 'w', status: 'FAILED', evidence: ['e'] });
  const t = await getTask(x.tasks.a);
  await transitionTask({ taskId: t.id, expectedVersion: t.version, to: 'READY', actor: 'owner' });
  await assert.rejects(enq(x.tasks.a), (e) => e.code === 'BUDGET_EXCEEDED' && e.details.violations[0].limit === 'max_attempts');
  assert.ok(first.run);
});

test('Manual mode: each task start needs a human approval', async () => {
  const p = await project();
  const { tasks } = await approved(p, [n('a')]);
  await setProjectSettings({ projectId: p.id, actorKind: 'human', approvalMode: 'manual' });
  await code(enq(tasks.a), 'APPROVAL_REQUIRED');
  const open = await listApprovals({ projectId: p.id, status: 'PENDING' });
  assert.equal(open.length, 1); assert.equal(open[0].kind, 'task_start');
  await decideApproval({ approvalId: open[0].id, decision: 'APPROVED', ...H });
  assert.equal((await enq(tasks.a)).created, true);
});

test('approvals: one open request per subject; other kinds are stored and decided by a human', async () => {
  const p = await project();
  const a = await requestApproval({ projectId: p.id, kind: 'merge_ready', subjectId: 'pr-1', requestedBy: 'model' });
  const b = await requestApproval({ projectId: p.id, kind: 'merge_ready', subjectId: 'pr-1', requestedBy: 'model' });
  assert.equal(a.id, b.id);
  await code(decideApproval({ approvalId: a.id, decision: 'APPROVED', decidedBy: 'x', actorKind: 'tool' }), 'HUMAN_REQUIRED');
  assert.equal((await decideApproval({ approvalId: a.id, decision: 'REJECTED', reason: 'not yet', ...H })).decisionReason, 'not yet');
  await code(decideApproval({ approvalId: 'missing', decision: 'APPROVED', ...H }), 'APPROVAL_NOT_FOUND');
});
