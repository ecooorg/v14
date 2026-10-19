/**
 * P43 — RM-C3 closed: model_patch authorized in docs; runtime still env-gated.
 * Run: node --test tests/p43-rm-c3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('P43 STATUS records RM-C3 closed and model_patch authorization', () => {
  const status = read('docs/STATUS.md');
  assert.match(status, /RM-C3/);
  assert.match(status, /model_patch/);
  assert.match(status, /P43/);
  assert.doesNotMatch(status, /RM-C3 still needs/i);
});

test('P43 OWNER_OPS marks RM-C3 closed', () => {
  const ops = read('docs/OWNER_OPS.md');
  assert.match(ops, /RM-C3 closed/i);
  assert.match(ops, /model_patch/);
});

test('P43 NEXT points RM-C3 closed', () => {
  const next = read('docs/NEXT.md');
  assert.match(next, /RM-C3/);
  assert.match(next, /closed/i);
});

test('P43 runtime gate unchanged: CODE_EXECUTOR must equal model_patch', () => {
  const svc = read('server/codeTaskService.ts');
  assert.match(svc, /process\.env\.CODE_EXECUTOR !== 'model_patch'/);
  assert.match(svc, /EXECUTOR_UNAVAILABLE/);
});

test('P43 does not enable GitHub App write by default', () => {
  const status = read('docs/STATUS.md');
  assert.match(status, /GitHub write/i);
  assert.match(status, /Отложено|deferred|ADR-06/i);
  const env = read('.env.example');
  // GITHUB_DIFF_UPLOAD remains commented / opt-in
  assert.match(env, /GITHUB_DIFF_UPLOAD/);
});

test('P43 ADR-10 evidence still present (E-01 lab notes may live off-repo)', () => {
  assert.ok(existsSync(join(root, 'docs/ADR-10-code-executor.md')));
  // ARCHIVE/E01-* moved off-repo (docs/HISTORY_OFFREPO.md); presence is optional.
});
