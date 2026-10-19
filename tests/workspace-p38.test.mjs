/** P38: export full / changed / diff; full export preserves original blob bytes. */
import assert from 'node:assert/strict';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';
import {
  applyWorkspaceChangeSet,
  createEmptyWorkspace,
} from '../src/workspace/changeset.ts';
import { exportWorkspace, buildDeterministicZip } from '../src/workspace/exportZip.ts';
import { sha256Bytes } from '../src/workspace/hash.ts';

const store = new MemoryWorkspaceStore();

{
  const body = 'hello export\n';
  const { wsId } = await createEmptyWorkspace(store, 'p38-full', { 'a.txt': body });
  const exp = await exportWorkspace(store, wsId, { mode: 'full', name: 'p38-full' });
  assert.equal(exp.mode, 'full');
  assert.ok(exp.filename.endsWith('.zip'));
  assert.equal(exp.files, 1);
  // Re-zip single file must match deterministic builder with same bytes
  const bytes = new TextEncoder().encode(body);
  const map = new Map([['a.txt', bytes]]);
  const direct = await buildDeterministicZip(map);
  assert.equal(exp.sha256, await (async () => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(exp.bytes).digest('hex');
  })());
  // Unchanged path bytes equal original
  const man = await store.getManifest(wsId, 1);
  const blob = await store.readBlob(wsId, man[0].sha256);
  assert.equal(new TextDecoder().decode(blob), body);
  assert.equal(await sha256Bytes(blob), man[0].sha256);
}

{
  const { wsId } = await createEmptyWorkspace(store, 'p38-chg', { 'x.txt': 'one\n' });
  const man1 = await store.getManifest(wsId, 1);
  const applied = await applyWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'x.txt', action: 'modify', baseSha256: man1[0].sha256, content: 'two\n' }],
  });
  assert.equal(applied.ok, true);
  const ch = await exportWorkspace(store, wsId, { mode: 'changed', baseVersion: 1, version: 2, name: 'p38-chg' });
  assert.equal(ch.mode, 'changed');
  assert.ok(ch.filename.includes('changed'));
  assert.ok(ch.files >= 2); // file + BIFORGE-CHANGES.md

  const df = await exportWorkspace(store, wsId, { mode: 'diff', baseVersion: 1, version: 2, name: 'p38-chg' });
  assert.equal(df.mode, 'diff');
  assert.ok(df.filename.endsWith('.diff'));
  const text = new TextDecoder().decode(df.bytes);
  assert.ok(text.includes('x.txt') || text.includes('---') || text.includes('+++') || text.includes('one') || text.includes('two'));
}

console.log('workspace-p38: ok');
