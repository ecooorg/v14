import { z } from 'zod';
import { getPool } from './database.ts';
import { jobStatusForRun } from './queueMachine.ts';
import {
  DEFAULT_MAX_ATTEMPTS, RUN_STATES, TaskError, assertTaskTransition, canRunTransition, runEffectOnTask, taskFingerprint, taskInputSchema,
  type RunStatus, type TaskInput, type TaskState,
} from './taskMachine.ts';
import { gatesAllowTaskPass } from './gateEngine.ts';
import { getTaskGates } from './gateService.ts';

// Task/Run domain service (TZ 8.1, 8.2). Every change: one transaction, task row locked (FOR UPDATE),
// version checked, one or more events written. No HTTP routes, no queue (P12).
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const keySchema = z.string().trim().min(1).max(200);
const actorSchema = z.string().trim().min(1).max(100);
const titleSchema = z.string().trim().min(1).max(200);
const versionSchema = z.number().int().min(1);
const evidenceSchema = z.array(z.string().trim().min(1).max(500)).max(100);

function newId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `${Date.now().toString(36).padStart(9, '0')}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export type Db = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

const mapTask = (r: any) => ({
  id: r.id as string, projectId: r.project_id as string, title: r.title as string, input: r.input as TaskInput,
  inputFingerprint: r.input_fingerprint as string, idempotencyKey: r.idempotency_key as string, state: r.state as TaskState,
  version: r.version as number, maxAttempts: r.max_attempts as number, blockedReason: (r.blocked_reason ?? null) as string | null,
  validatedFingerprint: (r.validated_fingerprint ?? null) as string | null, createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
});
const mapRun = (r: any) => ({
  id: r.id as string, taskId: r.task_id as string, projectId: r.project_id as string, attempt: r.attempt as number, status: r.status as RunStatus,
  idempotencyKey: r.idempotency_key as string, inputFingerprint: r.input_fingerprint as string, inputRefs: r.input_refs as string[],
  profile: (r.profile ?? null) as string | null, profileVersion: (r.profile_version ?? null) as string | null,
  providerId: (r.provider_id ?? null) as string | null, modelId: (r.model_id ?? null) as string | null,
  policyVersion: (r.policy_version ?? null) as string | null, budget: (r.budget ?? null) as unknown, evidence: r.evidence as string[],
  queuedAt: r.queued_at as Date, startedAt: (r.started_at ?? null) as Date | null, finishedAt: (r.finished_at ?? null) as Date | null,
});
const mapEvent = (r: any) => ({
  id: r.id as string, taskId: r.task_id as string, projectId: r.project_id as string, runId: (r.run_id ?? null) as string | null,
  eventType: r.event_type as string, fromState: (r.from_state ?? null) as string | null, toState: (r.to_state ?? null) as string | null,
  actor: r.actor as string, details: r.details as Record<string, unknown>, createdAt: r.created_at as Date,
});
export type Task = ReturnType<typeof mapTask>;
export type Run = ReturnType<typeof mapRun>;

export async function inTx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function event(db: Db, t: { id: string; projectId: string }, e: { runId?: string | null; type: string; from?: string | null; to?: string | null; actor: string; details?: Record<string, unknown> }) {
  await db.query(
    'INSERT INTO task_events(id,task_id,project_id,run_id,event_type,from_state,to_state,actor,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
    [newId(), t.id, t.projectId, e.runId ?? null, e.type, e.from ?? null, e.to ?? null, e.actor, JSON.stringify(e.details ?? {})]);
}

export async function lockTask(db: Db, taskId: string): Promise<Task> {
  const r = await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
  if (!r.rows[0]) throw new TaskError('NOT_FOUND', 'Task not found');
  return mapTask(r.rows[0]);
}
const checkVersion = (t: Task, expected: number) => {
  if (t.version !== expected) throw new TaskError('VERSION_CONFLICT', `Task version conflict: expected ${expected}, actual ${t.version}`);
};
async function countRuns(db: Db, taskId: string): Promise<number> {
  return Number((await db.query('SELECT COUNT(*)::int AS n FROM runs WHERE task_id=$1', [taskId])).rows[0].n);
}
/** Writes the new state, bumps the version, records one task.transition event. */
async function moveTask(db: Db, t: Task, to: TaskState, actor: string, o: { blockedReason?: string | null; validatedFingerprint?: string | null; runId?: string; details?: Record<string, unknown> } = {}): Promise<Task> {
  const r = await db.query(
    `UPDATE tasks SET state=$2, version=version+1, blocked_reason=$3, validated_fingerprint=$4, updated_at=now() WHERE id=$1 RETURNING *`,
    [t.id, to, to === 'BLOCKED' ? (o.blockedReason ?? null) : null, o.validatedFingerprint !== undefined ? o.validatedFingerprint : t.validatedFingerprint]);
  await event(db, t, { runId: o.runId, type: 'task.transition', from: t.state, to, actor, details: o.details });
  return mapTask(r.rows[0]);
}

type CreateTaskInput = { projectId: string; idempotencyKey: string; title: string; input: TaskInput; maxAttempts?: number; actor: string };

export async function createTask(input: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
  try {
    return await inTx((db) => createTaskInTx(db, input));
  } catch (error: any) {
    if (error?.code === '23503') throw new TaskError('NOT_FOUND', 'Project not found');
    throw error;
  }
}

/** createTask inside an open transaction (also used when an approved plan creates its tasks). */
export async function createTaskInTx(db: Db, input: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
  const projectId = idSchema.parse(input.projectId);
  const key = keySchema.parse(input.idempotencyKey);
  const title = titleSchema.parse(input.title);
  const actor = actorSchema.parse(input.actor);
  const body = taskInputSchema.parse(input.input);
  const maxAttempts = z.number().int().min(1).max(10).parse(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const fingerprint = taskFingerprint(body);
  const ins = await db.query(
    `INSERT INTO tasks(id,project_id,title,input,input_fingerprint,idempotency_key,max_attempts) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
     ON CONFLICT (project_id, idempotency_key) DO NOTHING RETURNING *`,
    [newId(), projectId, title, JSON.stringify(body), fingerprint, key, maxAttempts]);
  if (ins.rows[0]) {
    const task = mapTask(ins.rows[0]);
    await event(db, task, { type: 'task.created', to: 'DRAFT', actor, details: { inputFingerprint: fingerprint } });
    return { task, created: true };
  }
  const existing = mapTask((await db.query('SELECT * FROM tasks WHERE project_id=$1 AND idempotency_key=$2', [projectId, key])).rows[0]);
  if (existing.inputFingerprint !== fingerprint) throw new TaskError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different input');
  return { task: existing, created: false };
}

export async function getTask(idInput: string): Promise<Task | null> {
  const id = idSchema.parse(idInput);
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM tasks WHERE id=$1', [id]);
  return r.rows[0] ? mapTask(r.rows[0]) : null;
}
export async function listRuns(taskId: string): Promise<Run[]> {
  const pool = await getPool();
  return (await pool.query('SELECT * FROM runs WHERE task_id=$1 ORDER BY attempt', [idSchema.parse(taskId)])).rows.map(mapRun);
}
export async function listTaskEvents(taskId: string) {
  const pool = await getPool();
  return (await pool.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY seq', [idSchema.parse(taskId)])).rows.map(mapEvent);
}

type TransitionInput = { taskId: string; expectedVersion: number; to: TaskState; actor: string; reason?: string; validation?: { passed: boolean; evidence: string[] } };

export async function transitionTask(input: TransitionInput): Promise<Task> {
  return inTx((db) => transitionTaskInTx(db, input));
}

/** transitionTask inside an open transaction (also used by the budget guard and approvals). */
export async function transitionTaskInTx(db: Db, input: TransitionInput): Promise<Task> {
  const taskId = idSchema.parse(input.taskId);
  const expected = versionSchema.parse(input.expectedVersion);
  const actor = actorSchema.parse(input.actor);
  const t = await lockTask(db, taskId);
  checkVersion(t, expected);
  assertTaskTransition(t.state, input.to, { reason: input.reason, validation: input.validation, attemptsUsed: await countRuns(db, t.id), maxAttempts: t.maxAttempts });
  let gatesCommit: string | null = null;
  if (input.to === 'PASS') {
    const snap = await getTaskGates(db, taskId);
    gatesCommit = snap.commit;
    const allow = gatesAllowTaskPass(snap.gates);
    if (!allow.ok) {
      const err = new TaskError(
        'GATES_BLOCKED',
        'Task PASS requires gate Release Candidate PASS or WAIVED at the current head',
        409,
      );
      (err as any).details = { blockers: allow.blockers, commit: snap.commit };
      throw err;
    }
  }
  return moveTask(db, t, input.to, actor, {
    blockedReason: input.reason ?? null,
    validatedFingerprint: input.to === 'PASS' ? t.inputFingerprint : undefined,
    details: input.to === 'PASS'
      ? { validation: input.validation, ...(gatesCommit ? { gates_commit: gatesCommit } : {}) }
      : input.reason ? { reason: input.reason } : undefined,
  });
}

export async function changeTaskInput(input: { taskId: string; expectedVersion: number; input: TaskInput; actor: string }): Promise<Task> {
  const taskId = idSchema.parse(input.taskId);
  const expected = versionSchema.parse(input.expectedVersion);
  const actor = actorSchema.parse(input.actor);
  const body = taskInputSchema.parse(input.input);
  const fingerprint = taskFingerprint(body);
  return inTx(async (db) => {
    const t = await lockTask(db, taskId);
    checkVersion(t, expected);
    if (!['DRAFT', 'READY', 'FAIL', 'BLOCKED', 'PASS'].includes(t.state)) throw new TaskError('INPUT_LOCKED', `Input cannot change in state ${t.state}`);
    if (fingerprint === t.inputFingerprint) return t;
    const invalidates = t.state === 'PASS';
    if (invalidates) assertTaskTransition('PASS', 'VALIDATING', { reason: 'input_changed' });
    const to: TaskState = invalidates ? 'VALIDATING' : t.state;
    const r = await db.query('UPDATE tasks SET input=$2::jsonb, input_fingerprint=$3, state=$4, version=version+1, updated_at=now() WHERE id=$1 RETURNING *',
      [t.id, JSON.stringify(body), fingerprint, to]);
    await event(db, t, { type: invalidates ? 'task.pass_invalidated' : 'task.input_changed', from: t.state, to, actor, details: { from: t.inputFingerprint, to: fingerprint } });
    return mapTask(r.rows[0]);
  });
}

export async function enqueueTask(input: { taskId: string; expectedVersion: number; idempotencyKey: string; actor: string }): Promise<{ task: Task; run: Run; created: boolean }> {
  return inTx((db) => enqueueTaskInTx(db, input));
}

/** enqueueTask inside an open transaction (also used by the plan service, which checks the plan and the budget first). */
export async function enqueueTaskInTx(db: Db, input: { taskId: string; expectedVersion: number; idempotencyKey: string; actor: string }): Promise<{ task: Task; run: Run; created: boolean }> {
  const taskId = idSchema.parse(input.taskId);
  const expected = versionSchema.parse(input.expectedVersion);
  const key = keySchema.parse(input.idempotencyKey);
  const actor = actorSchema.parse(input.actor);
  {
    const t = await lockTask(db, taskId);
    const prior = await db.query('SELECT * FROM runs WHERE task_id=$1 AND idempotency_key=$2', [t.id, key]);
    if (prior.rows[0]) {   // a replay returns the existing Run before any version check
      const run = mapRun(prior.rows[0]);
      if (run.inputFingerprint !== t.inputFingerprint) throw new TaskError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different input');
      return { task: t, run, created: false };
    }
    checkVersion(t, expected);
    assertTaskTransition(t.state, 'QUEUED', { via: 'run' });
    const used = await countRuns(db, t.id);
    if (used >= t.maxAttempts) throw new TaskError('ATTEMPTS_EXHAUSTED', 'No attempts left');
    const run = mapRun((await db.query(
      `INSERT INTO runs(id,task_id,project_id,attempt,idempotency_key,input_fingerprint,input_refs,profile,profile_version)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
      [newId(), t.id, t.projectId, used + 1, key, t.inputFingerprint, JSON.stringify(t.input.artifactRefs), t.input.profile, t.input.profileVersion])).rows[0]);
    await db.query('INSERT INTO jobs(id,run_id,task_id,project_id) VALUES($1,$2,$3,$4) ON CONFLICT (run_id) DO NOTHING', [newId(), run.id, t.id, t.projectId]);
    await event(db, t, { runId: run.id, type: 'run.queued', actor, details: { attempt: run.attempt } });
    const task = await moveTask(db, t, 'QUEUED', actor, { runId: run.id });
    return { task, run, created: true };
  }
}

export async function lockRun(db: Db, runId: string): Promise<{ task: Task; run: Run }> {
  const found = await db.query('SELECT task_id FROM runs WHERE id=$1', [runId]);
  if (!found.rows[0]) throw new TaskError('NOT_FOUND', 'Run not found');
  const task = await lockTask(db, found.rows[0].task_id);   // lock order: task, then run
  const run = mapRun((await db.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]);
  return { task, run };
}

/** Starts a QUEUED Run inside an open transaction (also used by claimJob). */
export async function startRunInTx(db: Db, runId: string, actor: string): Promise<{ task: Task; run: Run }> {
  const { task: t, run } = await lockRun(db, runId);
  if (!canRunTransition(run.status, 'RUNNING')) throw new TaskError('INVALID_TRANSITION', `Run cannot move from ${run.status} to RUNNING`);
  assertTaskTransition(t.state, 'RUNNING', { via: 'run' });
  const r = await db.query("UPDATE runs SET status='RUNNING', started_at=now() WHERE id=$1 RETURNING *", [run.id]);
  await event(db, t, { runId: run.id, type: 'run.started', actor, details: { attempt: run.attempt } });
  return { task: await moveTask(db, t, 'RUNNING', actor, { runId: run.id }), run: mapRun(r.rows[0]) };
}

export async function startRun(input: { runId: string; actor: string }): Promise<{ task: Task; run: Run }> {
  const runId = idSchema.parse(input.runId);
  const actor = actorSchema.parse(input.actor);
  return inTx((db) => startRunInTx(db, runId, actor));
}

export type FinishRunInput = {
  runId: string; status: RunStatus; actor: string; providerId?: string; modelId?: string; policyVersion?: string; budget?: unknown; evidence?: string[];
  blockReason?: 'budget';   // FAILED/TIMED_OUT Run that was stopped by the budget guard: the Task becomes BLOCKED(budget)
};

/** Finishes a Run inside an open transaction: Run, Task, the Run's job and events (also used by completeJob and recovery). */
export async function finishRunInTx(db: Db, input: FinishRunInput): Promise<{ task: Task; run: Run }> {
  const runId = idSchema.parse(input.runId);
  const actor = actorSchema.parse(input.actor);
  const evidence = evidenceSchema.parse(input.evidence ?? []);
  const status = input.status;
  const { task: t, run } = await lockRun(db, runId);
  if (!(RUN_STATES as readonly string[]).includes(status) || !canRunTransition(run.status, status)) {
    throw new TaskError('INVALID_TRANSITION', `Run cannot move from ${run.status} to ${status}`);
  }
  const effect = runEffectOnTask(status, input.blockReason);
  assertTaskTransition(t.state, effect.state, { via: 'run' });
  const r = await db.query(
    `UPDATE runs SET status=$2, finished_at=now(), provider_id=$3, model_id=$4, policy_version=$5, budget=$6::jsonb, evidence=$7::jsonb WHERE id=$1 RETURNING *`,
    [run.id, status, input.providerId ?? null, input.modelId ?? null, input.policyVersion ?? null, input.budget === undefined ? null : JSON.stringify(input.budget), JSON.stringify(evidence)]);
  await db.query('UPDATE jobs SET status=$2, finished_at=now() WHERE run_id=$1', [run.id, jobStatusForRun(status)]);
  await event(db, t, { runId: run.id, type: 'run.finished', actor, details: { attempt: run.attempt, status } });
  const task = await moveTask(db, t, effect.state, actor, { runId: run.id, blockedReason: effect.blockedReason, details: { runStatus: status } });
  return { task, run: mapRun(r.rows[0]) };
}

export async function finishRun(input: FinishRunInput): Promise<{ task: Task; run: Run }> {
  return inTx((db) => finishRunInTx(db, input));
}
