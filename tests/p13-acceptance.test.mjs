// P13 acceptance (no database): budgets, Task Graph v1 validation, approvals rules. Describes ARCHIVE/P13-SPEC.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUDGET_KEYS, APPROVAL_MODES, APPROVAL_KINDS, MAX_PLAN_TASKS, DEFAULT_MAX_CONCURRENT_RUNS, PlanError, emptyUsage, checkBudget, raisesBudget,
  validatePlan, planFromTemplate, planUnits, budgetLimitsSchema,
} from '../server/planMachine.ts';
import { runEffectOnTask, TaskError } from '../server/taskMachine.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const node = (key, deps = [], extra = {}) => ({ key, title: key, task: `do ${key}`, deps, ...extra });
const reason = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof PlanError, String(e)); assert.equal(e.code, 'PLAN_INVALID'); return e.details.reason; } return null; };

test('limits cover TZ 8.4 and nothing else; unknown keys are refused', () => {
  assert.deepEqual([...BUDGET_KEYS], ['max_model_calls', 'max_tokens', 'max_cost_units', 'max_wall_clock_ms', 'max_attempts', 'max_code_tasks']);
  assert.ok(budgetLimitsSchema.safeParse({ max_tokens: 10 }).success);
  assert.equal(budgetLimitsSchema.safeParse({ max_tokens: -1 }).success, false);
  assert.equal(budgetLimitsSchema.safeParse({ max_dollars: 1 }).success, false);
});

test('checkBudget: used + requested over a limit is a violation; a missing limit is no limit', () => {
  const used = { ...emptyUsage(), calls: 2, tokens: 900 };
  assert.deepEqual(checkBudget('task', { max_model_calls: 3 }, used, { calls: 1 }), []);
  const v = checkBudget('task', { max_model_calls: 2, max_tokens: null }, used, { calls: 1 });
  assert.deepEqual(v, [{ scope: 'task', limit: 'max_model_calls', max: 2, used: 2, requested: 1 }]);
  assert.deepEqual(checkBudget('run', { max_tokens: 1000 }, used, { tokens: 101 }).map((x) => x.limit), ['max_tokens']);
  assert.deepEqual(checkBudget('run', null, used, { calls: 99 }), []);
});

test('raisesBudget: higher number or a removed limit raises; lowering or first set does not', () => {
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: 11 }), true);
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: null }), true);
  assert.equal(raisesBudget({ max_tokens: 10 }, {}), true);
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: 10 }), false);
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: 5 }), false);
  assert.equal(raisesBudget(null, { max_tokens: 5 }), false);
  assert.equal(raisesBudget({}, { max_tokens: 5 }), false);
});

test('plan validator: cycle, self-dependency, unknown dependency, duplicates, empty, more than 12 tasks', () => {
  assert.equal(MAX_PLAN_TASKS, 12);
  assert.equal(reason(() => validatePlan([node('a', ['b']), node('b', ['a'])])), 'cycle');
  assert.equal(reason(() => validatePlan([node('a', ['a'])])), 'cycle');
  assert.equal(reason(() => validatePlan([node('a', ['x'])])), 'unknown_dependency');
  assert.equal(reason(() => validatePlan([node('a'), node('a')])), 'duplicate_key');
  assert.equal(reason(() => validatePlan([])), 'empty');
  assert.equal(reason(() => validatePlan(Array.from({ length: 13 }, (_, i) => node(`n${i}`)))), 'too_many_tasks');
  assert.equal(validatePlan(Array.from({ length: 12 }, (_, i) => node(`n${i}`))).length, 12);
  assert.equal(reason(() => validatePlan([{ key: 'A B', title: 't', task: 'x' }])), 'schema');
  assert.equal(reason(() => validatePlan([{ ...node('a'), extra: 1 }])), 'schema');
  assert.equal(validatePlan([node('a'), node('b', ['a']), node('c', ['a', 'b'])]).length, 3);
});

test('plan validator: total units must fit the project limit', () => {
  const nodes = [node('a', [], { units: 6 }), node('b', ['a'], { units: 5 })];
  assert.equal(planUnits(validatePlan(nodes, null)), 11);
  assert.equal(planUnits(validatePlan(nodes, 11)), 11);
  assert.equal(reason(() => validatePlan(nodes, 10)), 'budget');
});

test('static template: specification -> architecture -> review -> approval', () => {
  const nodes = planFromTemplate('spec_arch_review_approval', { goal: 'Ship it' });
  assert.deepEqual(nodes.map((n) => n.key), ['specification', 'architecture', 'review', 'approval']);
  assert.deepEqual(nodes.map((n) => n.deps), [[], ['specification'], ['architecture'], ['review']]);
  assert.ok(nodes.every((n) => n.task.includes('Ship it')));
  assert.throws(() => planFromTemplate('nope', { goal: 'x' }), (e) => e.code === 'TEMPLATE_UNKNOWN');
  assert.throws(() => planFromTemplate('spec_arch_review_approval', { goal: '  ' }), (e) => e.code === 'PLAN_INVALID');
});

test('approvals: supervised and manual only, no autonomous mode and no flag for it (TZ 8.6)', () => {
  assert.deepEqual([...APPROVAL_MODES], ['supervised', 'manual']);
  assert.deepEqual([...APPROVAL_KINDS], ['plan', 'budget', 'merge_ready', 'state_decision', 'destructive', 'task_start']);
  assert.equal(DEFAULT_MAX_CONCURRENT_RUNS, 2);
  for (const f of ['migrations/007_budgets_plans_approvals.sql', 'server/planMachine.ts', 'server/planService.ts', '.env.example']) {
    assert.ok(!/autonomous/i.test(fs.readFileSync(path.join(root, f), 'utf8').replace(/--[^\n]*|\/\/[^\n]*/g, '')), `${f} must not mention autonomous`);
  }
});

test('PlanError carries a code and an HTTP status', () => {
  const st = { BUDGET_EXCEEDED: 409, PLAN_INVALID: 400, PLAN_NOT_APPROVED: 409, DEPENDENCY_NOT_READY: 409, ARTIFACT_WRITE_CONFLICT: 409, HUMAN_REQUIRED: 403, APPROVAL_NOT_FOUND: 404, APPROVAL_CLOSED: 409 };
  for (const [c, s] of Object.entries(st)) { const e = new PlanError(c, 'm'); assert.equal(e.status, s); assert.equal(e.code, c); }
});

test('a budget stop moves the Task to BLOCKED(budget); it never leads to PASS', () => {
  assert.deepEqual(runEffectOnTask('FAILED', 'budget'), { state: 'BLOCKED', blockedReason: 'budget' });
  assert.deepEqual(runEffectOnTask('TIMED_OUT', 'budget'), { state: 'BLOCKED', blockedReason: 'budget' });
  assert.throws(() => runEffectOnTask('SUCCEEDED', 'budget'), TaskError);
  assert.deepEqual(runEffectOnTask('FAILED'), { state: 'FAIL' });   // unchanged without the reason
});
