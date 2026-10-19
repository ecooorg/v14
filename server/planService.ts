import { z } from 'zod';
import { getPool } from './database.ts';
import {
  APPROVAL_KINDS, APPROVAL_MODES, BUDGET_SCOPES, CODE_PROFILES, DEFAULT_MAX_CONCURRENT_RUNS, PlanError, budgetLimitsSchema, checkBudget, emptyUsage,
  planFromTemplate, planUnits, raisesBudget, validatePlan,
  type ApprovalKind, type ApprovalMode, type BudgetLimits, type BudgetScope, type PlanNode, type Request, type Usage, type Violation,
} from './planMachine.ts';
import { createTaskInTx, enqueueTaskInTx, inTx, lockTask, transitionTaskInTx, type Db, type Run, type Task } from './taskService.ts';
import { TaskError } from './taskMachine.ts';

// Budgets, Task Graph v1 and approvals (TZ 8.4-8.6). Every change: one transaction. Humans decide; the model only proposes.
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const actorSchema = z.string().trim().min(1).max(100);
const scopeSchema = z.enum(BUDGET_SCOPES);

function newId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `${Date.now().toString(36).padStart(9, '0')}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
const isHuman = (kind: unknown) => kind === 'human';
const requireHuman = (kind: unknown, what: string) => { if (!isHuman(kind)) throw new PlanError('HUMAN_REQUIRED', `${what} is a human decision`); };

const mapApproval = (r: any) => ({
  id: r.id as string, projectId: r.project_id as string, kind: r.kind as ApprovalKind, subjectId: r.subject_id as string,
  status: r.status as 'PENDING' | 'APPROVED' | 'REJECTED', details: r.details as Record<string, unknown>, requestedBy: r.requested_by as string,
  decidedBy: (r.decided_by ?? null) as string | null, decisionReason: (r.decision_reason ?? null) as string | null,
  createdAt: r.created_at as Date, decidedAt: (r.decided_at ?? null) as Date | null,
});
const mapPlan = (r: any) => ({
  id: r.id as string, projectId: r.project_id as string, version: r.version as number, status: r.status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED',
  source: r.source as 'template' | 'model' | 'human', template: (r.template ?? null) as string | null, nodes: r.nodes as PlanNode[],
  totalUnits: r.total_units as number, createdBy: r.created_by as string, createdAt: r.created_at as Date, decidedAt: (r.decided_at ?? null) as Date | null,
});
export type Approval = ReturnType<typeof mapApproval>;
export type Plan = ReturnType<typeof mapPlan>;

async function audit(db: Db, projectId: string, type: string, actor: string, details: Record<string, unknown>) {
  await db.query('INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)', [newId(), projectId, type, actor, JSON.stringify(details)]);
}

// ---------- project settings ----------
export async function getProjectSettings(projectId: string): Promise<{ approvalMode: ApprovalMode; maxConcurrentRuns: number }> {
  const pool = await getPool();
  const r = await pool.query('SELECT approval_mode, max_concurrent_runs FROM project_settings WHERE project_id=$1', [idSchema.parse(projectId)]);
  return r.rows[0] ? { approvalMode: r.rows[0].approval_mode, maxConcurrentRuns: r.rows[0].max_concurrent_runs } : { approvalMode: 'supervised', maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS };
}
/** Only a human changes the mode or the concurrency limit. The schema accepts supervised and manual only (TZ 8.6). */
export async function setProjectSettings(input: { projectId: string; actorKind: string; approvalMode?: ApprovalMode; maxConcurrentRuns?: number }) {
  requireHuman(input.actorKind, 'Changing project settings');
  const projectId = idSchema.parse(input.projectId);
  const mode = input.approvalMode === undefined ? null : z.enum(APPROVAL_MODES).parse(input.approvalMode);
  const max = input.maxConcurrentRuns === undefined ? null : z.number().int().min(1).max(10).parse(input.maxConcurrentRuns);
  const pool = await getPool();
  await pool.query(
    `INSERT INTO project_settings(project_id, approval_mode, max_concurrent_runs) VALUES($1, COALESCE($2::text,'supervised'), COALESCE($3::int,$4::int))
     ON CONFLICT (project_id) DO UPDATE SET approval_mode=COALESCE($2::text, project_settings.approval_mode),
       max_concurrent_runs=COALESCE($3::int, project_settings.max_concurrent_runs), updated_at=now()`, [projectId, mode, max, DEFAULT_MAX_CONCURRENT_RUNS]);
  await pool.query(
    'INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)',
    [newId(), projectId, 'project.settings.changed', 'human', JSON.stringify({ approvalMode: mode, maxConcurrentRuns: max })],
  );
  return getProjectSettings(projectId);
}

// ---------- budgets ----------
export async function getBudget(projectId: string, scope: BudgetScope, scopeId: string): Promise<BudgetLimits | null> {
  const pool = await getPool();
  const r = await pool.query('SELECT limits FROM budgets WHERE project_id=$1 AND scope=$2 AND scope_id=$3', [idSchema.parse(projectId), scopeSchema.parse(scope), idSchema.parse(scopeId)]);
  return r.rows[0] ? (r.rows[0].limits as BudgetLimits) : null;
}

async function setBudgetInTx(db: Db, input: { projectId: string; scope: BudgetScope; scopeId: string; limits: BudgetLimits; actor: string; actorKind: string }) {
  const projectId = idSchema.parse(input.projectId);
  const scope = scopeSchema.parse(input.scope);
  const scopeId = idSchema.parse(input.scopeId);
  const limits = budgetLimitsSchema.parse(input.limits);
  const actor = actorSchema.parse(input.actor);
  const old = (await db.query('SELECT limits FROM budgets WHERE project_id=$1 AND scope=$2 AND scope_id=$3 FOR UPDATE', [projectId, scope, scopeId])).rows[0];
  if (old && raisesBudget(old.limits, limits)) requireHuman(input.actorKind, 'Raising a budget');   // anyone may set a first budget or lower it
  await db.query(
    `INSERT INTO budgets(id,project_id,scope,scope_id,limits) VALUES($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (project_id,scope,scope_id) DO UPDATE SET limits=$5::jsonb, updated_at=now()`, [newId(), projectId, scope, scopeId, JSON.stringify(limits)]);
  await audit(db, projectId, 'budget.set', actor, { scope, scopeId, limits, raised: Boolean(old && raisesBudget(old.limits, limits)) });
  return limits;
}
/** A first budget or a lower one may be set by anyone; a higher one only by a human (TZ 8.4). */
export async function setBudget(input: { projectId: string; scope: BudgetScope; scopeId: string; limits: BudgetLimits; actor: string; actorKind: string }) {
  return inTx((db) => setBudgetInTx(db, input));
}

async function usageFor(db: Db, scope: BudgetScope, o: { projectId: string; taskId?: string; runId?: string }, now: Date): Promise<Usage> {
  const col = scope === 'project' ? 'r.project_id' : scope === 'task' ? 'r.task_id' : 'r.id';
  const id = scope === 'project' ? o.projectId : scope === 'task' ? o.taskId : o.runId;
  const u = emptyUsage();
  if (!id) return u;
  const led = (await db.query(
    `SELECT count(*)::int AS calls, COALESCE(sum(l.input_tokens + l.output_tokens),0)::bigint AS tokens, COALESCE(sum(l.units),0)::bigint AS units
       FROM usage_ledger l JOIN runs r ON r.id = l.run_id WHERE ${col} = $1`, [id])).rows[0];
  u.calls = Number(led.calls); u.tokens = Number(led.tokens); u.units = Number(led.units);
  const runs = (await db.query(
    `SELECT count(*)::int AS attempts,
            COALESCE(sum(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(r.finished_at, $2::timestamptz) - r.started_at)) * 1000)),0)::bigint AS wall
       FROM runs r WHERE ${col} = $1`, [id, now])).rows[0];
  u.attempts = Number(runs.attempts); u.wallClockMs = Number(runs.wall);
  if (scope === 'project') {
    u.codeTasks = Number((await db.query(
      `SELECT count(*)::int AS n FROM tasks t WHERE t.project_id=$1 AND t.input->>'profile' = ANY($2::text[]) AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id=t.id)`,
      [o.projectId, [...CODE_PROFILES]])).rows[0].n);
  }
  return u;
}

/** All violations over the project, task and run budgets for the given request. Nothing is written. */
async function evaluate(db: Db, o: { projectId: string; taskId?: string; runId?: string; request: Request; now: Date }): Promise<Violation[]> {
  const out: Violation[] = [];
  const scopes: Array<[BudgetScope, string | undefined]> = [['project', o.projectId], ['task', o.taskId], ['run', o.runId]];
  for (const [scope, scopeId] of scopes) {
    if (!scopeId) continue;
    const row = (await db.query('SELECT limits FROM budgets WHERE project_id=$1 AND scope=$2 AND scope_id=$3', [o.projectId, scope, scopeId])).rows[0];
    if (!row) continue;
    out.push(...checkBudget(scope, row.limits, await usageFor(db, scope, o, o.now), o.request));
  }
  return out;
}

async function requestApprovalInTx(db: Db, o: { projectId: string; kind: ApprovalKind; subjectId: string; details?: Record<string, unknown>; requestedBy: string }): Promise<Approval> {
  const kind = z.enum(APPROVAL_KINDS).parse(o.kind);
  const projectId = idSchema.parse(o.projectId);
  const subjectId = idSchema.parse(o.subjectId);
  const ins = await db.query(
    `INSERT INTO approvals(id,project_id,kind,subject_id,details,requested_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (project_id,kind,subject_id) WHERE status='PENDING' DO NOTHING RETURNING *`,
    [newId(), projectId, kind, subjectId, JSON.stringify(o.details ?? {}), actorSchema.parse(o.requestedBy)]);   // one open request per subject
  if (ins.rows[0]) { await audit(db, projectId, 'approval.requested', o.requestedBy, { kind, subjectId }); return mapApproval(ins.rows[0]); }
  return mapApproval((await db.query("SELECT * FROM approvals WHERE project_id=$1 AND kind=$2 AND subject_id=$3 AND status='PENDING'", [projectId, kind, subjectId])).rows[0]);
}
export async function requestApproval(o: { projectId: string; kind: ApprovalKind; subjectId: string; details?: Record<string, unknown>; requestedBy: string }): Promise<Approval> {
  return inTx((db) => requestApprovalInTx(db, o));
}
export async function getApproval(id: string): Promise<Approval | null> {
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM approvals WHERE id=$1', [idSchema.parse(id)]);
  return r.rows[0] ? mapApproval(r.rows[0]) : null;
}
export async function listApprovals(o: { projectId: string; status?: 'PENDING' | 'APPROVED' | 'REJECTED' }): Promise<Approval[]> {
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM approvals WHERE project_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY seq', [idSchema.parse(o.projectId), o.status ?? null]);
  return r.rows.map(mapApproval);
}
export async function hasApproval(projectId: string, kind: ApprovalKind, subjectId: string): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query("SELECT 1 FROM approvals WHERE project_id=$1 AND kind=$2 AND subject_id=$3 AND status='APPROVED' LIMIT 1", [idSchema.parse(projectId), kind, idSchema.parse(subjectId)]);
  return r.rows.length > 0;
}

/** Writes the budget block: the Task waits (BLOCKED(budget)) unless a Run owns its state, and a human gets one approval request. */
async function blockForBudget(db: Db, task: Task, violations: Violation[], actor: string, runId?: string): Promise<Approval> {
  if (task.state === 'READY' || task.state === 'VALIDATING') await transitionTaskInTx(db, { taskId: task.id, expectedVersion: task.version, to: 'BLOCKED', actor, reason: 'budget' });
  return requestApprovalInTx(db, { projectId: task.projectId, kind: 'budget', subjectId: task.id, details: { violations, runId: runId ?? null }, requestedBy: actor });
}

/**
 * Called before every model call (TZ 8.4). Over budget: one approval request is written and BUDGET_EXCEEDED is thrown.
 * The caller (the worker) ends the Run with blockReason 'budget', which moves the Task to BLOCKED(budget).
 */
export async function guardModelCall(input: { taskId: string; runId?: string; request?: { tokens?: number; units?: number }; actor: string; now?: Date }): Promise<void> {
  const taskId = idSchema.parse(input.taskId);
  const actor = actorSchema.parse(input.actor);
  const now = input.now ?? new Date();
  const request: Request = { calls: 1, tokens: input.request?.tokens ?? 0, units: input.request?.units ?? 0 };
  const failure = await inTx(async (db) => {
    const task = await lockTask(db, taskId);
    const violations = await evaluate(db, { projectId: task.projectId, taskId, runId: input.runId, request, now });
    if (violations.length === 0) return null;
    const approval = await blockForBudget(db, task, violations, actor, input.runId);
    return { violations, approvalId: approval.id };
  });
  if (failure) throw new PlanError('BUDGET_EXCEEDED', 'Budget exceeded: a human must decide', failure);
}

/** A human decides. APPROVED needs new limits for a budget request (and moves the Task back to READY); REJECTED fails the Task. */
export async function decideApproval(input: {
  approvalId: string; decision: 'APPROVED' | 'REJECTED'; decidedBy: string; actorKind: string; reason?: string;
  budgetLimits?: { scope: BudgetScope; scopeId: string; limits: BudgetLimits };
}): Promise<Approval> {
  requireHuman(input.actorKind, 'An approval');
  const id = idSchema.parse(input.approvalId);
  const decision = z.enum(['APPROVED', 'REJECTED']).parse(input.decision);
  const by = actorSchema.parse(input.decidedBy);
  const reason = input.reason === undefined ? null : z.string().max(1000).parse(input.reason);
  return inTx(async (db) => {
    const found = (await db.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!found) throw new PlanError('APPROVAL_NOT_FOUND', 'Approval not found');
    const a = mapApproval(found);
    if (a.status !== 'PENDING') throw new PlanError('APPROVAL_CLOSED', 'Approval already decided');
    if (a.kind === 'budget' && decision === 'APPROVED' && !input.budgetLimits) throw new PlanError('BUDGET_LIMITS_REQUIRED', 'Approving a budget request needs the new limits');
    const done = mapApproval((await db.query(
      "UPDATE approvals SET status=$2, decided_by=$3, decision_reason=$4, decided_at=now() WHERE id=$1 RETURNING *", [id, decision, by, reason])).rows[0]);
    if (a.kind === 'plan') await settlePlan(db, a, decision, by);
    if (a.kind === 'budget') {
      const task = await lockTask(db, a.subjectId);
      if (decision === 'APPROVED') {
        const b = input.budgetLimits!;
        const existing = (await db.query('SELECT limits FROM budgets WHERE project_id=$1 AND scope=$2 AND scope_id=$3 FOR UPDATE', [a.projectId, b.scope, b.scopeId])).rows[0]?.limits ?? {};
        // Approval updates only the explicitly chosen budget keys; unrelated limits must not silently disappear.
        const mergedLimits = budgetLimitsSchema.parse({ ...existing, ...b.limits });
        await setBudgetInTx(db, { projectId: a.projectId, scope: b.scope, scopeId: b.scopeId, limits: mergedLimits, actor: by, actorKind: 'human' });
        if (task.state === 'BLOCKED' && task.blockedReason === 'budget') await transitionTaskInTx(db, { taskId: task.id, expectedVersion: task.version, to: 'READY', actor: by });
      } else if (task.state === 'BLOCKED' && task.blockedReason === 'budget') {
        await transitionTaskInTx(db, { taskId: task.id, expectedVersion: task.version, to: 'FAIL', actor: by, reason: 'budget_rejected' });
      }
    }
    await audit(db, a.projectId, 'approval.decided', by, { kind: a.kind, subjectId: a.subjectId, decision });
    return done;
  });
}

// ---------- Task Graph v1 ----------
export async function listPlans(projectId: string): Promise<Plan[]> {
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM plans WHERE project_id=$1 ORDER BY version DESC', [idSchema.parse(projectId)]);
  return r.rows.map(mapPlan);
}

export async function getPlan(id: string): Promise<Plan | null> {
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM plans WHERE id=$1', [idSchema.parse(id)]);
  return r.rows[0] ? mapPlan(r.rows[0]) : null;
}
export async function listPlanTasks(planId: string): Promise<Array<{ nodeKey: string; taskId: string; state: string }>> {
  const pool = await getPool();
  const r = await pool.query('SELECT pt.node_key, pt.task_id, t.state FROM plan_tasks pt JOIN tasks t ON t.id=pt.task_id WHERE pt.plan_id=$1 ORDER BY pt.node_key', [idSchema.parse(planId)]);
  return r.rows.map((x: any) => ({ nodeKey: x.node_key as string, taskId: x.task_id as string, state: x.state as string }));
}

/**
 * Stores a plan (a static template, a human list, or a model proposal) and asks a human to approve it.
 * Nothing runs before the approval. A new version is a new plan and needs its own approval; nodes of a stored plan are never edited.
 */
export async function createPlan(input: { projectId: string; source: 'template' | 'model' | 'human'; template?: string; goal?: string; nodes?: unknown; actor: string }): Promise<{ plan: Plan; approval: Approval }> {
  const projectId = idSchema.parse(input.projectId);
  const actor = actorSchema.parse(input.actor);
  const source = z.enum(['template', 'model', 'human']).parse(input.source);
  return inTx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${projectId}`]);
    const lim = (await db.query("SELECT limits FROM budgets WHERE project_id=$1 AND scope='project' AND scope_id=$1", [projectId])).rows[0]?.limits as BudgetLimits | undefined;
    const nodes = source === 'template'
      ? planFromTemplate(input.template ?? '', { goal: input.goal ?? '' })
      : validatePlan(input.nodes, lim?.max_cost_units ?? null);
    const unitLimit = lim?.max_cost_units ?? null;
    if (source === 'template') validatePlan(nodes, unitLimit);
    const version = Number((await db.query('SELECT COALESCE(max(version),0)+1 AS v FROM plans WHERE project_id=$1', [projectId])).rows[0].v);
    let row;
    try {
      row = (await db.query(
        'INSERT INTO plans(id,project_id,version,source,template,nodes,total_units,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *',
        [newId(), projectId, version, source, source === 'template' ? input.template : null, JSON.stringify(nodes), planUnits(nodes), actor])).rows[0];
    } catch (e: any) {
      if (e?.code === '23503') throw new TaskError('NOT_FOUND', 'Project not found');
      throw e;
    }
    const plan = mapPlan(row);
    const approval = await requestApprovalInTx(db, { projectId, kind: 'plan', subjectId: plan.id, details: { version, source, tasks: nodes.length, totalUnits: plan.totalUnits }, requestedBy: actor });
    return { plan, approval };
  });
}

/** Plan decision: APPROVED creates the tasks (READY, with their unit budgets) and supersedes the previous approved plan. */
async function settlePlan(db: Db, a: Approval, decision: 'APPROVED' | 'REJECTED', by: string) {
  const plan = mapPlan((await db.query('SELECT * FROM plans WHERE id=$1 FOR UPDATE', [a.subjectId])).rows[0]);
  if (decision === 'REJECTED') { await db.query("UPDATE plans SET status='REJECTED', decided_at=now() WHERE id=$1", [plan.id]); return; }
  const old = (await db.query("SELECT id FROM plans WHERE project_id=$1 AND status='APPROVED' AND id<>$2 FOR UPDATE", [plan.projectId, plan.id])).rows;
  for (const o of old) {
    await db.query("UPDATE plans SET status='SUPERSEDED' WHERE id=$1", [o.id]);
    const open = (await db.query("SELECT t.id FROM plan_tasks pt JOIN tasks t ON t.id=pt.task_id WHERE pt.plan_id=$1 AND t.state IN ('DRAFT','READY')", [o.id])).rows;
    for (const t of open) {
      const task = await lockTask(db, t.id);
      if (task.state === 'DRAFT' || task.state === 'READY') await transitionTaskInTx(db, { taskId: task.id, expectedVersion: task.version, to: 'CANCELLED', actor: by, reason: 'plan_superseded' });
    }
  }
  await db.query("UPDATE plans SET status='APPROVED', decided_at=now() WHERE id=$1", [plan.id]);
  await db.query('INSERT INTO project_settings(project_id) VALUES($1) ON CONFLICT (project_id) DO NOTHING', [plan.projectId]);
  for (const n of plan.nodes) {
    const { task } = await createTaskInTx(db, {
      projectId: plan.projectId, idempotencyKey: `plan-${plan.id}-${n.key}`, title: n.title, actor: by,
      input: { task: n.task, artifactRefs: [], stateVersion: null, profile: n.profile, profileVersion: null, criteria: n.criteria },
    });
    await db.query('INSERT INTO plan_tasks(plan_id,node_key,task_id) VALUES($1,$2,$3)', [plan.id, n.key, task.id]);
    if (n.units > 0) await setBudgetInTx(db, { projectId: plan.projectId, scope: 'task', scopeId: task.id, limits: { max_cost_units: n.units }, actor: by, actorKind: 'human' });
    await transitionTaskInTx(db, { taskId: task.id, expectedVersion: task.version, to: 'READY', actor: by });
  }
}

/**
 * Queues a task of an approved plan: the plan is APPROVED, every dependency is PASS, no other active task writes the same artifact,
 * the project is not in Manual mode without an approval for this task, and the budget has room for one more attempt and call.
 * Over budget: the Task becomes BLOCKED(budget), one approval request is written, BUDGET_EXCEEDED is thrown.
 */
export async function enqueuePlanTask(input: { taskId: string; expectedVersion: number; idempotencyKey: string; actor: string; now?: Date }): Promise<{ task: Task; run: Run; created: boolean }> {
  const taskId = idSchema.parse(input.taskId);
  const now = input.now ?? new Date();
  const outcome = await inTx(async (db) => {
    const link = (await db.query('SELECT pt.plan_id, pt.node_key FROM plan_tasks pt WHERE pt.task_id=$1', [taskId])).rows[0];
    if (!link) throw new PlanError('NOT_IN_PLAN', 'The task does not belong to a plan');
    const plan = mapPlan((await db.query('SELECT * FROM plans WHERE id=$1', [link.plan_id])).rows[0]);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${plan.projectId}`]);   // serializes the checks below per project
    const replay = (await db.query('SELECT 1 FROM runs WHERE task_id=$1 AND idempotency_key=$2', [taskId, input.idempotencyKey])).rows[0];
    if (replay) return { ok: await enqueueTaskInTx(db, input) };
    if (plan.status !== 'APPROVED') throw new PlanError('PLAN_NOT_APPROVED', 'Only a task of an approved plan can start', { planStatus: plan.status });
    const node = plan.nodes.find((n) => n.key === link.node_key)!;
    const deps = (await db.query(
      `SELECT pt.node_key, t.state FROM plan_tasks pt JOIN tasks t ON t.id=pt.task_id WHERE pt.plan_id=$1 AND pt.node_key = ANY($2::text[])`, [plan.id, node.deps])).rows;
    const open = node.deps.filter((d) => deps.find((x: any) => x.node_key === d)?.state !== 'PASS');
    if (open.length > 0) throw new PlanError('DEPENDENCY_NOT_READY', 'Dependencies are not PASS', { open });
    if (node.writesArtifact) {
      const clash = (await db.query(
        `SELECT pt.node_key FROM plan_tasks pt JOIN tasks t ON t.id=pt.task_id
          WHERE pt.plan_id=$1 AND pt.task_id<>$2 AND t.state IN ('QUEUED','RUNNING','VALIDATING')`, [plan.id, taskId])).rows
        .map((x: any) => x.node_key as string).filter((k: string) => plan.nodes.find((n) => n.key === k)?.writesArtifact === node.writesArtifact);
      if (clash.length > 0) throw new PlanError('ARTIFACT_WRITE_CONFLICT', 'Another active task writes the same artifact', { artifact: node.writesArtifact, tasks: clash });
    }
    const task = await lockTask(db, taskId);
    const settings = (await db.query('SELECT approval_mode FROM project_settings WHERE project_id=$1', [plan.projectId])).rows[0];
    if (settings?.approval_mode === 'manual') {
      const ok = (await db.query("SELECT 1 FROM approvals WHERE project_id=$1 AND kind='task_start' AND subject_id=$2 AND status='APPROVED'", [plan.projectId, taskId])).rows[0];
      if (!ok) { const approval = await requestApprovalInTx(db, { projectId: plan.projectId, kind: 'task_start', subjectId: taskId, requestedBy: input.actor }); return { approvalId: approval.id, code: 'APPROVAL_REQUIRED' as const }; }
    }
    const isCode = node.profile !== null && (CODE_PROFILES as readonly string[]).includes(node.profile);
    const first = Number((await db.query('SELECT count(*)::int AS n FROM runs WHERE task_id=$1', [taskId])).rows[0].n) === 0;
    const violations = await evaluate(db, { projectId: plan.projectId, taskId, request: { calls: 1, attempts: 1, codeTasks: isCode && first ? 1 : 0 }, now });
    if (violations.length > 0) {
      const approval = await blockForBudget(db, task, violations, input.actor);
      return { approvalId: approval.id, violations, code: 'BUDGET_EXCEEDED' as const };
    }
    return { ok: await enqueueTaskInTx(db, input) };
  });
  if ('ok' in outcome) return outcome.ok;
  throw new PlanError(outcome.code, outcome.code === 'BUDGET_EXCEEDED' ? 'Budget exceeded: a human must decide' : 'This task needs a human approval to start', { ...outcome });
}
