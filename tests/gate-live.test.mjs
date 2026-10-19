import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../server/projectRepository.ts';
import { createTask } from '../server/taskService.ts';
import { getPool, closeDatabase } from '../server/database.ts';
import { ingestGitHubEvent, getTaskGates, recordApproval, recordEvidence, recordWaiver } from '../server/gateService.ts';
import { GATE_RULES_VERSION } from '../server/gateEngine.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL gate tests');
const S1 = '1'.repeat(40), S2 = '2'.repeat(40);
const checkRun = (taskId, id, name, conclusion, sha, extra = {}) => ({ action: 'completed', check_run: { id, name, status: 'completed', conclusion, head_sha: sha, html_url: `https://github.com/o/r/runs/${id}`, check_suite: { head_branch: `biforge/${taskId}` }, app: { name: 'GitHub Actions' }, ...extra } });
const pr = (taskId, number, sha, action = 'synchronize') => ({ action, pull_request: { number, head: { sha, ref: `biforge/${taskId}` } } });

test('P17 live PostgreSQL: CI evidence, Test Integrity, invalidation, waiver, redelivery', async () => {
  const project = await createProject({ name: `CI gates ${Date.now()}`, state: { s: 1 } });
  const pool = await getPool();
  try {
    const { task } = await createTask({ projectId: project.id, idempotencyKey: `k-${Date.now()}`, title: 'gate task', actor: 'human', input: { task: 'x', artifactRefs: [], stateVersion: null, profile: null, profileVersion: null, criteria: [] } });
    const cleanDiff = { listFiles: async () => ({ files: [{ filename: 'server/a.ts', status: 'modified' }], truncated: false }), githubConfig: () => ({}) };
    const badDiff = { listFiles: async () => ({ files: [{ filename: 'tests/acceptance/a.test.mjs', status: 'modified' }], truncated: false }), githubConfig: () => ({}) };

    // not a task branch / unknown task: nothing is stored
    assert.equal((await ingestGitHubEvent('check_run', checkRun('nope', 1, 'build', 'success', S1))).ignored, 'not_a_task_branch');
    assert.equal((await ingestGitHubEvent('check_run', { ...checkRun(task.id, 1, 'build', 'success', S1), check_run: { ...checkRun(task.id, 1, 'x', 'success', S1).check_run, check_suite: { head_branch: 'main' } } })).ignored, 'not_a_task_branch');

    assert.equal((await ingestGitHubEvent('pull_request', pr(task.id, 5, S1, 'opened'), cleanDiff)).recorded, 1);
    assert.equal((await ingestGitHubEvent('check_run', checkRun(task.id, 10, 'Build application', 'success', S1))).recorded, 1);
    assert.equal((await ingestGitHubEvent('check_run', checkRun(task.id, 11, 'unit tests', 'success', S1))).recorded, 1);
    assert.equal((await ingestGitHubEvent('check_run', checkRun(task.id, 12, 'Scan repository for leaked secrets', 'success', S1))).recorded, 1);
    assert.equal((await ingestGitHubEvent('check_run', checkRun(task.id, 12, 'Scan repository for leaked secrets', 'success', S1))).recorded, 0, 'redelivery is a no-op');
    let g = await getTaskGates(pool, task.id);
    assert.equal(g.commit, S1);
    for (const n of ['build', 'test', 'security', 'test_integrity']) assert.equal(g.gates[n].status, 'PASS', n);
    assert.equal(g.gates.release_candidate.status, 'NOT_RUN', 'requirements/spec/review have no evidence');

    // human approvals complete the picture; a model/agent cannot approve
    await assert.rejects(() => recordApproval(pool, { projectId: project.id, taskId: task.id, gate: 'spec', commitSha: S1, actor: 'agent', approvalId: 'x' }), /not_human/);
    for (const gate of ['requirements', 'spec', 'review']) await recordApproval(pool, { projectId: project.id, taskId: task.id, gate, commitSha: S1, actor: 'owner', approvalId: `a-${gate}` });
    g = await getTaskGates(pool, task.id);
    assert.equal(g.gates.release_candidate.status, 'PASS');
    assert.equal(g.manifest.complete, true);
    await assert.rejects(() => recordEvidence(pool, { projectId: project.id, taskId: task.id, gate: 'build', checkName: 'model says ok', status: 'PASS', commitSha: S1, source: 'model', rulesVersion: GATE_RULES_VERSION, tool: 'x', sourceRef: 'm1' }), /untrusted_source/);

    // a failing check
    await ingestGitHubEvent('check_run', checkRun(task.id, 13, 'integration tests', 'failure', S1));
    assert.equal((await getTaskGates(pool, task.id)).gates.test.status, 'FAIL');

    // new commit: earlier evidence is invalidated, the gates start from NOT_RUN
    const r = await ingestGitHubEvent('pull_request', pr(task.id, 5, S2), badDiff);
    assert.ok(r.invalidated >= 7);
    g = await getTaskGates(pool, task.id);
    assert.equal(g.commit, S2);
    assert.equal(g.gates.build.status, 'NOT_RUN');
    assert.equal(g.gates.release_candidate.status, 'NOT_RUN');
    const old = await pool.query('SELECT count(*)::int AS n FROM gate_evidence WHERE task_id=$1 AND commit_sha=$2 AND invalidated_at IS NULL', [task.id, S1]);
    assert.equal(old.rows[0].n, 0);
    assert.equal(g.gates.test_integrity.status, 'FAIL', 'protected tests changed');

    // diff unavailable -> BLOCKED, never PASS
    const { task: t2 } = await createTask({ projectId: project.id, idempotencyKey: `k2-${Date.now()}`, title: 'gate task 2', actor: 'human', input: { task: 'x', artifactRefs: [], stateVersion: null, profile: null, profileVersion: null, criteria: [] } });
    await ingestGitHubEvent('pull_request', pr(t2.id, 6, S1, 'opened'), { githubConfig: () => null });
    assert.equal((await getTaskGates(pool, t2.id)).gates.test_integrity.status, 'BLOCKED');

    // human waiver: reason mandatory, audited, bound to the commit
    await assert.rejects(() => recordWaiver(pool, { projectId: project.id, taskId: task.id, gate: 'test_integrity', commitSha: S2, reason: ' ', actor: 'owner' }), /waiver_rejected/);
    await assert.rejects(() => recordWaiver(pool, { projectId: project.id, taskId: task.id, gate: 'test_integrity', commitSha: S2, reason: 'ok', actor: 'agent' }), /waiver_rejected/);
    await recordWaiver(pool, { projectId: project.id, taskId: task.id, gate: 'test_integrity', commitSha: S2, reason: 'owner approved test update', actor: 'owner' });
    assert.equal((await getTaskGates(pool, task.id)).gates.test_integrity.status, 'WAIVED');
    const audit = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE project_id=$1 AND event_type='gate.waived'", [project.id]);
    assert.equal(audit.rows[0].n, 1);

    // untrusted payload text is never stored
    const stored = await pool.query('SELECT details::text AS d, check_name FROM gate_evidence WHERE task_id=$1', [task.id]);
    assert.ok(stored.rows.every((x) => x.d.length < 300));
  } finally {
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await closeDatabase();
  }
});
