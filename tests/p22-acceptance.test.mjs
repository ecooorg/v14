// P22 / BX-23: Repair Loop stop rules and diagnostic report.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('P22 docs and sources exist', () => {
  assert.ok(existsSync(`${root}/docs/P22-SPEC.md`));
  assert.ok(existsSync(`${root}/server/repairLoop.ts`));
  assert.ok(existsSync(`${root}/migrations/013_repair_loop.sql`));
  const srv = readFileSync(`${root}/server.ts`, 'utf8');
  assert.match(srv, /code\/:codeTaskId\/repair/);
  assert.match(readFileSync(`${root}/server/codeTaskService.ts`, 'utf8'), /requestRepair/);
});

test('classifyFailure: security before build; criteria from human repair', async () => {
  const { classifyFailure } = await import(pathToFileURL(`${root}/server/repairLoop.ts`).href);
  const sec = classifyFailure({ gates: [{ gate: 'security', status: 'FAIL' }, { gate: 'build', status: 'FAIL' }] });
  assert.equal(sec.kind, 'security');
  const lint = classifyFailure({ gates: [{ gate: 'build', status: 'FAIL', reasons: ['lint:FAIL'] }] });
  assert.equal(lint.kind, 'lint');
  const human = classifyFailure({ decision: 'repair', gates: [] });
  assert.equal(human.kind, 'criteria');
  const again = classifyFailure({ decision: 'repair', gates: [] });
  assert.equal(again.signature, human.signature);
});

test('stop: max_attempts, identical diff, identical error, no progress, budget', async () => {
  const { evaluateRepairStop } = await import(pathToFileURL(`${root}/server/repairLoop.ts`).href);
  const base = [{ attempt: 1, diffHash: 'a'.repeat(64), errorSignature: 'b'.repeat(64), failingTests: 4 }];
  assert.deepEqual(evaluateRepairStop({ priorRepairs: 0, history: base }).reasons, []);
  assert.ok(evaluateRepairStop({ priorRepairs: 2, history: base }).reasons.includes('max_attempts'));
  assert.ok(evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'a'.repeat(64), errorSignature: 'c'.repeat(64), failingTests: 1 }],
  }).reasons.includes('identical_diff'));
  assert.ok(evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'd'.repeat(64), errorSignature: 'b'.repeat(64), failingTests: 1 }],
  }).reasons.includes('identical_error'));
  assert.ok(evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'd'.repeat(64), errorSignature: 'e'.repeat(64), failingTests: 4 }],
  }).reasons.includes('no_progress'));
  const progress = evaluateRepairStop({
    priorRepairs: 0,
    history: [...base, { attempt: 2, diffHash: 'd'.repeat(64), errorSignature: 'e'.repeat(64), failingTests: 2 }],
  });
  assert.equal(progress.stop, false);
  assert.ok(evaluateRepairStop({ priorRepairs: 0, history: base, budgetExceeded: true }).reasons.includes('budget'));
});

test('diagnostic report names the stop and asks for a human', async () => {
  const { buildDiagnosticReport, buildRepairPrompt } = await import(pathToFileURL(`${root}/server/repairLoop.ts`).href);
  const text = buildDiagnosticReport({
    taskId: 'task_1', codeTaskId: 'code_1', reasons: ['budget', 'max_attempts'], kind: 'test', summary: 'test:FAIL',
    attempts: [{ attempt: 1, failingTests: 3, errorSignature: 'ab', diffHash: 'cd' }],
  });
  assert.match(text, /budget/);
  assert.match(text, /human decision/i);
  assert.match(text, /task_1/);
  const prompt = buildRepairPrompt('Do the spec.', { kind: 'test', summary: 'test:FAIL', attempts: ['attempt 1'], logExcerpt: 'x'.repeat(5000) });
  assert.ok(prompt.length <= 20_000);
  assert.match(prompt, /Repair report/);
  assert.match(prompt, /Do the spec/);
});

test('APP_VERSION matches package.json', () => {
  const m = readFileSync(`${root}/src/config.ts`, 'utf8').match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m);
  assert.equal(JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version, m[1]);
});
