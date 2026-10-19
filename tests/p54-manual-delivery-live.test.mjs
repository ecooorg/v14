import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createProject } from '../server/projectRepository.ts';
import { getPool, closeDatabase } from '../server/database.ts';

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
