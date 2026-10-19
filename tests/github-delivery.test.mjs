import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as gh from '../server/githubIntegration.ts';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg = { appId: '1', installationId: '2', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner: 'o', repository: 'r', apiBaseUrl: 'https://gh.test' };
const READ = { metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' };
const WRITE = { metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'write' };
const SHA = 'c'.repeat(40);
function fake(perms, calls) {
  return async (url, o = {}) => {
    const u = new URL(url); const method = o.method || 'GET'; calls.push({ method, path: u.pathname + u.search, body: o.body ? JSON.parse(o.body) : null });
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.pathname.endsWith('/access_tokens')) return json({ token: 'tok-secret', permissions: perms }, 201);
    if (u.pathname.includes('/git/ref/heads/')) return json({ object: { sha: SHA } });
    if (u.pathname.endsWith('/git/refs')) return json({}, 201);
    if (u.pathname.includes('/contents/') && method === 'GET') return json({}, 404);
    if (u.pathname.includes('/contents/') && method === 'PUT') return json({ commit: { sha: 'd'.repeat(40) } }, 201);
    if (u.pathname.endsWith('/pulls/7')) return json({ state: 'open', merged: false, head: { sha: SHA, ref: 'biforge/t1' }, base: { ref: 'main' } });
    if (u.pathname.endsWith('/pulls/7/files')) return json([{ filename: 'a.ts', status: 'modified' }]);
    if (u.pathname.includes('/check-runs')) return json({ check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/runs/1' }] });
    return json({}, 404);
  };
}

test('read PR, files and check runs with read-only permissions', async () => {
  const calls = [];
  const f = fake(READ, calls);
  assert.deepEqual(await gh.readPullRequest(cfg, 7, f), { number: 7, state: 'open', merged: false, headSha: SHA, headRef: 'biforge/t1', baseRef: 'main' });
  assert.equal((await gh.listPullRequestFiles(cfg, 7, f)).files[0].filename, 'a.ts');
  assert.equal((await gh.listCheckRuns(cfg, SHA, f))[0].conclusion, 'success');
  assert.ok(calls.every((c) => c.method === 'GET' || c.path.endsWith('/access_tokens')), 'reads never write');
});

test('reads fail when the installation token is broader than the manifest', async () => {
  await assert.rejects(() => gh.readPullRequest(cfg, 7, fake({ ...READ, administration: 'write' }, [])), /permissions_too_broad_or_missing/);
  await assert.rejects(() => gh.readPullRequest(cfg, 7, fake(WRITE, [])), /permissions_too_broad_or_missing/);
});

test('Task Package commit: refused unless writes are enabled; only biforge/<task_id>; no merge, no main', async () => {
  const files = [{ path: 'AGENTS.md', content: 'x' }, { path: '.biforge/tasks/t1/SPEC.md', content: 'y' }, { path: 'tests/acceptance/a.test.mjs', content: 'z' }];
  await assert.rejects(() => gh.commitTaskPackage(cfg, { taskId: 't1', baseBranch: 'main', files, writeEnabled: false }, fake(WRITE, [])), /github_write_disabled/);
  const calls = [];
  const r = await gh.commitTaskPackage(cfg, { taskId: 't1', baseBranch: 'main', files, writeEnabled: true }, fake(WRITE, calls));
  assert.equal(r.branch, 'biforge/t1');
  const writes = calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/access_tokens'));
  assert.ok(writes.length === 4);
  assert.ok(writes.every((c) => c.method === 'PUT' || c.path.endsWith('/git/refs')));
  assert.ok(writes.filter((c) => c.method === 'PUT').every((c) => c.body.branch === 'biforge/t1'));
  assert.equal(calls.some((c) => /merge|workflows|\/heads\/main/.test(c.path) && c.method !== 'GET'), false);
  assert.equal(JSON.stringify(r).includes('tok-secret'), false);
  assert.equal(Object.keys(gh).some((k) => /merge/i.test(k)), false, 'the module exposes no merge operation');
});

test('Task Package commit: paths, branch and base are validated', async () => {
  const w = (files, extra = {}) => gh.commitTaskPackage(cfg, { taskId: 't1', baseBranch: 'main', files, writeEnabled: true, ...extra }, fake(WRITE, []));
  for (const p of ['.github/workflows/ci.yml', '../x', '/etc/passwd', 'server/a.ts', '.biforge/tasks/other/SPEC.md', '.biforge/tasks/t1/../t2/SPEC.md', 'tests/acceptance/', 'a\\b']) {
    await assert.rejects(() => w([{ path: p, content: 'x' }]), /path_not_allowed/, p);
  }
  await assert.rejects(() => gh.commitTaskPackage(cfg, { taskId: '../main', baseBranch: 'main', files: [{ path: 'AGENTS.md', content: 'x' }], writeEnabled: true }, fake(WRITE, [])), /invalid_task_id/);
  await assert.rejects(() => w([{ path: 'AGENTS.md', content: 'x' }], { baseBranch: 'biforge/other' }), /invalid_base_branch/);
  await assert.rejects(() => w([]), /invalid_file_count/);
  assert.equal(gh.taskIdFromBranch('biforge/abc_1'), 'abc_1');
  assert.equal(gh.taskIdFromBranch('main'), null);
  assert.equal(gh.taskIdFromBranch('biforge/a/b'), null);
});
