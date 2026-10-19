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

test('Current STATUS preserves model_patch authorization boundary', () => {
  const status = read('docs/STATUS.md');
  assert.match(status, /model_patch/);
  assert.match(status, /GitHub write deferred/i);
  assert.match(status, /GitHub App remains read-only until authorised/i);
});

test('canonical security and status docs preserve the current delivery boundary', () => {
  assert.match(read('docs/07-Security-Privacy-and-Operations.md'), /model_patch/i);
  assert.match(read('docs/STATUS.md'), /GitHub write deferred/i);
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

test('retired ADR-10 and E-01 reports are intentionally not required', () => {
  assert.equal(existsSync(join(root, 'docs/ADR-10-code-executor.md')), false);
  assert.match(read('docs/02-Architecture-and-Components.md'), /model_patch.*source ZIP/i);
});
