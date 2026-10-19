// P20 acceptance: brief_writer, package baseline for Test Integrity, approval helpers.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('docs and migration for P20 exist', () => {
  assert.ok(existsSync(`${root}/docs/P20-SPEC.md`));
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
