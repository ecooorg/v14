/** P26b: workspace ChangeSet validate/apply, CRLF, stale sha, CI/lock confirm, rollback (AC-07…09, AC-15). */
import assert from 'node:assert/strict';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';
import {
  applyWorkspaceChangeSet,
  createEmptyWorkspace,
  rollbackWorkspace,
  validateWorkspaceChangeSet,
  applyEdits,
  WORKSPACE_LIMITS,
} from '../src/workspace/changeset.ts';
import { sha256Bytes } from '../src/workspace/hash.ts';

const store = new MemoryWorkspaceStore();

// --- create from scratch (AC-15) ---
{
  const { wsId, version } = await createEmptyWorkspace(store, 'Tetris', {
    'index.html': '<!doctype html><title>Tetris</title>\n',
    'src/main.js': 'console.log("go");\n',
  }, true);
  assert.ok(wsId);
  assert.equal(version.no, 1);
  assert.equal(version.parent, null);
  const man = await store.getManifest(wsId, 1);
  assert.equal(man.length, 2);
  assert.ok(man.every((e) => e.sha256.length === 64));
}

// --- AC-07: valid modify via edits ---
{
  const { wsId } = await createEmptyWorkspace(store, 'demo', {
    'hello.txt': 'hello world\nsecond line\n',
  });
  const man = await store.getManifest(wsId, 1);
  const entry = man.find((e) => e.path === 'hello.txt');
  const cs = {
    baseVersion: 1,
    message: 'greet',
    ops: [
      {
        path: 'hello.txt',
        action: 'modify',
        baseSha256: entry.sha256,
        edits: [{ find: 'world', replace: 'BiForge' }],
      },
    ],
  };
  const v = await validateWorkspaceChangeSet(store, wsId, cs);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.previews[0].added + v.previews[0].removed > 0, true);
  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  assert.equal(applied.version.no, 2);
  const bytes = await store.readBlob(wsId, (await store.getManifest(wsId, 2)).find((e) => e.path === 'hello.txt').sha256);
  assert.equal(new TextDecoder().decode(bytes), 'hello BiForge\nsecond line\n');
}

// --- AC-08: violations ---
{
  const { wsId } = await createEmptyWorkspace(store, 'viol', { 'a.txt': 'alpha\n' });
  const man = await store.getManifest(wsId, 1);
  const sha = man[0].sha256;

  // stale baseSha256
  let r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'a.txt', action: 'modify', baseSha256: '0'.repeat(64), content: 'beta\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'stale_base_sha'));

  // unsafe path
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: '../etc/passwd', action: 'create', content: 'x' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'unsafe_path'));

  // .git blocked
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: '.git/config', action: 'create', content: 'x' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'git_path'));

  // secret in content
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'leak.txt', action: 'create', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'secret_in_content'));

  // CI/lock without confirm
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'package-lock.json', action: 'create', content: '{}\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'ci_lock_confirm_required'));
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    confirmCiLock: true,
    ops: [{ path: 'package-lock.json', action: 'create', content: '{}\n' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.violations));

  // too many files
  const many = Array.from({ length: WORKSPACE_LIMITS.maxFiles + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    action: 'create',
    content: 'x\n',
  }));
  r = await validateWorkspaceChangeSet(store, wsId, { baseVersion: 1, ops: many });
  assert.ok(r.violations.some((v) => v.code === 'too_many_files'));

  // find not unique
  const uniq = await createEmptyWorkspace(store, 'uniq', { 'u.txt': 'aa aa\n' });
  const um = await store.getManifest(uniq.wsId, 1);
  r = await validateWorkspaceChangeSet(store, uniq.wsId, {
    baseVersion: 1,
    ops: [{ path: 'u.txt', action: 'modify', baseSha256: um[0].sha256, edits: [{ find: 'aa', replace: 'b' }] }],
  });
  assert.ok(r.violations.some((v) => v.code === 'find_not_unique'));
}

// --- AC-09: CRLF preserved + rollback restores hash ---
{
  const crlf = 'line1\r\nline2\r\n';
  const { wsId } = await createEmptyWorkspace(store, 'crlf', { 'crlf.txt': crlf });
  const man = await store.getManifest(wsId, 1);
  const e = man[0];
  assert.equal(e.eol, 'CRLF');
  const beforeHash = e.sha256;
  const cs = {
    baseVersion: 1,
    ops: [{ path: 'crlf.txt', action: 'modify', baseSha256: beforeHash, edits: [{ find: 'line2', replace: 'LINE2' }] }],
  };
  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  const afterBytes = await store.readBlob(wsId, (await store.getManifest(wsId, 2)).find((x) => x.path === 'crlf.txt').sha256);
  const afterText = new TextDecoder().decode(afterBytes);
  assert.ok(afterText.includes('\r\n'), 'CRLF must be preserved');
  assert.equal(afterText, 'line1\r\nLINE2\r\n');

  const rb = await rollbackWorkspace(store, wsId, 1);
  assert.equal(rb.no, 3);
  const m3 = await store.getManifest(wsId, 3);
  assert.equal(m3.find((x) => x.path === 'crlf.txt').sha256, beforeHash);
}

// --- applyEdits unit ---
{
  const r = applyEdits('foo bar foo', [{ find: 'bar', replace: 'baz' }], 'LF');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'foo baz foo');
  const fail = applyEdits('x x', [{ find: 'x', replace: 'y' }], 'LF');
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 'find_not_unique');
}

console.log('workspace-changeset: ok');
