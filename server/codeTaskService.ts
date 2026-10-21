import crypto from 'node:crypto';
import { z } from 'zod';
import { getPool } from './database.ts';
import { getProject } from './projectRepository.ts';
import { getTask, inTx, lockTask, type Db } from './taskService.ts';
import { readArtifact, saveArtifact, sha256Hex } from './artifactRepository.ts';
import JSZip from 'jszip';
import {
  CODE_EXECUTOR_IDS, CodeExecutorError, applyFileDiff, buildPackageMd, canExecutorTransition, countChanges, createManualExecutor, createModelPatchExecutor, modelPatchToBranchChanges, packageHash, parseUnifiedDiff,
  taskPackageSchema, findSecretRules, validateChangeSet, validateGeneratedSource, validateModelPatch, type ChangeFile, type CodeExecutor, type CodeExecutorId, type ExecutorState, type ModelPatch, type TaskPackage, type Violation,
} from './codeExecutor.ts';
import {
  commitChangesToBranch, commitTaskPackage, compareToBase, diffUploadEnabled, findPullRequestByBranch, githubConfigFromEnv, githubWritesEnabled, openPullRequest, readBranchHead, readPullRequest, readTextFile,
  taskBranchName, type BranchChange, type ComparedFile, type GitHubAppConfig,
} from './githubIntegration.ts';
import { packageAcceptancePaths } from './briefWriter.ts';
import { buildReviewFindings, type ReviewFindings } from './reviewer.ts';
import { getTaskGates, recordApproval } from './gateService.ts';
import { buildDiagnosticReport, buildRepairPrompt, classifyFailure, evaluateRepairStop, type RepairAttempt, type StopReason } from './repairLoop.ts';

// Code Delivery, executor side (TZ 11.3-11.5; P18 / BX-21.a). A human starts a `manual` run for a task with a Task Package, takes PACKAGE.md
// into any tool and returns a PR, a branch or a unified diff. Nothing here runs code or calls a model. Merge is never done by this module.
// P21 / BX-22.b: reviewer findings + human decision (accept | repair | reject) on DELIVERED runs.
const STATUS = {
  NOT_FOUND: 404, HUMAN_REQUIRED: 403, VALIDATION: 400, PACKAGE_INVALID: 400, PACKAGE_SECRET: 400, PACKAGE_TOO_LARGE: 400, APPROVAL_REQUIRED: 409,
  EXECUTOR_UNAVAILABLE: 409, CODE_TASK_ACTIVE: 409, CODE_TASK_CLOSED: 409, TASK_NOT_ACTIVE: 409, BUDGET_EXCEEDED: 409, GITHUB_NOT_CONFIGURED: 503,
  DIFF_UPLOAD_DISABLED: 409, PR_MISMATCH: 409, PR_NOT_OPEN: 409, BRANCH_MISMATCH: 409, BRANCH_NOT_FOUND: 404, GITHUB_ERROR: 502, ARTIFACT_ERROR: 409,
  DECISION_REQUIRED: 409, DECISION_EXISTS: 409, HIGH_FINDINGS: 409, NOT_DELIVERED: 409, REPAIR_NOT_TRIGGERED: 409, NOT_LATEST: 409,
  MODEL_CALLER_MISSING: 503, MODEL_PATCH_INVALID: 400, EXECUTOR_MISMATCH: 409,
} as const;
export type CodeTaskErrorCode = keyof typeof STATUS;
export class CodeTaskError extends Error {
  readonly status: number;
  readonly code: CodeTaskErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: CodeTaskErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message); this.name = 'CodeTaskError'; this.code = code; this.details = details; this.status = STATUS[code] ?? 400;
  }
}

export interface CodeTaskDeps {
  githubConfig?: () => GitHubAppConfig | null;
  fetcher?: typeof fetch;
  /** Diff upload writes to GitHub (11.7): off unless GITHUB_DIFF_UPLOAD=true. */
  diffUpload?: () => boolean;
  /**
   * P19x: injectable model call for `model_patch`. Receives PACKAGE.md text and the Task Package;
   * must return a structured model_patch JSON object (or throw). Production wires Router + confirmed json_output;
   * tests inject a fake. When absent, driveModelPatch fails with MODEL_CALLER_MISSING.
   */
  modelCaller?: (input: { packageMd: string; pkg: TaskPackage; taskId: string; projectId: string }) => Promise<unknown>;
  /** Product-facing small-program flow: deliver the validated ZIP only; never write user code into BiForge's own repository. */
  sourceOnly?: boolean;
}

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const noteSchema = z.string().trim().max(500);
const newId = () => `code_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
const OPEN_STATES = ['WAITING_HUMAN', 'RUNNING', 'BLOCKED'] as const;
const requireHuman = (kind: unknown) => { if (kind !== 'human') throw new CodeTaskError('HUMAN_REQUIRED', 'Code delivery is a human action'); };
const BASE_BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const baseBranchSchema = z.string().refine((b) => BASE_BRANCH_RE.test(b) && !b.startsWith('biforge/') && !b.includes('..') && !b.startsWith('/') && !b.endsWith('/'), 'invalid base branch');

function expectedBranchOf(taskId: unknown): string | null {
  try { return taskBranchName(String(taskId)); } catch { return null; }
}
const mapCodeTask = (r: any) => ({
  id: r.id as string, projectId: r.project_id as string, taskId: r.task_id as string, runId: (r.run_id ?? null) as string | null, attempt: r.attempt as number,
  executor: r.executor as CodeExecutorId, status: r.status as ExecutorState, delivery: (r.delivery ?? null) as 'pr' | 'branch' | 'diff' | null,
  baseBranch: r.base_branch as string, branch: (r.branch ?? null) as string | null, headSha: (r.head_sha ?? null) as string | null,
  prNumber: (r.pr_number ?? null) as number | null, prUrl: (r.pr_url ?? null) as string | null, executorNote: (r.executor_note ?? null) as string | null,
  filesChanged: (r.files_changed ?? null) as number | null, linesChanged: (r.lines_changed ?? null) as number | null,
  statusReason: (r.status_reason ?? null) as string | null, violations: (r.violations ?? []) as Violation[],
  packageHash: r.package_hash as string, packageArtifactId: (r.package_artifact_id ?? null) as string | null, packageArtifactVersion: (r.package_artifact_version ?? null) as number | null,
  packageApprovedAt: (r.package_approved_at ?? null) as Date | null,
  packageApprovedBy: (r.package_approved_by ?? null) as string | null,
  packageBranchSha: (r.package_branch_sha ?? null) as string | null,
  decision: (r.decision ?? null) as 'accept' | 'repair' | 'reject' | null,
  decisionReason: (r.decision_reason ?? null) as string | null,
  decisionAt: (r.decision_at ?? null) as Date | null,
  reviewFindings: (r.review_findings ?? null) as ReviewFindings | null,
  repairOf: (r.repair_of ?? null) as string | null,
  diffHash: (r.diff_hash ?? null) as string | null,
  errorSignature: (r.error_signature ?? null) as string | null,
  failingTests: (r.failing_tests ?? null) as number | null,
  failureKind: (r.failure_kind ?? null) as string | null,
  ciRestarts: Number(r.ci_restarts ?? 0),
  repairStopReasons: (r.repair_stop_reasons ?? null) as StopReason[] | null,
  diagnosticArtifactId: (r.diagnostic_artifact_id ?? null) as string | null,
  // P54: the branch the pull request must come from, so the page can say it exactly. Null for an id that cannot form a branch.
  expectedBranch: expectedBranchOf(r.task_id),
  createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
});
export type CodeTask = ReturnType<typeof mapCodeTask>;

async function audit(db: Db, projectId: string, type: string, details: Record<string, unknown>) {
  await db.query('INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)',
    [`audit_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`, projectId, type, 'human', JSON.stringify(details)]);
}

function parsePackage(input: unknown): TaskPackage {
  const r = taskPackageSchema.safeParse(input);
  if (!r.success) throw new CodeTaskError('PACKAGE_INVALID', 'The Task Package does not match the schema', { issues: r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) });
  return r.data;
}
function renderPackage(taskId: string, pkg: TaskPackage): string {
  try { return buildPackageMd(taskId, pkg); }
  catch (e) { if (e instanceof CodeExecutorError) throw new CodeTaskError(e.code as CodeTaskErrorCode, e.message, e.details); throw e; }
}

/** P19: `model_patch` is available only when CODE_EXECUTOR=model_patch (ADR-10 interim; final enablement after E-01). Passport may request it; otherwise default manual. */
function selectExecutorId(passportExecutor: unknown): CodeExecutorId {
  const requested = (CODE_EXECUTOR_IDS as readonly string[]).includes(passportExecutor as string) ? (passportExecutor as CodeExecutorId) : 'manual';
  if (requested === 'model_patch') {
    if (process.env.CODE_EXECUTOR !== 'model_patch') {
      throw new CodeTaskError('EXECUTOR_UNAVAILABLE', 'model_patch is disabled; set CODE_EXECUTOR=model_patch after E-01 / ADR-10 approval, or use manual', { executor: 'model_patch' });
    }
    return 'model_patch';
  }
  return 'manual';
}

/** max_code_tasks (TZ 8.4): project scope counts tasks that have code runs, task scope counts executor runs of the task. */
async function checkCodeTaskBudget(db: Db, projectId: string, taskId: string) {
  const limit = async (scope: 'project' | 'task', scopeId: string): Promise<number | null> => {
    const r = (await db.query('SELECT limits FROM budgets WHERE project_id=$1 AND scope=$2 AND scope_id=$3', [projectId, scope, scopeId])).rows[0];
    const v = r?.limits?.max_code_tasks;
    return typeof v === 'number' ? v : null;
  };
  const pl = await limit('project', projectId);
  if (pl !== null) {
    const used = Number((await db.query('SELECT count(DISTINCT task_id)::int AS n FROM code_tasks WHERE project_id=$1', [projectId])).rows[0].n);
    const has = Number((await db.query('SELECT count(*)::int AS n FROM code_tasks WHERE task_id=$1', [taskId])).rows[0].n) > 0;
    if (!has && used + 1 > pl) throw new CodeTaskError('BUDGET_EXCEEDED', 'The code task budget of the project is used up; a human must raise it', { scope: 'project', limit: pl, used });
  }
  const tl = await limit('task', taskId);
  if (tl !== null) {
    const used = Number((await db.query('SELECT count(*)::int AS n FROM code_tasks WHERE task_id=$1', [taskId])).rows[0].n);
    if (used + 1 > tl) throw new CodeTaskError('BUDGET_EXCEEDED', 'The code task budget of the task is used up; a human must raise it', { scope: 'task', limit: tl, used });
  }
}

// ---- start ----
export async function startCodeTask(input: { projectId: string; taskId: string; package: unknown; baseBranch?: string; actorKind: string }, deps: CodeTaskDeps = {}): Promise<{ codeTask: CodeTask; created: boolean }> {
  requireHuman(input.actorKind);
  const projectId = idSchema.parse(input.projectId), taskId = idSchema.parse(input.taskId);
  const baseBranch = baseBranchSchema.parse(input.baseBranch ?? 'main');
  const pkg = parsePackage(input.package);
  if (pkg.sensitivity === 'high') throw new CodeTaskError('APPROVAL_REQUIRED', 'Handing a package with sensitivity high to an external tool needs a separate approval (TZ 13.6); use a normal package or an explicit approval flow when provided');
  const md = renderPackage(taskId, pkg);
  const hash = packageHash(pkg);
  const project = await getProject(projectId);
  if (!project) throw new CodeTaskError('NOT_FOUND', 'Project not found');
  const executorId = selectExecutorId((project.state as any)?.passport?.executor);
  const task = await getTask(taskId);
  if (!task || task.projectId !== projectId) throw new CodeTaskError('NOT_FOUND', 'Task not found');
  if (task.state === 'CANCELLED') throw new CodeTaskError('TASK_NOT_ACTIVE', 'The task is cancelled');

  let artifact: { artifactId: string; version: number };
  try {
    artifact = await saveArtifact({ projectId, artifactId: `pkg_${sha256Hex(Buffer.from(taskId)).slice(0, 40)}`, filename: 'PACKAGE.md', mime: 'text/markdown', text: md, createdBy: 'biforge:code_executor', derivedFrom: [`task:${taskId}`] });
  } catch (e) {
    if ((e as Error)?.name === 'ArtifactFormatError') throw new CodeTaskError('ARTIFACT_ERROR', 'PACKAGE.md could not be stored as an artifact', { reason: (e as any).code ?? null });
    throw e;
  }

  try {
    const started = await inTx(async (db) => {
      const locked = await lockTask(db, taskId);
      if (locked.projectId !== projectId) throw new CodeTaskError('NOT_FOUND', 'Task not found');
      const open = (await db.query(`SELECT * FROM code_tasks WHERE task_id=$1 AND status = ANY($2::text[]) ORDER BY attempt DESC LIMIT 1`, [taskId, [...OPEN_STATES]])).rows[0];
      if (open) {
        if (open.package_hash === hash && open.executor === executorId && open.base_branch === baseBranch && open.status !== 'RUNNING') return { codeTask: mapCodeTask(open), created: false };
        throw new CodeTaskError('CODE_TASK_ACTIVE', 'This task already has an open code run; finish or cancel it first', { codeTaskId: open.id, status: open.status });
      }
      await checkCodeTaskBudget(db, projectId, taskId);
      const attempt = Number((await db.query('SELECT COALESCE(max(attempt),0)::int + 1 AS n FROM code_tasks WHERE task_id=$1', [taskId])).rows[0].n);
      const executor = executorFor(executorId, {
        async createWaiting(ref, run, ex) {
          const id = newId();
          await db.query(
            `INSERT INTO code_tasks(id,project_id,task_id,run_id,attempt,executor,status,base_branch,package_hash,package,package_artifact_id,package_artifact_version)
             VALUES($1,$2,$3,$4,$5,$6,'WAITING_HUMAN',$7,$8,$9::jsonb,$10,$11)`,
            [id, ref.projectId, ref.taskId, run.runId, run.attempt, ex, ref.baseBranch, ref.packageHash, JSON.stringify(pkg), artifact.artifactId, artifact.version]);
          return { codeTaskId: id };
        },
        async read() { return null; },
      });
      const handle = await executor.start({ taskId, projectId, packageHash: hash, baseBranch }, { runId: null, attempt });
      await audit(db, projectId, 'code_task.started', { code_task_id: handle.codeTaskId, task_id: taskId, executor: executorId, attempt, package_hash: hash });
      return { codeTask: mapCodeTask((await db.query('SELECT * FROM code_tasks WHERE id=$1', [handle.codeTaskId])).rows[0]), created: true };
    });
    // P19x: a configured model_patch run is driven automatically after its durable row exists.
    // The default/manual executor path is unchanged; this never merges or deploys.
    if (started.created && started.codeTask.executor === 'model_patch' && deps.modelCaller) {
      try {
        const codeTask = await driveModelPatch({ projectId, taskId, codeTaskId: started.codeTask.id }, deps);
        return { codeTask, created: true };
      } catch (driveError) {
        // Delivery can be blocked after source generation (for example, missing GitHub credentials).
        // Return the durable task status so the caller can still offer a validated source bundle.
        const current = await getCodeTask(projectId, taskId, started.codeTask.id).catch(() => null);
        if (current && ['BLOCKED', 'FAILED', 'DELIVERED'].includes(current.status)) return { codeTask: current, created: true };
        throw driveError;
      }
    }
    return started;
  } catch (e: any) {
    if (e?.code === '23505') throw new CodeTaskError('CODE_TASK_ACTIVE', 'This task already has an open code run');
    throw e;
  }
}

function executorFor(id: CodeExecutorId, store: Parameters<typeof createManualExecutor>[0]): CodeExecutor {
  if (id === 'model_patch') return createModelPatchExecutor(store);
  return createManualExecutor(store);
}

// ---- reads ----
async function loadRow(db: Db, projectId: string, taskId: string, codeTaskId: string, lock = false) {
  const r = (await db.query(`SELECT * FROM code_tasks WHERE id=$1 AND project_id=$2 AND task_id=$3${lock ? ' FOR UPDATE' : ''}`, [idSchema.parse(codeTaskId), idSchema.parse(projectId), idSchema.parse(taskId)])).rows[0];
  if (!r) throw new CodeTaskError('NOT_FOUND', 'Code task not found');
  return r;
}
export async function listCodeTasks(projectId: string, taskId: string): Promise<CodeTask[]> {
  const pool = await getPool();
  const r = await pool.query('SELECT * FROM code_tasks WHERE project_id=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 100', [idSchema.parse(projectId), idSchema.parse(taskId)]);
  return r.rows.map(mapCodeTask);
}
/** P54: every code attempt of a project with its task title, most recently updated first (the Delivery tab groups by task). */
export async function listProjectCodeTasks(projectId: string): Promise<Array<CodeTask & { taskTitle: string }>> {
  const pool = await getPool();
  const r = await pool.query(
    'SELECT c.*, t.title AS task_title FROM code_tasks c JOIN tasks t ON t.id=c.task_id WHERE c.project_id=$1 ORDER BY c.updated_at DESC, c.attempt DESC LIMIT 200',
    [idSchema.parse(projectId)],
  );
  return r.rows.map((x) => ({ ...mapCodeTask(x), taskTitle: String(x.task_title) }));
}
export async function getCodeTask(projectId: string, taskId: string, codeTaskId: string): Promise<CodeTask> {
  return mapCodeTask(await loadRow(await getPool(), projectId, taskId, codeTaskId));
}
/** PACKAGE.md for hand-over (11.3), read from the artifact registry with its integrity check. Never committed to the repository. */

/** P20: human approves the Task Package for handoff / commit (TZ 11.3, 13.6). Required before export when sensitivity is high. */
export async function approveCodePackage(input: {
  projectId: string; taskId: string; codeTaskId: string; actorKind: string; actor?: string;
}): Promise<CodeTask> {
  requireHuman(input.actorKind);
  const actor = (input.actor || 'human').trim().slice(0, 200) || 'human';
  const row = await loadRow(await getPool(), input.projectId, input.taskId, input.codeTaskId);
  if (!['WAITING_HUMAN', 'BLOCKED'].includes(row.status)) {
    throw new CodeTaskError('CODE_TASK_CLOSED', 'Only an open code task package can be approved', { status: row.status });
  }
  const pool = await getPool();
  const upd = await pool.query(
    `UPDATE code_tasks SET package_approved_at=now(), package_approved_by=$2, updated_at=now() WHERE id=$1 RETURNING *`,
    [row.id, actor],
  );
  await inTx(async (db) => {
    await audit(db, input.projectId, 'code_task.package_approved', { code_task_id: row.id, task_id: input.taskId, actor });
  });
  return mapCodeTask(upd.rows[0]);
}

/** Paths declared in the stored package for Test Integrity baseline (P20). */
export function acceptancePathsFromCodeTaskRow(row: { package?: unknown } | any): string[] {
  try {
    const pkg = typeof row.package === 'string' ? JSON.parse(row.package) : row.package;
    if (!pkg) return [];
    return packageAcceptancePaths(pkg as TaskPackage);
  } catch { return []; }
}

/**
 * P20: commit approved package files to biforge/<task_id> when GitHub writes are enabled.
 * PACKAGE.md stays an artifact only (not committed). Acceptance tests from the package become the integrity baseline.
 */
export async function commitApprovedPackage(input: {
  projectId: string; taskId: string; codeTaskId: string; actorKind: string;
}, deps: CodeTaskDeps = {}): Promise<{ codeTask: CodeTask; branch: string; commitShas: string[] }> {
  requireHuman(input.actorKind);
  const row = await loadRow(await getPool(), input.projectId, input.taskId, input.codeTaskId);
  if (!row.package_approved_at) {
    throw new CodeTaskError('APPROVAL_REQUIRED', 'Approve the package before committing it to the task branch');
  }
  const writeOn = deps.diffUpload?.() ?? githubWritesEnabled();
  if (!writeOn) {
    throw new CodeTaskError('DIFF_UPLOAD_DISABLED', 'GitHub writes are off; set GITHUB_DIFF_UPLOAD=true (or enable model_patch writes) to commit the package');
  }
  const cfg = deps.githubConfig?.() ?? githubConfigFromEnv();
  if (!cfg) throw new CodeTaskError('GITHUB_NOT_CONFIGURED', 'GitHub App is not configured');
  const pkg = row.package as TaskPackage;
  const taskId = row.task_id as string;
  const files: Array<{ path: string; content: string }> = [
    { path: `.biforge/tasks/${taskId}/SPEC.md`, content: pkg.specMd },
    { path: `.biforge/tasks/${taskId}/ACCEPTANCE.md`, content: pkg.acceptanceMd },
    { path: `.biforge/tasks/${taskId}/EXECUTOR_PROMPT.md`, content: pkg.executorPromptMd },
    { path: 'AGENTS.md', content: pkg.agentsMd },
    ...pkg.acceptanceTests.map((f) => ({ path: f.path, content: f.content })),
  ];
  try {
    const out = await commitTaskPackage(cfg, {
      taskId,
      baseBranch: row.base_branch,
      files,
      message: `Task Package ${taskId} (approved)`,
      writeEnabled: true,
    }, deps.fetcher);
    const lastSha = out.commitShas.filter(Boolean).pop() || null;
    const pool = await getPool();
    const upd = await pool.query(
      `UPDATE code_tasks SET package_branch_sha=COALESCE($2, package_branch_sha), branch=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, lastSha, out.branch],
    );
    await inTx(async (db) => {
      await audit(db, input.projectId, 'code_task.package_committed', { code_task_id: row.id, branch: out.branch, commits: out.commitShas.length });
    });
    return { codeTask: mapCodeTask(upd.rows[0]), branch: out.branch, commitShas: out.commitShas };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('github_write_disabled')) throw new CodeTaskError('DIFF_UPLOAD_DISABLED', msg);
    throw new CodeTaskError('GITHUB_ERROR', msg.slice(0, 200));
  }
}

export async function exportPackage(projectId: string, taskId: string, codeTaskId: string, actorKind: string): Promise<{ filename: string; text: string; hash: string; packageHash: string }> {
  requireHuman(actorKind);
  const row = await loadRow(await getPool(), projectId, taskId, codeTaskId);
  const pkgExp = row.package as TaskPackage;
  if (pkgExp?.sensitivity === 'high' && !row.package_approved_at) {
    throw new CodeTaskError('APPROVAL_REQUIRED', 'Approve this high-sensitivity package before export (TZ 13.6)');
  }
  let text: string;
  try {
    const a = row.package_artifact_id ? await readArtifact(row.package_artifact_id, row.package_artifact_version ?? undefined) : null;
    text = a ? a.text : renderPackage(taskId, row.package as TaskPackage);
  } catch (e) {
    if ((e as any)?.code === 'INTEGRITY') throw new CodeTaskError('ARTIFACT_ERROR', 'PACKAGE.md failed its integrity check', { problems: (e as any).problems ?? [] });
    throw e;
  }
  return { filename: 'PACKAGE.md', text, hash: sha256Hex(Buffer.from(text, 'utf8')), packageHash: row.package_hash };
}

// ---- state writes (always with the row locked, the transition checked) ----
async function settle(
  codeTaskId: string,
  to: 'DELIVERED' | 'BLOCKED' | 'FAILED',
  fields: { delivery?: 'pr' | 'branch' | 'diff'; branch?: string; headSha?: string; prNumber?: number | null; prUrl?: string | null; files?: number; lines?: number; note?: string | null; reason?: string; violations?: Violation[] },
  opts: { from?: ExecutorState[]; event: string; extra?: Record<string, unknown> },
): Promise<CodeTask> {
  return inTx(async (db) => {
    const row = (await db.query('SELECT * FROM code_tasks WHERE id=$1 FOR UPDATE', [codeTaskId])).rows[0];
    if (!row) throw new CodeTaskError('NOT_FOUND', 'Code task not found');
    const allowedFrom = opts.from ?? ['WAITING_HUMAN', 'BLOCKED'];
    if (!allowedFrom.includes(row.status) || !canExecutorTransition(row.status, to)) throw new CodeTaskError('CODE_TASK_CLOSED', 'The code run is not open for this change', { status: row.status });
    const upd = await db.query(
      `UPDATE code_tasks SET status=$2, delivery=COALESCE($3,delivery), branch=COALESCE($4,branch), head_sha=COALESCE($5,head_sha),
              pr_number=COALESCE($6,pr_number), pr_url=COALESCE($7,pr_url), files_changed=COALESCE($8,files_changed), lines_changed=COALESCE($9,lines_changed),
              executor_note=COALESCE($10,executor_note), status_reason=$11, violations=$12::jsonb, updated_at=now() WHERE id=$1 RETURNING *`,
      [codeTaskId, to, fields.delivery ?? null, fields.branch ?? null, fields.headSha ?? null, fields.prNumber ?? null, fields.prUrl ?? null, fields.files ?? null, fields.lines ?? null,
        fields.note ?? null, to === 'DELIVERED' ? null : (fields.reason ?? null), JSON.stringify(to === 'DELIVERED' ? [] : (fields.violations ?? []))]);
    await audit(db, row.project_id, opts.event, { code_task_id: codeTaskId, task_id: row.task_id, to, delivery: fields.delivery ?? null, files: fields.files ?? null, lines: fields.lines ?? null,
      violations: (fields.violations ?? []).map((v) => v.code).slice(0, 20), ...(opts.extra ?? {}) });
    return mapCodeTask(upd.rows[0]);
  });
}
const blockRow = (id: string, reason: string, violations: Violation[], delivery?: 'pr' | 'branch' | 'diff', from?: ExecutorState[]) =>
  settle(id, 'BLOCKED', { reason, violations, ...(delivery ? { delivery } : {}) }, { event: 'code_task.blocked', ...(from ? { from } : {}) });

function changeSetFromCompare(c: { files: ComparedFile[]; truncated: boolean }): { files: ChangeFile[]; extra: Violation[] } {
  const files: ChangeFile[] = [], extra: Violation[] = [];
  if (c.truncated) extra.push({ code: 'diff_truncated' });
  for (const f of c.files) {
    if (f.status === 'renamed' && f.previous_filename) {
      files.push({ path: f.filename, action: 'create', added: f.additions, removed: f.deletions }, { path: f.previous_filename, action: 'delete', added: 0, removed: 0 });
    } else files.push({ path: f.filename, action: f.status === 'added' || f.status === 'copied' ? 'create' : f.status === 'removed' ? 'delete' : 'modify', added: f.additions, removed: f.deletions });
    if ((f.status === 'added' || f.status === 'modified' || f.status === 'changed') && !f.hasPatch) extra.push({ code: 'binary_or_unreadable', path: f.filename.slice(0, 200) });
  }
  return { files, extra };
}

function githubFor(deps: CodeTaskDeps): { cfg: GitHubAppConfig; fetcher: typeof fetch } {
  const cfg = (deps.githubConfig ?? githubConfigFromEnv)();
  if (!cfg) throw new CodeTaskError('GITHUB_NOT_CONFIGURED', 'GitHub is not configured (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_REPOSITORY_OWNER, GITHUB_REPOSITORY_NAME)');
  return { cfg, fetcher: deps.fetcher ?? fetch };
}
const githubFailure = (e: unknown): CodeTaskError => {
  if (e instanceof CodeTaskError) return e;
  const msg = String((e as Error)?.message || e).slice(0, 100);
  return new CodeTaskError('GITHUB_ERROR', 'GitHub refused or could not answer', { reason: /^[a-z0-9_:-]+$/i.test(msg) ? msg : 'github_error' });
};

/** Validates a branch or PR against the package (11.4 items 1 to 4 as far as the GitHub file list shows them) and settles the code task. */
async function deliverBranch(row: any, input: { delivery: 'pr' | 'branch'; branch: string; baseBranch: string; head: string; prNumber?: number; prUrl?: string | null; note?: string | null; extra?: Violation[] }, deps: CodeTaskDeps): Promise<CodeTask> {
  const { cfg, fetcher } = githubFor(deps);
  let compared;
  try { compared = await compareToBase(cfg, row.base_branch, input.head, fetcher); } catch (e) { throw githubFailure(e); }
  const { files, extra } = changeSetFromCompare(compared);
  const pkg = row.package as TaskPackage;
  const violations = [...(input.extra ?? []), ...validateChangeSet(files, { allowedPaths: pkg.allowedPaths, limits: pkg.limits }), ...extra];
  if (violations.length) return blockRow(row.id, 'validation_failed', violations.slice(0, 100), input.delivery);
  const { filesChanged, linesChanged } = countChanges(files);
  return settle(row.id, 'DELIVERED', { delivery: input.delivery, branch: input.branch, headSha: compared.headSha, prNumber: input.prNumber ?? null, prUrl: input.prUrl ?? null, files: filesChanged, lines: linesChanged, note: input.note ?? null },
    { event: 'code_task.delivered' });
}

export type CodeResultInput =
  | { kind: 'pr'; prNumber: number; note?: string }
  | { kind: 'branch'; branch: string; note?: string }
  | { kind: 'diff'; diff: string; title?: string; note?: string };

/** The human returns the result of the external tool: a PR, a branch or a unified diff (11.4, `manual`). */
export async function submitCodeResult(input: { projectId: string; taskId: string; codeTaskId: string; result: CodeResultInput; actorKind: string }, deps: CodeTaskDeps = {}): Promise<CodeTask> {
  requireHuman(input.actorKind);
  const row = await loadRow(await getPool(), input.projectId, input.taskId, input.codeTaskId);
  if (row.status !== 'WAITING_HUMAN' && row.status !== 'BLOCKED') throw new CodeTaskError('CODE_TASK_CLOSED', 'The code run is not waiting for a result', { status: row.status });
  const note = input.result.note === undefined ? null : noteSchema.parse(input.result.note);
  const expectedBranch = taskBranchName(row.task_id);

  if (input.result.kind === 'pr') {
    const { cfg, fetcher } = githubFor(deps);
    let pr;
    try { pr = await readPullRequest(cfg, input.result.prNumber, fetcher); } catch (e) { throw githubFailure(e); }
    if (pr.headRef !== expectedBranch) throw new CodeTaskError('PR_MISMATCH', 'The pull request must come from the task branch', { expected_branch: expectedBranch });
    if (pr.state !== 'open' || pr.merged) throw new CodeTaskError('PR_NOT_OPEN', 'The pull request is not open');
    const extra: Violation[] = pr.baseRef !== row.base_branch ? [{ code: 'base_branch_mismatch' }] : [];
    return deliverBranch(row, { delivery: 'pr', branch: expectedBranch, baseBranch: row.base_branch, head: pr.headSha, prNumber: pr.number, prUrl: pr.htmlUrl ?? null, note, extra }, deps);
  }

  if (input.result.kind === 'branch') {
    if (input.result.branch !== expectedBranch) throw new CodeTaskError('BRANCH_MISMATCH', 'The branch must be the task branch', { expected_branch: expectedBranch });
    const { cfg, fetcher } = githubFor(deps);
    let head: string | null;
    try { head = await readBranchHead(cfg, expectedBranch, fetcher); } catch (e) { throw githubFailure(e); }
    if (!head) throw new CodeTaskError('BRANCH_NOT_FOUND', 'The task branch does not exist in the repository');
    return deliverBranch(row, { delivery: 'branch', branch: expectedBranch, baseBranch: row.base_branch, head, note }, deps);
  }

  return deliverDiff(row, input.result, note, deps);
}

async function deliverDiff(row: any, result: { diff: string; title?: string }, note: string | null, deps: CodeTaskDeps): Promise<CodeTask> {
  if (!(deps.diffUpload ?? diffUploadEnabled)()) throw new CodeTaskError('DIFF_UPLOAD_DISABLED', 'Diff upload is switched off (GITHUB_DIFF_UPLOAD); return a PR or a branch instead');
  const pkg = row.package as TaskPackage;
  const parsed = parseUnifiedDiff(result.diff);
  const violations = [...parsed.problems, ...(parsed.problems.length ? [] : validateChangeSet(parsed.files, { allowedPaths: pkg.allowedPaths, limits: pkg.limits }))];
  if (violations.length) return blockRow(row.id, 'validation_failed', violations.slice(0, 100), 'diff');
  const { cfg, fetcher } = githubFor(deps);
  const branch = taskBranchName(row.task_id);

  // Claim the run: of two parallel uploads only one reaches GitHub.
  const claimed = await (await getPool()).query(`UPDATE code_tasks SET status='RUNNING', updated_at=now() WHERE id=$1 AND status IN ('WAITING_HUMAN','BLOCKED') RETURNING id`, [row.id]).catch((e: any) => {
    if (e?.code === '23505') throw new CodeTaskError('CODE_TASK_ACTIVE', 'This task already has an open code run');
    throw e;
  });
  if (!claimed.rows[0]) throw new CodeTaskError('CODE_TASK_CLOSED', 'The code run is not waiting for a result');
  const fromRunning = ['RUNNING'] as ExecutorState[];

  let changes: BranchChange[];
  let headSha: string, prNumber: number | null = null, prUrl: string | null = null;
  try {
    const existingHead = await readBranchHead(cfg, branch, fetcher);
    const ref = existingHead ?? row.base_branch;
    changes = [];
    for (const f of parsed.files) {
      const original = await readTextFile(cfg, f.path, ref, fetcher);
      try { const text = applyFileDiff(original, f); changes.push({ path: f.path, content: text }); }
      catch (e) {
        if (e instanceof CodeExecutorError) return await blockRow(row.id, 'apply_failed', [{ code: e.code, path: f.path }], 'diff', fromRunning);
        throw e;
      }
    }
  } catch (e) {
    const err = githubFailure(e);
    await blockRow(row.id, `github_error:${String(err.details.reason ?? 'github_error')}`.slice(0, 200), [], 'diff', fromRunning);
    throw err;
  }
  const title = (result.title?.trim() || `Task ${row.task_id}`).slice(0, 200);
  try {
    ({ headSha } = await commitChangesToBranch(cfg, { taskId: row.task_id, baseBranch: row.base_branch, changes, message: title, writeEnabled: true }, fetcher));
  } catch (e) {
    const err = githubFailure(e);
    await blockRow(row.id, `github_error:${String(err.details.reason ?? 'github_error')}`.slice(0, 200), [], 'diff', fromRunning);
    throw err;
  }
  let prFailed = false;
  try {
    const pr = await openPullRequest(cfg, { taskId: row.task_id, baseBranch: row.base_branch, title, body: `BiForge task ${row.task_id}. Changes uploaded as a diff and applied by BiForge. Review and merge are human actions.`, writeEnabled: true }, fetcher);
    prNumber = pr.number; prUrl = pr.htmlUrl;
  } catch { prFailed = true; }   // the commit exists: record it; the PR is found later by webhook or refresh
  const { filesChanged, linesChanged } = countChanges(parsed.files);
  return settle(row.id, 'DELIVERED', { delivery: 'diff', branch, headSha, prNumber, prUrl, files: filesChanged, lines: linesChanged, note },
    { from: fromRunning, event: 'code_task.delivered', extra: prFailed ? { pr_open_failed: true } : {} });
}

/** Poll fallback (11.4 `manual`, a): finds the PR of the task branch and delivers it, or fills in the PR of a delivered branch. */
export async function refreshCodeTask(input: { projectId: string; taskId: string; codeTaskId: string; actorKind: string }, deps: CodeTaskDeps = {}): Promise<{ codeTask: CodeTask; changed: boolean }> {
  requireHuman(input.actorKind);
  const row = await loadRow(await getPool(), input.projectId, input.taskId, input.codeTaskId);
  if (row.status === 'FAILED' || row.status === 'RUNNING') return { codeTask: mapCodeTask(row), changed: false };
  const { cfg, fetcher } = githubFor(deps);
  const branch = taskBranchName(row.task_id);
  let pr;
  try { pr = await findPullRequestByBranch(cfg, branch, fetcher); } catch (e) { throw githubFailure(e); }
  if (!pr || pr.state !== 'open' || pr.merged) return { codeTask: mapCodeTask(row), changed: false };
  return { codeTask: await applyPullRequest(row, pr, deps), changed: true };
}

async function applyPullRequest(row: any, pr: { number: number; headSha: string; baseRef: string; htmlUrl: string | null }, deps: CodeTaskDeps): Promise<CodeTask> {
  if (row.status === 'DELIVERED') {
    const upd = await (await getPool()).query(`UPDATE code_tasks SET pr_number=COALESCE(pr_number,$2), pr_url=COALESCE(pr_url,$3), updated_at=now() WHERE id=$1 AND status='DELIVERED' RETURNING *`, [row.id, pr.number, pr.htmlUrl]);
    return mapCodeTask(upd.rows[0] ?? row);
  }
  const extra: Violation[] = pr.baseRef && pr.baseRef !== row.base_branch ? [{ code: 'base_branch_mismatch' }] : [];
  return deliverBranch(row, { delivery: 'pr', branch: taskBranchName(row.task_id), baseBranch: row.base_branch, head: pr.headSha, prNumber: pr.number, prUrl: pr.htmlUrl, extra }, deps);
}

/**
 * Called by the webhook path (P17 `pull_request`): the PR of an open task branch is found without polling.
 * Never throws; GitHub trouble leaves the run as it was, and the human can submit or refresh by hand.
 */
export async function syncCodeTaskFromPullRequest(taskId: string, pr: { number: number; headSha: string; htmlUrl?: string | null }, deps: CodeTaskDeps = {}): Promise<'none' | 'delivered' | 'blocked' | 'updated' | 'error'> {
  try {
    const pool = await getPool();
    const row = (await pool.query(`SELECT * FROM code_tasks WHERE task_id=$1 AND status IN ('WAITING_HUMAN','BLOCKED','DELIVERED') ORDER BY attempt DESC LIMIT 1`, [idSchema.parse(taskId)])).rows[0];
    if (!row || row.executor !== 'manual') return 'none';
    const out = await applyPullRequest(row, { number: pr.number, headSha: pr.headSha, baseRef: '', htmlUrl: pr.htmlUrl ?? null }, deps);
    return row.status === 'DELIVERED' ? 'updated' : out.status === 'DELIVERED' ? 'delivered' : 'blocked';
  } catch (e) {
    console.error(JSON.stringify({ type: 'code_task_sync_error', message: String((e as Error)?.message || e).slice(0, 120) }));
    return 'error';
  }
}

/** Stable artifact id for the validated generated source archive associated with a code task. */
export function generatedSourceArtifactId(codeTaskId: string): string {
  return `source_${sha256Hex(Buffer.from(idSchema.parse(codeTaskId))).slice(0, 40)}`;
}

/**
 * P19x: drive a `model_patch` code task end-to-end (TZ 11.4).
 * Claims RUNNING, calls modelCaller, validates and saves a source ZIP; generic delivery may then commit to biforge/<task_id> and open a PR, while sourceOnly stops after the ZIP. Never merges.
 * Does not merge. Writes only when GitHub write flag is on. Injectable modelCaller for tests.
 */
export async function driveModelPatch(
  input: { projectId: string; taskId: string; codeTaskId: string },
  deps: CodeTaskDeps = {},
): Promise<CodeTask> {
  const row = await loadRow(await getPool(), input.projectId, input.taskId, input.codeTaskId);
  if (row.executor !== 'model_patch') {
    throw new CodeTaskError('EXECUTOR_MISMATCH', 'driveModelPatch only runs for model_patch executor', { executor: row.executor });
  }
  if (row.status !== 'WAITING_HUMAN' && row.status !== 'BLOCKED') {
    throw new CodeTaskError('CODE_TASK_CLOSED', 'The code run is not open for model_patch drive', { status: row.status });
  }
  const writeOn = deps.diffUpload?.() ?? githubWritesEnabled();
  if (!deps.modelCaller) {
    throw new CodeTaskError('MODEL_CALLER_MISSING', 'model_patch requires an injected modelCaller (Router + json_output) or a test fake');
  }

  const claimed = await (await getPool()).query(
    `UPDATE code_tasks SET status='RUNNING', updated_at=now() WHERE id=$1 AND status IN ('WAITING_HUMAN','BLOCKED') RETURNING id`,
    [row.id],
  );
  if (!claimed.rows[0]) throw new CodeTaskError('CODE_TASK_CLOSED', 'The code run is not waiting for a result');
  const fromRunning = ['RUNNING'] as ExecutorState[];

  const pkg = row.package as TaskPackage;
  let packageMd: string;
  try {
    packageMd = buildPackageMd(row.task_id, pkg);
  } catch (e) {
    if (e instanceof CodeExecutorError) {
      return blockRow(row.id, `package_error:${e.code}`, [], undefined, fromRunning);
    }
    throw e;
  }

  let raw: unknown;
  try {
    raw = await deps.modelCaller({ packageMd, pkg, taskId: row.task_id, projectId: row.project_id });
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 200);
    return settle(row.id, 'FAILED', { reason: `model_error:${reason}` }, { from: fromRunning, event: 'code_task.failed' });
  }

  const validated = validateModelPatch(raw, { allowedPaths: pkg.allowedPaths, limits: pkg.limits });
  if (validated.ok === false) {
    return blockRow(row.id, 'validation_failed', validated.violations.slice(0, 100), 'diff', fromRunning);
  }
  const generatedSecrets = validated.patch.files.flatMap((file) => file.content === undefined ? [] : findSecretRules(file.content).map((rule) => ({ code: `generated_secret:${rule}`, path: file.path })));
  if (generatedSecrets.length) return blockRow(row.id, 'generated_source_secret_detected', generatedSecrets.slice(0, 100), 'diff', fromRunning);
  if (!validated.patch.files.some((file) => file.action !== 'delete')) return blockRow(row.id, 'generated_source_empty', [{ code: 'no_source_files' }], 'diff', fromRunning);
  const goalText = pkg.specMd.match(/## Goal\s*\n+([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? pkg.specMd;
  const staticFindings = validateGeneratedSource(validated.patch, goalText);
  if (staticFindings.length) return blockRow(row.id, 'generated_source_static_validation_failed', staticFindings.slice(0, 100), 'diff', fromRunning);

  // Preserve a downloadable, validated source bundle even when GitHub write access is not enabled.
  // The archive contains only paths accepted by validateModelPatch; it is never executed on this server.
  const bundleId = generatedSourceArtifactId(row.id);
  try {
    const zip = new JSZip();
    const outputPrefix = `generated-projects/${row.task_id}/`;
    for (const file of validated.patch.files) {
      if (file.action !== 'delete') {
        const bundlePath = file.path.startsWith(outputPrefix) ? file.path.slice(outputPrefix.length) : file.path;
        zip.file(bundlePath, file.content ?? '');
      }
    }
    const hasReadme = validated.patch.files.some((f) => f.action !== 'delete' && /(?:^|\/)readme\.md$/i.test(f.path));
    zip.file('BIFORGE-README.txt', [
      'Generated source bundle from BiForge Project Mode.',
      `Project: ${row.project_id}`, `Task: ${row.task_id}`, `Code task: ${row.id}`,
      'Review the files before running them. BiForge did not execute this generated code on its server.',
      'Static source checks were applied; runtime tests are NOT_RUN.',
      'For a standalone browser app, open index.html in a modern browser.',
      'For a Node app: copy .env.example to .env if present, install dependencies, follow README.',
      'BiForge does not push to GitHub or Render. You upload and deploy manually.',
    ].join('\n') + '\n');
    zip.file('DEPLOY-MANUAL.md', [
      '# Manual deploy (GitHub + Render / Railway)',
      '',
      '1. Unpack this ZIP on your computer.',
      '2. Read README.md if present; otherwise open the main entry (index.html or package.json scripts).',
      '3. Copy `.env.example` to `.env` when the project has server-side config. Never commit real secrets.',
      '4. Create an empty GitHub repository and upload these files (no automatic push from BiForge).',
      '5. On Render: New → Web Service → connect the repo → set Build/Start from README (often `npm install` / `npm start`).',
      '6. On Railway: New Project → Deploy from GitHub → add variables from `.env.example`.',
      '7. Open the health URL if the app exposes `/health` or `/api/health`.',
      '',
      hasReadme ? 'A README.md is included in this bundle.' : 'No README.md was generated; use this file and BIFORGE-README.txt.',
      '',
    ].join('\n'));
    const bundle = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await saveArtifact({ projectId: row.project_id, artifactId: bundleId, filename: 'generated-program.zip', mime: 'application/zip', data: new Uint8Array(bundle), createdBy: `code_task:${row.id}`, derivedFrom: [`task:${row.task_id}`, `code_task:${row.id}`] });
  } catch (e) {
    const reason = String((e as any)?.code || (e as Error)?.message || 'bundle_creation_failed').slice(0, 160);
    return settle(row.id, 'FAILED', { reason: `source_bundle_error:${reason}` }, { from: fromRunning, event: 'code_task.failed' });
  }
  if (deps.sourceOnly) {
    return blockRow(row.id, 'source_bundle_ready_github_delivery_not_requested', [], undefined, fromRunning);
  }
  if (!writeOn) {
    return blockRow(row.id, 'github_writes_disabled_bundle_available', [], undefined, fromRunning);
  }
  const changes = modelPatchToBranchChanges(validated.patch);
  const { cfg, fetcher } = githubFor(deps);
  const title = (`model_patch: ${row.task_id}`).slice(0, 200);
  let headSha: string;
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  try {
    ({ headSha } = await commitChangesToBranch(cfg, {
      taskId: row.task_id,
      baseBranch: row.base_branch,
      changes,
      message: title,
      writeEnabled: true,
    }, fetcher));
    const pr = await openPullRequest(cfg, {
      taskId: row.task_id,
      baseBranch: row.base_branch,
      title,
      body: `BiForge model_patch task ${row.task_id}. Review and merge are human actions.`,
      writeEnabled: true,
    }, fetcher);
    prNumber = pr.number;
    prUrl = pr.htmlUrl ?? null;
  } catch (e) {
    const err = githubFailure(e);
    await blockRow(row.id, `github_error:${String(err.details.reason ?? 'github_error')}`.slice(0, 200), [], 'diff', fromRunning);
    throw err;
  }

  const { filesChanged, linesChanged } = countChanges(validated.files);
  const note = validated.patch.notes ? String(validated.patch.notes).slice(0, 500) : null;
  return settle(row.id, 'DELIVERED', {
    delivery: 'diff',
    branch: taskBranchName(row.task_id),
    headSha,
    prNumber,
    prUrl,
    files: filesChanged,
    lines: linesChanged,
    note,
  }, { from: fromRunning, event: 'code_task.delivered', extra: { executor: 'model_patch' } });
}

/** The human gives up on a run (any open state, also a stuck RUNNING). A reason is required; it is stored as text and never interpreted. */
export async function cancelCodeTask(input: { projectId: string; taskId: string; codeTaskId: string; reason: string; actorKind: string }): Promise<CodeTask> {
  requireHuman(input.actorKind);
  const reason = z.string().trim().min(1).max(500).parse(input.reason);
  const row = await loadRow(await getPool(), input.projectId, input.taskId, input.codeTaskId);
  return settle(row.id, 'FAILED', { reason }, { from: [...OPEN_STATES], event: 'code_task.failed' });
}

const DECISIONS = ['accept', 'repair', 'reject'] as const;
export type CodeTaskDecision = (typeof DECISIONS)[number];

/**
 * P21 / BX-22.b: run structured reviewer on a DELIVERED code task (gates + delivery → findings).
 * Pure structure; no model call. Findings are stored on the row and audited.
 */
export async function runCodeTaskReview(input: {
  projectId: string; taskId: string; codeTaskId: string; actorKind: string; notes?: string | null;
}): Promise<{ codeTask: CodeTask; findings: ReviewFindings }> {
  requireHuman(input.actorKind);
  const pool = await getPool();
  const row = await loadRow(pool, input.projectId, input.taskId, input.codeTaskId);
  if (row.status !== 'DELIVERED') {
    throw new CodeTaskError('NOT_DELIVERED', 'Review requires a DELIVERED code task', { status: row.status });
  }
  const gatesOut = await getTaskGates(pool, row.task_id, row.head_sha ?? undefined);
  const gateList = gatesOut.gates
    ? Object.entries(gatesOut.gates).map(([gate, g]: [string, any]) => ({
        gate: gate as any,
        status: (g?.status ?? 'NOT_RUN') as any,
        reasons: Array.isArray(g?.reasons) ? g.reasons : [],
      }))
    : [];
  const findings = buildReviewFindings({
    commitSha: row.head_sha,
    delivery: row.delivery,
    filesChanged: row.files_changed,
    linesChanged: row.lines_changed,
    violations: Array.isArray(row.violations) ? row.violations : [],
    gates: gateList,
    notes: input.notes ?? null,
  });
  const upd = await pool.query(
    `UPDATE code_tasks SET review_findings=$2::jsonb, updated_at=now() WHERE id=$1 AND status='DELIVERED' RETURNING *`,
    [row.id, JSON.stringify(findings)],
  );
  if (!upd.rows[0]) throw new CodeTaskError('CODE_TASK_CLOSED', 'The code task is no longer delivered');
  await audit(pool, row.project_id, 'code_task.reviewed', {
    code_task_id: row.id, task_id: row.task_id, high_count: findings.highCount, has_unresolved_high: findings.hasUnresolvedHigh,
  });
  return { codeTask: mapCodeTask(upd.rows[0]), findings };
}

/**
 * P21: human decision on a delivered PR/branch/diff — accept | repair | reject (TZ 11.5 step 8).
 * Merge remains human-only in GitHub (11.5 step 9). Accept with unresolved high findings requires a reason.
 */
export async function decideCodeTask(input: {
  projectId: string; taskId: string; codeTaskId: string; decision: CodeTaskDecision; reason?: string | null; actorKind: string;
}): Promise<CodeTask> {
  requireHuman(input.actorKind);
  if (!(DECISIONS as readonly string[]).includes(input.decision)) {
    throw new CodeTaskError('VALIDATION', 'decision must be accept, repair or reject');
  }
  const reason = input.reason != null ? z.string().trim().max(1000).parse(input.reason) : null;
  const pool = await getPool();
  const row = await loadRow(pool, input.projectId, input.taskId, input.codeTaskId);
  if (row.status !== 'DELIVERED') {
    throw new CodeTaskError('NOT_DELIVERED', 'A decision requires a DELIVERED code task', { status: row.status });
  }
  if (row.decision) {
    throw new CodeTaskError('DECISION_EXISTS', 'A decision was already recorded for this code task', { decision: row.decision });
  }
  const findings = (row.review_findings ?? null) as ReviewFindings | null;
  if (input.decision === 'accept' && findings?.hasUnresolvedHigh && !(reason && reason.length > 0)) {
    throw new CodeTaskError('HIGH_FINDINGS', 'Accepting with unresolved high findings requires a non-empty reason', {
      high_count: findings.highCount,
    });
  }
  if ((input.decision === 'reject' || input.decision === 'repair') && !(reason && reason.length > 0)) {
    throw new CodeTaskError('VALIDATION', `${input.decision} requires a non-empty reason`);
  }

  const head = row.head_sha as string | null;
  if (head && /^[0-9a-f]{40}$/i.test(head)) {
    if (input.decision === 'accept') {
      await recordApproval(pool, {
        projectId: row.project_id, taskId: row.task_id, gate: 'review', commitSha: head,
        actor: 'human', approvalId: `code_decision_${row.id}`, status: 'PASS',
      }).catch(() => { /* head may lack prior evidence path; decision still records */ });
    } else if (input.decision === 'reject') {
      await recordApproval(pool, {
        projectId: row.project_id, taskId: row.task_id, gate: 'review', commitSha: head,
        actor: 'human', approvalId: `code_decision_${row.id}`, status: 'FAIL',
      }).catch(() => {});
    }
  }

  const upd = await pool.query(
    `UPDATE code_tasks SET decision=$2, decision_reason=$3, decision_at=now(), updated_at=now()
     WHERE id=$1 AND status='DELIVERED' AND decision IS NULL RETURNING *`,
    [row.id, input.decision, reason],
  );
  if (!upd.rows[0]) throw new CodeTaskError('DECISION_EXISTS', 'A decision was already recorded for this code task');
  await audit(pool, row.project_id, 'code_task.decision', {
    code_task_id: row.id, task_id: row.task_id, decision: input.decision, reason: reason ?? null,
  });
  return mapCodeTask(upd.rows[0]);
}

const SHA64 = /^[0-9a-f]{64}$/i;

/**
 * P22 / BX-23: Repair Loop on the latest DELIVERED code run.
 * One flaky CI restart does not open a new executor run. Otherwise classify the failure,
 * stop with a diagnostic artifact, or open the next manual PACKAGE.md.
 */
export async function requestRepair(input: {
  projectId: string; taskId: string; codeTaskId: string; actorKind: string;
  trigger?: 'ci' | 'reviewer' | 'human';
  flaky?: boolean;
  diffHash?: string | null;
  failingTests?: number | null;
  logExcerpt?: string | null;
  links?: string[];
}): Promise<{ action: 'ci_restart' | 'repair_started' | 'stopped'; codeTask: CodeTask; child?: CodeTask; reasons?: StopReason[]; diagnostic?: string }> {
  requireHuman(input.actorKind);
  const pool = await getPool();
  const row = await loadRow(pool, input.projectId, input.taskId, input.codeTaskId);
  if (row.status !== 'DELIVERED') throw new CodeTaskError('NOT_DELIVERED', 'Repair requires a DELIVERED code task', { status: row.status });
  const latest = (await pool.query('SELECT max(attempt)::int AS n FROM code_tasks WHERE task_id=$1', [row.task_id])).rows[0];
  if (Number(latest.n) !== Number(row.attempt)) throw new CodeTaskError('NOT_LATEST', 'Repair runs only on the latest code attempt');

  if (Array.isArray(row.repair_stop_reasons) && row.repair_stop_reasons.length) {
    return { action: 'stopped', codeTask: mapCodeTask(row), reasons: row.repair_stop_reasons };
  }
  const existingChild = (await pool.query(
    `SELECT * FROM code_tasks WHERE repair_of=$1 ORDER BY attempt DESC LIMIT 1`, [row.id],
  )).rows[0];
  if (existingChild && (existingChild.status === 'WAITING_HUMAN' || existingChild.status === 'RUNNING' || existingChild.status === 'BLOCKED')) {
    return { action: 'repair_started', codeTask: mapCodeTask(row), child: mapCodeTask(existingChild) };
  }

  const findings = (row.review_findings ?? null) as ReviewFindings | null;
  const triggered = row.decision === 'repair'
    || (row.decision === 'reject' && !!(row.decision_reason && String(row.decision_reason).trim()))
    || !!findings?.hasUnresolvedHigh
    || input.trigger === 'ci' || input.trigger === 'reviewer' || input.trigger === 'human';
  if (!triggered) throw new CodeTaskError('REPAIR_NOT_TRIGGERED', 'Repair needs a CI failure trigger, a high review finding, or a human repair/reject decision');

  if (input.flaky && Number(row.ci_restarts ?? 0) < 1) {
    const upd = await pool.query(`UPDATE code_tasks SET ci_restarts=1, updated_at=now() WHERE id=$1 RETURNING *`, [row.id]);
    await audit(pool, row.project_id, 'code_task.ci_restart', { code_task_id: row.id, task_id: row.task_id });
    return { action: 'ci_restart', codeTask: mapCodeTask(upd.rows[0]) };
  }

  const gatesOut = await getTaskGates(pool, row.task_id, row.head_sha ?? undefined);
  const gateList = gatesOut.gates
    ? Object.entries(gatesOut.gates).map(([gate, g]: [string, any]) => ({ gate, status: g?.status ?? 'NOT_RUN', reasons: g?.reasons ?? [] }))
    : [];
  const classified = classifyFailure({
    gates: gateList,
    highFindings: findings?.highCount ?? 0,
    decision: row.decision,
    decisionReason: row.decision_reason,
    failingTests: input.failingTests ?? null,
    diffHash: input.diffHash ?? null,
  });
  const diffHash = input.diffHash && SHA64.test(input.diffHash) ? input.diffHash.toLowerCase() : null;
  const failingTests = typeof input.failingTests === 'number' && input.failingTests >= 0 ? Math.floor(input.failingTests) : null;
  await pool.query(
    `UPDATE code_tasks SET error_signature=$2, failure_kind=$3, diff_hash=COALESCE($4, diff_hash), failing_tests=COALESCE($5, failing_tests), updated_at=now() WHERE id=$1`,
    [row.id, classified.signature, classified.kind, diffHash, failingTests],
  );

  const historyRows = (await pool.query(
    `SELECT attempt, diff_hash, error_signature, failing_tests, id FROM code_tasks WHERE task_id=$1 AND status='DELIVERED' ORDER BY attempt`,
    [row.task_id],
  )).rows;
  const history: RepairAttempt[] = historyRows.map((h: any) => ({
    attempt: Number(h.attempt),
    diffHash: h.id === row.id ? (diffHash ?? h.diff_hash) : h.diff_hash,
    errorSignature: h.id === row.id ? classified.signature : h.error_signature,
    failingTests: h.id === row.id ? (failingTests ?? (h.failing_tests == null ? null : Number(h.failing_tests))) : (h.failing_tests == null ? null : Number(h.failing_tests)),
  }));
  const priorRepairs = Number((await pool.query(
    `SELECT count(*)::int AS n FROM code_tasks WHERE task_id=$1 AND repair_of IS NOT NULL`, [row.task_id],
  )).rows[0].n);
  let budgetExceeded = false;
  try { await checkCodeTaskBudget(pool, row.project_id, row.task_id); }
  catch (e) {
    if (e instanceof CodeTaskError && e.code === 'BUDGET_EXCEEDED') budgetExceeded = true;
    else throw e;
  }
  const stop = evaluateRepairStop({ priorRepairs, history, budgetExceeded });
  if (stop.stop) {
    const diagnostic = buildDiagnosticReport({
      taskId: row.task_id, codeTaskId: row.id, reasons: stop.reasons, kind: classified.kind, summary: classified.summary, attempts: history,
    });
    let artifactId: string | null = null;
    try {
      const art = await saveArtifact({
        projectId: row.project_id, artifactId: `repair_${sha256Hex(Buffer.from(row.task_id)).slice(0, 32)}`,
        filename: 'REPAIR_DIAGNOSIS.md', mime: 'text/markdown', text: diagnostic,
        createdBy: 'biforge:repair_loop', derivedFrom: [`task:${row.task_id}`, `code_task:${row.id}`],
      });
      artifactId = art.artifactId;
    } catch (e) {
      if ((e as Error)?.name === 'ArtifactFormatError') throw new CodeTaskError('ARTIFACT_ERROR', 'The diagnostic report could not be stored', { reason: (e as any).code ?? null });
      throw e;
    }
    const upd = await pool.query(
      `UPDATE code_tasks SET repair_stop_reasons=$2::jsonb, diagnostic_artifact_id=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, JSON.stringify(stop.reasons), artifactId],
    );
    await audit(pool, row.project_id, 'code_task.repair_stopped', {
      code_task_id: row.id, task_id: row.task_id, reasons: stop.reasons, diagnostic_artifact_id: artifactId,
    });
    return { action: 'stopped', codeTask: mapCodeTask(upd.rows[0]), reasons: stop.reasons, diagnostic };
  }

  const pkg = parsePackage(row.package);
  const attempts = history.map((h) => `attempt ${h.attempt}`);
  const nextPkg: TaskPackage = {
    ...pkg,
    executorPromptMd: buildRepairPrompt(pkg.executorPromptMd, {
      kind: classified.kind, summary: classified.summary, attempts,
      logExcerpt: input.logExcerpt ?? null,
      links: (input.links ?? []).filter((l) => typeof l === 'string' && l.startsWith('https://')).slice(0, 10),
    }),
  };
  const md = renderPackage(row.task_id, nextPkg);
  const hash = packageHash(nextPkg);
  let artifact: { artifactId: string; version: number };
  try {
    artifact = await saveArtifact({
      projectId: row.project_id, artifactId: `pkg_${sha256Hex(Buffer.from(row.task_id)).slice(0, 40)}`,
      filename: 'PACKAGE.md', mime: 'text/markdown', text: md, createdBy: 'biforge:repair_loop', derivedFrom: [`task:${row.task_id}`, `code_task:${row.id}`],
    });
  } catch (e) {
    if ((e as Error)?.name === 'ArtifactFormatError') throw new CodeTaskError('ARTIFACT_ERROR', 'PACKAGE.md could not be stored as an artifact', { reason: (e as any).code ?? null });
    throw e;
  }
  const child = await inTx(async (db) => {
    await lockTask(db, row.task_id);
    const open = (await db.query(`SELECT id, status FROM code_tasks WHERE task_id=$1 AND status = ANY($2::text[]) LIMIT 1`, [row.task_id, [...OPEN_STATES]])).rows[0];
    if (open) throw new CodeTaskError('CODE_TASK_ACTIVE', 'This task already has an open code run', { codeTaskId: open.id, status: open.status });
    await checkCodeTaskBudget(db, row.project_id, row.task_id);
    const attempt = Number((await db.query('SELECT COALESCE(max(attempt),0)::int + 1 AS n FROM code_tasks WHERE task_id=$1', [row.task_id])).rows[0].n);
    const id = newId();
    await db.query(
      `INSERT INTO code_tasks(id,project_id,task_id,attempt,executor,status,base_branch,package_hash,package,package_artifact_id,package_artifact_version,repair_of,error_signature,failure_kind)
       VALUES($1,$2,$3,$4,$5,'WAITING_HUMAN',$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
      [id, row.project_id, row.task_id, attempt, row.executor, row.base_branch, hash, JSON.stringify(nextPkg), artifact.artifactId, artifact.version, row.id, classified.signature, classified.kind],
    );
    await audit(db, row.project_id, 'code_task.repair_started', { code_task_id: id, parent_id: row.id, task_id: row.task_id, attempt, kind: classified.kind });
    return mapCodeTask((await db.query('SELECT * FROM code_tasks WHERE id=$1', [id])).rows[0]);
  });
  const parent = mapCodeTask((await pool.query('SELECT * FROM code_tasks WHERE id=$1', [row.id])).rows[0]);
  return { action: 'repair_started', codeTask: parent, child };
}

