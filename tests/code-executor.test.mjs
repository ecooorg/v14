import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as ce from '../server/codeExecutor.ts';
import * as gh from '../server/githubIntegration.ts';

const pkg = (over = {}) => ce.taskPackageSchema.parse({
  agentsMd: 'Rules', specMd: 'Goal', acceptanceMd: 'Criteria', executorPromptMd: 'Do it',
  allowedPaths: ['src/**', 'docs/*.md'], acceptanceTests: [{ path: 'tests/acceptance/a.test.mjs', content: 'x' }], contextFiles: [{ path: 'src/a.ts', content: 'const a = 1;\n```\n' }], ...over,
});
const diffOf = (path, oldL, newL) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldL.length} +1,${newL.length} @@\n${oldL.map((l) => '-' + l).join('\n')}\n${newL.map((l) => '+' + l).join('\n')}\n`;

test('package: schema, limits cap, hash is stable, secrets are refused without echoing them', () => {
  const p = pkg();
  assert.equal(p.limits.maxFiles, 10); assert.equal(p.limits.maxChangedLines, 400);
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, limits: { maxFiles: 11 } }));
  assert.throws(() => ce.taskPackageSchema.parse({ ...p, limits: { maxChangedLines: 401 } }));
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
