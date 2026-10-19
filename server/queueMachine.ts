// Job queue rules (TZ 8.3). Pure functions: no database, no clock.
export const JOB_STATES = ['QUEUED', 'LEASED', 'DONE', 'ABANDONED', 'CANCELLED'] as const;
export type JobStatus = typeof JOB_STATES[number];
export const DEFAULT_LEASE_MS = 60000;
export const DEFAULT_HEARTBEAT_MS = 20000;
export const DEFAULT_POLL_MS = 2000;

const STATUS = { LEASE_LOST: 409, NOT_FOUND: 404, INVALID_TIMING: 400, INVALID_STATUS: 400 } as const;

export class QueueError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof STATUS | string, message: string, status?: number) {
    super(message);
    this.name = 'QueueError';
    this.status = status ?? (STATUS as Record<string, number>)[code] ?? 400;
  }
}

export const leaseUntil = (now: Date, leaseMs: number): Date => new Date(now.getTime() + leaseMs);
/** A lease is over exactly at lease_until. */
export const isLeaseExpired = (until: Date, now: Date): boolean => now.getTime() >= until.getTime();

export function validateTiming(t: { leaseMs: number; heartbeatMs: number }): void {
  const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (!ok(t.leaseMs) || !ok(t.heartbeatMs) || t.heartbeatMs * 2 > t.leaseMs) {
    throw new QueueError('INVALID_TIMING', 'leaseMs and heartbeatMs must be positive integers and heartbeatMs * 2 <= leaseMs');
  }
}

/** Job status after the final status of its Run. */
export function jobStatusForRun(status: string): JobStatus {
  switch (status) {
    case 'SUCCEEDED': case 'FAILED': case 'TIMED_OUT': return 'DONE';
    case 'CANCELLED': return 'CANCELLED';
    case 'ABANDONED': return 'ABANDONED';
    default: throw new QueueError('INVALID_STATUS', `Run status ${status} does not close a job`);
  }
}
