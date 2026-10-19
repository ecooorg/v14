import { createHash } from 'node:crypto';
import { z } from 'zod';

// Task/Run state machine (TZ 8.1, 8.2). Pure functions: no database, no clock.
export const TASK_STATES = ['DRAFT', 'READY', 'QUEUED', 'RUNNING', 'VALIDATING', 'PASS', 'FAIL', 'BLOCKED', 'CANCELLED'] as const;
export const RUN_STATES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED'] as const;
export type TaskState = typeof TASK_STATES[number];
export type RunStatus = typeof RUN_STATES[number];
export const DEFAULT_MAX_ATTEMPTS = 3;

const STATUS = {
  NOT_FOUND: 404, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, INVALID_TRANSITION: 409,
  RUN_API_REQUIRED: 409, VALIDATION_REQUIRED: 409, GATES_BLOCKED: 409, ATTEMPTS_EXHAUSTED: 409, INPUT_LOCKED: 409,
} as const;
export type TaskErrorCode = keyof typeof STATUS;

export class TaskError extends Error {
  readonly status: number;
  constructor(readonly code: TaskErrorCode | string, message: string, status?: number) {
    super(message);
    this.name = 'TaskError';
    this.status = status ?? (STATUS as Record<string, number>)[code] ?? 400;
  }
}

export const taskInputSchema = z.object({
  task: z.string().min(1).max(20000),
  artifactRefs: z.array(z.string().min(1).max(500)).max(200),
  stateVersion: z.number().int().min(1).nullable(),
  profile: z.string().min(1).max(100).nullable(),
  profileVersion: z.string().min(1).max(100).nullable(),
  criteria: z.array(z.string().min(1).max(2000)).max(100),
}).strict();
export type TaskInput = z.infer<typeof taskInputSchema>;

/** SHA-256 of the canonical JSON: keys sorted, artifactRefs sorted; other order is significant. */
export function taskFingerprint(input: TaskInput): string {
  const v = taskInputSchema.parse(input);
  const canonical = JSON.stringify({
    artifactRefs: [...v.artifactRefs].sort(), criteria: v.criteria, profile: v.profile,
    profileVersion: v.profileVersion, stateVersion: v.stateVersion, task: v.task,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['QUEUED', 'BLOCKED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'BLOCKED', 'CANCELLED', 'FAIL'],
  RUNNING: ['VALIDATING', 'FAIL', 'BLOCKED', 'CANCELLED'],
  VALIDATING: ['PASS', 'FAIL', 'BLOCKED', 'CANCELLED'],
  PASS: ['VALIDATING'],
  FAIL: ['READY', 'CANCELLED'],
  BLOCKED: ['READY', 'FAIL', 'CANCELLED'],
  CANCELLED: [],
};

export type TransitionContext = {
  via?: 'run';
  reason?: string;
  validation?: { passed: boolean; evidence: string[] };
  attemptsUsed?: number;
  maxAttempts?: number;
};

export function assertTaskTransition(from: TaskState, to: TaskState, ctx: TransitionContext = {}): void {
  if (!(TASK_TRANSITIONS[from] ?? []).includes(to)) throw new TaskError('INVALID_TRANSITION', `Task cannot move from ${from} to ${to}`);
  const runMove = (s: TaskState) => s === 'QUEUED' || s === 'RUNNING';
  if ((runMove(from) || runMove(to)) && ctx.via !== 'run') throw new TaskError('RUN_API_REQUIRED', `Moves ${from} -> ${to} belong to the Run API`);
  if (from === 'PASS' && ctx.reason !== 'input_changed') throw new TaskError('INVALID_TRANSITION', 'PASS can be reopened only when the input changed');
  if (to === 'PASS') {
    const v = ctx.validation;
    if (!v || v.passed !== true || !Array.isArray(v.evidence) || v.evidence.length < 1 || !v.evidence.every((e) => typeof e === 'string' && e.trim().length > 0)) {
      throw new TaskError('VALIDATION_REQUIRED', 'PASS requires a passed validation with evidence');
    }
  }
  if (from === 'FAIL' && to === 'READY' && (ctx.attemptsUsed ?? 0) >= (ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
    throw new TaskError('ATTEMPTS_EXHAUSTED', 'No attempts left');
  }
}

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED'],
  SUCCEEDED: [], FAILED: [], TIMED_OUT: [], CANCELLED: [], ABANDONED: [],
};
export const canRunTransition = (from: RunStatus, to: RunStatus): boolean => (RUN_TRANSITIONS[from] ?? []).includes(to);

/** The effect of a final Run status on its Task. No status leads to PASS. */
export function runEffectOnTask(status: RunStatus, blockReason?: 'budget'): { state: TaskState; blockedReason?: string } {
  if (blockReason === 'budget') {   // a Run stopped by the budget guard: the Run is FAILED or TIMED_OUT, the Task waits for a human (TZ 8.4)
    if (status !== 'FAILED' && status !== 'TIMED_OUT') throw new TaskError('INVALID_TRANSITION', 'Only a FAILED or TIMED_OUT Run can block its Task for budget');
    return { state: 'BLOCKED', blockedReason: 'budget' };
  }
  switch (status) {
    case 'SUCCEEDED': return { state: 'VALIDATING' };
    case 'FAILED': case 'TIMED_OUT': return { state: 'FAIL' };
    case 'CANCELLED': return { state: 'CANCELLED' };
    case 'ABANDONED': return { state: 'BLOCKED', blockedReason: 'recovery' };
    default: throw new TaskError('INVALID_TRANSITION', `Run status ${status} has no final effect`);
  }
}
