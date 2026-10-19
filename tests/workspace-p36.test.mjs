/** P36: ChangeSet parse, human-gated apply, no version bump before Apply, rollback. */
import assert from 'node:assert/strict';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';
import {
  applyWorkspaceChangeSet,
  createEmptyWorkspace,
  rollbackWorkspace,
  validateWorkspaceChangeSet,
} from '../src/workspace/changeset.ts';
import {
  normalizeWorkspaceChangeSet,
  parseChangeSetFromText,
} from '../src/workspace/changeSetParse.ts';

const store = new MemoryWorkspaceStore();

// --- parse from fenced JSON ---
{
  const text = `Here is the patch:

\`\`\`json
{
  "changeSet": {
    "baseVersion": 1,
    "message": "rename greeting",
    "ops": [
      {
        "path": "hello.txt",
        "action": "modify",
        "baseSha256": "${'a'.repeat(64)}",
        "edits": [{ "find": "world", "replace": "BiForge" }]
      }
    ]
  }
}
\`\`\`
`;
  const cs = parseChangeSetFromText(text);
  assert.ok(cs);
  assert.equal(cs.baseVersion, 1);
  assert.equal(cs.ops[0].action, 'modify');
  assert.equal(cs.ops[0].edits?.[0].replace, 'BiForge');
}

// --- reject garbage ---
{
  assert.equal(parseChangeSetFromText('no json here'), null);
  assert.equal(normalizeWorkspaceChangeSet({ baseVersion: 0, ops: [] }), null);
}

// --- validate does not write; apply creates v2 ---
{
  const { wsId } = await createEmptyWorkspace(store, 'p36', {
    'hello.txt': 'hello world\n',
  });
  const man = await store.getManifest(wsId, 1);
  const sha = man[0].sha256;
  const cs = {
    baseVersion: 1,
    message: 'greet',
    ops: [
      {
        path: 'hello.txt',
        action: 'modify',
        baseSha256: sha,
        edits: [{ find: 'world', replace: 'BiForge' }],
      },
    ],
  };
  const v = await validateWorkspaceChangeSet(store, wsId, cs);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  // Still version 1 after validate
  const ws = await store.getWorkspace?.(wsId);
  assert.equal(ws?.head, 1);

  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  assert.equal(applied.version.no, 2);
  const bytes = await store.readBlob(
    wsId,
    (await store.getManifest(wsId, 2)).find((e) => e.path === 'hello.txt').sha256,
  );
  assert.equal(new TextDecoder().decode(bytes), 'hello BiForge\n');
}

// --- rollback adds new version restoring prior content ---
{
  const { wsId } = await createEmptyWorkspace(store, 'p36-rb', {
    'a.txt': 'one\n',
  });
  const man1 = await store.getManifest(wsId, 1);
  const cs = {
    baseVersion: 1,
    ops: [{ path: 'a.txt', action: 'modify', baseSha256: man1[0].sha256, content: 'two\n' }],
  };
  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  assert.equal(applied.version.no, 2);
  const rb = await rollbackWorkspace(store, wsId, 1);
  assert.equal(rb.no, 3);
  assert.equal(rb.createdBy, 'rollback');
  const man3 = await store.getManifest(wsId, 3);
  const text = new TextDecoder().decode(await store.readBlob(wsId, man3[0].sha256));
  assert.equal(text, 'one\n');
}

// --- stale sha blocked (no apply) ---
{
  const { wsId } = await createEmptyWorkspace(store, 'p36-stale', { 'x.txt': 'x\n' });
  const r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'x.txt', action: 'modify', baseSha256: '0'.repeat(64), content: 'y\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'stale_base_sha'));
  const applied = await applyWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'x.txt', action: 'modify', baseSha256: '0'.repeat(64), content: 'y\n' }],
  });
  assert.equal(applied.ok, false);
  const ws = await store.getWorkspace?.(wsId);
  assert.equal(ws?.head, 1);
}

console.log('workspace-p36: ok');
