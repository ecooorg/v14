import { z } from 'zod';

// Budgets, Task Graph v1 and approvals (TZ 8.4-8.6). Pure functions: no database, no clock.
export const MAX_PLAN_TASKS = 12;
export const DEFAULT_MAX_CONCURRENT_RUNS = 2;
export const APPROVAL_KINDS = ['plan', 'budget', 'merge_ready', 'state_decision', 'destructive', 'task_start'] as const;
export const APPROVAL_MODES = ['supervised', 'manual'] as const;   // no autonomous mode and no flag for it (TZ 8.6)
export type ApprovalKind = typeof APPROVAL_KINDS[number];
export type ApprovalMode = typeof APPROVAL_MODES[number];
/** Profiles whose tasks count against max_code_tasks. */
export const CODE_PROFILES = ['code_author'] as const;

const STATUS = {
  BUDGET_EXCEEDED: 409, PLAN_INVALID: 400, PLAN_NOT_APPROVED: 409, DEPENDENCY_NOT_READY: 409, ARTIFACT_WRITE_CONFLICT: 409,
  APPROVAL_NOT_FOUND: 404, APPROVAL_CLOSED: 409, HUMAN_REQUIRED: 403, APPROVAL_REQUIRED: 409, NOT_IN_PLAN: 409, PLAN_NOT_FOUND: 404, TEMPLATE_UNKNOWN: 400, BUDGET_LIMITS_REQUIRED: 400,
} as const;
export type PlanErrorCode = keyof typeof STATUS;

export class PlanError extends Error {
  readonly status: number;
  constructor(readonly code: PlanErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PlanError';
    this.status = STATUS[code] ?? 400;
  }
}

// ---- budgets (TZ 8.4) ----
export const BUDGET_KEYS = ['max_model_calls', 'max_tokens', 'max_cost_units', 'max_wall_clock_ms', 'max_attempts', 'max_code_tasks'] as const;
export type BudgetKey = typeof BUDGET_KEYS[number];
const lim = z.number().int().min(0).max(1_000_000_000).nullable().optional();
export const budgetLimitsSchema = z.object({
  max_model_calls: lim, max_tokens: lim, max_cost_units: lim, max_wall_clock_ms: lim, max_attempts: lim, max_code_tasks: lim,
}).strict();
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>;
export const BUDGET_SCOPES = ['project', 'task', 'run'] as const;
export type BudgetScope = typeof BUDGET_SCOPES[number];

export type Usage = { calls: number; tokens: number; units: number; wallClockMs: number; attempts: number; codeTasks: number };
export const emptyUsage = (): Usage => ({ calls: 0, tokens: 0, units: 0, wallClockMs: 0, attempts: 0, codeTasks: 0 });
export type Request = Partial<Usage>;
export type Violation = { scope: BudgetScope; limit: BudgetKey; max: number; used: number; requested: number };

const USAGE_OF: Record<BudgetKey, keyof Usage> = {
  max_model_calls: 'calls', max_tokens: 'tokens', max_cost_units: 'units', max_wall_clock_ms: 'wallClockMs', max_attempts: 'attempts', max_code_tasks: 'codeTasks',
};

/** A limit is exceeded when used + requested goes over it. A missing limit (null/undefined) means no limit. */
export function checkBudget(scope: BudgetScope, limits: BudgetLimits | null | undefined, used: Usage, request: Request = {}): Violation[] {
  const out: Violation[] = [];
  if (!limits) return out;
  for (const key of BUDGET_KEYS) {
    const max = limits[key];
    if (max === null || max === undefined) continue;
    const field = USAGE_OF[key];
    const requested = request[field] ?? 0;
    if (used[field] + requested > max) out.push({ scope, limit: key, max, used: used[field], requested });
  }
  return out;
}

/** True when the new limits give more room than the old ones (a higher number, or a limit removed). Only a human may do that (TZ 8.4). */
export function raisesBudget(oldLimits: BudgetLimits | null | undefined, next: BudgetLimits): boolean {
  for (const key of BUDGET_KEYS) {
    const before = oldLimits?.[key] ?? null;
    const after = next[key] ?? null;
    if (before === null) continue;          // was unlimited: any new value is not more room
    if (after === null || after > before) return true;
  }
  return false;
}

// ---- Task Graph v1 (TZ 8.5) ----
export const planNodeSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  title: z.string().trim().min(1).max(200),
  task: z.string().min(1).max(20000),
  profile: z.string().min(1).max(100).nullable().default(null),
  deps: z.array(z.string()).max(MAX_PLAN_TASKS).default([]),
  units: z.number().int().min(0).max(1_000_000).default(0),
  writesArtifact: z.string().min(1).max(500).nullable().default(null),
  criteria: z.array(z.string().min(1).max(2000)).max(100).default([]),
}).strict();
export type PlanNode = z.infer<typeof planNodeSchema>;

/** Validates a plan and returns the parsed nodes. projectUnitLimit = the project's max_cost_units (null: no limit). */
export function validatePlan(raw: unknown, projectUnitLimit: number | null = null): PlanNode[] {
  const parsed = z.array(planNodeSchema).safeParse(raw);
  if (!parsed.success) throw new PlanError('PLAN_INVALID', 'Plan nodes are malformed', { reason: 'schema' });
  const nodes = parsed.data;
  if (nodes.length < 1) throw new PlanError('PLAN_INVALID', 'Plan has no tasks', { reason: 'empty' });
  if (nodes.length > MAX_PLAN_TASKS) throw new PlanError('PLAN_INVALID', `Plan has more than ${MAX_PLAN_TASKS} tasks`, { reason: 'too_many_tasks' });
  const keys = new Set<string>();
  for (const n of nodes) {
    if (keys.has(n.key)) throw new PlanError('PLAN_INVALID', `Duplicate task key ${n.key}`, { reason: 'duplicate_key', key: n.key });
    keys.add(n.key);
  }
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!keys.has(d)) throw new PlanError('PLAN_INVALID', `Task ${n.key} depends on unknown ${d}`, { reason: 'unknown_dependency', key: n.key, dep: d });
    }
    if (new Set(n.deps).size !== n.deps.length) throw new PlanError('PLAN_INVALID', `Task ${n.key} repeats a dependency`, { reason: 'duplicate_dependency', key: n.key });
  }
  // Kahn: anything left after peeling nodes without open dependencies is on a cycle (a self-dependency too).
  const left = new Map(nodes.map((n) => [n.key, new Set(n.deps)]));
  for (let progress = true; progress && left.size > 0;) {
    progress = false;
    for (const [k, deps] of [...left]) if (deps.size === 0) { left.delete(k); for (const d of left.values()) d.delete(k); progress = true; }
  }
  if (left.size > 0) throw new PlanError('PLAN_INVALID', 'Plan has a dependency cycle', { reason: 'cycle', keys: [...left.keys()].sort() });
  const total = planUnits(nodes);
  if (projectUnitLimit !== null && total > projectUnitLimit) {
    throw new PlanError('PLAN_INVALID', `Plan budget ${total} exceeds the project limit ${projectUnitLimit}`, { reason: 'budget', total, limit: projectUnitLimit });
  }
  return nodes;
}
export const planUnits = (nodes: PlanNode[]): number => nodes.reduce((s, n) => s + n.units, 0);

export const PLAN_TEMPLATES = ['spec_arch_review_approval'] as const;
export type PlanTemplate = typeof PLAN_TEMPLATES[number];

/** Static template: specification -> architecture -> review -> approval. */
export function planFromTemplate(name: string, o: { goal: string; unitsPerTask?: number }): PlanNode[] {
  if (name !== 'spec_arch_review_approval') throw new PlanError('TEMPLATE_UNKNOWN', `Unknown plan template ${name}`);
  const goal = o.goal.trim();
  if (!goal) throw new PlanError('PLAN_INVALID', 'Goal is empty', { reason: 'empty_goal' });
  const units = o.unitsPerTask ?? 10;
  const mk = (key: string, title: string, task: string, deps: string[], profile: string | null): PlanNode =>
    planNodeSchema.parse({ key, title, task: `${task}\n\nGoal: ${goal}`, deps, units, profile, writesArtifact: null, criteria: [] });
  return validatePlan([
    mk('specification', 'Specification', 'Write the specification.', [], null),
    mk('architecture', 'Architecture', 'Design the architecture from the specification.', ['specification'], 'architect'),
    mk('review', 'Review', 'Review the specification and the architecture.', ['architecture'], null),
    mk('approval', 'Approval', 'Prepare the result for the human decision.', ['review'], null),
  ]);
}
