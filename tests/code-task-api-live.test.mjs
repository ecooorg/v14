import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createProject } from '../server/projectRepository.ts';
import { createTask } from '../server/taskService.ts';
import { getPool, closeDatabase } from '../server/database.ts';

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
