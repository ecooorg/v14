import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GATES, GATE_STATUSES } from '../server/gateEngine.ts';
import {
  CODE_ERROR_MESSAGES, CODE_STATE_LABELS, GATE_LABELS, GATE_STATUS_LABELS, GATE_ORDER, GATE_STATUS_ORDER, HUMAN_APPROVAL_GATES, CI_ONLY_NOTE,
  deliveryErrorMessage, gateRows, handoffText, latestPerTask, nextDeliveryAction, shortSha, stopReasonLabel, STEP_ORDER, NO_COMMIT_NOTE,
} from '../src/projectDeliveryModel.ts';
import { STOP_REASONS } from '../server/repairLoop.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const server = read('server.ts');
const svc = read('server/codeTaskService.ts');
const comp = read('src/ProjectDelivery.tsx');
const pm = read('src/ProjectMode.tsx');

const SHA = 'a'.repeat(40);
const ct = (over = {}) => ({ id: 'c1', taskId: 't1', status: 'WAITING_HUMAN', delivery: null, branch: null, expectedBranch: 'biforge/t1', headSha: null, prNumber: null, prUrl: null, statusReason: null, packageApprovedAt: null, packageHash: 'h'.repeat(64), decision: null, decisionReason: null, reviewFindings: null, repairStopReasons: null, attempt: 1, repairOf: null, ...over });
const caps = (over = {}) => ({ analysis: true, plans: true, programZip: false, manualDelivery: { githubRead: true }, githubWrite: false, ...over });

test('P54 labels cover every gate and every gate status of the engine, in the same order', () => {
  assert.deepEqual([...GATE_ORDER], [...GATES]);
  assert.deepEqual([...GATE_STATUS_ORDER], [...GATE_STATUSES]);
  for (const g of GATES) assert.ok(GATE_LABELS[g] && !/_/.test(GATE_LABELS[g]), `label for ${g}`);
  for (const s of GATE_STATUSES) assert.ok(GATE_STATUS_LABELS[s], `label for ${s}`);
  assert.equal(GATE_STATUS_LABELS.WAIVED, 'Waived by you');
});

test('P54 every server error code of the code task service has a plain sentence', () => {
  const block = svc.match(/const STATUS = \{([\s\S]*?)\} as const;/)[1];
  const codes = [...block.matchAll(/\b([A-Z][A-Z_]+):\s*\d{3}/g)].map((m) => m[1]);
  assert.ok(codes.length >= 25, `found ${codes.length} codes`);
  for (const c of codes) assert.ok(CODE_ERROR_MESSAGES[c], `no sentence for ${c}`);
  for (const c of ['NO_HEAD', 'INVALID_GATE', 'PASSPORT_NOT_CONFIRMED', 'UNAUTHORIZED']) assert.ok(CODE_ERROR_MESSAGES[c], c);
  for (const m of Object.values(CODE_ERROR_MESSAGES)) assert.doesNotMatch(m, /[A-Z]{3,}_[A-Z_]+|GITHUB_|CODE_EXECUTOR|model_patch/);
  assert.equal(deliveryErrorMessage('PR_MISMATCH', 'x'), CODE_ERROR_MESSAGES.PR_MISMATCH);
  assert.equal(deliveryErrorMessage('SOMETHING_NEW', 'Server said this'), 'Server said this');
  assert.match(deliveryErrorMessage(undefined, ''), /Nothing was changed/);
});

test('P54 gate rows: only requirements/spec/review can be approved; CI gates are read-only; settled rows cannot be waived', () => {
  assert.deepEqual([...HUMAN_APPROVAL_GATES], ['requirements', 'spec', 'review']);
  const gates = Object.fromEntries(GATES.map((g) => [g, { gate: g, status: 'NOT_RUN', reasons: [`${g} missing`] }]));
  gates.build = { gate: 'build', status: 'PASS', reasons: [] };
  gates.spec = { gate: 'spec', status: 'WAIVED', reasons: [] };
  gates.test = { gate: 'test', status: 'FAIL', reasons: ['1 failing'] };
  const rows = gateRows({ commit: SHA, gates });
  assert.equal(rows.length, 8);
  for (const r of rows) {
    const human = HUMAN_APPROVAL_GATES.includes(r.gate);
    assert.equal(r.canApprove, human && r.status !== 'PASS', r.gate);
    assert.equal(r.ciOnlyNote, human ? null : CI_ONLY_NOTE, r.gate);
    assert.equal(r.canWaive, r.status !== 'PASS' && r.status !== 'WAIVED', r.gate);
  }
  assert.equal(rows.find((r) => r.gate === 'build').canApprove, false);
  assert.equal(rows.find((r) => r.gate === 'test').statusLabel, 'Failed');
  assert.equal(rows.find((r) => r.gate === 'release_candidate').canApprove, false, 'the release candidate is derived, never approved by a button');
  assert.deepEqual(gateRows({ commit: null, gates: null }), []);
  assert.deepEqual(gateRows(null), []);
  assert.equal(gateRows({ commit: SHA, gates: {} }).every((r) => r.status === 'NOT_RUN'), true, 'a missing gate is shown as not run, never as passed');
  assert.match(NO_COMMIT_NOTE('biforge/t1'), /biforge\/t1/);
  assert.equal(shortSha(SHA), 'aaaaaaa');
});

test('P54 next action: steps follow the code task state', () => {
  const step = (o, c = caps()) => nextDeliveryAction(ct(o), c).step;
  assert.equal(step({}), 'package');
  assert.equal(step({ packageApprovedAt: 'x' }), 'handoff');
  assert.equal(step({ packageApprovedAt: 'x', status: 'BLOCKED' }), 'result');
  assert.equal(step({ status: 'DELIVERED', headSha: null, packageApprovedAt: 'x' }), 'checks');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA }), 'review');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA, reviewFindings: { findings: [], summary: '', highCount: 0, hasUnresolvedHigh: false } }), 'decision');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA, decision: 'repair' }), 'repair');
  assert.equal(step({ status: 'DELIVERED', headSha: SHA, decision: 'accept' }), 'closed');
  assert.equal(step({ status: 'FAILED' }), 'closed');
  for (const s of ['package', 'handoff', 'result', 'checks', 'review', 'decision', 'repair']) assert.ok(STEP_ORDER.includes(s));
});

test('P54 next action: package approval, result kinds and cancel', () => {
  const a = (o, c = caps()) => nextDeliveryAction(ct(o), c);
  assert.equal(a({}).canApprovePackage, true);
  assert.equal(a({ packageApprovedAt: 'x' }).canApprovePackage, false);
  assert.equal(a({}).canSubmitResult, false, 'no result before the package is approved');
  assert.equal(a({ packageApprovedAt: 'x' }).canSubmitResult, true);
  assert.deepEqual(a({ packageApprovedAt: 'x' }).resultKinds, ['pr', 'branch']);
  assert.equal(a({ packageApprovedAt: 'x' }, caps({ manualDelivery: { githubRead: false } })).canSubmitResult, false);
  assert.equal(a({ packageApprovedAt: 'x' }, caps({ manualDelivery: { githubRead: false } })).needsGithubForResult, true);
  assert.deepEqual(a({ packageApprovedAt: 'x' }, null).resultKinds, []);
  assert.equal(a({}).canCancel, true);
  assert.equal(a({ status: 'DELIVERED', headSha: SHA }).canCancel, false);
  assert.equal(a({ status: 'FAILED' }).canCancel, false);
  assert.equal(a({}).canDownloadPackage, true);
});

test('P54 no write control without the GitHub write capability (ADR-06 Amendment 1)', () => {
  for (const c of [caps(), caps({ githubWrite: false }), null, undefined, caps({ manualDelivery: { githubRead: false }, githubWrite: true })]) {
    const x = nextDeliveryAction(ct({ packageApprovedAt: 'x' }), c);
    assert.equal(x.showCommitPackage, false);
    assert.equal(x.resultKinds.includes('diff'), false);
  }
  const on = nextDeliveryAction(ct({ packageApprovedAt: 'x' }), caps({ githubWrite: true }));
  assert.equal(on.showCommitPackage, true);
  assert.deepEqual(on.resultKinds, ['pr', 'branch', 'diff']);
});

test('P54 next action: review, decide, refresh and repair only when they make sense', () => {
  const d = (o, c = caps()) => nextDeliveryAction(ct({ status: 'DELIVERED', headSha: SHA, ...o }), c);
  assert.equal(d({}).canRefresh, true);
  assert.equal(d({}, caps({ manualDelivery: { githubRead: false } })).canRefresh, false);
  assert.equal(d({}).canReview, true);
  assert.equal(d({ reviewFindings: { findings: [], summary: '', highCount: 0, hasUnresolvedHigh: false } }).canReview, false);
  assert.equal(d({}).canDecide, true);
  assert.equal(d({ decision: 'accept' }).canDecide, false);
  assert.equal(d({ decision: 'accept' }).canRepair, false);
  assert.equal(d({ decision: 'repair' }).canRepair, true);
  assert.equal(nextDeliveryAction(ct({}), caps()).canDecide, false, 'no decision before delivery');
});

test('P54 list groups attempts by task and keeps the latest attempt', () => {
  const list = latestPerTask([ct({ id: 'b2', taskId: 'tb', attempt: 2 }), ct({ id: 'a1', taskId: 'ta', attempt: 1 }), ct({ id: 'b1', taskId: 'tb', attempt: 1 })]);
  assert.deepEqual(list.map((c) => c.id), ['b2', 'a1']);
  assert.deepEqual(latestPerTask([]), []);
});

test('P54 plain text: states, stop reasons and hand-off steps', () => {
  for (const s of ['WAITING_HUMAN', 'RUNNING', 'DELIVERED', 'FAILED', 'BLOCKED']) assert.ok(CODE_STATE_LABELS[s]);
  for (const r of STOP_REASONS) assert.notEqual(stopReasonLabel(r), r, `plain sentence for ${r}`);
  const t = handoffText('biforge/t1').join(' ');
  assert.match(t, /PACKAGE\.md/); assert.match(t, /biforge\/t1/); assert.match(t, /pull request/);
});

test('P54 server: manual task route, project list and expectedBranch', () => {
  assert.match(server, /app\.get\('\/api\/projects\/:projectId\/code', async/);
  assert.match(server, /app\.post\('\/api\/projects\/:projectId\/code\/manual', async/);
  assert.match(server, /passport\?\.executor !== 'manual'/);
  assert.match(server, /code: 'EXECUTOR_MISMATCH'/);
  assert.match(server, /code: 'PASSPORT_NOT_CONFIRMED'/);
  assert.match(svc, /export async function listProjectCodeTasks/);
  assert.match(svc, /expectedBranch: expectedBranchOf\(r\.task_id\)/);
  const route = server.slice(server.indexOf("app.post('/api/projects/:projectId/code/manual'"), server.indexOf("app.post('/api/projects/:projectId/tasks/:taskId/code/start'"));
  assert.doesNotMatch(route, /commitApprovedPackage|commitChangesToBranch|openPullRequest|modelCaller/, 'the manual route never writes and never calls a model');
  assert.doesNotMatch(route, /req\.body\??\.actor/);
});

test('P54 interface wiring: tab, component, every endpoint, error codes', () => {
  assert.match(pm, /import ProjectDelivery from '\.\/ProjectDelivery\.tsx'/);
  assert.match(pm, /\['delivery', 'Delivery'\]/);
  assert.match(pm, /activeTab === 'delivery' && <ProjectDelivery/);
  assert.match(pm, /Open in Delivery/);
  for (const frag of ['/code`', '/code/manual', '/package`', '/approve`', '/commit-package`', '/result`', '/refresh`', '/review`', '/decide`', '/repair`', '/cancel`', '/gates`', '/gates/${gate}/approve', '/gates/${gate}/waive']) assert.ok(comp.includes(frag), `component calls ${frag}`);
  assert.match(comp, /e\.code = p\.code/);
  assert.match(comp, /role="status" aria-live="polite"/);
  assert.match(comp, /role="alertdialog"/);
  assert.match(comp, /BiForge never merges/);
});

test('P54 write controls are only reachable behind the write capability; CI gates have no approve button', () => {
  const commitBtn = comp.indexOf('commitPackage(selected)}>');
  assert.ok(commitBtn > 0);
  assert.match(comp.slice(Math.max(0, commitBtn - 160), commitBtn), /action\.showCommitPackage &&/);
  assert.match(comp, /resultKind === 'diff' && action\.resultKinds\.includes\('diff'\)/);
  assert.match(comp, /r\.canApprove &&/);
  assert.doesNotMatch(comp, /gates\/\$\{gate\}\/approve`, \{ status: 'PASS' \}[\s\S]{0,40}release_candidate/);
  assert.doesNotMatch(comp, /localStorage|sessionStorage|setInterval|setTimeout\(\(\) => void (reload|refresh)/, 'nothing polls, nothing is stored');
  assert.doesNotMatch(comp, /actor/i, 'the actor is never sent from the browser');
});

test('P54 destructive and decision actions go through a confirmation with a reason', () => {
  assert.match(comp, /<Confirm\s+title=\{pending\.decision/);
  assert.match(comp, /title="Close this task"/);
  assert.match(comp, /title=\{`Waive «\$\{r\.label\}»`\}/);
  assert.match(comp, /needReason/);
  assert.match(comp, /idemKey/);
});

test('P54 render smoke: the Delivery tab renders its list state for every capability combination', async () => {
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const { default: ProjectDelivery } = await import('../src/ProjectDelivery.tsx');
  const html = (props) => renderToString(React.createElement(ProjectDelivery, { projectId: 'p1', capabilities: caps(), passportConfirmed: true, executor: 'manual', ...props }));
  const ok = html({});
  assert.match(ok, /Delivery/); assert.match(ok, /New hand-off task/); assert.match(ok, /BiForge never merges/);
  assert.match(ok, /role="status"/);
  assert.doesNotMatch(ok, /disabled=""[^>]*>New hand-off task/);
  assert.match(html({ passportConfirmed: false }), /Confirm the project description first\./);
  assert.match(html({ executor: 'model_patch' }), /Set «How code is written» to Manual/);
  for (const c of [null, caps({ manualDelivery: { githubRead: false } }), caps({ githubWrite: true })]) assert.match(html({ capabilities: c }), /New hand-off task/);
});
