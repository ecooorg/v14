// P15 static/invariant acceptance. Live provider, PostgreSQL, and scenario 18.1 remain REAL_ONLY checks; E-01 is closed by PA-05.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('P13b routes expose plans, approvals, queueing and explicit evidence-backed validation', () => {
  const server = read('server.ts');
  for (const route of [
    "'/api/projects/:projectId/plans'",
    "'/api/projects/:projectId/approvals'",
    "'/api/projects/:projectId/budgets/:scope/:scopeId'",
    "'/api/projects/:projectId/approvals/:approvalId/decision'",
    "'/api/projects/:projectId/tasks/:taskId/queue'",
    "'/api/projects/:projectId/tasks/:taskId/validate'",
  ]) assert.ok(server.includes(route), `missing route ${route}`);
  assert.match(server, /actorKind:\s*'human'/);
  assert.match(server, /evidence: z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)/);
});

test('worker starts only in authenticated, configured Project Mode and writes run-linked evidence', () => {
  const server = read('server.ts');
  assert.match(server, /PROJECT_MODE_ENABLED && process\.env\.DATABASE_URL && ai/);
  assert.match(server, /projectWorker = createWorker\(/);
  assert.match(server, /await projectWorker\.start\(\)/);
  assert.match(server, /taskId: task\.id, runId: run\.id/);
  assert.match(server, /artifact:\$\{result\.artifact\.artifactId\}@\$\{result\.artifact\.version\}/);
});

test('each worker model call is budget-guarded before provider execution and ledger uses the DB Run id', () => {
  const analysis = read('server/analysisService.ts');
  assert.match(analysis, /if \(input\.taskId\) await guardModelCall\(/);
  assert.match(analysis, /runId, request: \{ tokens:/);
  assert.match(analysis, /await writeLedgerEntry\(ledgerEntryFromResponse\(resp, \{ runId/);
  assert.match(analysis, /input\.artifactFilename \?\? 'analysis\.md'/);
});

test('plan approval creates READY tasks; queue requires approved plan and dependency PASS', () => {
  const plans = read('server/planService.ts');
  assert.match(plans, /status='APPROVED'/);
  assert.match(plans, /to: 'READY'/);
  assert.match(plans, /plan\.status !== 'APPROVED'/);
  assert.match(plans, /state !== 'PASS'/);
  assert.match(plans, /kind: 'budget'/);
});

test('Task PASS is impossible without explicit successful validation evidence', () => {
  const machine = read('server/taskMachine.ts');
  assert.match(machine, /if \(!v \|\| v\.passed !== true \|\| !Array\.isArray\(v\.evidence\) \|\| v\.evidence\.length < 1/);
  const server = read('server.ts');
  assert.match(server, /to: input\.passed \? 'PASS' : 'FAIL'/);
});

test('E-01 closure: ADR-10 accepted; scenario 18.1 remains owner/live (ARCHIVE/P15-REPORT optional off-repo)', () => {
  assert.match(read('docs/ADR-10-code-executor.md'), /Status: Accepted/i);
  // Historical table lived in ARCHIVE/P15-REPORT.md; may be local-only per HISTORY_OFFREPO.
});
