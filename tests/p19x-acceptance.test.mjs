/**
 * P19x acceptance: validateModelPatch matrix + driveModelPatch with fakes.
 * No live network, no real DB for pure validation; drive uses injectable deps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ce from '../server/codeExecutor.ts';

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
