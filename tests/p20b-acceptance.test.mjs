// P20b: Task PASS requires gates when a code head is tracked; analysis-only tasks unchanged.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('P20b docs and sources exist', () => {
  assert.ok(existsSync(`${root}/docs/P20b-SPEC.md`));
  assert.ok(readFileSync(`${root}/server/taskService.ts`, 'utf8').includes('gatesAllowTaskPass'));
  assert.ok(readFileSync(`${root}/server/gateEngine.ts`, 'utf8').includes('gatesAllowTaskPass'));
  assert.ok(readFileSync(`${root}/server.ts`, 'utf8').includes("gates/:gate/approve"));
});

test('gatesAllowTaskPass: no snapshot allows PASS; RC PASS allows; blocked otherwise', async () => {
  const { gatesAllowTaskPass, evaluateAll, GATE_RULES_VERSION } = await import(pathToFileURL(`${root}/server/gateEngine.ts`).href);
  assert.deepEqual(gatesAllowTaskPass(null), { ok: true, blockers: [] });
  assert.equal(gatesAllowTaskPass(undefined).ok, true);

  const sha = 'a'.repeat(40);
  const ev = (gate, status, checkName = 'c') => ({
    gate, checkName, status, commitSha: sha, source: gate === 'build' || gate === 'test' || gate === 'test_integrity' || gate === 'security' ? 'ci' : gate === 'test_integrity' ? 'diff' : 'approval',
    rulesVersion: GATE_RULES_VERSION, tool: 't',
  });
  // fix sources properly
  const mk = (gate, status, source, checkName = 'c') => ({
    gate, checkName, status, commitSha: sha, source, rulesVersion: GATE_RULES_VERSION, tool: 't',
  });
  const allPass = [
    mk('requirements', 'PASS', 'approval'),
    mk('spec', 'PASS', 'approval'),
    mk('build', 'PASS', 'ci'),
    mk('test', 'PASS', 'ci'),
    mk('test_integrity', 'PASS', 'diff'),
    mk('security', 'PASS', 'ci'),
    mk('review', 'PASS', 'approval'),
  ];
  const gatesOk = evaluateAll(allPass, sha);
  assert.equal(gatesOk.release_candidate.status, 'PASS');
  assert.equal(gatesAllowTaskPass(gatesOk).ok, true);

  const gatesFail = evaluateAll([mk('build', 'FAIL', 'ci'), ...allPass.filter((e) => e.gate !== 'build')], sha);
  assert.notEqual(gatesFail.release_candidate.status, 'PASS');
  const blocked = gatesAllowTaskPass(gatesFail);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.length >= 1);
});

test('GATES_BLOCKED is a task error code', () => {
  const src = readFileSync(`${root}/server/taskMachine.ts`, 'utf8');
  assert.match(src, /GATES_BLOCKED/);
});
