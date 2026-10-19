import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createProject } from '../server/projectRepository.ts';
import { createTask } from '../server/taskService.ts';
import { getPool, closeDatabase } from '../server/database.ts';

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
