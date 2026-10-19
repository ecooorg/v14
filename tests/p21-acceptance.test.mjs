// P21: reviewer findings + human decision on DELIVERED code tasks (BX-22.b).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('P21 docs and sources exist', () => {
  assert.ok(existsSync(`${root}/docs/P21-SPEC.md`));
  assert.ok(existsSync(`${root}/server/reviewer.ts`));
  assert.ok(existsSync(`${root}/migrations/012_code_task_decision.sql`));
  const srv = readFileSync(`${root}/server.ts`, 'utf8');
  assert.match(srv, /code\/:codeTaskId\/review/);
  assert.match(srv, /code\/:codeTaskId\/decide/);
  const cts = readFileSync(`${root}/server/codeTaskService.ts`, 'utf8');
  assert.match(cts, /runCodeTaskReview/);
  assert.match(cts, /decideCodeTask/);
  assert.match(cts, /decision:/);
});

test('buildReviewFindings: FAIL on build → high; empty gates → no high', async () => {
  const { buildReviewFindings } = await import(pathToFileURL(`${root}/server/reviewer.ts`).href);
  const empty = buildReviewFindings({ delivery: 'pr', filesChanged: 2, linesChanged: 10, gates: [] });
  assert.equal(empty.hasUnresolvedHigh, false);
  assert.ok(empty.summary.length > 0);

  const sha = 'b'.repeat(40);
  const withFail = buildReviewFindings({
    commitSha: sha,
    delivery: 'pr',
    filesChanged: 1,
    linesChanged: 5,
    gates: [
      { gate: 'build', status: 'FAIL', reasons: ['ci'] },
      { gate: 'test', status: 'PASS' },
    ],
  });
  assert.equal(withFail.hasUnresolvedHigh, true);
  assert.ok(withFail.highCount >= 1);
  assert.equal(withFail.gatesSnapshot.build, 'FAIL');
  assert.ok(withFail.findings.some((f) => f.gate === 'build' && f.severity === 'high'));
});

test('buildReviewFindings: BLOCKED critical gate → medium, not high', async () => {
  const { buildReviewFindings } = await import(pathToFileURL(`${root}/server/reviewer.ts`).href);
  const out = buildReviewFindings({
    gates: [{ gate: 'test', status: 'BLOCKED', reasons: ['infra'] }],
    delivery: 'branch',
    filesChanged: 1,
  });
  assert.equal(out.hasUnresolvedHigh, false);
  assert.ok(out.findings.some((f) => f.severity === 'medium' && f.gate === 'test'));
});

test('buildReviewFindings: violations → high', async () => {
  const { buildReviewFindings } = await import(pathToFileURL(`${root}/server/reviewer.ts`).href);
  const out = buildReviewFindings({
    violations: [{ code: 'path_not_allowed', path: 'secret.env' }],
    delivery: 'diff',
    filesChanged: 1,
  });
  assert.equal(out.hasUnresolvedHigh, true);
  assert.ok(out.findings.some((f) => f.summary.includes('path_not_allowed')));
});

test('APP_VERSION matches package.json', () => {
  const cfg = readFileSync(`${root}/src/config.ts`, 'utf8');
  const m = cfg.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m);
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  assert.equal(pkg.version, m[1]);
});
