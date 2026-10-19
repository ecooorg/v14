import { z } from 'zod';
import { getPool } from './database.ts';
import { DEFAULT_LEASE_MS, QueueError, isLeaseExpired, leaseUntil, type JobStatus } from './queueMachine.ts';
import { finishRunInTx, inTx, lockTask, startRunInTx, type Db, type Run, type Task } from './taskService.ts';

// Job queue (TZ 8.3, D-05): claim with FOR UPDATE SKIP LOCKED, lease, heartbeat, recovery.
// Lock order is always task, then job. Claim and recovery lock job and task in one statement with SKIP LOCKED, so they never wait.
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const workerSchema = z.string().trim().min(1).max(100);
const leaseSchema = z.number().int().min(1).max(86_400_000);

const mapJob = (r: any) => ({
  id: r.id as string, runId: r.run_id as string, taskId: r.task_id as string, projectId: r.project_id as string, status: r.status as JobStatus,
  availableAt: r.available_at as Date, claims: r.claims as number, leaseOwner: (r.lease_owner ?? null) as string | null,
  leaseUntil: (r.lease_until ?? null) as Date | null, heartbeatAt: (r.heartbeat_at ?? null) as Date | null,
  createdAt: r.created_at as Date, finishedAt: (r.finished_at ?? null) as Date | null,
});
export type Job = ReturnType<typeof mapJob>;

export async function getJob(idInput: string): Promise<Job | null> {
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM jobs WHERE id=$1', [idSchema.parse(idInput)]);
  return r.rows[0] ? mapJob(r.rows[0]) : null;
}
export async function getJobByRun(runIdInput: string): Promise<Job | null> {
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM jobs WHERE run_id=$1', [idSchema.parse(runIdInput)]);
  return r.rows[0] ? mapJob(r.rows[0]) : null;
}

/** maxConcurrent: leased jobs allowed per project; when omitted the project's `project_settings` row decides, and no row means no limit (TZ 8.5). */
export async function claimJob(input: { workerId: string; projectId?: string; now?: Date; leaseMs?: number; maxConcurrent?: number }): Promise<{ job: Job; run: Run; task: Task } | null> {
  const workerId = workerSchema.parse(input.workerId);
  const projectId = input.projectId === undefined ? null : idSchema.parse(input.projectId);
  const now = input.now ?? new Date();
  const leaseMs = leaseSchema.parse(input.leaseMs ?? DEFAULT_LEASE_MS);
  const maxConcurrent = input.maxConcurrent === undefined ? null : z.number().int().min(1).max(10).parse(input.maxConcurrent);
  return inTx(async (db) => {
    const cand = await db.query(
      `SELECT j.id, j.run_id, j.project_id FROM jobs j
         JOIN runs r ON r.id = j.run_id AND r.status = 'QUEUED'
         JOIN tasks t ON t.id = j.task_id
         LEFT JOIN project_settings ps ON ps.project_id = j.project_id
        WHERE j.status = 'QUEUED' AND j.available_at <= $1 AND ($2::text IS NULL OR j.project_id = $2)
          AND (COALESCE($3::int, ps.max_concurrent_runs) IS NULL
               OR (SELECT count(*) FROM jobs l WHERE l.project_id = j.project_id AND l.status = 'LEASED') < COALESCE($3::int, ps.max_concurrent_runs))
        ORDER BY j.seq LIMIT 1
        FOR UPDATE OF j, t SKIP LOCKED`, [now, projectId, maxConcurrent]);
    if (!cand.rows[0]) return null;
    const lim = await db.query('SELECT COALESCE($2::int, (SELECT max_concurrent_runs FROM project_settings WHERE project_id=$1)) AS n', [cand.rows[0].project_id, maxConcurrent]);
    if (lim.rows[0].n !== null) {   // serialize claimers of one project, then count again: two workers never exceed the limit together
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`claim:${cand.rows[0].project_id}`]);
      const n = Number((await db.query("SELECT count(*)::int AS n FROM jobs WHERE project_id=$1 AND status='LEASED'", [cand.rows[0].project_id])).rows[0].n);
      if (n >= lim.rows[0].n) return null;
    }
    const upd = await db.query(
      `UPDATE jobs SET status='LEASED', lease_owner=$2, lease_until=$3, heartbeat_at=$4, claims=claims+1 WHERE id=$1 RETURNING *`,
      [cand.rows[0].id, workerId, leaseUntil(now, leaseMs), now]);
    const { task, run } = await startRunInTx(db, cand.rows[0].run_id, workerId);
    return { job: mapJob(upd.rows[0]), run, task };
  });
}

/** Loads the job with the task locked first (lock order), and checks the lease. Anything but a live lease of this worker is LEASE_LOST. */
async function leasedJob(db: Db, jobId: string, workerId: string, now: Date): Promise<ReturnType<typeof mapJob>> {
  const found = await db.query('SELECT task_id FROM jobs WHERE id=$1', [jobId]);
  if (!found.rows[0]) throw new QueueError('NOT_FOUND', 'Job not found');
  await lockTask(db, found.rows[0].task_id);
  const job = mapJob((await db.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0]);
  if (job.status !== 'LEASED' || job.leaseOwner !== workerId || !job.leaseUntil || isLeaseExpired(job.leaseUntil, now)) {
    throw new QueueError('LEASE_LOST', 'The lease of this job is not held by this worker');
  }
  return job;
}

export async function heartbeatJob(input: { jobId: string; workerId: string; now?: Date; leaseMs?: number }): Promise<Job> {
  const jobId = idSchema.parse(input.jobId);
  const workerId = workerSchema.parse(input.workerId);
  const now = input.now ?? new Date();
  const leaseMs = leaseSchema.parse(input.leaseMs ?? DEFAULT_LEASE_MS);
  return inTx(async (db) => {
    await leasedJob(db, jobId, workerId, now);
    const r = await db.query('UPDATE jobs SET heartbeat_at=$2, lease_until=$3 WHERE id=$1 RETURNING *', [jobId, now, leaseUntil(now, leaseMs)]);
    return mapJob(r.rows[0]);
  });
}

export async function completeJob(input: {
  jobId: string; workerId: string; status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'; actor?: string; providerId?: string; modelId?: string;
  policyVersion?: string; budget?: unknown; evidence?: string[]; blockReason?: 'budget'; now?: Date;
}): Promise<{ task: Task; run: Run; job: Job }> {
  const jobId = idSchema.parse(input.jobId);
  const workerId = workerSchema.parse(input.workerId);
  if (!['SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(input.status)) throw new QueueError('INVALID_STATUS', 'A worker can report SUCCEEDED, FAILED or TIMED_OUT only');
  const now = input.now ?? new Date();
  return inTx(async (db) => {
    const job = await leasedJob(db, jobId, workerId, now);
    const { task, run } = await finishRunInTx(db, {
      runId: job.runId, status: input.status, actor: input.actor ?? workerId, providerId: input.providerId, modelId: input.modelId,
      policyVersion: input.policyVersion, budget: input.budget, evidence: input.evidence, blockReason: input.blockReason,
    });
    return { task, run, job: mapJob((await db.query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0]) };
  });
}

/** Run -> ABANDONED, Task -> BLOCKED(recovery), job -> ABANDONED for every expired lease. One transaction per job; concurrent callers never take the same job. */
export async function recoverExpired(input: { projectId?: string; now?: Date; actor?: string } = {}): Promise<Array<{ jobId: string; runId: string; taskId: string }>> {
  const projectId = input.projectId === undefined ? null : idSchema.parse(input.projectId);
  const now = input.now ?? new Date();
  const actor = workerSchema.parse(input.actor ?? 'system');
  const out: Array<{ jobId: string; runId: string; taskId: string }> = [];
  for (;;) {
    const one = await inTx(async (db) => {
      const r = await db.query(
        `SELECT j.id, j.run_id, j.task_id FROM jobs j JOIN tasks t ON t.id = j.task_id
          WHERE j.status = 'LEASED' AND j.lease_until <= $1 AND ($2::text IS NULL OR j.project_id = $2)
          ORDER BY j.seq LIMIT 1
          FOR UPDATE OF j, t SKIP LOCKED`, [now, projectId]);
      if (!r.rows[0]) return null;
      await finishRunInTx(db, { runId: r.rows[0].run_id, status: 'ABANDONED', actor });
      return { jobId: r.rows[0].id as string, runId: r.rows[0].run_id as string, taskId: r.rows[0].task_id as string };
    });
    if (!one) return out;
    out.push(one);
  }
}
