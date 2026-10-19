import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { getPool, closeDatabase } from '../server/database.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Project Mode API tests');
const PASS = 'bx06-api-test-password';
const SECRET = 'bx06-api-test-session-secret-long-enough';
const REQUEST_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 10_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

function request(url, options = {}) {
  // Node's fetch has no default request deadline. A stalled route must fail with
  // a useful error instead of keeping the whole test alive until the runner timeout.
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = exited => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    // Cover the case where the process exited just before the listener was attached.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 3_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child, 3_000);
}

test('BX-06 Project Mode API: authentication, CSRF, CRUD, optimistic versioning', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      ENABLE_PROJECT_MODE: 'true',
      ENABLE_APP_AUTH: 'true',
      APP_PASSWORD: PASS,
      SESSION_SECRET: SECRET,
      PGSSLMODE: 'disable',
      SKIP_DIST_HEALTHCHECK: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let stage = 'starting server';
  const appendLog = chunk => {
    // Keep failure output useful without allowing a noisy child process to grow memory forever.
    log = (log + chunk.toString()).slice(-20_000);
  };
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  let projectId = '';
  let testError;

  try {
    stage = 'waiting for /api/health';
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server exited before becoming ready (${child.exitCode ?? child.signalCode}):\n${log}`);
      }
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(750) });
        if (response.ok) { ready = true; break; }
      } catch (error) {
        if (error?.name !== 'TimeoutError' && error?.name !== 'AbortError' && error?.cause?.code !== 'ECONNREFUSED') {
          // Connection-refused is expected while the server is starting. Other
          // transient fetch errors are retried until the bounded startup deadline.
        }
      }
      await sleep(125);
    }
    assert.equal(ready, true, `server did not start within ${STARTUP_TIMEOUT_MS}ms:\n${log}`);

    stage = 'checking unauthenticated access';
    assert.equal((await request(`${base}/api/projects`)).status, 401);

    stage = 'logging in';
    const login = await request(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASS }),
    });
    assert.equal(login.status, 200, `login failed; server log:\n${log}`);
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, 'login response did not set a session cookie');

    stage = 'checking login audit event';
    const pool = await getPool();
    const loginAudit = await pool.query(`SELECT 1 FROM audit_events WHERE event_type='auth.login.succeeded' AND details->>'auth_mode'='password' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(loginAudit.rowCount, 1, 'successful Project Mode login must be audited');

    stage = 'checking CSRF rejection';
    const csrf = await request(`${base}/api/projects`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'should be rejected' }),
    });
    assert.equal(csrf.status, 403);

    stage = 'creating project';
    const created = await request(`${base}/api/projects`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ name: `BX06 ${Date.now()}`, state: { phase: 'draft' } }),
    });
    assert.equal(created.status, 201, `project creation failed; server log:\n${log}`);
    const createdJson = await created.json();
    projectId = createdJson.data.id;

    stage = 'updating project state';
    const update = await request(`${base}/api/projects/${projectId}/state`, {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ expected_version: 1, state: { phase: 'active' } }),
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).data.state_version, 2);

    stage = 'checking optimistic concurrency conflict';
    const stale = await request(`${base}/api/projects/${projectId}/state`, {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ expected_version: 1, state: { phase: 'stale' } }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'CONFLICT');

    stage = 'checking state version history';
    const versions = await request(`${base}/api/projects/${projectId}/versions`, { headers: { cookie } });
    assert.equal(versions.status, 200);
    assert.equal((await versions.json()).data.length, 2);
  } catch (error) {
    testError = new Error(`BX-06 API test failed while ${stage}: ${error?.stack || error}\n--- child server log ---\n${log}`);
  } finally {
    // Stop the server first so it cannot keep DB connections or requests active.
    try {
      await stopChild(child);
    } catch (error) {
      console.error(`Could not stop test server cleanly: ${error}`);
    }

    if (projectId) {
      try {
        const pool = await getPool();
        await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
      } catch (error) {
        console.error(`Could not remove temporary project ${projectId}: ${error}`);
        if (!testError) testError = error;
      }
    }

    try {
      await closeDatabase();
    } catch (error) {
      console.error(`Could not close test database pool: ${error}`);
      if (!testError) testError = error;
    }
  }

  if (testError) throw testError;
});
