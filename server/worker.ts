import { DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_MS, DEFAULT_POLL_MS, QueueError, validateTiming } from './queueMachine.ts';
import { claimJob, completeJob, heartbeatJob, recoverExpired, type Job } from './queueService.ts';
import type { Run, Task } from './taskService.ts';

// Worker (TZ 8.3): library only; not started from server.ts in P12. One job at a time.
export type WorkerStatus = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
export type WorkerResult = { status: WorkerStatus; providerId?: string; modelId?: string; policyVersion?: string; budget?: unknown; evidence?: string[]; blockReason?: 'budget' };
export type WorkerHandler = (ctx: { job: Job; run: Run; task: Task; signal: AbortSignal }) => Promise<WorkerResult>;
export type WorkerOptions = { workerId: string; handler: WorkerHandler; projectId?: string; leaseMs?: number; heartbeatMs?: number; pollMs?: number; maxConcurrent?: number };

export function createWorker(opts: WorkerOptions) {
  if (typeof opts.workerId !== 'string' || !opts.workerId.trim()) throw new TypeError('workerId is required');
  if (typeof opts.handler !== 'function') throw new TypeError('handler is required');
  const workerId = opts.workerId.trim();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  validateTiming({ leaseMs, heartbeatMs });
  const scope = opts.projectId === undefined ? {} : { projectId: opts.projectId };
  const claimScope = opts.maxConcurrent === undefined ? scope : { ...scope, maxConcurrent: opts.maxConcurrent };
  const isLost = (e: unknown) => e instanceof QueueError && e.code === 'LEASE_LOST';

  async function tick(): Promise<'idle' | 'done' | 'lease_lost'> {
    await recoverExpired(scope);
    const claimed = await claimJob({ workerId, leaseMs, ...claimScope });
    if (!claimed) return 'idle';
    const { job, run, task } = claimed;
    const ac = new AbortController();
    let lost = false;
    let inflight: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (inflight || lost) return;
      inflight = heartbeatJob({ jobId: job.id, workerId, leaseMs }).then(() => undefined, (e) => {
        if (isLost(e)) { lost = true; ac.abort(); }   // other errors are transient: the next beat retries; a real loss shows up as LEASE_LOST
      }).finally(() => { inflight = null; });
    }, heartbeatMs);
    let result: WorkerResult;
    try {
      result = await opts.handler({ job, run, task, signal: ac.signal });
      if (!result || !['SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(result.status) || (result.blockReason !== undefined && result.blockReason !== 'budget')) result = { status: 'FAILED', evidence: ['worker:invalid_result'] };
    } catch (e: any) {
      result = e?.name === 'PlanError' && e?.code === 'BUDGET_EXCEEDED'   // the budget guard stopped the call: the Task waits for a human
        ? { status: 'FAILED', evidence: ['worker:budget_exceeded'], blockReason: 'budget' }
        : { status: 'FAILED', evidence: ['worker:handler_error'] };   // the error message is never stored
    } finally {
      clearInterval(timer);
      if (inflight) await inflight;
    }
    if (lost) return 'lease_lost';
    try {
      await completeJob({ jobId: job.id, workerId, ...result });
      return 'done';
    } catch (e) {
      if (isLost(e)) { ac.abort(); return 'lease_lost'; }
      throw e;
    }
  }

  let running = false;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });

  async function start(): Promise<void> {
    if (running) return;
    await recoverExpired(scope);   // restart recovery (TZ 8.3)
    running = true;
    loop = (async () => {
      while (running) {
        let r: 'idle' | 'done' | 'lease_lost' = 'idle';
        try { r = await tick(); } catch (e: any) { console.error('worker tick failed', e?.code ?? e?.name ?? 'error'); }
        if (running && r === 'idle') await pause(pollMs);
      }
    })();
  }
  async function stop(): Promise<void> {
    running = false;
    wake?.();
    if (loop) await loop;
    loop = null;
  }
  return { tick, start, stop };
}
