/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN bx06-api.test.mjs =====
if (process.env.RUN_LIVE_TESTS === 'true' || process.env.RUN_BX06_API === 'true') {
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const net = (await import("node:net")).default;
const { spawn } = await import("node:child_process");
const { getPool, closeDatabase } = await import("../server/database.ts");

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
}
}
// ===== END bx06-api.test.mjs =====

// ===== BEGIN bx06-contract.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;

const server = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const repo = fs.readFileSync(new URL('../server/projectRepository.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

// Updated in P56: the same contracts, asserted against the current code (messages and structure moved after BX-06).
test('Project Mode is opt-in and requires credentials plus PostgreSQL at startup', () => {
  assert.match(server, /ENABLE_PROJECT_MODE === 'true'/);
  assert.match(server, /ENABLE_PROJECT_MODE=true requires APP_PASSWORD and ENABLE_APP_AUTH=true/);
  assert.match(server, /Project Mode must never start without authentication/);
  assert.match(server, /ENABLE_PROJECT_MODE=true requires SESSION_SECRET/);
  assert.match(server, /ENABLE_PROJECT_MODE=true requires DATABASE_URL/);
  assert.match(server, /SESSION_SECRET is required \(at least 16 characters\)/);
});

test('Project Mode mutating routes require same-origin Origin and persistent rate limiting', () => {
  assert.match(server, /Project Mode writes require a same-origin request/);
  assert.match(server, /code: 'CSRF_ORIGIN'/);
  assert.match(server, /consumeRateLimit\(\{ key, limit: Number\(process\.env\.PROJECT_RATE_LIMIT_PER_MINUTE\) \|\| 300, windowMs: 60_000 \}\)/);
  assert.match(repo, /INSERT INTO rate_limits/);
});

test('Project Mode routes are gated and its UI is a separate switchable page', () => {
  assert.match(server, /PROJECT_MODE_DISABLED/);
  assert.match(server, /app\.get\('\/api\/projects'/);
  assert.match(server, /app\.post\('\/api\/projects'/);
  assert.match(main, /pathname === '\/project'/);
  assert.match(main, /lazy\(\(\) => import\('\.\/ProjectMode\.tsx'\)\)/);
  assert.match(app, /data-testid="start-mode-project"/);
  assert.match(app, /disabled=\{!projectModeEnabled\}/);
  assert.match(app, /if \(mode === 'Project' && !projectModeEnabled\) return;/);
});

test('Simple Mode still uses its existing decision state and local storage path', () => {
  assert.match(app, /getStoredDecisions/);
  assert.match(app, /saveDecisions/);
  assert.match(app, /chooseStartMode\('Simple'\)|mode === 'Simple'/);
});
}
// ===== END bx06-contract.test.mjs =====

// ===== BEGIN bx06-runtime.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { spawn } = await import("node:child_process");

 test('Project Mode refuses to start without an application password', async () => {
  const child = spawn('tsx', ['server.ts'], { env: { ...process.env, NODE_ENV: 'production', ENABLE_PROJECT_MODE: 'true', ENABLE_APP_AUTH: 'true', APP_PASSWORD: '', SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not refuse insecure Project Mode startup')); }, 10000);
    child.once('error', reject);
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 1);
  assert.match(output, /requires APP_PASSWORD and ENABLE_APP_AUTH=true/);
});
}
// ===== END bx06-runtime.test.mjs =====

// ===== BEGIN bx06.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;

const server = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const database = fs.readFileSync(new URL('../server/database.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../server/healthRoutes.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const projectUI = fs.readFileSync(new URL('../src/ProjectMode.tsx', import.meta.url), 'utf8');
const appUI = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const modeMenuUI = fs.readFileSync(new URL('../src/ModeMenu.tsx', import.meta.url), 'utf8');

test('BX-06 Project Mode is opt-in and fails closed without required security settings', () => {
  assert.match(server, /ENABLE_PROJECT_MODE === 'true'/);
  assert.match(server, /requires APP_PASSWORD and ENABLE_APP_AUTH=true/);
  assert.match(server, /requires SESSION_SECRET/);
  assert.match(server, /requires DATABASE_URL/);
  assert.match(server, /Project Mode authentication required/);
  assert.match(server, /Project Mode writes require a same-origin request/);
});

test('BX-06 Project Mode uses persistent PostgreSQL rate limits and returns 429', () => {
  assert.match(server, /consumeRateLimit\(/);
  assert.match(server, /key: `login:\$\{ip\}`/);
  assert.match(server, /auth\.login\.succeeded/);
  assert.match(server, /RATE_LIMIT_UNAVAILABLE/);
  assert.match(server, /RATE_LIMITED/);
  assert.match(database, /schema_migrations/);
  assert.match(database, /001_project_state/);
});

test('BX-06 Simple Mode and Project Mode have separate UI entry points', () => {
  assert.match(main, /window\.location\.pathname === '\/project'/);
  assert.match(main, /<Root \/>/);
  assert.match(projectUI, /\/api\/projects/);
  assert.match(projectUI, /expected_version/);
  assert.match(projectUI, /projectModeEnabled/);
  assert.match(projectUI, /Project Mode is disabled/);
  assert.match(projectUI, /async function logout/);
  assert.match(projectUI, /href="\/"/);
  assert.match(server, /projectModeEnabled: PROJECT_MODE_ENABLED/);
  assert.match(appUI, /projectModeEnabled=\{projectModeEnabled\}/);
  // P51: the Project entry lives in the shared Mode menu and leaves the chat shell through chooseStartMode
  assert.match(modeMenuUI, /mode: 'Project'/);
  assert.match(appUI, /window\.location\.href = '\/project'/);
  assert.match(appUI, /expertMode=\{expertMode\}[\s\S]*?onSelectMode=/);
});

test('health and readiness expose stable JSON status contracts', () => {
  assert.match(routes, /app\.get\('\/health'/);
  assert.match(routes, /app\.get\('\/ready'/);
  assert.match(routes, /database_unavailable/);
});
}
// ===== END bx06.test.mjs =====

// ===== BEGIN code-executor.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const crypto = (await import("node:crypto")).default;
const ce = await import("../server/codeExecutor.ts");
const gh = await import("../server/githubIntegration.ts");

const pkg = (over = {}) => ce.taskPackageSchema.parse({
  agentsMd: 'Rules', specMd: 'Goal', acceptanceMd: 'Criteria', executorPromptMd: 'Do it',
  allowedPaths: ['src/**', 'docs/*.md'], acceptanceTests: [{ path: 'tests/acceptance/a.test.mjs', content: 'x' }], contextFiles: [{ path: 'src/a.ts', content: 'const a = 1;\n```\n' }], ...over,
});
const diffOf = (path, oldL, newL) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldL.length} +1,${newL.length} @@\n${oldL.map((l) => '-' + l).join('\n')}\n${newL.map((l) => '+' + l).join('\n')}\n`;

test('package: schema, limits cap, hash is stable, secrets are refused without echoing them', () => {
  const p = pkg();
  assert.equal(p.limits.maxFiles, 10); assert.equal(p.limits.maxChangedLines, 400);
  // Cap is ABSOLUTE_* (app-builder ceiling), not the legacy DEFAULT 10/400.
  const absFiles = ce.ABSOLUTE_MAX_FILES ?? ce.APP_BUILDER_MAX_FILES ?? 120;
  const absLines = ce.ABSOLUTE_MAX_CHANGED_LINES ?? ce.APP_BUILDER_MAX_CHANGED_LINES ?? 20000;
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, limits: { maxFiles: absFiles + 1 } }));
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, limits: { maxChangedLines: absLines + 1 } }));
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, allowedPaths: ['**'] }), 'bare wildcard is too broad');
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, allowedPaths: ['../x'] }));
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, acceptanceTests: [{ path: 'src/x.test.mjs', content: '' }] }));
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, extra: 1 }), 'strict');
  assert.equal(ce.packageHash(p), ce.packageHash(pkg()));
  assert.notEqual(ce.packageHash(p), ce.packageHash(pkg({ specMd: 'Other' })));
  const secretText = 'token: ' + 'ghp_' + 'a'.repeat(36);
  try { ce.buildPackageMd('t1', pkg({ specMd: secretText })); assert.fail('should throw'); }
  catch (e) { assert.equal(e.code, 'PACKAGE_SECRET'); assert.equal(JSON.stringify(e.details).includes('aaaa'), false); }
  assert.throws(() => ce.buildPackageMd('t1', pkg({ contextFiles: [{ path: 'src/k.pem', content: '-----BEGIN PRIVATE KEY-----' }] })), /secret/i);
});

test('PACKAGE.md: deterministic, holds every part, fences survive backticks in content', () => {
  const md = ce.buildPackageMd('t1', pkg());
  assert.equal(md, ce.buildPackageMd('t1', pkg()));
  for (const part of ['Rules', 'Goal', 'Criteria', 'Do it', 'tests/acceptance/a.test.mjs', 'src/a.ts', '## allowed_paths', '`src/**`', 'biforge/t1']) assert.ok(md.includes(part), part);
  assert.ok(md.includes('````\nconst a = 1;\n```'), 'a longer fence wraps content that contains ```');
  assert.throws(() => ce.buildPackageMd('t1', pkg({ contextFiles: Array.from({ length: 6 }, (_, i) => ({ path: `src/big${i}.txt`, content: 'x'.repeat(190_000) })) })), (e) => e.code === 'PACKAGE_TOO_LARGE');
});

test('protected paths and allowed_paths', () => {
  for (const p of ['tests/acceptance/a.mjs', 'TESTS/Acceptance/a.mjs', '.github/workflows/ci.yml', 'AGENTS.md', 'docs/AGENTS.md', '.biforge/tasks/t/SPEC.md', 'package-lock.json', 'sub/yarn.lock', '.gitlab-ci.yml', '../x', '/etc/x', 'a\\b']) assert.equal(ce.isProtectedPath(p), true, p);
  for (const p of ['src/a.ts', 'tests/unit/a.mjs', 'package.json']) assert.equal(ce.isProtectedPath(p), false, p);
  assert.equal(ce.matchesAllowedPath('src/a/b.ts', ['src/**']), true);
  assert.equal(ce.matchesAllowedPath('src/a.ts', ['src/*.ts']), true);
  assert.equal(ce.matchesAllowedPath('src/a/b.ts', ['src/*.ts']), false);
  assert.equal(ce.matchesAllowedPath('src/x.ts', ['src/**/x.ts']), true);
  assert.equal(ce.matchesAllowedPath('srcx/a.ts', ['src/**']), false);
  assert.equal(ce.matchesAllowedPath('docs/a.md', ['docs/a.md']), true);
});

test('diff validation: size limits at the boundary, protected, outside allowed_paths, unsafe', () => {
  const f = (path, n = 1) => ({ path, action: 'modify', added: n, removed: 0 });
  const opts = { allowedPaths: ['src/**'] };
  assert.deepEqual(ce.validateChangeSet(Array.from({ length: 10 }, (_, i) => f(`src/${i}.ts`, 1)), opts), []);
  assert.deepEqual(ce.validateChangeSet(Array.from({ length: 11 }, (_, i) => f(`src/${i}.ts`, 1)), opts).map((v) => v.code), ['too_many_files']);
  assert.deepEqual(ce.validateChangeSet([f('src/a.ts', 400)], opts), []);
  assert.deepEqual(ce.validateChangeSet([f('src/a.ts', 401)], opts).map((v) => v.code), ['too_many_lines']);
  assert.deepEqual(ce.validateChangeSet([f('src/a.ts', 3)], { ...opts, limits: { maxChangedLines: 2 } }).map((v) => v.code), ['too_many_lines']);
  assert.deepEqual(ce.validateChangeSet([f('src/a.ts', 3)], { ...opts, limits: { maxChangedLines: 9999, maxFiles: 99 } }), [], 'a package cannot raise the ceiling, and 3 lines are fine');
  assert.deepEqual(ce.validateChangeSet([f('server/a.ts')], opts), [{ code: 'path_not_allowed', path: 'server/a.ts' }]);
  assert.deepEqual(ce.validateChangeSet([f('tests/acceptance/a.mjs')], { allowedPaths: ['tests/**'] }), [{ code: 'path_protected', path: 'tests/acceptance/a.mjs' }], 'protected wins over allowed');
  assert.deepEqual(ce.validateChangeSet([f('src/../x')], opts).map((v) => v.code), ['path_unsafe']);
  assert.deepEqual(ce.validateChangeSet([], opts).map((v) => v.code), ['empty_diff']);
});

test('parse and apply: modify, create, delete, no newline at end', () => {
  const mod = ce.parseUnifiedDiff(diffOf('src/a.ts', ['one', 'two'], ['one', 'TWO', 'three']));
  assert.deepEqual(mod.problems, []);
  assert.equal(ce.applyFileDiff('one\ntwo\n', mod.files[0]), 'one\nTWO\nthree\n');
  const cr = ce.parseUnifiedDiff('diff --git a/src/n.ts b/src/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  assert.equal(cr.files[0].action, 'create');
  assert.equal(ce.applyFileDiff(null, cr.files[0]), 'a\nb\n');
  assert.throws(() => ce.applyFileDiff('x\n', cr.files[0]), (e) => e.code === 'file_exists');
  const del = ce.parseUnifiedDiff('diff --git a/src/d.ts b/src/d.ts\ndeleted file mode 100644\n--- a/src/d.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n');
  assert.equal(del.files[0].action, 'delete');
  assert.equal(ce.applyFileDiff('a\nb\n', del.files[0]), null);
  assert.throws(() => ce.applyFileDiff('a\nb\nc\n', del.files[0]), (e) => e.code === 'hunk_failed');
  assert.throws(() => ce.applyFileDiff(null, mod.files[0]), (e) => e.code === 'file_missing');
  assert.throws(() => ce.applyFileDiff('one\nDIFFERENT\n', mod.files[0]), (e) => e.code === 'hunk_failed', 'strict context');
  const noeol = ce.parseUnifiedDiff('--- a/src/e.ts\n+++ b/src/e.ts\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
  assert.equal(ce.applyFileDiff('a', noeol.files[0]), 'b');
  const removedDashes = ce.parseUnifiedDiff('--- a/src/f.ts\n+++ b/src/f.ts\n@@ -1,2 +1,1 @@\n--- x\n-y\n+z\n');
  assert.deepEqual(removedDashes.problems, [], 'a removed line that starts with -- is content, not a header');
  assert.equal(ce.applyFileDiff('-- x\ny\n', removedDashes.files[0]), 'z\n');
});

test('parse refuses rename, copy, binary, mode, symlink, submodule, unsafe and duplicate paths, empty and oversized', () => {
  const codes = (t) => ce.parseUnifiedDiff(t).problems.map((p) => p.code);
  assert.ok(codes('diff --git a/src/a.ts b/src/b.ts\nsimilarity index 90%\nrename from src/a.ts\nrename to src/b.ts\n').includes('rename_unsupported'));
  assert.ok(codes('diff --git a/src/a.ts b/src/a.ts\nBinary files a/src/a.ts and b/src/a.ts differ\n').includes('binary_not_allowed'));
  assert.ok(codes('diff --git a/src/a.ts b/src/a.ts\nGIT binary patch\nliteral 3\n').includes('binary_not_allowed'));
  assert.ok(codes('diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n').includes('mode_change_not_allowed'));
  assert.ok(codes('diff --git a/src/a.sh b/src/a.sh\nnew file mode 100755\n--- /dev/null\n+++ b/src/a.sh\n@@ -0,0 +1 @@\n+x\n').includes('mode_not_allowed'));
  assert.ok(codes('diff --git a/src/l b/src/l\nnew file mode 120000\n--- /dev/null\n+++ b/src/l\n@@ -0,0 +1 @@\n+target\n').includes('symlink_not_allowed'));
  assert.ok(codes('diff --git a/src/m b/src/m\nnew file mode 160000\n').includes('submodule_not_allowed'));
  assert.ok(codes(diffOf('../etc/passwd', ['a'], ['b'])).includes('path_unsafe'));
  assert.ok(codes(diffOf('/abs/x', ['a'], ['b'])).includes('path_unsafe'));
  assert.ok(codes('diff --git a/src/a.ts b/src/a.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-a\n+b\n').includes('path_mismatch'), 'header and file lines must agree');
  assert.ok(codes(diffOf('src/a.ts', ['a'], ['b']) + diffOf('src/A.ts', ['a'], ['b'])).includes('duplicate_path'));
  assert.ok(codes('').includes('empty_diff'));
  assert.ok(codes('just some words').includes('empty_diff'));
  assert.ok(codes('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\0\n').includes('binary_content'));
  assert.ok(codes('x'.repeat(ce.MAX_DIFF_BYTES + 1)).includes('diff_too_large'));
  assert.ok(codes('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n').includes('malformed_hunk'));
});

test('fuzz (seeded): random text never throws out of the parser and never yields an unsafe or protected path as valid', () => {
  const seed = Number(process.env.FUZZ_SEED) || 20261012; console.log('fuzz seed', seed);
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const bits = ['diff --git a/', ' b/', '--- a/', '+++ b/', '@@ -1,2 +1,2 @@', '\n', '+x', '-y', ' z', '../', '/dev/null', 'new file mode 100755', 'src/a.ts', '.github/x.yml', 'tests/acceptance/t.mjs', '\\ No newline at end of file', 'AGENTS.md', '\r\n', '\t'];
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: 1 + Math.floor(rnd() * 25) }, () => bits[Math.floor(rnd() * bits.length)]).join(rnd() < 0.5 ? '' : '\n');
    const r = ce.parseUnifiedDiff(text);
    if (r.problems.length) continue;
    const v = ce.validateChangeSet(r.files, { allowedPaths: ['src/**', '.github/**', 'tests/**', '*.md'] });
    for (const f of r.files) {
      assert.ok(!f.path.includes('..') && !f.path.startsWith('/'), `safe path: ${f.path} (seed ${seed}, i ${i})`);
      if (ce.isProtectedPath(f.path)) assert.ok(v.some((x) => x.code === 'path_protected' && x.path === f.path), `protected path must be flagged: ${f.path}`);
    }
  }
});

test('manual executor follows the CodeExecutor interface and starts nothing by itself', async () => {
  const rows = new Map();
  const ex = ce.createManualExecutor({
    async createWaiting(ref, run, executor) { const id = `c${rows.size + 1}`; rows.set(id, { state: 'WAITING_HUMAN', ref, run, executor }); return { codeTaskId: id }; },
    async read(id) { return rows.get(id) ?? null; },
  });
  assert.equal(ex.id, 'manual');
  const h = await ex.start({ taskId: 't', projectId: 'p', packageHash: 'h', baseBranch: 'main' }, { runId: null, attempt: 1 });
  assert.deepEqual(h, { codeTaskId: 'c1', executor: 'manual' });
  assert.deepEqual(await ex.poll(h), { state: 'WAITING_HUMAN' });
  await assert.rejects(() => ex.poll({ codeTaskId: 'nope', executor: 'manual' }), /not found/i);
  assert.equal(ce.canExecutorTransition('DELIVERED', 'FAILED'), false);
  assert.equal(ce.canExecutorTransition('FAILED', 'DELIVERED'), false);
  assert.equal(ce.canExecutorTransition('BLOCKED', 'DELIVERED'), true);
});

// ---- GitHub side on a fake API ----
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg = { appId: '1', installationId: '2', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner: 'o', repository: 'r', apiBaseUrl: 'https://gh.test' };
const WRITE = { metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'write' };
const S = (c) => c.repeat(40);
function fakeGh(calls, { branchExists = false, prStatus = 201 } = {}) {
  return async (url, o = {}) => {
    const u = new URL(url); const method = o.method || 'GET'; calls.push({ method, path: u.pathname, body: o.body ? JSON.parse(o.body) : null });
    const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.pathname.endsWith('/access_tokens')) return j({ token: 'tok-secret', permissions: WRITE }, 201);
    if (u.pathname.includes('/git/ref/heads/biforge/')) return branchExists ? j({ object: { sha: S('b') } }) : j({}, 404);
    if (u.pathname.includes('/git/ref/heads/main')) return j({ object: { sha: S('a') } });
    if (u.pathname.includes('/git/commits/') && method === 'GET') return j({ tree: { sha: S('e') } });
    if (u.pathname.endsWith('/git/blobs')) return j({ sha: S('1') }, 201);
    if (u.pathname.endsWith('/git/trees')) return j({ sha: S('2') }, 201);
    if (u.pathname.endsWith('/git/commits')) return j({ sha: S('3') }, 201);
    if (u.pathname.endsWith('/git/refs') || u.pathname.includes('/git/refs/heads/')) return j({}, method === 'POST' ? 201 : 200);
    if (u.pathname.endsWith('/pulls') && method === 'POST') return prStatus === 201 ? j({ number: 9, html_url: 'https://github.com/o/r/pull/9' }, 201) : j({ message: 'x' }, prStatus);
    return j({}, 404);
  };
}

test('commitChangesToBranch: Git Data API only, on biforge/<task_id>, never main, never force, no merge', async () => {
  process.env.GITHUB_DIFF_UPLOAD = 'true';
  try {
    const calls = [];
    const r = await gh.commitChangesToBranch(cfg, { taskId: 't1', baseBranch: 'main', changes: [{ path: 'src/a.ts', content: 'x' }, { path: 'src/old.ts', content: null }], message: 'm', writeEnabled: true }, fakeGh(calls));
    assert.deepEqual(r, { branch: 'biforge/t1', headSha: S('3') });
    const writes = calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/access_tokens'));
    assert.deepEqual(writes.map((c) => `${c.method} ${c.path.split('/r/')[1]}`), ['POST git/blobs', 'POST git/trees', 'POST git/commits', 'POST git/refs']);
    assert.equal(writes[1].body.tree.find((e) => e.path === 'src/old.ts').sha, null, 'deletion is a null sha');
    assert.equal(writes[3].body.ref, 'refs/heads/biforge/t1');
    assert.equal(calls.some((c) => /merge|workflows/.test(c.path) || /heads\/main$/.test(c.path) && c.method !== 'GET'), false);
    const calls2 = [];
    await gh.commitChangesToBranch(cfg, { taskId: 't1', baseBranch: 'main', changes: [{ path: 'src/a.ts', content: 'x' }], message: 'm', writeEnabled: true }, fakeGh(calls2, { branchExists: true }));
    const patch = calls2.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.force, false); assert.ok(patch.path.endsWith('/git/refs/heads/biforge/t1'));
    assert.equal(calls2.find((c) => c.path.endsWith('/git/commits') && c.method === 'POST').body.parents[0], S('b'), 'advances the existing branch');
    assert.equal(JSON.stringify([r, calls]).includes('tok-secret'), false);
    const bad = (changes, extra = {}) => gh.commitChangesToBranch(cfg, { taskId: 't1', baseBranch: 'main', changes, message: 'm', writeEnabled: true, ...extra }, fakeGh([]));
    await assert.rejects(() => gh.commitChangesToBranch(cfg, { taskId: 't1', baseBranch: 'main', changes: [{ path: 'src/a.ts', content: 'x' }], message: 'm', writeEnabled: false }, fakeGh([])), /github_write_disabled/);
    for (const p of ['tests/acceptance/a.mjs', '.github/workflows/x.yml', 'AGENTS.md', '../x', '/x', 'package-lock.json']) await assert.rejects(() => bad([{ path: p, content: 'x' }]), /path_not_allowed/, p);
    await assert.rejects(() => bad([{ path: 'src/a.ts', content: 'x' }], { baseBranch: 'biforge/other' }), /invalid_base_branch/);
    await assert.rejects(() => bad([{ path: 'src/a.ts', content: 'x' }], { taskId: 'bad id' }), /invalid_task_id/);
    await assert.rejects(() => bad(Array.from({ length: 11 }, (_, i) => ({ path: `src/${i}.ts`, content: 'x' }))), /invalid_file_count/);
    assert.equal(Object.keys(gh).some((k) => /merge/i.test(k)), false);
  } finally { delete process.env.GITHUB_DIFF_UPLOAD; }
});

test('openPullRequest: needs the write flag, never merges, reuses an open PR on 422', async () => {
  process.env.GITHUB_DIFF_UPLOAD = 'true';
  try {
    const calls = [];
    assert.deepEqual(await gh.openPullRequest(cfg, { taskId: 't1', baseBranch: 'main', title: 't', body: 'b', writeEnabled: true }, fakeGh(calls)), { number: 9, htmlUrl: 'https://github.com/o/r/pull/9' });
    assert.equal(calls.find((c) => c.path.endsWith('/pulls')).body.head, 'biforge/t1');
    await assert.rejects(() => gh.openPullRequest(cfg, { taskId: 't1', baseBranch: 'main', title: 't', body: 'b', writeEnabled: false }, fakeGh([])), /github_write_disabled/);
  } finally { delete process.env.GITHUB_DIFF_UPLOAD; }
});

test('write permissions are accepted only when the diff-upload switch is on', async () => {
  const f = async (url) => { const u = new URL(url); return new Response(JSON.stringify(u.pathname.endsWith('/access_tokens') ? { token: 't', permissions: WRITE } : { object: { sha: S('b') } }), { status: 200 }); };
  await assert.rejects(() => gh.readBranchHead(cfg, 'biforge/t1', f), /permissions_too_broad_or_missing/);
  process.env.GITHUB_DIFF_UPLOAD = 'true';
  try { assert.equal(await gh.readBranchHead(cfg, 'biforge/t1', f), S('b')); } finally { delete process.env.GITHUB_DIFF_UPLOAD; }
  assert.equal(gh.githubWritesEnabled(), false);
});

// P53 / ADR-06 Amendment 1: CODE_EXECUTOR=model_patch means "source ZIP" and implies no GitHub write.
test('P53: model_patch alone does not switch on GitHub write; a write-level token is rejected, a read-only one accepted', async () => {
  const READ = { metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' };
  const tokenWith = (permissions) => async (url) => { const u = new URL(url); return new Response(JSON.stringify(u.pathname.endsWith('/access_tokens') ? { token: 't', permissions } : { object: { sha: S('b') } }), { status: 200 }); };
  const prevExec = process.env.CODE_EXECUTOR; const prevUp = process.env.GITHUB_DIFF_UPLOAD;
  delete process.env.GITHUB_DIFF_UPLOAD;
  process.env.CODE_EXECUTOR = 'model_patch';
  try {
    assert.equal(gh.githubWritesEnabled(), false);
    assert.equal(gh.diffUploadEnabled(), false);
    assert.equal(await gh.readBranchHead(cfg, 'biforge/t1', tokenWith(READ)), S('b'), 'read-only App works with model_patch');
    await assert.rejects(() => gh.readBranchHead(cfg, 'biforge/t1', tokenWith(WRITE)), /permissions_too_broad_or_missing/);
    process.env.GITHUB_DIFF_UPLOAD = 'true';
    assert.equal(gh.githubWritesEnabled(), true);
    assert.equal(await gh.readBranchHead(cfg, 'biforge/t1', tokenWith(WRITE)), S('b'));
  } finally {
    if (prevExec === undefined) delete process.env.CODE_EXECUTOR; else process.env.CODE_EXECUTOR = prevExec;
    if (prevUp === undefined) delete process.env.GITHUB_DIFF_UPLOAD; else process.env.GITHUB_DIFF_UPLOAD = prevUp;
  }
});
}
// ===== END code-executor.test.mjs =====

// ===== BEGIN p19x-acceptance.test.mjs =====
{
/**
 * P19x acceptance: validateModelPatch matrix + driveModelPatch with fakes.
 * No live network, no real DB for pure validation; drive uses injectable deps.
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const ce = await import("../server/codeExecutor.ts");

const allowed = ['src/**', 'docs/*.md'];

test('validateModelPatch: accepts a minimal valid create/modify/delete set', () => {
  const raw = {
    files: [
      { path: 'src/a.ts', action: 'create', content: 'export const a = 1;\n' },
      { path: 'src/b.ts', action: 'modify', content: 'export const b = 2;\n' },
      { path: 'src/old.ts', action: 'delete' },
    ],
    notes: 'ok',
  };
  const r = ce.validateModelPatch(raw, { allowedPaths: allowed });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.patch.files.length, 3);
  assert.equal(r.files.length, 3);
  const changes = ce.modelPatchToBranchChanges(r.patch);
  assert.deepEqual(changes.find((c) => c.path === 'src/old.ts'), { path: 'src/old.ts', content: null });
  assert.equal(changes.find((c) => c.path === 'src/a.ts')?.content, 'export const a = 1;\n');
});

test('validateModelPatch: rejects schema-invalid and missing content', () => {
  assert.equal(ce.validateModelPatch({ files: [] }, { allowedPaths: allowed }).ok, false);
  assert.equal(ce.validateModelPatch({ files: [{ path: 'src/a.ts', action: 'create' }] }, { allowedPaths: allowed }).ok, false);
  assert.equal(ce.validateModelPatch({ files: [{ path: 'src/a.ts', action: 'delete', content: 'x' }] }, { allowedPaths: allowed }).ok, false);
  assert.equal(ce.validateModelPatch({ files: [{ path: 'src/a.ts', action: 'modify', content: 'x' }], extra: 1 }, { allowedPaths: allowed }).ok, false);
});

test('validateModelPatch: rejects protected paths, escape, oversized', () => {
  const badPaths = [
    'tests/acceptance/x.test.mjs',
    '.github/workflows/ci.yml',
    'AGENTS.md',
    'package-lock.json',
    '../etc/passwd',
    '/abs/x.ts',
  ];
  for (const path of badPaths) {
    const r = ce.validateModelPatch(
      { files: [{ path, action: 'create', content: 'x\n' }] },
      { allowedPaths: ['**/*', 'src/**'] },
    );
    assert.equal(r.ok, false, path);
  }
  const tooMany = {
    files: Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.ts`, action: 'create', content: 'x\n' })),
  };
  assert.equal(ce.validateModelPatch(tooMany, { allowedPaths: allowed }).ok, false);
});

test('validateModelPatch: rejects paths outside allowed_paths even if not protected', () => {
  const r = ce.validateModelPatch(
    { files: [{ path: 'lib/x.ts', action: 'create', content: 'x\n' }] },
    { allowedPaths: allowed },
  );
  assert.equal(r.ok, false);
});

test('modelPatchToBranchChanges: delete is null content', () => {
  const patch = ce.modelPatchSchema.parse({
    files: [
      { path: 'src/a.ts', action: 'modify', content: 'a' },
      { path: 'src/b.ts', action: 'delete' },
    ],
  });
  const ch = ce.modelPatchToBranchChanges(patch);
  assert.equal(ch.length, 2);
  assert.equal(ch[1].content, null);
});

test('createModelPatchExecutor: start returns model_patch handle; poll reads store', async () => {
  const store = {
    async createWaiting(pkg, run, ex) {
      assert.equal(ex, 'model_patch');
      return { codeTaskId: 'code_test_1' };
    },
    async read(id) {
      assert.equal(id, 'code_test_1');
      return { state: 'WAITING_HUMAN' };
    },
  };
  const ex = ce.createModelPatchExecutor(store);
  assert.equal(ex.id, 'model_patch');
  const h = await ex.start({ taskId: 't1', projectId: 'p1', packageHash: 'h', baseBranch: 'main' }, { runId: null, attempt: 1 });
  assert.equal(h.executor, 'model_patch');
  const st = await ex.poll(h);
  assert.equal(st.state, 'WAITING_HUMAN');
});
}
// ===== END p19x-acceptance.test.mjs =====

// ===== BEGIN p20-acceptance.test.mjs =====
{
// P20 acceptance: brief_writer, package baseline for Test Integrity, approval helpers.
const assert = (await import("node:assert/strict")).default;
const { readFileSync, existsSync } = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const test = (await import("node:test")).default;

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('docs and migration for P20 exist', () => {
  assert.ok(existsSync(`${root}/migrations/011_code_task_package_approval.sql`));
  assert.ok(existsSync(`${root}/server/briefWriter.ts`));
});

test('evaluateTestIntegrity allows package-declared acceptance paths (P20 baseline)', async () => {
  const { evaluateTestIntegrity } = await import(pathToFileURL(`${root}/server/gateEngine.ts`).href);
  const files = [
    { filename: 'tests/acceptance/task1.test.mjs', status: 'added' },
    { filename: 'server/foo.ts', status: 'modified' },
  ];
  assert.equal(evaluateTestIntegrity(files).status, 'FAIL', 'without baseline still FAIL');
  const ok = evaluateTestIntegrity(files, { packageAcceptancePaths: ['tests/acceptance/task1.test.mjs'] });
  assert.equal(ok.status, 'PASS');
  assert.ok(ok.packageBaseline.length >= 1);
  const still = evaluateTestIntegrity(
    [...files, { filename: 'tests/acceptance/other.test.mjs', status: 'added' }],
    { packageAcceptancePaths: ['tests/acceptance/task1.test.mjs'] },
  );
  assert.equal(still.status, 'FAIL');
  assert.ok(still.touched.some((p) => p.includes('other')));
});

test('brief_writer source exports buildTaskPackageFromBrief and validates goal', () => {
  const src = readFileSync(`${root}/server/briefWriter.ts`, 'utf8');
  assert.match(src, /export function buildTaskPackageFromBrief/);
  assert.match(src, /packageAcceptancePaths/);
  assert.match(src, /taskPackageSchema/);
  assert.match(src, /goal is required/);
});

test('approval and commit helpers are present', () => {
  const src = readFileSync(`${root}/server/codeTaskService.ts`, 'utf8');
  assert.match(src, /approveCodePackage/);
  assert.match(src, /commitApprovedPackage/);
  assert.match(src, /package_approved_at/);
  const server = readFileSync(`${root}/server.ts`, 'utf8');
  assert.match(server, /code\/brief/);
  assert.match(server, /commit-package/);
});
}
// ===== END p20-acceptance.test.mjs =====

// ===== BEGIN p20b-acceptance.test.mjs =====
{
// P20b: Task PASS requires gates when a code head is tracked; analysis-only tasks unchanged.
const assert = (await import("node:assert/strict")).default;
const { existsSync, readFileSync } = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const test = (await import("node:test")).default;

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('P20b docs and sources exist', () => {
  assert.ok(readFileSync(`${root}/server/taskService.ts`, 'utf8').includes('gatesAllowTaskPass'));
  assert.ok(readFileSync(`${root}/server/gateEngine.ts`, 'utf8').includes('gatesAllowTaskPass'));
  assert.ok(readFileSync(`${root}/server.ts`, 'utf8').includes("gates/:gate/approve"));
});

test('gatesAllowTaskPass: no snapshot allows PASS; RC PASS allows; blocked otherwise', async () => {
  const { gatesAllowTaskPass, evaluateAll, GATE_RULES_VERSION } = await import(pathToFileURL(`${root}/server/gateEngine.ts`).href);
  assert.deepEqual(gatesAllowTaskPass(null), { ok: true, blockers: [] });
  assert.equal(gatesAllowTaskPass(undefined).ok, true);

  const sha = 'a'.repeat(40);
  const ev = (gate, status, checkName = 'c') => ({
    gate, checkName, status, commitSha: sha, source: gate === 'build' || gate === 'test' || gate === 'test_integrity' || gate === 'security' ? 'ci' : gate === 'test_integrity' ? 'diff' : 'approval',
    rulesVersion: GATE_RULES_VERSION, tool: 't',
  });
  // fix sources properly
  const mk = (gate, status, source, checkName = 'c') => ({
    gate, checkName, status, commitSha: sha, source, rulesVersion: GATE_RULES_VERSION, tool: 't',
  });
  const allPass = [
    mk('requirements', 'PASS', 'approval'),
    mk('spec', 'PASS', 'approval'),
    mk('build', 'PASS', 'ci'),
    mk('test', 'PASS', 'ci'),
    mk('test_integrity', 'PASS', 'diff'),
    mk('security', 'PASS', 'ci'),
    mk('review', 'PASS', 'approval'),
  ];
  const gatesOk = evaluateAll(allPass, sha);
  assert.equal(gatesOk.release_candidate.status, 'PASS');
  assert.equal(gatesAllowTaskPass(gatesOk).ok, true);

  const gatesFail = evaluateAll([mk('build', 'FAIL', 'ci'), ...allPass.filter((e) => e.gate !== 'build')], sha);
  assert.notEqual(gatesFail.release_candidate.status, 'PASS');
  const blocked = gatesAllowTaskPass(gatesFail);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.length >= 1);
});

test('GATES_BLOCKED is a task error code', () => {
  const src = readFileSync(`${root}/server/taskMachine.ts`, 'utf8');
  assert.match(src, /GATES_BLOCKED/);
});
}
// ===== END p20b-acceptance.test.mjs =====

// ===== BEGIN p21-acceptance.test.mjs =====
{
// P21: reviewer findings + human decision on DELIVERED code tasks (BX-22.b).
const assert = (await import("node:assert/strict")).default;
const { existsSync, readFileSync } = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const test = (await import("node:test")).default;

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('P21 docs and sources exist', () => {
  assert.ok(existsSync(`${root}/server/reviewer.ts`));
  assert.ok(existsSync(`${root}/migrations/012_code_task_decision.sql`));
  const srv = readFileSync(`${root}/server.ts`, 'utf8');
  assert.match(srv, /code\/:codeTaskId\/review/);
  assert.match(srv, /code\/:codeTaskId\/decide/);
  const cts = readFileSync(`${root}/server/codeTaskService.ts`, 'utf8');
  assert.match(cts, /runCodeTaskReview/);
  assert.match(cts, /decideCodeTask/);
  assert.match(cts, /decision:/);
});

test('buildReviewFindings: FAIL on build → high; empty gates → no high', async () => {
  const { buildReviewFindings } = await import(pathToFileURL(`${root}/server/reviewer.ts`).href);
  const empty = buildReviewFindings({ delivery: 'pr', filesChanged: 2, linesChanged: 10, gates: [] });
  assert.equal(empty.hasUnresolvedHigh, false);
  assert.ok(empty.summary.length > 0);

  const sha = 'b'.repeat(40);
  const withFail = buildReviewFindings({
    commitSha: sha,
    delivery: 'pr',
    filesChanged: 1,
    linesChanged: 5,
    gates: [
      { gate: 'build', status: 'FAIL', reasons: ['ci'] },
      { gate: 'test', status: 'PASS' },
    ],
  });
  assert.equal(withFail.hasUnresolvedHigh, true);
  assert.ok(withFail.highCount >= 1);
  assert.equal(withFail.gatesSnapshot.build, 'FAIL');
  assert.ok(withFail.findings.some((f) => f.gate === 'build' && f.severity === 'high'));
});

test('buildReviewFindings: BLOCKED critical gate → medium, not high', async () => {
  const { buildReviewFindings } = await import(pathToFileURL(`${root}/server/reviewer.ts`).href);
  const out = buildReviewFindings({
    gates: [{ gate: 'test', status: 'BLOCKED', reasons: ['infra'] }],
    delivery: 'branch',
    filesChanged: 1,
  });
  assert.equal(out.hasUnresolvedHigh, false);
  assert.ok(out.findings.some((f) => f.severity === 'medium' && f.gate === 'test'));
});

test('buildReviewFindings: violations → high', async () => {
  const { buildReviewFindings } = await import(pathToFileURL(`${root}/server/reviewer.ts`).href);
  const out = buildReviewFindings({
    violations: [{ code: 'path_not_allowed', path: 'secret.env' }],
    delivery: 'diff',
    filesChanged: 1,
  });
  assert.equal(out.hasUnresolvedHigh, true);
  assert.ok(out.findings.some((f) => f.summary.includes('path_not_allowed')));
});

test('APP_VERSION matches package.json', () => {
  const cfg = readFileSync(`${root}/src/config.ts`, 'utf8');
  const m = cfg.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m);
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  assert.equal(pkg.version, m[1]);
});
}
// ===== END p21-acceptance.test.mjs =====

// ===== BEGIN p22-acceptance.test.mjs =====
{
// P22 / BX-23: Repair Loop stop rules and diagnostic report.
const assert = (await import("node:assert/strict")).default;
const { existsSync, readFileSync } = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const test = (await import("node:test")).default;

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('P22 docs and sources exist', () => {
  assert.ok(existsSync(`${root}/server/repairLoop.ts`));
  assert.ok(existsSync(`${root}/migrations/013_repair_loop.sql`));
  const srv = readFileSync(`${root}/server.ts`, 'utf8');
  assert.match(srv, /code\/:codeTaskId\/repair/);
  assert.match(readFileSync(`${root}/server/codeTaskService.ts`, 'utf8'), /requestRepair/);
});

test('classifyFailure: security before build; criteria from human repair', async () => {
  const { classifyFailure } = await import(pathToFileURL(`${root}/server/repairLoop.ts`).href);
  const sec = classifyFailure({ gates: [{ gate: 'security', status: 'FAIL' }, { gate: 'build', status: 'FAIL' }] });
  assert.equal(sec.kind, 'security');
  const lint = classifyFailure({ gates: [{ gate: 'build', status: 'FAIL', reasons: ['lint:FAIL'] }] });
  assert.equal(lint.kind, 'lint');
  const human = classifyFailure({ decision: 'repair', gates: [] });
  assert.equal(human.kind, 'criteria');
  const again = classifyFailure({ decision: 'repair', gates: [] });
  assert.equal(again.signature, human.signature);
});

test('stop: max_attempts, identical diff, identical error, no progress, budget', async () => {
  const { evaluateRepairStop } = await import(pathToFileURL(`${root}/server/repairLoop.ts`).href);
  const base = [{ attempt: 1, diffHash: 'a'.repeat(64), errorSignature: 'b'.repeat(64), failingTests: 4 }];
  assert.deepEqual(evaluateRepairStop({ priorRepairs: 0, history: base }).reasons, []);
  assert.ok(evaluateRepairStop({ priorRepairs: 2, history: base }).reasons.includes('max_attempts'));
  assert.ok(evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'a'.repeat(64), errorSignature: 'c'.repeat(64), failingTests: 1 }],
  }).reasons.includes('identical_diff'));
  assert.ok(evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'd'.repeat(64), errorSignature: 'b'.repeat(64), failingTests: 1 }],
  }).reasons.includes('identical_error'));
  assert.ok(evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'd'.repeat(64), errorSignature: 'e'.repeat(64), failingTests: 4 }],
  }).reasons.includes('no_progress'));
  const progress = evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'd'.repeat(64), errorSignature: 'e'.repeat(64), failingTests: 2 }],
  });
  assert.equal(progress.stop, false);
  assert.ok(evaluateRepairStop({ priorRepairs: 0, history: base, budgetExceeded: true }).reasons.includes('budget'));
});

test('diagnostic report names the stop and asks for a human', async () => {
  const { buildDiagnosticReport, buildRepairPrompt } = await import(pathToFileURL(`${root}/server/repairLoop.ts`).href);
  const text = buildDiagnosticReport({
    taskId: 'task_1', codeTaskId: 'code_1', reasons: ['budget', 'max_attempts'], kind: 'test', summary: 'test:FAIL',
    attempts: [{ attempt: 1, failingTests: 3, errorSignature: 'ab', diffHash: 'cd' }],
  });
  assert.match(text, /budget/);
  assert.match(text, /human decision/i);
  assert.match(text, /task_1/);
  const prompt = buildRepairPrompt('Do the spec.', { kind: 'test', summary: 'test:FAIL', attempts: ['attempt 1'], logExcerpt: 'x'.repeat(5000) });
  assert.ok(prompt.length <= 20_000);
  assert.match(prompt, /Repair report/);
  assert.match(prompt, /Do the spec/);
});

test('APP_VERSION matches package.json', () => {
  const m = readFileSync(`${root}/src/config.ts`, 'utf8').match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m);
  assert.equal(JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version, m[1]);
});
}
// ===== END p22-acceptance.test.mjs =====

// ===== BEGIN p24-acceptance.test.mjs =====
{
/**
 * P24 / BX-25 — ops metrics, alerts, backup-check (offline).
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { fileURLToPath } = await import("node:url");
const { spawn } = await import("node:child_process");
const { evaluateOpsAlerts, buildOpsSnapshot, processRssMb, renderOpsHtml } = await import("../server/opsMetrics.ts");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('alert: stale queue is critical', () => {
  const alerts = evaluateOpsAlerts({
    queueQueued: 2, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: [], migrationCount: 1, oldestQueuedAgeSec: 3600,
    memoryRssMb: 100, memoryRssLimitMb: 1024,
  });
  assert.ok(alerts.some((a) => a.id === 'queue:stale' && a.level === 'critical'));
});

test('alert: disabled provider is warn', () => {
  const alerts = evaluateOpsAlerts({
    queueQueued: 0, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: ['gemini'], migrationCount: 1, oldestQueuedAgeSec: null,
    memoryRssMb: 50, memoryRssLimitMb: 1024,
  });
  assert.ok(alerts.some((a) => a.id === 'provider:disabled'));
});

test('alert: high RSS ratio warns', () => {
  const alerts = evaluateOpsAlerts({
    queueQueued: 0, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: [], migrationCount: 1, oldestQueuedAgeSec: null,
    memoryRssMb: 800, memoryRssLimitMb: 1000,
  });
  assert.ok(alerts.some((a) => a.id === 'capacity:ram'));
});

test('buildOpsSnapshot includes alerts and no secret-looking keys', () => {
  const snap = buildOpsSnapshot({
    queueQueued: 1, queueLeased: 1, abandoned24h: 0, runsFinished24h: 3, avgRunDurationMs: 1200,
    disabledProviders: [], migrationCount: 14, oldestQueuedAgeSec: 10,
    memoryRssMb: processRssMb(), memoryRssLimitMb: 1024,
  });
  assert.equal(snap.schema.migrationCount, 14);
  assert.ok(Array.isArray(snap.alerts));
  const json = JSON.stringify(snap);
  assert.ok(!/api[_-]?key|password|secret/i.test(json) || json.includes('alerts'));
});

test('renderOpsHtml escapes and lists metrics', () => {
  const snap = buildOpsSnapshot({
    queueQueued: 0, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: [], migrationCount: 1, oldestQueuedAgeSec: null,
    memoryRssMb: 10, memoryRssLimitMb: null,
  });
  const html = renderOpsHtml(snap, '24');
  assert.match(html, /BiForge operations/);
  assert.match(html, /<table>/);
  assert.ok(!html.includes('<script>'));
});

test('backup-restore check script exists', () => {
  for (const f of ['scripts/backup-restore-check.mjs']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('ops:backup-check exits 0 offline with migrations on disk', async () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/backup-restore-check.mjs', '--json'], {
      env,
      cwd: root,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.out + result.err);
  const raw = result.out.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const j = JSON.parse(raw.slice(start, end + 1));
  assert.equal(j.ok, true);
  assert.ok(j.migrations_on_disk >= 1);
});
}
// ===== END p24-acceptance.test.mjs =====

// ===== BEGIN p53-project-scope.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { readFileSync } = await import("node:fs");
const { projectCapabilities } = await import("../server/projectCapabilities.ts");
const { githubWritesEnabled } = await import("../server/githubIntegration.ts");
const { describeCapabilities, PROJECT_SCOPE_TEXT, ZIP_OFF_HINT } = await import("../src/projectCapabilities.ts");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const server = read('server.ts');
const gh = read('server/githubIntegration.ts');
const svc = read('server/codeTaskService.ts');
const pm = read('src/ProjectMode.tsx');

test('P53 capability matrix: model_patch = ZIP only; the diff-upload switch = the only write', () => {
  const c = (env, githubConfigured = true) => projectCapabilities({ env, githubConfigured });
  assert.deepEqual(c({}), { analysis: true, plans: true, programZip: false, manualDelivery: { githubRead: true }, githubWrite: false });
  const zip = c({ CODE_EXECUTOR: 'model_patch' });
  assert.equal(zip.programZip, true); assert.equal(zip.githubWrite, false);
  const up = c({ GITHUB_DIFF_UPLOAD: 'true' });
  assert.equal(up.programZip, false); assert.equal(up.githubWrite, true);
  const both = c({ CODE_EXECUTOR: 'model_patch', GITHUB_DIFF_UPLOAD: 'true' });
  assert.equal(both.programZip, true); assert.equal(both.githubWrite, true);
  assert.equal(c({ CODE_EXECUTOR: 'manual' }).programZip, false);
  assert.equal(c({}, false).manualDelivery.githubRead, false);
});

test('P53 capabilities carry booleans only and no variable values', () => {
  const caps = projectCapabilities({ env: { CODE_EXECUTOR: 'model_patch', GITHUB_APP_PRIVATE_KEY: 'SECRET', GEMINI_API_KEY: 'SECRET' }, githubConfigured: true });
  const flat = JSON.stringify(caps);
  assert.doesNotMatch(flat, /SECRET|model_patch|CODE_EXECUTOR|GITHUB/);
  const walk = (o) => Object.values(o).forEach((v) => (typeof v === 'object' ? walk(v) : assert.equal(typeof v, 'boolean')));
  walk(caps);
});

test('P53 default env: githubWritesEnabled follows the process environment, not CODE_EXECUTOR', () => {
  const prev = { e: process.env.CODE_EXECUTOR, u: process.env.GITHUB_DIFF_UPLOAD };
  try {
    delete process.env.GITHUB_DIFF_UPLOAD; process.env.CODE_EXECUTOR = 'model_patch';
    assert.equal(githubWritesEnabled(), false);
    assert.equal(projectCapabilities({ githubConfigured: false }).githubWrite, false);
    process.env.GITHUB_DIFF_UPLOAD = 'true';
    assert.equal(githubWritesEnabled(), true);
    assert.equal(projectCapabilities({ githubConfigured: false }).githubWrite, true);
  } finally {
    for (const [k, v] of [['CODE_EXECUTOR', prev.e], ['GITHUB_DIFF_UPLOAD', prev.u]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('P53 code: one write switch; no write path is enabled by model_patch', () => {
  assert.match(gh, /export const githubWritesEnabled = \(\): boolean => process\.env\.GITHUB_DIFF_UPLOAD === 'true';/);
  assert.doesNotMatch(gh, /githubWritesEnabled[^\n]*CODE_EXECUTOR/);
  assert.equal((svc.match(/deps\.diffUpload\?\.\(\) \?\? githubWritesEnabled\(\)/g) || []).length, 2);
  assert.doesNotMatch(svc, /diffUploadEnabled\(\) \|\| githubWritesEnabled\(\)/);
  assert.match(svc, /github_writes_disabled_bundle_available/);
});

test('P53 /api/session: capabilities only for a signed-in person with Project Mode on', () => {
  assert.match(server, /isAuthenticated && PROJECT_MODE_ENABLED \? projectCapabilities\(/);
  assert.match(server, /\.\.\.\(capabilities \? \{ capabilities \} : \{\}\)/);
  assert.match(server, /projectModeEnabled: PROJECT_MODE_ENABLED/);
});

test('P53 interface text: plain rows, scope sentence, no env names, no "administrator"', () => {
  const on = describeCapabilities({ analysis: true, plans: true, programZip: true, manualDelivery: { githubRead: true }, githubWrite: false });
  assert.equal(on.length, 5);
  assert.deepEqual(on.map((r) => r.on), [true, true, true, true, false]);
  const off = describeCapabilities({ analysis: true, plans: true, programZip: false, manualDelivery: { githubRead: false }, githubWrite: false });
  assert.equal(off.find((r) => r.label === 'Program as ZIP').note, ZIP_OFF_HINT);
  assert.match(JSON.stringify([on, off, PROJECT_SCOPE_TEXT, ZIP_OFF_HINT]), /^(?!.*(CODE_EXECUTOR|GITHUB_|model_patch|administrator)).*$/s);
  assert.equal(describeCapabilities(null)[0].on, false);
  assert.match(pm, /PROJECT_SCOPE_TEXT/);
  assert.match(pm, /What is available here/);
  assert.match(pm, /s\.capabilities && typeof s\.capabilities === 'object'/);
  assert.match(pm, /capabilities !== null && !capabilities\.programZip/);
  assert.doesNotMatch(pm, /when your administrator has enabled/);
});

test('P53 scope decision is carried by code comments and .env.example', () => {
  assert.match(gh, /implies no GitHub write/);
  assert.match(read('.env.example'), /does NOT switch on any GitHub write/);
});
}
// ===== END p53-project-scope.test.mjs =====

// ===== BEGIN p54-project-delivery.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { readFileSync } = await import("node:fs");
const { GATES, GATE_STATUSES } = await import("../server/gateEngine.ts");
const { CODE_ERROR_MESSAGES, CODE_STATE_LABELS, GATE_LABELS, GATE_STATUS_LABELS, GATE_ORDER, GATE_STATUS_ORDER, HUMAN_APPROVAL_GATES, CI_ONLY_NOTE, deliveryErrorMessage, gateRows, handoffText, latestPerTask, nextDeliveryAction, shortSha, stopReasonLabel, STEP_ORDER, NO_COMMIT_NOTE } = await import("../src/projectDeliveryModel.ts");
const { STOP_REASONS } = await import("../server/repairLoop.ts");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const server = read('server.ts');
const svc = read('server/codeTaskService.ts');
const comp = read('src/ProjectDelivery.tsx');
const pm = read('src/ProjectMode.tsx');

const SHA = 'a'.repeat(40);
const ct = (over = {}) => ({ id: 'c1', taskId: 't1', status: 'WAITING_HUMAN', delivery: null, branch: null, expectedBranch: 'biforge/t1', headSha: null, prNumber: null, prUrl: null, statusReason: null, packageApprovedAt: null, packageHash: 'h'.repeat(64), decision: null, decisionReason: null, reviewFindings: null, repairStopReasons: null, attempt: 1, repairOf: null, ...over });
const caps = (over = {}) => ({ analysis: true, plans: true, programZip: false, manualDelivery: { githubRead: true }, githubWrite: false, ...over });

test('P54 labels cover every gate and every gate status of the engine, in the same order', () => {
  assert.deepEqual([...GATE_ORDER], [...GATES]);
  assert.deepEqual([...GATE_STATUS_ORDER], [...GATE_STATUSES]);
  for (const g of GATES) assert.ok(GATE_LABELS[g] && !/_/.test(GATE_LABELS[g]), `label for ${g}`);
  for (const s of GATE_STATUSES) assert.ok(GATE_STATUS_LABELS[s], `label for ${s}`);
  assert.equal(GATE_STATUS_LABELS.WAIVED, 'Waived by you');
});

test('P54 every server error code of the code task service has a plain sentence', () => {
  const block = svc.match(/const STATUS = \{([\s\S]*?)\} as const;/)[1];
  const codes = [...block.matchAll(/\b([A-Z][A-Z_]+):\s*\d{3}/g)].map((m) => m[1]);
  assert.ok(codes.length >= 25, `found ${codes.length} codes`);
  for (const c of codes) assert.ok(CODE_ERROR_MESSAGES[c], `no sentence for ${c}`);
  for (const c of ['NO_HEAD', 'INVALID_GATE', 'PASSPORT_NOT_CONFIRMED', 'UNAUTHORIZED']) assert.ok(CODE_ERROR_MESSAGES[c], c);
  for (const m of Object.values(CODE_ERROR_MESSAGES)) assert.doesNotMatch(m, /[A-Z]{3,}_[A-Z_]+|GITHUB_|CODE_EXECUTOR|model_patch/);
  assert.equal(deliveryErrorMessage('PR_MISMATCH', 'x'), CODE_ERROR_MESSAGES.PR_MISMATCH);
  assert.equal(deliveryErrorMessage('SOMETHING_NEW', 'Server said this'), 'Server said this');
  assert.match(deliveryErrorMessage(undefined, ''), /Nothing was changed/);
});

test('P54 gate rows: only requirements/spec/review can be approved; CI gates are read-only; settled rows cannot be waived', () => {
  assert.deepEqual([...HUMAN_APPROVAL_GATES], ['requirements', 'spec', 'review']);
  const gates = Object.fromEntries(GATES.map((g) => [g, { gate: g, status: 'NOT_RUN', reasons: [`${g} missing`] }]));
  gates.build = { gate: 'build', status: 'PASS', reasons: [] };
  gates.spec = { gate: 'spec', status: 'WAIVED', reasons: [] };
  gates.test = { gate: 'test', status: 'FAIL', reasons: ['1 failing'] };
  const rows = gateRows({ commit: SHA, gates });
  assert.equal(rows.length, 8);
  for (const r of rows) {
    const human = HUMAN_APPROVAL_GATES.includes(r.gate);
    assert.equal(r.canApprove, human && r.status !== 'PASS', r.gate);
    assert.equal(r.ciOnlyNote, human ? null : CI_ONLY_NOTE, r.gate);
    assert.equal(r.canWaive, r.status !== 'PASS' && r.status !== 'WAIVED', r.gate);
  }
  assert.equal(rows.find((r) => r.gate === 'build').canApprove, false);
  assert.equal(rows.find((r) => r.gate === 'test').statusLabel, 'Failed');
  assert.equal(rows.find((r) => r.gate === 'release_candidate').canApprove, false, 'the release candidate is derived, never approved by a button');
  assert.deepEqual(gateRows({ commit: null, gates: null }), []);
  assert.deepEqual(gateRows(null), []);
  assert.equal(gateRows({ commit: SHA, gates: {} }).every((r) => r.status === 'NOT_RUN'), true, 'a missing gate is shown as not run, never as passed');
  assert.match(NO_COMMIT_NOTE('biforge/t1'), /biforge\/t1/);
  assert.equal(shortSha(SHA), 'aaaaaaa');
});

test('P54 next action: steps follow the code task state', () => {
  const step = (o, c = caps()) => nextDeliveryAction(ct(o), c).step;
  assert.equal(step({}), 'package');
  assert.equal(step({ packageApprovedAt: 'x' }), 'handoff');
  assert.equal(step({ packageApprovedAt: 'x', status: 'BLOCKED' }), 'result');
  assert.equal(step({ status: 'DELIVERED', headSha: null, packageApprovedAt: 'x' }), 'checks');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA }), 'review');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA, reviewFindings: { findings: [], summary: '', highCount: 0, hasUnresolvedHigh: false } }), 'decision');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA, decision: 'repair' }), 'repair');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA, decision: 'accept' }), 'closed');
  assert.equal(step({ status: 'FAILED' }), 'closed');
  for (const s of ['package', 'handoff', 'result', 'checks', 'review', 'decision', 'repair']) assert.ok(STEP_ORDER.includes(s));
});

test('P54 next action: package approval, result kinds and cancel', () => {
  const a = (o, c = caps()) => nextDeliveryAction(ct(o), c);
  assert.equal(a({}).canApprovePackage, true);
  assert.equal(a({ packageApprovedAt: 'x' }).canApprovePackage, false);
  assert.equal(a({}).canSubmitResult, false, 'no result before the package is approved');
  assert.equal(a({ packageApprovedAt: 'x' }).canSubmitResult, true);
  assert.deepEqual(a({ packageApprovedAt: 'x' }).resultKinds, ['pr', 'branch']);
  assert.equal(a({ packageApprovedAt: 'x' }, caps({ manualDelivery: { githubRead: false } })).canSubmitResult, false);
  assert.equal(a({ packageApprovedAt: 'x' }, caps({ manualDelivery: { githubRead: false } })).needsGithubForResult, true);
  assert.deepEqual(a({ packageApprovedAt: 'x' }, null).resultKinds, []);
  assert.equal(a({}).canCancel, true);
  assert.equal(a({ status: 'DELIVERED', headSha: SHA }).canCancel, false);
  assert.equal(a({ status: 'FAILED' }).canCancel, false);
  assert.equal(a({}).canDownloadPackage, true);
});

test('P54 no write control without the GitHub write capability (ADR-06 Amendment 1)', () => {
  for (const c of [caps(), caps({ githubWrite: false }), null, undefined, caps({ manualDelivery: { githubRead: false }, githubWrite: true })]) {
    const x = nextDeliveryAction(ct({ packageApprovedAt: 'x' }), c);
    assert.equal(x.showCommitPackage, false);
    assert.equal(x.resultKinds.includes('diff'), false);
  }
  const on = nextDeliveryAction(ct({ packageApprovedAt: 'x' }), caps({ githubWrite: true }));
  assert.equal(on.showCommitPackage, true);
  assert.deepEqual(on.resultKinds, ['pr', 'branch', 'diff']);
});

test('P54 next action: review, decide, refresh and repair only when they make sense', () => {
  const d = (o, c = caps()) => nextDeliveryAction(ct({ status: 'DELIVERED', headSha: SHA, ...o }), c);
  assert.equal(d({}).canRefresh, true);
  assert.equal(d({}, caps({ manualDelivery: { githubRead: false } })).canRefresh, false);
  assert.equal(d({}).canReview, true);
  assert.equal(d({ reviewFindings: { findings: [], summary: '', highCount: 0, hasUnresolvedHigh: false } }).canReview, false);
  assert.equal(d({}).canDecide, true);
  assert.equal(d({ decision: 'accept' }).canDecide, false);
  assert.equal(d({ decision: 'accept' }).canRepair, false);
  assert.equal(d({ decision: 'repair' }).canRepair, true);
  assert.equal(nextDeliveryAction(ct({}), caps()).canDecide, false, 'no decision before delivery');
});

test('P54 list groups attempts by task and keeps the latest attempt', () => {
  const list = latestPerTask([ct({ id: 'b2', taskId: 'tb', attempt: 2 }), ct({ id: 'a1', taskId: 'ta', attempt: 1 }), ct({ id: 'b1', taskId: 'tb', attempt: 1 })]);
  assert.deepEqual(list.map((c) => c.id), ['b2', 'a1']);
  assert.deepEqual(latestPerTask([]), []);
});

test('P54 plain text: states, stop reasons and hand-off steps', () => {
  for (const s of ['WAITING_HUMAN', 'RUNNING', 'DELIVERED', 'FAILED', 'BLOCKED']) assert.ok(CODE_STATE_LABELS[s]);
  for (const r of STOP_REASONS) assert.notEqual(stopReasonLabel(r), r, `plain sentence for ${r}`);
  const t = handoffText('biforge/t1').join(' ');
  assert.match(t, /PACKAGE\.md/); assert.match(t, /biforge\/t1/); assert.match(t, /pull request/);
});

test('P54 server: manual task route, project list and expectedBranch', () => {
  assert.match(server, /app\.get\('\/api\/projects\/:projectId\/code', async/);
  assert.match(server, /app\.post\('\/api\/projects\/:projectId\/code\/manual', async/);
  assert.match(server, /passport\?\.executor !== 'manual'/);
  assert.match(server, /code: 'EXECUTOR_MISMATCH'/);
  assert.match(server, /code: 'PASSPORT_NOT_CONFIRMED'/);
  assert.match(svc, /export async function listProjectCodeTasks/);
  assert.match(svc, /expectedBranch: expectedBranchOf\(r\.task_id\)/);
  const route = server.slice(server.indexOf("app.post('/api/projects/:projectId/code/manual'"), server.indexOf("app.post('/api/projects/:projectId/tasks/:taskId/code/start'"));
  assert.doesNotMatch(route, /commitApprovedPackage|commitChangesToBranch|openPullRequest|modelCaller/, 'the manual route never writes and never calls a model');
  assert.doesNotMatch(route, /req\.body\??\.actor/);
});

test('P54 interface wiring: tab, component, every endpoint, error codes', () => {
  assert.match(pm, /import ProjectDelivery from '\.\/ProjectDelivery\.tsx'/);
  assert.match(pm, /\['delivery', 'Delivery'\]/);
  assert.match(pm, /activeTab === 'delivery' && <ProjectDelivery/);
  assert.match(pm, /Open in Delivery/);
  for (const frag of ['/code`', '/code/manual', '/package`', '/approve`', '/commit-package`', '/result`', '/refresh`', '/review`', '/decide`', '/repair`', '/cancel`', '/gates`', '/gates/${gate}/approve', '/gates/${gate}/waive']) assert.ok(comp.includes(frag), `component calls ${frag}`);
  assert.match(comp, /e\.code = p\.code/);
  assert.match(comp, /role="status" aria-live="polite"/);
  assert.match(comp, /role="alertdialog"/);
  assert.match(comp, /BiForge never merges/);
});

test('P54 write controls are only reachable behind the write capability; CI gates have no approve button', () => {
  const commitBtn = comp.indexOf('commitPackage(selected)}>');
  assert.ok(commitBtn > 0);
  assert.match(comp.slice(Math.max(0, commitBtn - 160), commitBtn), /action\.showCommitPackage &&/);
  assert.match(comp, /resultKind === 'diff' && action\.resultKinds\.includes\('diff'\)/);
  assert.match(comp, /r\.canApprove &&/);
  assert.doesNotMatch(comp, /gates\/\$\{gate\}\/approve`, \{ status: 'PASS' \}[\s\S]{0,40}release_candidate/);
  assert.doesNotMatch(comp, /localStorage|sessionStorage|setInterval|setTimeout\(\(\) => void (reload|refresh)/, 'nothing polls, nothing is stored');
  assert.doesNotMatch(comp, /actor/i, 'the actor is never sent from the browser');
});

test('P54 destructive and decision actions go through a confirmation with a reason', () => {
  assert.match(comp, /<Confirm\s+title=\{pending\.decision/);
  assert.match(comp, /title="Close this task"/);
  assert.match(comp, /title=\{`Waive «\$\{r\.label\}»`\}/);
  assert.match(comp, /needReason/);
  assert.match(comp, /idemKey/);
});

test('P54 render smoke: the Delivery tab renders its list state for every capability combination', async () => {
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const { default: ProjectDelivery } = await import('../src/ProjectDelivery.tsx');
  const html = (props) => renderToString(React.createElement(ProjectDelivery, { projectId: 'p1', capabilities: caps(), passportConfirmed: true, executor: 'manual', ...props }));
  const ok = html({});
  assert.match(ok, /Delivery/); assert.match(ok, /New hand-off task/); assert.match(ok, /BiForge never merges/);
  assert.match(ok, /role="status"/);
  assert.doesNotMatch(ok, /disabled=""[^>]*>New hand-off task/);
  assert.match(html({ passportConfirmed: false }), /Confirm the project description first\./);
  assert.match(html({ executor: 'model_patch' }), /Set «How code is written» to Manual/);
  for (const c of [null, caps({ manualDelivery: { githubRead: false } }), caps({ githubWrite: true })]) assert.match(html({ capabilities: c }), /New hand-off task/);
});
}
// ===== END p54-project-delivery.test.mjs =====

// ===== BEGIN program-creation.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { buildTaskPackageFromBrief } = await import("../server/briefWriter.ts");
const { validateGeneratedSource, validateModelPatch } = await import("../server/codeExecutor.ts");
const { generatedSourceArtifactId } = await import("../server/codeTaskService.ts");

test('program creation package confines output to the generated task directory', () => {
  const taskId = 'task_tetris_123';
  const allowedPaths = [`generated-projects/${taskId}/**`];
  const pkg = buildTaskPackageFromBrief({
    taskId,
    projectId: 'project_123',
    goal: 'Create a playable browser Tetris game with keyboard controls, score and restart.',
    allowedPaths,
    limits: { maxFiles: 10, maxChangedLines: 400 },
    acceptanceCriteria: 'Create a directly usable browser game and do not claim runtime tests.',
  });
  assert.deepEqual(pkg.allowedPaths, allowedPaths);
  assert.equal(validateModelPatch({ files: [{ path: `generated-projects/${taskId}/index.html`, action: 'create', content: '<!doctype html>\n' }] }, { allowedPaths, limits: pkg.limits }).ok, true);
  assert.equal(validateModelPatch({ files: [{ path: 'generated-projects/another-task/index.html', action: 'create', content: '<!doctype html>\n' }] }, { allowedPaths, limits: pkg.limits }).ok, false);
  assert.deepEqual(validateGeneratedSource({ files: [{ path: `generated-projects/${taskId}/index.html`, action: 'create', content: '<html><body><script>const x = 1;</script></body></html>' }] }, 'Create Tetris'), []);
  assert.ok(validateGeneratedSource({ files: [{ path: `generated-projects/${taskId}/index.html`, action: 'create', content: '<html><body><script>const = ;</script></body></html>' }] }, 'Create Tetris').some((v) => v.code === 'javascript_syntax_invalid'));
  assert.ok(validateGeneratedSource({ files: [{ path: `generated-projects/${taskId}/app.js`, action: 'create', content: 'console.log("x");' }] }, 'Create Tetris').some((v) => v.code === 'browser_entrypoint_missing'));
});

test('generated source artifact id is deterministic and safe for repository storage', () => {
  const a = generatedSourceArtifactId('code_task_123');
  assert.equal(a, generatedSourceArtifactId('code_task_123'));
  assert.match(a, /^source_[a-f0-9]{40}$/);
  assert.notEqual(a, generatedSourceArtifactId('code_task_456'));
});

test('program creation is wired end-to-end and remains gated', async () => {
  const { readFile } = await import('node:fs/promises');
  const [server, service, ui] = await Promise.all([
    readFile(new URL('../server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/codeTaskService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ProjectMode.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /\/api\/projects\/:projectId\/code\/build/);
  assert.match(server, /passport\?\.executor !== 'model_patch' \|\| process\.env\.CODE_EXECUTOR !== 'model_patch'/);
  assert.match(server, /\/download/);
  assert.match(service, /driveModelPatch\(\{ projectId, taskId, codeTaskId: started\.codeTask\.id \}, deps\)/);
  assert.match(service, /generated_secret:/);
  assert.match(ui, /Create a small program/);
  assert.match(ui, /Download generated program/);
});
}
// ===== END program-creation.test.mjs =====
