/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN analysis-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject, getProject, updateProjectState, StateVersionConflict } = await import("../server/projectRepository.ts");
const { runAnalysis, reviewItem, addDecision, listProjectLedger, listProjectArtifacts, AnalysisError } = await import("../server/analysisService.ts");
const { readArtifact } = await import("../server/artifactRepository.ts");
const { createFakeAdapter } = await import("../server/fakeProvider.ts");
const { newRouterState } = await import("../server/router.ts");
const { closeDatabase } = await import("../server/database.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const out = { summary: 'Two risks found.', patch: { ops: [
  { op: 'add', section: 'facts', item: { text: 'Fact from the model', ref: 'msg:1' } },
  { op: 'add', section: 'risks', item: { text: 'Schedule risk', severity: 'high' } } ] } };

test('P06 live: slice S1 - passport gate, model patch is proposed, human review, artifact, ledger, 409', async () => {
  const p = await createProject({ name: `CI S1 ${Date.now()}` });
  const deps = { adapters: { gemini: createFakeAdapter('gemini', ['success'], out) }, router: newRouterState() };
  try {
    await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 1, task: 'x' }, deps), (e) => e instanceof AnalysisError && e.code === 'PASSPORT_NOT_CONFIRMED');
    const cur = await getProject(p.id);
    await updateProjectState({ projectId: p.id, expectedVersion: 1, actor: 'human', sourceRef: 'ci', state: { ...cur.state, passport: { ...cur.state.passport, projectType: 'software', goal: 'CI goal', users: 'owner', inputsOutputs: 'text', constraints: 'none', securityData: 'synthetic', successCriteria: 'works', budget: { calls: 10, tokens: 100000, executorRuns: 1 }, executor: 'manual', humanLevel: 'supervised', status: 'confirmed' } } });
    const r = await runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'Analyse the schedule' }, deps);
    assert.equal(r.state_version, 3); assert.equal(r.changes.length, 2);
    const after = await getProject(p.id);
    assert.ok(after.state.items.facts.concat(after.state.items.risks).every((x) => (x.status === 'proposed' || x.review === 'proposed') || x.status === 'confirmed'));
    assert.equal(after.state.items.risks[0].review, 'proposed');
    const art = await readArtifact(r.artifact.artifactId);   // hash verified inside
    assert.match(art.text, /Two risks found/);
    const ledger = await listProjectLedger(p.id);
    assert.equal(ledger.length, 1); assert.equal(ledger[0].input_tokens, 10);
    const { getPool } = await import('../server/database.ts');
    const dec = await (await getPool()).query('SELECT policy_version, status, units_spent FROM route_decisions WHERE run_id=$1', [r.run_id]);   // P08: every decision is stored
    assert.equal(dec.rowCount, 1); assert.equal(dec.rows[0].policy_version, 'router-v1/units-v1'); assert.equal(dec.rows[0].status, 'ok');
    assert.ok(r.tokens.estimated.total > 0);
    await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'stale' }, deps), (e) => e instanceof StateVersionConflict);
    const rv = await reviewItem({ projectId: p.id, expectedVersion: 3, section: 'risks', id: 'R-1', action: 'confirm' });
    assert.equal((await getProject(p.id)).state.items.risks[0].review, 'confirmed'); assert.equal(rv.state_version, 4);
    const d = await addDecision({ projectId: p.id, expectedVersion: 4, text: 'Go ahead', rationale: 'ok' });
    assert.equal(d.state_version, 5);
    assert.equal((await listProjectArtifacts(p.id)).length, 1);
    // the model may not create decisions: the whole patch is refused, nothing is written
    const bad = { adapters: { gemini: createFakeAdapter('gemini', ['success'], { summary: '', patch: { ops: [{ op: 'add', section: 'decisions', item: { text: 'x' } }] } }) }, router: newRouterState() };
    await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 5, task: 'y' }, bad), /rejected/);
    assert.equal(Number((await getProject(p.id)).state_version), 5);
  } finally { await closeDatabase(); }
});
}
}
// ===== END analysis-live.test.mjs =====

// ===== BEGIN artifacts-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject } = await import("../server/projectRepository.ts");
const { saveArtifact, readArtifact, listArtifactVersions, ArtifactIntegrityError } = await import("../server/artifactRepository.ts");
const { writeLedgerEntry } = await import("../server/ledger.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');

test('BX-17.a live: versions, hash, no duplicate content, integrity; ledger row', async () => {
  const project = await createProject({ name: `CI artifacts ${Date.now()}` });
  const pool = await getPool();
  try {
    const a1 = await saveArtifact({ projectId: project.id, filename: 'note.md', text: 'first', createdBy: 'human' });
    assert.deepEqual([a1.version, a1.created], [1, true]);
    const same = await saveArtifact({ projectId: project.id, artifactId: a1.artifactId, filename: 'note.md', text: 'first', createdBy: 'human' });
    assert.deepEqual([same.version, same.created], [1, false]);
    const a2 = await saveArtifact({ projectId: project.id, artifactId: a1.artifactId, filename: 'note.md', text: 'second', createdBy: 'run:1', derivedFrom: [`${a1.artifactId}@1`] });
    assert.deepEqual([a2.version, a2.created], [2, true]);
    assert.equal((await listArtifactVersions(a1.artifactId)).length, 2);
    assert.equal((await readArtifact(a1.artifactId, 1)).text, 'first');
    assert.equal((await readArtifact(a1.artifactId)).text, 'second');
    assert.equal(await readArtifact('missing_id'), null);
    await pool.query('UPDATE artifacts SET content=$1 WHERE artifact_id=$2 AND version=2', [Buffer.from('tampered'), a1.artifactId]);
    await assert.rejects(() => readArtifact(a1.artifactId, 2), ArtifactIntegrityError);
    await writeLedgerEntry({ providerId: 'fake', modelId: 'm', inputTokens: 1, cachedTokens: 0, outputTokens: 2, latencyMs: 3, retries: 0, status: 'ok', runId: `ci-${project.id}` });
    const l = await pool.query('SELECT 1 FROM usage_ledger WHERE run_id=$1', [`ci-${project.id}`]);
    assert.equal(l.rowCount, 1);
    await pool.query('DELETE FROM usage_ledger WHERE run_id=$1', [`ci-${project.id}`]);
  } finally {
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await closeDatabase();
  }
});
}
}
// ===== END artifacts-live.test.mjs =====

// ===== BEGIN code-task-api-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
const { createProject } = await import("../server/projectRepository.ts");
const { createTask } = await import("../server/taskService.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the live code task API test');
const PASS = 'code-api-test-password';
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PKG = { agentsMd: 'Rules', specMd: 'Goal', acceptanceMd: 'Criteria', executorPromptMd: 'Do it', allowedPaths: ['src/**'] };

test('P18 live API: Project Mode session only, same origin, strict bodies, start, export, refusals', async () => {
  const project = await createProject({ name: `code api ${Date.now()}`, state: {} });
  const { task } = await createTask({ projectId: project.id, idempotencyKey: `api-${Date.now()}`, title: 'api task', actor: 'human', input: { task: 'x', artifactRefs: [], stateVersion: null, profile: null, profileVersion: null, criteria: [] } });
  const pool = await getPool();
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), ENABLE_PROJECT_MODE: 'true', ENABLE_APP_AUTH: 'true', APP_PASSWORD: PASS, SESSION_SECRET: 'code-api-session-secret-long-enough', PGSSLMODE: 'disable', SKIP_DIST_HEALTHCHECK: 'true', GITHUB_DIFF_UPLOAD: '', PROJECT_RATE_LIMIT_PER_MINUTE: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; for (const s of [child.stdout, child.stderr]) s.on('data', (c) => { log = (log + c).slice(-10_000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000; let ready = false;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
      try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(750) })).ok; } catch { /* starting */ }
      if (!ready) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(ready, `server did not start: ${log}`);
    const root = `${base}/api/projects/${project.id}/tasks/${task.id}/code`;
    const send = (url, method, body, cookie, origin = base) => fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });

    assert.equal((await send(root, 'GET')).status, 401);
    assert.equal((await send(`${root}/start`, 'POST', { package: PKG })).status, 401, 'no session, no start');
    assert.equal((await send(`${root}/start`, 'POST', { package: PKG, padding: 'x'.repeat(400_000) })).status, 401, 'a large body is not parsed without a session');
    const login = await send(`${base}/api/login`, 'POST', { password: PASS });
    assert.equal(login.status, 200, log);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    assert.equal((await send(`${root}/start`, 'POST', { package: PKG }, cookie, 'https://evil.example')).status, 403, 'cross-origin write refused');
    assert.equal((await send(`${root}/start`, 'POST', { package: PKG }, cookie, null)).status, 403, 'no Origin, no write');
    assert.equal((await send(`${root}/start`, 'POST', { package: PKG, actorKind: 'human' }, cookie)).status, 400, 'a forged actor field is rejected');
    assert.equal((await send(`${root}/start`, 'POST', { package: PKG, actor: 'agent' }, cookie)).status, 400);
    const bad = await send(`${root}/start`, 'POST', { package: { ...PKG, allowedPaths: ['**'] } }, cookie);
    assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'PACKAGE_INVALID');
    assert.equal((await send(`${base}/api/projects/${project.id}/tasks/nope/code/start`, 'POST', { package: PKG }, cookie)).status, 404);
    assert.equal((await send(`${base}/api/projects/other/tasks/${task.id}/code`, 'GET', undefined, cookie)).status, 404, 'task of another project');

    const big = await send(`${root}/start`, 'POST', { package: { ...PKG, specMd: 'x'.repeat(1_300_000) } }, cookie);
    assert.equal(big.status, 413, 'above the larger body limit');

    const started = await send(`${root}/start`, 'POST', { package: PKG, base_branch: 'main' }, cookie);
    assert.equal(started.status, 201, log);
    const sb = await started.json();
    assert.equal(sb.data.status, 'WAITING_HUMAN'); assert.equal(sb.created, true);
    assert.equal(JSON.stringify(sb).includes('"package"'), false, 'the stored package is not echoed');
    assert.equal((await send(`${root}/start`, 'POST', { package: PKG, base_branch: 'main' }, cookie)).status, 200, 'same package: idempotent');
    assert.equal((await send(`${root}/start`, 'POST', { package: { ...PKG, specMd: 'other' } }, cookie)).status, 409);
    const id = sb.data.id;

    const pk = await (await send(`${root}/${id}/package`, 'GET', undefined, cookie)).json();
    assert.equal(pk.data.filename, 'PACKAGE.md'); assert.ok(pk.data.text.includes('Goal'));
    assert.equal((await (await send(`${root}`, 'GET', undefined, cookie)).json()).data.length, 1);
    assert.equal((await send(`${root}/${id}`, 'GET', undefined, cookie)).status, 200);

    const diff = await send(`${root}/${id}/result`, 'POST', { kind: 'diff', diff: 'x' }, cookie);
    assert.equal(diff.status, 409); assert.equal((await diff.json()).code, 'DIFF_UPLOAD_DISABLED', 'uploads are off by default');
    assert.equal((await send(`${root}/${id}/result`, 'POST', { kind: 'pr', pr_number: 3, who: 'model' }, cookie)).status, 400, 'strict');
    assert.equal((await send(`${root}/${id}/result`, 'POST', { kind: 'unknown' }, cookie)).status, 400);
    const noGh = await send(`${root}/${id}/result`, 'POST', { kind: 'pr', pr_number: 3 }, cookie);
    assert.equal(noGh.status, 503); assert.equal((await noGh.json()).code, 'GITHUB_NOT_CONFIGURED');
    assert.equal((await send(`${root}/${id}/cancel`, 'POST', {}, cookie)).status, 400, 'a reason is required');
    const cancelled = await send(`${root}/${id}/cancel`, 'POST', { reason: 'not needed' }, cookie);
    assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).data.status, 'FAILED');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE project_id=$1 AND event_type LIKE 'code_task.%'`, [project.id])).rows[0].n, 2);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000); });
    await closeDatabase();
  }
});
}
}
// ===== END code-task-api-live.test.mjs =====

// ===== BEGIN code-task-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const crypto = (await import("node:crypto")).default;
const { createProject } = await import("../server/projectRepository.ts");
const { createTask } = await import("../server/taskService.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");
const { defaultPassport } = await import("../server/contracts.ts");
const svc = await import("../server/codeTaskService.ts");
const { ingestGitHubEvent } = await import("../server/gateService.ts");

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
}
}
// ===== END code-task-live.test.mjs =====

// ===== BEGIN database-contract.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;

const migration = fs.readFileSync(new URL('../migrations/001_project_state.sql', import.meta.url), 'utf8');
const repo = fs.readFileSync(new URL('../server/projectRepository.ts', import.meta.url), 'utf8');
const database = fs.readFileSync(new URL('../server/database.ts', import.meta.url), 'utf8');
const health = fs.readFileSync(new URL('../server/healthRoutes.ts', import.meta.url), 'utf8');

test('BX-04 migration includes only the initial project/state/audit/rate-limit tables', () => {
  for (const table of ['projects', 'project_states', 'project_state_versions', 'project_events', 'audit_events', 'rate_limits', 'schema_migrations']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing ${table}`);
  }
  assert.match(migration, /UNIQUE\s*\(project_id,\s*state_version\)/i);
  assert.match(migration, /ON DELETE CASCADE/i);
});

test('State repository validates inputs, checks expected version, and records immutable history transactionally', () => {
  assert.match(repo, /expectedVersion/);
  assert.match(repo, /StateVersionConflict/);
  assert.match(repo, /FOR UPDATE/);
  assert.match(repo, /INSERT INTO project_state_versions/);
  assert.match(repo, /INSERT INTO project_events/);
  assert.match(repo, /INSERT INTO audit_events/);
  assert.match(repo, /ROLLBACK/);
  assert.match(repo, /zod|from 'zod'/i);
});

test('database readiness checks a real query and /ready degrades to 503 when unavailable', () => {
  assert.match(database, /SELECT 1/);
  assert.match(health, /database_unavailable/);
  assert.match(health, /status\(503\)/);
});
}
// ===== END database-contract.test.mjs =====

// ===== BEGIN database-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject, getProject, listStateVersions, StateVersionConflict, updateProjectState, consumeRateLimit } = await import("../server/projectRepository.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL contract tests');

test('BX-04 live PostgreSQL: create, version, optimistic concurrency, history, and rate limits', async () => {
  const project = await createProject({ name: `CI contract ${Date.now()}`, state: { status: 'initial' } });
  const pool = await getPool();
  try {
    assert.equal(project.state_version, 1);
    const current = await getProject(project.id);
    assert.equal(current.state.status, 'initial');
    const updated = await updateProjectState({ projectId: project.id, expectedVersion: 1, state: { status: 'updated' }, actor: 'human', sourceRef: 'ci:live-test' });
    assert.equal(updated.state_version, 2);
    await assert.rejects(() => updateProjectState({ projectId: project.id, expectedVersion: 1, state: { status: 'stale' }, actor: 'human', sourceRef: 'ci:live-test' }), StateVersionConflict);
    const versions = await listStateVersions(project.id, 10);
    assert.deepEqual(versions.map(v => Number(v.state_version)).sort(), [1, 2]);
    // BX-07 provenance: every version and event records who/what made the change.
    assert.ok(versions.every(v => ['human', 'agent', 'tool', 'system'].includes(v.actor) && typeof v.source_ref === 'string' && v.source_ref.length > 0));
    await assert.rejects(() => updateProjectState({ projectId: project.id, expectedVersion: 2, state: { status: 'no-source' }, actor: 'human', sourceRef: '  ' }));
    const events = await pool.query('SELECT event_type, payload FROM project_events WHERE project_id=$1', [project.id]);
    assert.ok(events.rows.length >= 2 && events.rows.every(e => typeof e.payload.source_ref === 'string' && e.payload.source_ref.length > 0));
    const bucket = `ci-rate-limit-${project.id}`;
    assert.equal((await consumeRateLimit({ key: bucket, limit: 2, windowMs: 60_000 })).allowed, true);
    assert.equal((await consumeRateLimit({ key: bucket, limit: 2, windowMs: 60_000 })).allowed, true);
    assert.equal((await consumeRateLimit({ key: bucket, limit: 2, windowMs: 60_000 })).allowed, false);
  } finally {
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await pool.query("DELETE FROM rate_limits WHERE bucket_key=$1", [`ci-rate-limit-${project.id}`]);
    await closeDatabase();
  }
});

test('BX-07 live PostgreSQL: State and history survive a service restart', async () => {
  const project = await createProject({ name: `CI restart ${Date.now()}`, state: { step: 0 } });
  try {
    await updateProjectState({ projectId: project.id, expectedVersion: 1, state: { step: 1, note: 'a' }, actor: 'human', sourceRef: 'ci:restart-test' });
    await updateProjectState({ projectId: project.id, expectedVersion: 2, state: { step: 2, note: 'b' }, actor: 'system', sourceRef: 'ci:restart-test' });
    const before = await getProject(project.id);
    const historyBefore = await listStateVersions(project.id, 10);
    // Simulated restart: drop the pool; the next call opens a brand-new connection pool.
    await closeDatabase();
    const after = await getProject(project.id);
    const historyAfter = await listStateVersions(project.id, 10);
    assert.equal(Number(after.state_version), 3);
    assert.deepEqual(after.state, { step: 2, note: 'b' });
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(historyAfter.map(v => [Number(v.state_version), v.actor, v.source_ref]), historyBefore.map(v => [Number(v.state_version), v.actor, v.source_ref]));
    // Version counter continues correctly after the restart.
    const next = await updateProjectState({ projectId: project.id, expectedVersion: 3, state: { step: 3 }, actor: 'human', sourceRef: 'ci:restart-test' });
    assert.equal(next.state_version, 4);
  } finally {
    const pool = await getPool();
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await closeDatabase();
  }
});
}
}
// ===== END database-live.test.mjs =====

// ===== BEGIN gate-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject } = await import("../server/projectRepository.ts");
const { createTask } = await import("../server/taskService.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");
const { ingestGitHubEvent, getTaskGates, recordApproval, recordEvidence, recordWaiver } = await import("../server/gateService.ts");
const { GATE_RULES_VERSION } = await import("../server/gateEngine.ts");

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
}
}
// ===== END gate-live.test.mjs =====

// ===== BEGIN gate-webhook-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const crypto = (await import("node:crypto")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
const { createProject } = await import("../server/projectRepository.ts");
const { createTask } = await import("../server/taskService.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the live webhook test');
const WEBHOOK_SECRET = 'gate-webhook-test-secret';
const SHA = '9'.repeat(40);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sign = (body) => `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;

test('P17 live: signed check_run webhook registers evidence; a bad signature is 401 and writes nothing', async () => {
  const project = await createProject({ name: `CI webhook ${Date.now()}`, state: {} });
  const pool = await getPool();
  const { task } = await createTask({ projectId: project.id, idempotencyKey: `w-${Date.now()}`, title: 'webhook task', actor: 'human', input: { task: 'x', artifactRefs: [], stateVersion: null, profile: null, profileVersion: null, criteria: [] } });
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), ENABLE_PROJECT_MODE: 'true', ENABLE_APP_AUTH: 'true', APP_PASSWORD: 'webhook-test-password', SESSION_SECRET: 'webhook-test-session-secret-long-enough', GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, PGSSLMODE: 'disable', SKIP_DIST_HEALTHCHECK: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; for (const s of [child.stdout, child.stderr]) s.on('data', (c) => { log = (log + c).slice(-10_000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 15_000; let ready = false;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
      try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(750) })).ok; } catch { /* starting */ }
      if (!ready) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(ready, `server did not start: ${log}`);
    const body = JSON.stringify({ action: 'completed', check_run: { id: 77, name: 'unit tests', status: 'completed', conclusion: 'success', head_sha: SHA, check_suite: { head_branch: `biforge/${task.id}` }, html_url: 'https://github.com/o/r/runs/77' } });
    const post = (b, sig) => fetch(`${base}/api/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'check_run', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body: b, signal: AbortSignal.timeout(5_000) });
    assert.equal((await post(body, 'sha256=' + '0'.repeat(64))).status, 401);
    assert.equal((await post(body)).status, 401);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gate_evidence WHERE task_id=$1', [task.id])).rows[0].n, 0, 'unsigned events store nothing');
    const ok = await post(body, sign(body));
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).recorded, 1);
    const row = (await pool.query('SELECT gate, status, source, commit_sha FROM gate_evidence WHERE task_id=$1', [task.id])).rows[0];
    assert.deepEqual(row, { gate: 'test', status: 'PASS', source: 'ci', commit_sha: SHA });
    assert.equal((await (await post(body, sign(body))).json()).recorded, 0, 'redelivery does not duplicate');
    const other = JSON.stringify({ action: 'opened', pull_request: { number: 1, head: { sha: SHA, ref: 'feature/x' } } });
    const r2 = await fetch(`${base}/api/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(other) }, body: other });
    assert.equal(r2.status, 202);
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000); });
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await closeDatabase();
  }
});
}
}
// ===== END gate-webhook-live.test.mjs =====

// ===== BEGIN p09-live-acceptance.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
// P09 live expectations (PostgreSQL). Protected by Test Integrity. Expected to FAIL until P09 is implemented.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject, getProject, updateProjectState } = await import("../server/projectRepository.ts");
const { runAnalysis, AnalysisError } = await import("../server/analysisService.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");
const { newRouterState } = await import("../server/router.ts");
const { createQuotaTracker } = await import("../server/budget.ts");
const { saveHealthEvent, loadHealthRows, loadRouterState, loadQuotaRows } = await import("../server/modelHealth.ts");
const { createFakeAdapter } = await import("../server/fakeProvider.ts");
const { REGISTRY_SEED, registryEntrySchema } = await import("../server/modelRegistry.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const out = { summary: 'ok', patch: { ops: [{ op: 'add', section: 'facts', item: { text: 'A fact', ref: 'msg:1' } }] } };

// A unique provider id per test keeps these tests isolated from other live tests that share the database.
const isolated = (pid) => ({ registry: [registryEntrySchema.parse({ ...REGISTRY_SEED[0], providerId: pid, modelId: 'm', costTier: 'free' })] });

async function confirmedProject() {
  const p = await createProject({ name: `P09 ${Date.now()}-${Math.random().toString(16).slice(2, 6)}` });
  const cur = await getProject(p.id);
  await updateProjectState({ projectId: p.id, expectedVersion: 1, actor: 'human', sourceRef: 'ci', state: { ...cur.state, passport: { ...cur.state.passport, projectType: 'software', goal: 'g', users: 'u', inputsOutputs: 'io', constraints: 'c', securityData: 's', successCriteria: 'ok', budget: { calls: 10, tokens: 100000, executorRuns: 1 }, executor: 'manual', humanLevel: 'supervised', status: 'confirmed' } } });
  return p;
}

test('model_health: events are persisted and loaded back', async () => {
  const model = `ci/m-${Date.now()}`;
  await saveHealthEvent({ type: 'call', model, ok: true, latencyMs: 100 });
  await saveHealthEvent({ type: 'call', model, ok: false, latencyMs: 10, errorClass: 'PROVIDER_QUOTA' });
  await saveHealthEvent({ type: 'cooldown', model, until: Date.now() + 60_000 });
  const row = (await loadHealthRows()).find((r) => r.key === model);
  assert.equal(row.successes, 1); assert.equal(row.failures, 1); assert.equal(row.lastErrorClass, 'PROVIDER_QUOTA'); assert.ok(row.cooldownUntil > Date.now());
});

test('PROVIDER_AUTH survives a restart: persisted disable, audit event, fresh state does not call the provider', async () => {
  const p = await confirmedProject();
  const pid = `ci-auth-${Date.now()}`;
  const failing = createFakeAdapter(pid, ['auth']);
  await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'x' }, { ...isolated(pid), adapters: { [pid]: failing }, router: newRouterState(), quota: createQuotaTracker() }), (e) => e instanceof AnalysisError && e.code === 'MODEL_UNAVAILABLE');
  const pool = await getPool();
  const audit = await pool.query("SELECT details FROM audit_events WHERE event_type='provider.disabled' ORDER BY created_at DESC LIMIT 1");
  assert.equal(audit.rows[0].details.provider_id, pid);
  const state = await loadRouterState(newRouterState());   // what a restarted process would load
  assert.ok(state.disabledProviders.has(pid));
  const again = createFakeAdapter(pid, ['success'], out);
  await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'y' }, { ...isolated(pid), adapters: { [pid]: again }, router: newRouterState(), quota: createQuotaTracker() }), (e) => e instanceof AnalysisError && e.code === 'MODEL_UNAVAILABLE');
  assert.equal(again.calls.length, 0);
  await pool.query("DELETE FROM model_health WHERE key=$1 OR key LIKE $2", [pid, `${pid}/%`]);   // leave the shared test database clean
});

test('day cap: at 100 % the analysis is refused before any call; a normal run reports its budget', async () => {
  const pool = await getPool();
  const ok = await confirmedProject();
  const pid = `ci-cap-${Date.now()}`;
  const adapter = createFakeAdapter(pid, ['success'], out);
  const r = await runAnalysis({ projectId: ok.id, expectedVersion: 2, task: 'normal' }, { ...isolated(pid), adapters: { [pid]: adapter }, router: newRouterState(), quota: createQuotaTracker() });
  assert.equal(r.budget.level, 'ok'); assert.equal(r.budget.cap_units, 300); assert.ok(r.budget.used_units >= 1);

  const full = await confirmedProject();
  await pool.query("INSERT INTO usage_ledger(id,run_id,provider_id,model_id,status,units) VALUES($1,$2,'gemini','m','ok',300)", [`ci-cap-${full.id}`, `${full.id}:old`]);
  const idle = createFakeAdapter(pid, ['success'], out);
  await assert.rejects(() => runAnalysis({ projectId: full.id, expectedVersion: 2, task: 'z' }, { ...isolated(pid), adapters: { [pid]: idle }, router: newRouterState(), quota: createQuotaTracker() }),
    (e) => e instanceof AnalysisError && e.code === 'DAILY_BUDGET_EXCEEDED' && e.status === 429);
  assert.equal(idle.calls.length, 0);
  await pool.query("DELETE FROM model_health WHERE key LIKE $1", [`${pid}/%`]);
});

test('quota rows come from the ledger (last 24 h)', async () => {
  const pool = await getPool();
  const id = `ci-q-${Date.now()}`;
  await pool.query("INSERT INTO usage_ledger(id,run_id,provider_id,model_id,input_tokens,output_tokens,status,units) VALUES($1,$2,'qprov','qmodel',400,100,'ok',1)", [id, `${id}:r`]);
  const rows = await loadQuotaRows(Date.now() - 86_400_000);
  const mine = rows.find((x) => x.providerId === 'qprov' && x.modelId === 'qmodel');
  assert.equal(mine.tokens, 500); assert.ok(Date.now() - mine.atMs < 60_000);
  await pool.query('DELETE FROM usage_ledger WHERE id=$1', [id]);
});

test.after(async () => { await closeDatabase(); });
}
}
// ===== END p09-live-acceptance.test.mjs =====

// ===== BEGIN p11-live-acceptance.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
// P11 live expectations (PostgreSQL). Protected by Test Integrity. Expected to FAIL until P11 is implemented.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject } = await import("../server/projectRepository.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");
const { TaskError } = await import("../server/taskMachine.ts");
const { createTask, getTask, transitionTask, changeTaskInput, enqueueTask, startRun, finishRun, listRuns, listTaskEvents } = await import("../server/taskService.ts");

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
}
}
// ===== END p11-live-acceptance.test.mjs =====

// ===== BEGIN p12-live-acceptance.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
// P12 live expectations (PostgreSQL). Protected by Test Integrity. Expected to FAIL until P12 is implemented.
// Every test works in its own project and scopes claimJob/recoverExpired/worker by projectId (other test files share the database).
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject } = await import("../server/projectRepository.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");
const { TaskError } = await import("../server/taskMachine.ts");
const { QueueError } = await import("../server/queueMachine.ts");
const { createTask, getTask, transitionTask, enqueueTask, startRun, finishRun, listRuns, listTaskEvents } = await import("../server/taskService.ts");
const { claimJob, heartbeatJob, completeJob, recoverExpired, getJob, getJobByRun } = await import("../server/queueService.ts");
const { createWorker } = await import("../server/worker.ts");

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
}
}
// ===== END p12-live-acceptance.test.mjs =====

// ===== BEGIN p13-live-acceptance.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
// P13 live expectations (PostgreSQL). Every test works in its own project and scopes the worker by projectId.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject } = await import("../server/projectRepository.ts");
const { getPool } = await import("../server/database.ts");
const { PlanError } = await import("../server/planMachine.ts");
const { createTask, getTask, transitionTask, enqueueTask, listTaskEvents } = await import("../server/taskService.ts");
const { claimJob, completeJob } = await import("../server/queueService.ts");
const { createWorker } = await import("../server/worker.ts");
const { createPlan, getPlan, listPlanTasks, decideApproval, listApprovals, requestApproval, setBudget, getBudget, guardModelCall, enqueuePlanTask, setProjectSettings, getProjectSettings } = await import("../server/planService.ts");

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
}
}
// ===== END p13-live-acceptance.test.mjs =====

// ===== BEGIN p14-live-acceptance.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
// P14 live expectations (PostgreSQL). Every test works in its own project and never counts rows of other projects.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const { createProject } = await import("../server/projectRepository.ts");
const { getPool } = await import("../server/database.ts");
const { saveArtifact, readArtifact, readArtifactBytes, verifyArtifact, inspectArtifact, diffArtifactVersions, listArtifactVersions, exportProjectManifest, ArtifactIntegrityError, ArtifactFormatError, MAX_ARTIFACT_BYTES } = await import("../server/artifactRepository.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const project = () => createProject({ name: `P14 ${uid()}` });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0, 255]);
const save = (p, extra) => saveArtifact({ projectId: p.id, filename: 'f.txt', createdBy: 'human', ...extra });
const problems = async (id, v) => (await verifyArtifact(id, v)).problems;

test('migration 008 created artifact_manifests', async () => {
  const r = await (await getPool()).query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'artifact_manifests'");
  assert.equal(r.rowCount, 1);
});

test('a binary artifact is stored and downloaded byte for byte; its type comes from content; a manifest exists', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const a = await save(p, { filename: 'logo.png', mime: 'text/plain', data: PNG });
    assert.deepEqual([a.kind, a.mime, a.created, a.version], ['binary', 'image/png', true, 1]);
    const got = await readArtifactBytes(a.artifactId);
    assert.deepEqual(new Uint8Array(got.data), PNG);
    assert.equal(got.hash, a.hash);
    const m = (await pool.query('SELECT * FROM artifact_manifests WHERE artifact_id=$1', [a.artifactId])).rows[0];
    assert.equal(m.manifest.declared_mime, 'text/plain'); assert.equal(m.manifest.mime, 'image/png'); assert.equal(m.storage_ref.startsWith('pg:'), true);
    assert.deepEqual(await problems(a.artifactId), []);
    const again = await save(p, { artifactId: a.artifactId, filename: 'logo.png', data: PNG });
    assert.deepEqual([again.created, again.version], [false, 1]);
    const unknown = await save(p, { filename: 'blob.xyz', data: Uint8Array.from([0xff, 0xfe, 0, 7]) });
    assert.deepEqual([unknown.kind, unknown.mime], ['binary', 'application/octet-stream']);
    assert.equal((await inspectArtifact(a.artifactId)).preview, null);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('an executable is stored, flagged and never run; text keeps working through readArtifact', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const e = await save(p, { filename: 'run.sh', data: new TextEncoder().encode('#!/bin/sh\necho hi') });
    assert.equal(e.kind, 'executable');
    assert.equal((await pool.query('SELECT security_status FROM artifacts WHERE artifact_id=$1', [e.artifactId])).rows[0].security_status, 'flagged_executable');
    const t = await save(p, { text: 'hello' });
    assert.equal((await readArtifact(t.artifactId)).text, 'hello');
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('tampering and a missing object are detected (TZ 10.2)', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const a = await save(p, { text: 'one' });
    const v2 = await save(p, { artifactId: a.artifactId, text: 'two' });
    const v3 = await save(p, { artifactId: a.artifactId, text: 'three' });
    // 1. content replaced, hash left alone
    await pool.query('UPDATE artifacts SET content=$1 WHERE artifact_id=$2 AND version=1', [Buffer.from('evil'), a.artifactId]);
    assert.ok((await problems(a.artifactId, 1)).includes('hash_mismatch'));
    await assert.rejects(() => readArtifact(a.artifactId, 1), ArtifactIntegrityError);
    // 2. content and hash replaced together: the manifest still disagrees
    const evil = Buffer.from('evil2'); const { createHash } = await import('node:crypto');
    await pool.query('UPDATE artifacts SET content=$1, hash=$2, size=$3 WHERE artifact_id=$4 AND version=2', [evil, createHash('sha256').update(evil).digest('hex'), evil.length, a.artifactId]);
    assert.ok((await problems(a.artifactId, 2)).includes('metadata_mismatch'));
    // 3. the object is gone: the latest version is reported missing, not silently replaced by v2
    await pool.query('DELETE FROM artifacts WHERE artifact_id=$1 AND version=3', [a.artifactId]);
    assert.deepEqual(await problems(a.artifactId, 3), ['object_missing']);
    await assert.rejects(() => readArtifact(a.artifactId), (e) => e instanceof ArtifactIntegrityError && e.problems.includes('object_missing'));
    assert.equal((await inspectArtifact(a.artifactId, 3)).ok, false);
    assert.equal(v3.version, 3);
    // 4. a version is never reused after its object was lost
    const v4 = await save(p, { artifactId: a.artifactId, text: 'four' });
    assert.equal(v4.version, 4);
    // 5. the manifest itself was edited
    await pool.query("UPDATE artifact_manifests SET storage_ref='pg:other' WHERE artifact_id=$1 AND version=4", [a.artifactId]);
    assert.ok((await problems(a.artifactId, 4)).includes('manifest_tampered'));
    // 6. a row without a manifest
    await pool.query('DELETE FROM artifact_manifests WHERE artifact_id=$1 AND version=4', [a.artifactId]);
    assert.deepEqual(await problems(a.artifactId, 4), ['manifest_missing']);
    assert.equal(v2.version, 2);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('limits: exactly 5 MB passes, one byte more fails; 200 versions pass, the 201st fails; 1000 artifacts per project', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const big = await save(p, { filename: 'big.bin', data: new Uint8Array(MAX_ARTIFACT_BYTES).fill(7) });
    assert.equal(big.size, MAX_ARTIFACT_BYTES);
    assert.equal((await readArtifactBytes(big.artifactId)).data.length, MAX_ARTIFACT_BYTES);
    await assert.rejects(() => save(p, { data: new Uint8Array(MAX_ARTIFACT_BYTES + 1) }), (e) => e instanceof ArtifactFormatError && e.code === 'TOO_LARGE');
    const first = await save(p, { text: 'v1' });
    for (let i = 2; i <= 200; i++) await save(p, { artifactId: first.artifactId, text: `v${i}` });
    assert.equal((await listArtifactVersions(first.artifactId)).length, 200);
    await assert.rejects(() => save(p, { artifactId: first.artifactId, text: 'v201' }), (e) => e instanceof ArtifactFormatError && e.code === 'LIMIT');
    const q = await project();
    try {
      await pool.query(
        `INSERT INTO artifact_manifests(artifact_id,version,project_id,hash,size,storage_ref,mime,kind,manifest,manifest_hash)
         SELECT 'fill-' || $2 || '-' || g, 1, $1, repeat('a',64), 0, 'pg:x', 'text/plain', 'text', '{}'::jsonb, repeat('b',64) FROM generate_series(1,999) g`, [q.id, uid().replace(/[^A-Za-z0-9]/g, '')]);
      assert.equal((await save(q, { text: 'the 1000th' })).created, true);
      await assert.rejects(() => save(q, { text: 'the 1001st' }), (e) => e instanceof ArtifactFormatError && e.code === 'LIMIT');
      const newVersion = await save(q, { artifactId: (await pool.query("SELECT artifact_id FROM artifact_manifests WHERE project_id=$1 AND manifest->>'filename'='f.txt'", [q.id])).rows[0].artifact_id, text: 'second version is not a new artifact' });
      assert.equal(newVersion.version, 2);
    } finally { await pool.query('DELETE FROM projects WHERE id=$1', [q.id]); }
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('inspect, diff, archive listing and project manifest export', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const a = await save(p, { text: 'a\nb\nc' });
    await save(p, { artifactId: a.artifactId, text: 'a\nc\nd' });
    const d = await diffArtifactVersions(a.artifactId, 1, 2);
    assert.deepEqual(d.lines.filter((l) => l.op !== ' ').map((l) => l.op + l.line), ['-b', '+d']);
    const i = await inspectArtifact(a.artifactId);
    assert.equal(i.version, 2); assert.equal(i.preview, 'a\nc\nd'); assert.equal(i.ok, true);
    const bin = await save(p, { filename: 'x.png', data: PNG }); await save(p, { artifactId: bin.artifactId, filename: 'x.png', data: Uint8Array.from([...PNG, 9]) });
    assert.deepEqual(await diffArtifactVersions(bin.artifactId, 1, 2), { binary: true, same: false });
    const zipBytes = Uint8Array.from(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]));
    const z = await save(p, { filename: 'a.zip', data: zipBytes });
    assert.equal(z.kind, 'archive');
    assert.deepEqual((await inspectArtifact(z.artifactId)).archive, { entries: [], truncated: false });
    const m = await exportProjectManifest(p.id);
    assert.equal(m.artifacts.length, 5); assert.ok(m.artifacts.every((x) => x.ok === true && x.project_id === p.id && !('content' in x)));
    assert.equal(await diffArtifactVersions('missing_id', 1, 2), null);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('upgrade: versions stored before migration 008 get a manifest; a second run changes nothing', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('legacy text'); const hash = createHash('sha256').update(body).digest('hex'); const artifactId = `legacy_${uid().replace(/[^A-Za-z0-9]/g, '')}`;
    await pool.query("INSERT INTO artifacts(id,artifact_id,version,project_id,filename,mime,size,hash,content,created_by) VALUES($1,$2,1,$3,'old.md','text/markdown',$4,$5,$6,'run:old')", [`row_${artifactId}`, artifactId, p.id, body.length, hash, body]);
    assert.deepEqual(await problems(artifactId, 1), ['manifest_missing']);
    const sql = fs.readFileSync(new URL('../migrations/008_artifact_manifests.sql', import.meta.url), 'utf8');
    const backfill = sql.slice(sql.indexOf('INSERT INTO artifact_manifests'), sql.indexOf('COMMIT;'));
    await pool.query(backfill); await pool.query(backfill);
    assert.equal((await pool.query('SELECT 1 FROM artifact_manifests WHERE artifact_id=$1', [artifactId])).rowCount, 1);
    assert.deepEqual(await problems(artifactId, 1), []);
    assert.equal((await readArtifact(artifactId)).text, 'legacy text');
    const next = await save(p, { artifactId, filename: 'old.md', text: 'new text' });
    assert.equal(next.version, 2);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('concurrency: parallel saves of the same content create one version; deleting a project removes artifacts and manifests', async () => {
  const p = await project(); const pool = await getPool();
  const a = await save(p, { text: 'seed' });
  const results = await Promise.all(Array.from({ length: 5 }, () => save(p, { artifactId: a.artifactId, text: 'same new content' })));
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.deepEqual([...new Set(results.map((r) => r.version))], [2]);
  assert.equal((await listArtifactVersions(a.artifactId)).length, 2);
  await pool.query('DELETE FROM projects WHERE id=$1', [p.id]);
  assert.equal((await pool.query('SELECT 1 FROM artifacts WHERE project_id=$1', [p.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM artifact_manifests WHERE project_id=$1', [p.id])).rowCount, 0);
  assert.equal(await readArtifact(a.artifactId), null);
});
}
}
// ===== END p14-live-acceptance.test.mjs =====

// ===== BEGIN p54-manual-delivery-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
const { createProject } = await import("../server/projectRepository.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the live manual delivery API test');
const PASS = 'p54-test-password';
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const passport = (over = {}) => ({ passport: { status: 'confirmed', projectType: 'software', goal: 'g', users: 'u', inputsOutputs: 'io', constraints: 'c', securityData: 's', successCriteria: 'ok', budget: { calls: 10, tokens: 10000, executorRuns: 5 }, executor: 'manual', humanLevel: 'supervised', ...over } });

test('P54 live API: manual hand-off task, project list, expectedBranch, refusals', async () => {
  const ok = await createProject({ name: `p54 ok ${Date.now()}`, state: passport() });
  const unconfirmed = await createProject({ name: `p54 unconfirmed ${Date.now()}`, state: passport({ status: 'proposed' }) });
  const auto = await createProject({ name: `p54 auto ${Date.now()}`, state: passport({ executor: 'model_patch' }) });
  const other = await createProject({ name: `p54 other ${Date.now()}`, state: passport() });
  await getPool();
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), ENABLE_PROJECT_MODE: 'true', ENABLE_APP_AUTH: 'true', APP_PASSWORD: PASS, SESSION_SECRET: 'p54-session-secret-long-enough-value', PGSSLMODE: 'disable', SKIP_DIST_HEALTHCHECK: 'true', GITHUB_DIFF_UPLOAD: '', CODE_EXECUTOR: '', PROJECT_RATE_LIMIT_PER_MINUTE: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; for (const s of [child.stdout, child.stderr]) s.on('data', (c) => { log = (log + c).slice(-10_000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000; let ready = false;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
      try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(750) })).ok; } catch { /* starting */ }
      if (!ready) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(ready, `server did not start: ${log}`);
    const send = (url, method, body, cookie, origin = base) => fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const manual = (p) => `${base}/api/projects/${p.id}/code/manual`;

    assert.equal((await send(manual(ok), 'POST', { goal: 'x' })).status, 401, 'no session, no task');
    assert.equal((await send(`${base}/api/projects/${ok.id}/code`, 'GET')).status, 401, 'no session, no list');
    const login = await send(`${base}/api/login`, 'POST', { password: PASS });
    assert.equal(login.status, 200, log);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    // /api/session reports capabilities to a signed-in person: write is off, ZIP is off here.
    const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
    assert.equal(session.capabilities.githubWrite, false);
    assert.equal(session.capabilities.programZip, false);
    assert.equal((await (await fetch(`${base}/api/session`)).json()).capabilities, undefined, 'not reported without a session');

    // refusals
    assert.equal((await send(manual(ok), 'POST', { goal: 'x' }, cookie, 'https://evil.example')).status, 403, 'cross-origin write refused');
    assert.equal((await send(manual(ok), 'POST', { goal: 'x', actor: 'agent' }, cookie)).status, 400, 'strict body: no forged actor');
    assert.equal((await send(manual(ok), 'POST', { goal: '' }, cookie)).status, 400);
    assert.equal((await send(manual(ok), 'POST', { goal: 'x'.repeat(4001) }, cookie)).status, 400);
    assert.equal((await send(`${base}/api/projects/nope/code/manual`, 'POST', { goal: 'x' }, cookie)).status, 404);
    const un = await send(manual(unconfirmed), 'POST', { goal: 'x' }, cookie);
    assert.equal(un.status, 409); assert.equal((await un.json()).code, 'PASSPORT_NOT_CONFIRMED');
    const mm = await send(manual(auto), 'POST', { goal: 'x' }, cookie);
    assert.equal(mm.status, 409); assert.equal((await mm.json()).code, 'EXECUTOR_MISMATCH');

    // happy path, idempotent repeat
    const body = { goal: 'Add a health endpoint', constraints: 'No new dependencies', acceptance_criteria: 'GET /health returns 200', idempotency_key: 'p54-key-1' };
    const created = await send(manual(ok), 'POST', body, cookie);
    assert.equal(created.status, 201, log);
    const cb = await created.json();
    assert.equal(cb.data.created, true);
    assert.equal(cb.data.codeTask.status, 'WAITING_HUMAN');
    assert.equal(cb.data.codeTask.executor, 'manual');
    assert.equal(cb.data.codeTask.expectedBranch, `biforge/${cb.data.taskId}`);
    assert.equal(cb.data.codeTask.packageApprovedAt, null);
    assert.equal(JSON.stringify(cb).includes('"package"'), false, 'the stored package is not echoed');
    const again = await send(manual(ok), 'POST', body, cookie);
    assert.equal(again.status, 200, 'same key, same task');
    assert.equal((await again.json()).data.taskId, cb.data.taskId);

    // the package is exportable and approvable; the task is reachable through the existing endpoints
    const root = `${base}/api/projects/${ok.id}/tasks/${cb.data.taskId}/code/${cb.data.codeTask.id}`;
    const pk = await (await send(`${root}/package`, 'GET', undefined, cookie)).json();
    assert.equal(pk.data.filename, 'PACKAGE.md'); assert.ok(pk.data.text.includes('Add a health endpoint'));
    const ap = await send(`${root}/approve`, 'POST', {}, cookie);
    assert.equal(ap.status, 200); assert.ok((await ap.json()).data.packageApprovedAt);

    // write paths stay off: no diff upload, no commit
    const diff = await send(`${root}/result`, 'POST', { kind: 'diff', diff: 'x' }, cookie);
    assert.equal(diff.status, 409); assert.equal((await diff.json()).code, 'DIFF_UPLOAD_DISABLED');
    const commit = await send(`${root}/commit-package`, 'POST', {}, cookie);
    assert.equal(commit.status, 409); assert.equal((await commit.json()).code, 'DIFF_UPLOAD_DISABLED');

    // gates before any commit: nothing to show, and nothing is invented
    const gates = await (await send(`${base}/api/projects/${ok.id}/tasks/${cb.data.taskId}/gates`, 'GET', undefined, cookie)).json();
    assert.equal(gates.data.commit, null); assert.equal(gates.data.gates, null);
    const noHead = await send(`${base}/api/projects/${ok.id}/tasks/${cb.data.taskId}/gates/spec/approve`, 'POST', { status: 'PASS' }, cookie);
    assert.equal(noHead.status, 409); assert.equal((await noHead.json()).code, 'NO_HEAD');
    const ci = await send(`${base}/api/projects/${ok.id}/tasks/${cb.data.taskId}/gates/build/approve`, 'POST', { status: 'PASS' }, cookie);
    assert.equal(ci.status, 400, 'a CI gate cannot be approved by hand'); assert.equal((await ci.json()).code, 'INVALID_GATE');

    // project list: newest first, with the task title, scoped to the project
    const list = await (await send(`${base}/api/projects/${ok.id}/code`, 'GET', undefined, cookie)).json();
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].id, cb.data.codeTask.id);
    assert.equal(list.data[0].taskTitle, 'Add a health endpoint');
    assert.equal(list.data[0].expectedBranch, `biforge/${cb.data.taskId}`);
    assert.equal((await (await send(`${base}/api/projects/${other.id}/code`, 'GET', undefined, cookie)).json()).data.length, 0, 'another project sees nothing');
    assert.equal((await send(`${base}/api/projects/nope/code`, 'GET', undefined, cookie)).status, 404);

    // a task can be closed with a reason; closed tasks stay in the list
    assert.equal((await send(`${root}/cancel`, 'POST', {}, cookie)).status, 400, 'a reason is required');
    const closed = await send(`${root}/cancel`, 'POST', { reason: 'not needed' }, cookie);
    assert.equal(closed.status, 200); assert.equal((await closed.json()).data.status, 'FAILED');
    assert.equal((await (await send(`${base}/api/projects/${ok.id}/code`, 'GET', undefined, cookie)).json()).data[0].status, 'FAILED');
  } finally {
    child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000); });
    await closeDatabase();
  }
});
}
}
// ===== END p54-manual-delivery-live.test.mjs =====

// ===== BEGIN state-pipeline-live.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { createProject, getProject, listStateVersions, updateProjectState, StateVersionConflict } = await import("../server/projectRepository.ts");
const { applyPatchToProject, compactProjectState, PatchRejectedError } = await import("../server/stateService.ts");
const { getPool, closeDatabase } = await import("../server/database.ts");

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');

test('P05 live: patch pipeline writes a version, refuses bad patches, blocks direct model writes, compacts', async () => {
  const project = await createProject({ name: `CI state pipeline ${Date.now()}` });
  const pool = await getPool();
  try {
    const r = await applyPatchToProject({ projectId: project.id, expectedVersion: 1, actor: 'agent', sourceRef: 'run:ci-1', patch: { ops: [{ op: 'add', section: 'facts', item: { text: 'A fact' } }] } });
    assert.equal(r.state_version, 2);
    assert.equal((await getProject(project.id)).state.items.facts[0].status, 'proposed');
    await assert.rejects(() => applyPatchToProject({ projectId: project.id, expectedVersion: 2, actor: 'agent', sourceRef: 'run:ci-2', patch: { ops: [{ op: 'add', section: 'decisions', item: { text: 'no' } }] } }), PatchRejectedError);
    assert.equal(Number((await getProject(project.id)).state_version), 2);   // nothing written
    await assert.rejects(() => applyPatchToProject({ projectId: project.id, expectedVersion: 1, actor: 'agent', sourceRef: 'run:ci-3', patch: { ops: [{ op: 'add', section: 'facts', item: { text: 'stale' } }] } }), StateVersionConflict);
    await assert.rejects(() => updateProjectState({ projectId: project.id, expectedVersion: 2, state: { items: {} }, actor: 'agent', sourceRef: 'run:direct' }), /patch pipeline/);
    const long = 'x'.repeat(1200);
    await applyPatchToProject({ projectId: project.id, expectedVersion: 2, actor: 'human', sourceRef: 'ui:ci', patch: { ops: [1, 2, 3].map((n) => ({ op: 'add', section: 'hypotheses', item: { text: `${n} ${long}` } })) } });
    const c = await compactProjectState({ projectId: project.id, expectedVersion: 3, limits: { hypotheses: 400 } });
    assert.equal(c.state_version, 4);
    assert.ok(c.compacted.length > 0);
    const versions = await listStateVersions(project.id, 10);
    assert.deepEqual(versions.map((v) => Number(v.state_version)).sort(), [1, 2, 3, 4]);
    const full = versions.find((v) => Number(v.state_version) === 3);
    assert.ok(full.state.items.hypotheses[0].text.length > 1000);   // the full version stays available
    const audit = await pool.query("SELECT 1 FROM audit_events WHERE project_id=$1 AND event_type IN ('state.patch.applied','state.patch.rejected')", [project.id]);
    assert.ok(audit.rowCount >= 3);
  } finally {
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await closeDatabase();
  }
});
}
}
// ===== END state-pipeline-live.test.mjs =====
