import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createProject } from '../server/projectRepository.ts';
import { createTask } from '../server/taskService.ts';
import { getPool, closeDatabase } from '../server/database.ts';
import { defaultPassport } from '../server/contracts.ts';
import * as svc from '../server/codeTaskService.ts';
import { ingestGitHubEvent } from '../server/gateService.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL code task tests');
process.env.GITHUB_DIFF_UPLOAD = 'true';   // write permissions are accepted by the fake token below; each test says when uploads are off
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg = { appId: '1', installationId: '2', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner: 'o', repository: 'r', apiBaseUrl: 'https://gh.test' };
const WRITE = { metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'write' };
const S = (c) => c.repeat(40);
const H = { actorKind: 'human' };
const input = { task: 'x', artifactRefs: [], stateVersion: null, profile: null, profileVersion: null, criteria: [] };
const PKG = (over = {}) => ({ agentsMd: 'Rules', specMd: 'Goal', acceptanceMd: 'Criteria', executorPromptMd: 'Do it', allowedPaths: ['src/**'], acceptanceTests: [{ path: 'tests/acceptance/a.test.mjs', content: 'x' }], contextFiles: [], ...over });
let seq = 0;
async function setup(state = {}) {
  const project = await createProject({ name: `code ${Date.now()}-${++seq}`, state });
  const { task } = await createTask({ projectId: project.id, idempotencyKey: `k-${Date.now()}-${seq}`, title: 'code task', actor: 'human', input });
  return { project, task, pool: await getPool() };
}
/** A GitHub that records every call. `s` is mutable scenario state. */
function fakeGh(s) {
  const calls = (s.calls ??= []);
  const b64 = (t) => Buffer.from(t).toString('base64');
  return async (url, o = {}) => {
    const u = new URL(url); const method = o.method || 'GET'; const body = o.body ? JSON.parse(o.body) : null; calls.push({ method, path: u.pathname, body });
    const j = (b, st = 200) => new Response(JSON.stringify(b), { status: st });
    const p = u.pathname.replace('/repos/o/r', '');
    if (p.endsWith('/access_tokens')) return j({ token: 'tok-secret', permissions: WRITE }, 201);
    if (method === 'GET' && /^\/pulls\/\d+$/.test(p)) return s.pr ? j({ state: s.pr.state ?? 'open', merged: false, head: { sha: s.pr.head, ref: s.pr.ref ?? s.branch }, base: { ref: s.pr.base ?? 'main' }, html_url: 'https://github.com/o/r/pull/7' }) : j({}, 404);
    if (method === 'GET' && p === '/pulls') return j(s.pr && s.pr.listed ? [{ number: 7, state: 'open', merged_at: null, head: { ref: s.branch, sha: s.pr.head }, base: { ref: 'main' }, html_url: 'https://github.com/o/r/pull/7' }] : []);
    if (method === 'GET' && p.startsWith('/compare/')) return j({ files: s.files ?? [], commits: [{ sha: s.head ?? S('c') }] });
    if (method === 'GET' && p.startsWith('/contents/')) { const f = s.repoFiles?.[decodeURIComponent(p.slice('/contents/'.length))]; return f === undefined ? j({}, 404) : j({ type: 'file', encoding: 'base64', size: f.length, content: b64(f) }); }
    if (method === 'GET' && p.startsWith('/git/ref/heads/biforge/')) return s.branchHead ? j({ object: { sha: s.branchHead } }) : j({}, 404);
    if (method === 'GET' && p.startsWith('/git/ref/heads/main')) return j({ object: { sha: S('a') } });
    if (method === 'GET' && p.startsWith('/git/commits/')) return j({ tree: { sha: S('e') } });
    if (p === '/git/blobs') return s.failBlob ? j({}, 500) : j({ sha: S('1') }, 201);
    if (p === '/git/trees') return j({ sha: S('2') }, 201);
    if (p === '/git/commits') return j({ sha: S('3') }, 201);
    if (p === '/git/refs' || p.startsWith('/git/refs/heads/')) return j({}, method === 'POST' ? 201 : 200);
    if (method === 'POST' && p === '/pulls') return s.prFails ? j({}, 500) : j({ number: 9, html_url: 'https://github.com/o/r/pull/9' }, 201);
    return j({}, 404);
  };
}
const deps = (s) => ({ githubConfig: () => cfg, fetcher: fakeGh(s) });
const writes = (s) => s.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/access_tokens'));
const file = (filename, status = 'modified', additions = 2, deletions = 1, patch = '@@') => ({ filename, status, additions, deletions, ...(patch === null ? {} : { patch }) });
const start = (project, task, over = {}) => svc.startCodeTask({ projectId: project.id, taskId: task.id, package: PKG(), ...H, ...over });

test('P18 live: start validates, is human-only, idempotent, race-safe and exports PACKAGE.md', async () => {
  const { project, task, pool } = await setup();
  await assert.rejects(() => svc.startCodeTask({ projectId: project.id, taskId: task.id, package: PKG(), actorKind: 'model' }), (e) => e.code === 'HUMAN_REQUIRED' && e.status === 403);
  await assert.rejects(() => svc.startCodeTask({ projectId: project.id, taskId: task.id, package: PKG() }), (e) => e.code === 'HUMAN_REQUIRED');
  await assert.rejects(() => start(project, task, { package: { ...PKG(), bogus: 1 } }), (e) => e.code === 'PACKAGE_INVALID');
  await assert.rejects(() => start(project, task, { package: PKG({ allowedPaths: ['**'] }) }), (e) => e.code === 'PACKAGE_INVALID');
  await assert.rejects(() => start(project, task, { package: PKG({ specMd: 'key ' + 'AIza' + 'x'.repeat(35) }) }), (e) => e.code === 'PACKAGE_SECRET');
  await assert.rejects(() => start(project, task, { package: PKG({ sensitivity: 'high' }) }), (e) => e.code === 'APPROVAL_REQUIRED');
  await assert.rejects(() => start(project, task, { baseBranch: 'biforge/x' }), /invalid|base/i);
  const other = await setup();
  await assert.rejects(() => svc.startCodeTask({ projectId: other.project.id, taskId: task.id, package: PKG(), ...H }), (e) => e.code === 'NOT_FOUND', 'a task of another project');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM code_tasks WHERE task_id=$1', [task.id])).rows[0].n, 0, 'refusals store nothing');

  const results = await Promise.allSettled(Array.from({ length: 6 }, () => start(project, task)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.equal(ok.length, 6, 'the same package is idempotent');
  assert.equal(ok.filter((r) => r.created).length, 1, 'exactly one run is created');
  assert.equal(new Set(ok.map((r) => r.codeTask.id)).size, 1);
  const ct = ok[0].codeTask;
  assert.equal(ct.status, 'WAITING_HUMAN'); assert.equal(ct.executor, 'manual'); assert.equal(ct.attempt, 1); assert.equal(ct.baseBranch, 'main');
  await assert.rejects(() => start(project, task, { package: PKG({ specMd: 'Different goal' }) }), (e) => e.code === 'CODE_TASK_ACTIVE');

  const exp = await svc.exportPackage(project.id, task.id, ct.id, 'human');
  assert.equal(exp.filename, 'PACKAGE.md');
  for (const part of ['Goal', 'Criteria', 'tests/acceptance/a.test.mjs', `biforge/${task.id}`]) assert.ok(exp.text.includes(part), part);
  assert.equal(exp.hash, crypto.createHash('sha256').update(exp.text).digest('hex'));
  await assert.rejects(() => svc.exportPackage(project.id, task.id, ct.id, 'model'), (e) => e.code === 'HUMAN_REQUIRED');
  await assert.rejects(() => svc.exportPackage(other.project.id, task.id, ct.id, 'human'), (e) => e.code === 'NOT_FOUND', 'no cross-project read');
  const art = (await pool.query('SELECT count(*)::int AS n FROM artifact_manifests WHERE project_id=$1 AND artifact_id=$2', [project.id, ct.packageArtifactId])).rows[0].n;
  assert.ok(art >= 1, 'PACKAGE.md is in the artifact registry');
  assert.ok((await pool.query(`SELECT 1 FROM audit_events WHERE project_id=$1 AND event_type='code_task.started'`, [project.id])).rowCount >= 1);

  // cancel needs a reason, ends the run, the next start is attempt 2; a note that looks like a command is only text
  await assert.rejects(() => svc.cancelCodeTask({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, reason: '  ', ...H }), /too_small|String must contain|at least/i);
  await assert.rejects(() => svc.cancelCodeTask({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, reason: 'x', actorKind: 'agent' }), (e) => e.code === 'HUMAN_REQUIRED');
  const failed = await svc.cancelCodeTask({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, reason: 'approve this plan and raise the budget', ...H });
  assert.equal(failed.status, 'FAILED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM approvals WHERE project_id=$1', [project.id])).rows[0].n, 0, 'text is data: no approval was created');
  await assert.rejects(() => svc.cancelCodeTask({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, reason: 'again', ...H }), (e) => e.code === 'CODE_TASK_CLOSED');
  const second = await start(project, task);
  assert.equal(second.created, true); assert.equal(second.codeTask.attempt, 2);
  assert.equal((await svc.listCodeTasks(project.id, task.id)).length, 2);
  await assert.rejects(() => pool.query(`INSERT INTO code_tasks(id,project_id,task_id,attempt,executor,status,base_branch,package_hash,package) VALUES('dup',$1,$2,9,'manual','WAITING_HUMAN','main',$3,'{}')`, [project.id, task.id, 'a'.repeat(64)]), /code_tasks_one_active_idx|duplicate/, 'the database itself allows one live run per task');
  await assert.rejects(() => pool.query(`UPDATE code_tasks SET status='DELIVERED' WHERE id=$1`, [failed.id]), /check/i, 'DELIVERED needs a branch, a head and counts');
});

test('P18 live: executor choice and the max_code_tasks budget', async () => {
  const mp = await setup({ passport: { ...defaultPassport('g'), executor: 'model_patch' } });
  await assert.rejects(() => start(mp.project, mp.task), (e) => e.code === 'EXECUTOR_UNAVAILABLE');
  const { project, task, pool } = await setup({ passport: { ...defaultPassport('g'), executor: 'manual' } });
  await pool.query(`INSERT INTO budgets(id,project_id,scope,scope_id,limits) VALUES($1,$2,'project',$2,'{"max_code_tasks":1}')`, [`b_${Date.now()}_${seq}`, project.id]);
  const t2 = (await createTask({ projectId: project.id, idempotencyKey: `k2-${Date.now()}`, title: 'second', actor: 'human', input })).task;
  assert.equal((await start(project, task)).created, true);
  await assert.rejects(() => start(project, t2), (e) => e.code === 'BUDGET_EXCEEDED' && e.details.scope === 'project');
  const tb = await setup();
  await tb.pool.query(`INSERT INTO budgets(id,project_id,scope,scope_id,limits) VALUES($1,$2,'task',$3,'{"max_code_tasks":0}')`, [`bt_${Date.now()}_${seq}`, tb.project.id, tb.task.id]);
  await assert.rejects(() => start(tb.project, tb.task), (e) => e.code === 'BUDGET_EXCEEDED' && e.details.scope === 'task');
});

test('P18 live: a PR from the task branch is validated against the package; a refused PR can be fixed and resubmitted', async () => {
  const { project, task } = await setup();
  const ct = (await start(project, task)).codeTask;
  const s = { branch: `biforge/${task.id}`, pr: { head: S('d'), ref: 'feature/other' } };
  const submit = (result) => svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result, ...H }, deps(s));
  await assert.rejects(() => submit({ kind: 'pr', prNumber: 7 }), (e) => e.code === 'PR_MISMATCH');
  s.pr = { head: S('d'), ref: s.branch, state: 'closed' };
  await assert.rejects(() => submit({ kind: 'pr', prNumber: 7 }), (e) => e.code === 'PR_NOT_OPEN');
  await assert.rejects(() => svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result: { kind: 'pr', prNumber: 7 }, actorKind: 'model' }, deps(s)), (e) => e.code === 'HUMAN_REQUIRED');
  await assert.rejects(() => svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result: { kind: 'pr', prNumber: 7 } }, {}), (e) => e.code === 'HUMAN_REQUIRED');
  await assert.rejects(() => svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result: { kind: 'pr', prNumber: 7 }, ...H }, { githubConfig: () => null }), (e) => e.code === 'GITHUB_NOT_CONFIGURED' && e.status === 503);

  s.pr = { head: S('d'), ref: s.branch }; s.head = S('d');
  s.files = [file('src/a.ts'), file('tests/acceptance/a.test.mjs'), file('docs/x.md'), file('src/bin.png', 'modified', 0, 0, null)];
  const blocked = await submit({ kind: 'pr', prNumber: 7, note: 'built with a tool' });
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.statusReason, 'validation_failed');
  assert.deepEqual(blocked.violations.map((v) => `${v.code}:${v.path}`).sort(), ['binary_or_unreadable:src/bin.png', 'path_not_allowed:docs/x.md', 'path_protected:tests/acceptance/a.test.mjs']);
  assert.equal(writes(s).length, 0, 'validation never writes to GitHub');

  s.pr = { head: S('f'), ref: s.branch }; s.head = S('f'); s.files = [file('src/a.ts', 'modified', 5, 3), file('src/new.ts', 'added', 10, 0)];
  const done = await submit({ kind: 'pr', prNumber: 7, note: 'built with a tool' });
  assert.equal(done.status, 'DELIVERED'); assert.equal(done.delivery, 'pr'); assert.equal(done.prNumber, 7); assert.equal(done.prUrl, 'https://github.com/o/r/pull/7');
  assert.equal(done.branch, `biforge/${task.id}`); assert.equal(done.headSha, S('f')); assert.equal(done.filesChanged, 2); assert.equal(done.linesChanged, 18); assert.equal(done.executorNote, 'built with a tool'); assert.deepEqual(done.violations, []);
  await assert.rejects(() => submit({ kind: 'pr', prNumber: 7 }), (e) => e.code === 'CODE_TASK_CLOSED');
  assert.equal(JSON.stringify(done).includes('tok-secret'), false);
});

test('P18 live: size limits at the boundary on a PR (10 files / 400 lines pass, 11 / 401 are blocked)', async () => {
  for (const [files, expected] of [[Array.from({ length: 10 }, (_, i) => file(`src/${i}.ts`, 'modified', 40, 0)), 'DELIVERED'], [Array.from({ length: 11 }, (_, i) => file(`src/${i}.ts`, 'modified', 1, 0)), 'BLOCKED'], [[file('src/a.ts', 'modified', 400, 0)], 'DELIVERED'], [[file('src/a.ts', 'modified', 400, 1)], 'BLOCKED']]) {
    const { project, task } = await setup(); const ct = (await start(project, task)).codeTask;
    const s = { branch: `biforge/${task.id}`, pr: { head: S('d'), ref: `biforge/${task.id}` }, head: S('d'), files };
    const r = await svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result: { kind: 'pr', prNumber: 7 }, ...H }, deps(s));
    assert.equal(r.status, expected, JSON.stringify(r.violations));
  }
});

test('P18 live: branch result, poll fallback and the webhook find the PR', async () => {
  const { project, task, pool } = await setup();
  const ct = (await start(project, task)).codeTask;
  const branch = `biforge/${task.id}`;
  const s = { branch, head: S('c'), files: [file('src/a.ts')] };
  const call = (result) => svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result, ...H }, deps(s));
  await assert.rejects(() => call({ kind: 'branch', branch: 'main' }), (e) => e.code === 'BRANCH_MISMATCH');
  await assert.rejects(() => call({ kind: 'branch', branch }), (e) => e.code === 'BRANCH_NOT_FOUND');
  s.branchHead = S('c');
  const d = await call({ kind: 'branch', branch });
  assert.equal(d.status, 'DELIVERED'); assert.equal(d.delivery, 'branch'); assert.equal(d.prNumber, null);
  const noPr = await svc.refreshCodeTask({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, ...H }, deps(s));
  assert.equal(noPr.changed, false);
  s.pr = { head: S('c'), ref: branch, listed: true };
  const withPr = await svc.refreshCodeTask({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, ...H }, deps(s));
  assert.equal(withPr.changed, true); assert.equal(withPr.codeTask.prNumber, 7); assert.equal(withPr.codeTask.status, 'DELIVERED');

  // the webhook path: an open run learns about its PR without polling; GitHub trouble never breaks gate ingestion
  const w = await setup(); const wc = (await start(w.project, w.task)).codeTask;
  const ws = { branch: `biforge/${w.task.id}`, head: S('9'), files: [file('src/a.ts')] };
  const pr = { action: 'opened', pull_request: { number: 5, head: { sha: S('9'), ref: ws.branch } } };
  const clean = { listFiles: async () => ({ files: [{ filename: 'src/a.ts', status: 'modified' }], truncated: false }), githubConfig: () => cfg, fetcher: fakeGh(ws), db: w.pool };
  const ing = await ingestGitHubEvent('pull_request', pr, clean);
  assert.equal(ing.ok, true);
  const after = await svc.getCodeTask(w.project.id, w.task.id, wc.id);
  assert.equal(after.status, 'DELIVERED'); assert.equal(after.prNumber, 5); assert.equal(after.headSha, S('9'));
  const broken = await setup(); await start(broken.project, broken.task);
  const bad = await ingestGitHubEvent('pull_request', { action: 'opened', pull_request: { number: 6, head: { sha: S('8'), ref: `biforge/${broken.task.id}` } } }, { listFiles: async () => ({ files: [], truncated: false }), githubConfig: () => cfg, fetcher: async () => new Response('{}', { status: 500 }), db: broken.pool });
  assert.equal(bad.ok, true, 'a GitHub error in the sync does not fail the webhook');
  assert.equal((await svc.listCodeTasks(broken.project.id, broken.task.id))[0].status, 'WAITING_HUMAN');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM gate_evidence WHERE task_id=$1`, [broken.task.id])).rows[0].n >= 0, true);
});

const A_DIFF = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`;
test('P18 live: diff upload is validated before anything is written, then applied through the Git Data API and opened as a PR', async () => {
  const { project, task, pool } = await setup();
  const ct = (await start(project, task)).codeTask;
  const s = { branch: `biforge/${task.id}`, repoFiles: { 'src/a.ts': 'one\ntwo\n' } };
  const up = (diff, d = deps(s), extra = {}) => svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result: { kind: 'diff', diff, ...extra }, ...H }, d);

  await assert.rejects(() => up(A_DIFF, { ...deps(s), diffUpload: () => false }), (e) => e.code === 'DIFF_UPLOAD_DISABLED');
  assert.equal((await svc.getCodeTask(project.id, task.id, ct.id)).status, 'WAITING_HUMAN', 'a disabled feature changes nothing');

  for (const [diff, code] of [
    ['diff --git a/tests/acceptance/a.test.mjs b/tests/acceptance/a.test.mjs\n--- a/tests/acceptance/a.test.mjs\n+++ b/tests/acceptance/a.test.mjs\n@@ -1 +1 @@\n-x\n+y\n', 'path_protected'],
    ['diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-x\n+y\n', 'path_protected'],
    ['diff --git a/server/x.ts b/server/x.ts\n--- a/server/x.ts\n+++ b/server/x.ts\n@@ -1 +1 @@\n-x\n+y\n', 'path_not_allowed'],
    ['diff --git a/src/../../etc/x b/src/../../etc/x\n--- a/src/../../etc/x\n+++ b/src/../../etc/x\n@@ -1 +1 @@\n-x\n+y\n', 'path_unsafe'],
    ['diff --git a/src/a.png b/src/a.png\nBinary files a/src/a.png and b/src/a.png differ\n', 'binary_not_allowed'],
    ['diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n', 'mode_change_not_allowed'],
    ['diff --git a/src/a.ts b/src/b.ts\nrename from src/a.ts\nrename to src/b.ts\n', 'rename_unsupported'],
    ['diff --git a/src/big.ts b/src/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/big.ts\n@@ -0,0 +1,401 @@\n' + Array.from({ length: 401 }, (_, i) => '+l' + i).join('\n') + '\n', 'too_many_lines'],
    ['', 'empty_diff'],
  ]) {
    const r = await up(diff);
    assert.equal(r.status, 'BLOCKED', code); assert.equal(r.statusReason, 'validation_failed');
    assert.ok(r.violations.some((v) => v.code === code), `${code} in ${JSON.stringify(r.violations)}`);
    assert.equal(writes(s).length, 0, `${code}: nothing written to GitHub`);
  }
  const hunk = await up(A_DIFF.replace('-two', '-other'));
  assert.equal(hunk.statusReason, 'apply_failed'); assert.deepEqual(hunk.violations, [{ code: 'hunk_failed', path: 'src/a.ts' }]);
  assert.equal(writes(s).length, 0, 'a patch that does not apply writes nothing');

  s.failBlob = true;
  await assert.rejects(() => up(A_DIFF), (e) => e.code === 'GITHUB_ERROR' && e.status === 502);
  const afterErr = await svc.getCodeTask(project.id, task.id, ct.id);
  assert.equal(afterErr.status, 'BLOCKED'); assert.match(afterErr.statusReason, /^github_error:/);
  s.failBlob = false;

  const [r1, r2] = await Promise.allSettled([up(A_DIFF, deps(s), { title: 'Fix two' }), up(A_DIFF, deps(s), { title: 'Fix two' })]);
  const okOne = [r1, r2].filter((r) => r.status === 'fulfilled'), bad = [r1, r2].filter((r) => r.status === 'rejected');
  assert.equal(okOne.length, 1, 'exactly one of two parallel uploads wins'); assert.equal(bad.length, 1);
  const done = okOne[0].value;
  assert.equal(done.status, 'DELIVERED'); assert.equal(done.delivery, 'diff'); assert.equal(done.prNumber, 9); assert.equal(done.prUrl, 'https://github.com/o/r/pull/9');
  assert.equal(done.branch, `biforge/${task.id}`); assert.equal(done.headSha, S('3')); assert.equal(done.filesChanged, 1); assert.equal(done.linesChanged, 2);
  const w = s.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/access_tokens') && !c.path.endsWith('/git/blobs') || c.path.endsWith('/git/blobs')).filter((c) => c.method !== 'GET');
  assert.ok(w.every((c) => /\/git\/(blobs|trees|commits|refs)|\/pulls$/.test(c.path)), 'only Git Data writes and one PR');
  assert.equal(s.calls.some((c) => /merge|workflows/.test(c.path)), false);
  const blob = s.calls.filter((c) => c.path.endsWith('/git/blobs') && c.body).pop().body;
  assert.equal(blob.content, 'one\nTWO\n');
  assert.ok((await pool.query(`SELECT 1 FROM audit_events WHERE project_id=$1 AND event_type='code_task.delivered'`, [project.id])).rowCount >= 1);
});

test('P18 live: a PR that cannot be opened after the commit still records the delivered branch', async () => {
  const { project, task } = await setup(); const ct = (await start(project, task)).codeTask;
  const s = { branch: `biforge/${task.id}`, repoFiles: { 'src/a.ts': 'one\ntwo\n' }, prFails: true };
  const r = await svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result: { kind: 'diff', diff: A_DIFF }, ...H }, deps(s));
  assert.equal(r.status, 'DELIVERED'); assert.equal(r.prNumber, null); assert.equal(r.headSha, S('3'));
});

test('P18 live: creating and deleting files through a diff', async () => {
  const { project, task } = await setup(); const ct = (await start(project, task, { package: PKG({ allowedPaths: ['src/**'] }) })).codeTask;
  const s = { branch: `biforge/${task.id}`, repoFiles: { 'src/old.ts': 'bye\n' } };
  const diff = 'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+hello\ndiff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n';
  const r = await svc.submitCodeResult({ projectId: project.id, taskId: task.id, codeTaskId: ct.id, result: { kind: 'diff', diff }, ...H }, deps(s));
  assert.equal(r.status, 'DELIVERED'); assert.equal(r.filesChanged, 2);
  const tree = s.calls.find((c) => c.path.endsWith('/git/trees')).body.tree;
  assert.deepEqual(tree.map((e) => [e.path, e.sha === null]).sort(), [['src/new.ts', false], ['src/old.ts', true]]);
  const exists = { branch: `biforge/${task.id}`, repoFiles: { 'src/new.ts': 'already\n' } };
  const { project: p2, task: t2 } = await setup(); const c2 = (await start(p2, t2)).codeTask;
  const e = await svc.submitCodeResult({ projectId: p2.id, taskId: t2.id, codeTaskId: c2.id, result: { kind: 'diff', diff: diff.split('diff --git a/src/old.ts')[0] }, ...H }, deps(exists));
  assert.equal(e.statusReason, 'apply_failed'); assert.equal(e.violations[0].code, 'file_exists');
});

test.after(async () => { delete process.env.GITHUB_DIFF_UPLOAD; await closeDatabase(); });
