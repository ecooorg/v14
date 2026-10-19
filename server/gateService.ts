import crypto from 'node:crypto';
import { z } from 'zod';
import { getPool } from './database.ts';
import {
  GATE_RULES_VERSION, evaluateAll, evaluateTestIntegrity, gateForCheckName, isCommitSha, isGateName, releaseManifest, statusFromCheckRun, validateEvidence,
  type EvidenceRecord, type GateName, type GateStatus, type WaiverRecord,
} from './gateEngine.ts';
import { listPullRequestFiles, taskIdFromBranch, type GitHubAppConfig } from './githubIntegration.ts';
import { syncCodeTaskFromPullRequest } from './codeTaskService.ts';

// Gate Engine persistence and GitHub event ingestion (TZ 12.3, 12.5; P17 / BX-20).
// Webhook payloads are untrusted data: only the fields below are read, free text is never stored or interpreted.
type Db = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;

const checkRunPayload = z.object({
  action: z.string().max(80),
  repository: z.object({ full_name: z.string().max(200) }).optional(),
  check_run: z.object({
    id: z.number().int(), name: z.string().min(1).max(200), status: z.string().max(40), conclusion: z.string().max(40).nullable().optional(),
    head_sha: z.string(), html_url: z.string().max(500).nullable().optional(),
    check_suite: z.object({ head_branch: z.string().max(250).nullable().optional() }).optional(),
    pull_requests: z.array(z.object({ number: z.number().int().optional(), head: z.object({ ref: z.string().max(250).optional() }).optional() })).max(20).optional(),
    app: z.object({ name: z.string().max(100).optional() }).optional(),
  }),
});
const pullRequestPayload = z.object({
  action: z.string().max(80),
  repository: z.object({ full_name: z.string().max(200) }).optional(),
  pull_request: z.object({ number: z.number().int().min(1), head: z.object({ sha: z.string(), ref: z.string().max(250) }) }),
});

export interface IngestDeps { db?: Db; githubConfig?: () => GitHubAppConfig | null; listFiles?: typeof listPullRequestFiles; fetcher?: typeof fetch }
export type IngestResult = { ok: true; recorded: number; invalidated: number; ignored?: string } | { ok: false; reason: string };

async function taskForBranch(db: Db, ref: unknown): Promise<{ taskId: string; projectId: string } | null> {
  const taskId = taskIdFromBranch(ref);
  if (!taskId) return null;
  const r = await db.query('SELECT id, project_id FROM tasks WHERE id=$1', [taskId]);
  return r.rows[0] ? { taskId: r.rows[0].id, projectId: r.rows[0].project_id } : null;
}

/** Evidence for another commit is stale once the head moves (12.5). Returns the number of rows invalidated. */
export async function advanceHead(db: Db, t: { taskId: string; projectId: string }, sha: string, prNumber: number | null, reason = 'code_changed'): Promise<number> {
  if (!isCommitSha(sha)) throw new Error('invalid_commit_sha');
  const sha40 = sha.toLowerCase();
  await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [t.taskId]);
  const prev = await db.query('SELECT commit_sha FROM task_heads WHERE task_id=$1', [t.taskId]);
  await db.query(
    `INSERT INTO task_heads(task_id, project_id, commit_sha, pr_number, updated_at) VALUES($1,$2,$3,$4,now())
     ON CONFLICT (task_id) DO UPDATE SET commit_sha=EXCLUDED.commit_sha, pr_number=COALESCE(EXCLUDED.pr_number, task_heads.pr_number), updated_at=now()`,
    [t.taskId, t.projectId, sha40, prNumber]);
  if (prev.rows[0] && prev.rows[0].commit_sha === sha40) return 0;
  const inv = await db.query(
    `UPDATE gate_evidence SET invalidated_at=now(), invalidated_reason=$3 WHERE task_id=$1 AND commit_sha<>$2 AND invalidated_at IS NULL`,
    [t.taskId, sha40, reason]);
  return inv.rowCount ?? 0;
}

/** Register one evidence row. Refuses anything the rules reject; a redelivery is a no-op. */
export async function recordEvidence(db: Db, e: EvidenceRecord & { projectId: string; taskId: string; sourceRef: string; logUrl?: string | null; details?: Record<string, unknown> }): Promise<boolean> {
  const problem = validateEvidence(e);
  if (problem) throw new Error(`evidence_rejected:${problem}`);
  if (e.logUrl && !/^https:\/\//.test(e.logUrl)) throw new Error('evidence_rejected:log_url');
  const r = await db.query(
    `INSERT INTO gate_evidence(id,project_id,task_id,gate,check_name,status,rules_version,source,source_ref,tool,tool_version,exit_code,commit_sha,details,log_url)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) ON CONFLICT (task_id, source, source_ref) DO NOTHING`,
    [newId('ev'), e.projectId, e.taskId, e.gate, e.checkName, e.status, e.rulesVersion, e.source, e.sourceRef.slice(0, 300), e.tool, e.toolVersion ?? null, e.exitCode ?? null, e.commitSha.toLowerCase(), JSON.stringify(e.details ?? {}), e.logUrl ?? null]);
  return (r.rowCount ?? 0) > 0;
}

/** Human approval evidence for the gates that rest on a decision (requirements, spec, review). Actor must be a human. */
export async function recordApproval(db: Db, a: { projectId: string; taskId: string; gate: GateName; commitSha: string; actor: string; approvalId: string; status?: 'PASS' | 'FAIL' }): Promise<boolean> {
  if (!isGateName(a.gate)) throw new Error('evidence_rejected:unknown_gate');
  if (!a.actor.trim() || a.actor === 'agent' || a.actor === 'model') throw new Error('evidence_rejected:not_human');
  return recordEvidence(db, { projectId: a.projectId, taskId: a.taskId, gate: a.gate, checkName: `approval:${a.gate}`, status: a.status ?? 'PASS', commitSha: a.commitSha, source: 'approval', rulesVersion: GATE_RULES_VERSION, tool: 'biforge-approval', sourceRef: `approval:${a.approvalId}` });
}

/** WAIVED (12.2): only a human, with a reason, bound to one commit; audited. */
export async function recordWaiver(db: Db, w: { projectId: string; taskId: string; gate: GateName; commitSha: string; reason: string; actor: string }): Promise<void> {
  if (!isGateName(w.gate) || !isCommitSha(w.commitSha)) throw new Error('waiver_rejected:invalid');
  if (!w.reason.trim() || !w.actor.trim() || w.actor === 'agent' || w.actor === 'model') throw new Error('waiver_rejected:reason_and_human_actor_required');
  await db.query('INSERT INTO gate_waivers(id,project_id,task_id,gate,commit_sha,reason,actor) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (task_id,gate,commit_sha) DO NOTHING',
    [newId('wv'), w.projectId, w.taskId, w.gate, w.commitSha.toLowerCase(), w.reason.trim().slice(0, 1000), w.actor.trim()]);
  await db.query('INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)',
    [newId('audit'), w.projectId, 'gate.waived', 'human', JSON.stringify({ task_id: w.taskId, gate: w.gate, commit_sha: w.commitSha.toLowerCase(), by: w.actor.trim() })]);
}

const mapEvidence = (r: any): EvidenceRecord => ({
  gate: r.gate, checkName: r.check_name, status: r.status as GateStatus, commitSha: r.commit_sha, source: r.source, rulesVersion: r.rules_version,
  tool: r.tool, toolVersion: r.tool_version, exitCode: r.exit_code, invalidated: r.invalidated_at != null, createdAt: r.created_at,
});

/** Current gate results for a task at its latest known head (or an explicit commit). */
export async function getTaskGates(db: Db, taskId: string, commitSha?: string) {
  const head = commitSha ?? (await db.query('SELECT commit_sha FROM task_heads WHERE task_id=$1', [taskId])).rows[0]?.commit_sha;
  if (!head) return { commit: null, gates: null, manifest: null };
  const ev = (await db.query('SELECT * FROM gate_evidence WHERE task_id=$1 ORDER BY created_at', [taskId])).rows.map(mapEvidence);
  const wv: WaiverRecord[] = (await db.query('SELECT gate, commit_sha, reason, actor FROM gate_waivers WHERE task_id=$1', [taskId])).rows
    .map((r) => ({ gate: r.gate, commitSha: r.commit_sha, reason: r.reason, actor: r.actor }));
  const gates = evaluateAll(ev, head, wv);
  return { commit: head as string, gates, manifest: releaseManifest(gates, ev, head, wv) };
}

/** Webhook entry (12.5): check_run completed -> evidence; pull_request -> head tracking, invalidation and Test Integrity from the diff. */
export async function ingestGitHubEvent(event: string, payload: unknown, deps: IngestDeps = {}): Promise<IngestResult> {
  let db: Db;
  try { db = deps.db ?? await getPool(); } catch { return { ok: false, reason: 'database_unavailable' }; }
  const configured = (() => { const o = process.env.GITHUB_REPOSITORY_OWNER, n = process.env.GITHUB_REPOSITORY_NAME; return o && n ? `${o}/${n}`.toLowerCase() : null; })();
  const sameRepo = (full?: string) => !configured || (full ?? '').toLowerCase() === configured;

  if (event === 'check_run') {
    const p = checkRunPayload.safeParse(payload);
    if (!p.success) return { ok: false, reason: 'invalid_payload' };
    if (!sameRepo(p.data.repository?.full_name)) return { ok: true, recorded: 0, invalidated: 0, ignored: 'other_repository' };
    const c = p.data.check_run;
    if (!isCommitSha(c.head_sha)) return { ok: false, reason: 'invalid_commit_sha' };
    const ref = c.check_suite?.head_branch ?? c.pull_requests?.[0]?.head?.ref;
    const task = await taskForBranch(db, ref);
    if (!task) return { ok: true, recorded: 0, invalidated: 0, ignored: 'not_a_task_branch' };
    const prNumber = c.pull_requests?.[0]?.number ?? null;
    const invalidated = await advanceHead(db, task, c.head_sha, prNumber);
    if (p.data.action !== 'completed') return { ok: true, recorded: 0, invalidated, ignored: 'not_completed' };
    const gate = gateForCheckName(c.name);
    if (!gate) return { ok: true, recorded: 0, invalidated, ignored: 'check_not_mapped' };
    const inserted = await recordEvidence(db, {
      projectId: task.projectId, taskId: task.taskId, gate, checkName: c.name, status: statusFromCheckRun(c.status, c.conclusion ?? null), commitSha: c.head_sha,
      source: 'ci', rulesVersion: GATE_RULES_VERSION, tool: `github-check:${(c.app?.name ?? 'actions').slice(0, 60)}`, sourceRef: `check_run:${c.id}`,
      logUrl: c.html_url && c.html_url.startsWith('https://') ? c.html_url : null, details: { conclusion: c.conclusion ?? null },
    });
    return { ok: true, recorded: inserted ? 1 : 0, invalidated };
  }

  if (event === 'pull_request') {
    const p = pullRequestPayload.safeParse(payload);
    if (!p.success) return { ok: false, reason: 'invalid_payload' };
    if (!sameRepo(p.data.repository?.full_name)) return { ok: true, recorded: 0, invalidated: 0, ignored: 'other_repository' };
    const pr = p.data.pull_request;
    if (!isCommitSha(pr.head.sha)) return { ok: false, reason: 'invalid_commit_sha' };
    const task = await taskForBranch(db, pr.head.ref);
    if (!task) return { ok: true, recorded: 0, invalidated: 0, ignored: 'not_a_task_branch' };
    if (!['opened', 'synchronize', 'reopened', 'edited'].includes(p.data.action)) return { ok: true, recorded: 0, invalidated: 0, ignored: 'action_not_tracked' };
    const invalidated = await advanceHead(db, task, pr.head.sha, pr.number);
    // Test Integrity comes from the PR diff. If the diff cannot be read the gate is BLOCKED, never PASS.
    let status: GateStatus = 'BLOCKED'; let details: Record<string, unknown> = { reason: 'diff_unavailable' };
    const cfg = deps.githubConfig ? deps.githubConfig() : defaultGitHubConfig();
    if (cfg) {
      try {
        const diff = await (deps.listFiles ?? listPullRequestFiles)(cfg, pr.number);
        let packageAcceptancePaths: string[] = [];
        try {
          const ct = (await db.query(
            `SELECT package FROM code_tasks WHERE task_id=$1 AND status IN ('WAITING_HUMAN','RUNNING','BLOCKED','DELIVERED') ORDER BY attempt DESC LIMIT 1`,
            [task.taskId],
          )).rows[0];
          const pkg = ct?.package;
          if (pkg && Array.isArray(pkg.acceptanceTests)) {
            packageAcceptancePaths = pkg.acceptanceTests.map((f: { path?: string }) => f.path).filter((x: unknown): x is string => typeof x === 'string');
          }
        } catch { /* baseline optional */ }
        const r = evaluateTestIntegrity(diff.files, { truncated: diff.truncated, packageAcceptancePaths });
        status = r.status; details = { reasons: r.reasons, touched: r.touched, packageBaseline: r.packageBaseline };
      } catch { details = { reason: 'diff_fetch_failed' }; }
    }
    const inserted = await recordEvidence(db, {
      projectId: task.projectId, taskId: task.taskId, gate: 'test_integrity', checkName: 'tests/acceptance diff', status, commitSha: pr.head.sha,
      source: 'diff', rulesVersion: GATE_RULES_VERSION, tool: 'biforge-diff', toolVersion: GATE_RULES_VERSION, sourceRef: `pr:${pr.number}:${pr.head.sha.toLowerCase()}`, details,
    });
    // P18: an open manual code run of this task learns about its PR here (no polling needed). Never throws, never changes gate results.
    await syncCodeTaskFromPullRequest(task.taskId, { number: pr.number, headSha: pr.head.sha }, { githubConfig: deps.githubConfig, fetcher: deps.fetcher });
    return { ok: true, recorded: inserted ? 1 : 0, invalidated };
  }
  return { ok: true, recorded: 0, invalidated: 0, ignored: 'event_not_tracked' };
}

function defaultGitHubConfig(): GitHubAppConfig | null {
  const e = process.env;
  if (!e.GITHUB_APP_ID || !e.GITHUB_APP_INSTALLATION_ID || !e.GITHUB_APP_PRIVATE_KEY || !e.GITHUB_REPOSITORY_OWNER || !e.GITHUB_REPOSITORY_NAME) return null;
  return { appId: e.GITHUB_APP_ID, installationId: e.GITHUB_APP_INSTALLATION_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'), owner: e.GITHUB_REPOSITORY_OWNER, repository: e.GITHUB_REPOSITORY_NAME, apiBaseUrl: e.GITHUB_API_BASE_URL };
}
