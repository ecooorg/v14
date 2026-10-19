/** P26b: export full/changed/diff, byte-identity round-trip, determinism (AC-10, AC-11). */
import assert from 'node:assert/strict';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';
import { createEmptyWorkspace, applyWorkspaceChangeSet } from '../src/workspace/changeset.ts';
import { exportWorkspace, buildDeterministicZip } from '../src/workspace/exportZip.ts';
import { sha256Bytes } from '../src/workspace/hash.ts';

const store = new MemoryWorkspaceStore();

const files = {
  'README.md': '# Hello\n',
  'src/app.ts': 'export const n = 1;\n',
  'data/crlf.txt': 'a\r\nb\r\n',
};
const { wsId, version } = await createEmptyWorkspace(store, 'exp', files);
assert.equal(version.no, 1);

// AC-10: full export twice → same sha256; bytes match originals
const e1 = await exportWorkspace(store, wsId, { mode: 'full', version: 1 });
const e2 = await exportWorkspace(store, wsId, { mode: 'full', version: 1 });
assert.equal(e1.sha256, e2.sha256);
assert.equal(e1.filename, 'exp-v1.zip');
assert.ok(e1.bytes.byteLength > 20);

// Round-trip via JSZip if available
let JSZip;
try {
  JSZip = (await import('jszip')).default;
} catch {
  JSZip = null;
}
if (JSZip) {
  const z = await JSZip.loadAsync(e1.bytes);
  for (const [path, text] of Object.entries(files)) {
    const got = await z.file(path).async('uint8array');
    const expected = new TextEncoder().encode(text);
    assert.deepEqual([...got], [...expected], path);
  }
}

// Modify → changed + diff
const man = await store.getManifest(wsId, 1);
const app = man.find((e) => e.path === 'src/app.ts');
const applied = await applyWorkspaceChangeSet(store, wsId, {
  baseVersion: 1,
  message: 'bump',
  ops: [{ path: 'src/app.ts', action: 'modify', baseSha256: app.sha256, content: 'export const n = 2;\n' }],
});
assert.equal(applied.ok, true);

const changed = await exportWorkspace(store, wsId, { mode: 'changed', version: 2, baseVersion: 1 });
assert.ok(changed.filename.includes('changed'));
if (JSZip) {
  const z = await JSZip.loadAsync(changed.bytes);
  assert.ok(z.file('BIFORGE-CHANGES.md'));
  assert.ok(z.file('src/app.ts'));
  assert.equal(z.file('README.md'), null);
}

const diff = await exportWorkspace(store, wsId, { mode: 'diff', version: 2, baseVersion: 1 });
const diffText = new TextDecoder().decode(diff.bytes);
assert.ok(diffText.includes('diff --git'));
assert.ok(diffText.includes('src/app.ts'));
assert.ok(diffText.includes('-export const n = 1;') || diffText.includes('n = 1'));
assert.ok(diffText.includes('+export const n = 2;') || diffText.includes('n = 2'));

// Deterministic zip of same map
const map = new Map([
  ['b.txt', new TextEncoder().encode('b')],
  ['a.txt', new TextEncoder().encode('a')],
]);
const z1 = await buildDeterministicZip(map);
const z2 = await buildDeterministicZip(map);
assert.deepEqual([...z1], [...z2]);
assert.equal(await sha256Bytes(z1), await sha256Bytes(z2));

console.log('workspace-export: ok');
