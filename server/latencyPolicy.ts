/**
 * P57 — latency policy for the conversation path.
 *
 * Pure helpers only: no network, no prompt text, no model calls. They decide how much extra work
 * a conversation turn may still do once it has already been waiting, and they time the phases of a turn.
 * Every default keeps the answer itself unchanged:
 *  - the quality retry is skipped only when the first draft was already slow (the person still gets that draft);
 *  - the optional verifier waits less, and a late verifier simply leaves the reply without the extra annotation;
 *  - only OLDER assistant messages are shortened in the model input; every user message and the latest
 *    exchange stay complete, and the durable decision state is untouched.
 */

export interface LatencyPolicy {
  /** Skip the "rewrite from scratch" quality retry when the turn has already taken longer than this. 0 = never skip. */
  retryMaxElapsedMs: number;
  /** How long the optional Groq verifier may take before it is dropped. */
  verifierTimeoutMs: number;
  /** Older assistant messages longer than this are shortened in the model input. 0 = never shorten. */
  olderAssistantMaxChars: number;
  /** Number of most recent messages that are always kept complete. */
  recentMessagesKept: number;
}

export const LATENCY_DEFAULTS: LatencyPolicy = {
  retryMaxElapsedMs: 12_000,
  verifierTimeoutMs: 5_000,
  olderAssistantMaxChars: 2_500,
  recentMessagesKept: 2,
};

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Reads the policy from the environment. Unset or invalid values fall back to the defaults. */
export function readLatencyPolicy(env: Record<string, string | undefined> = process.env): LatencyPolicy {
  return {
    retryMaxElapsedMs: readInt(env.QUALITY_RETRY_MAX_ELAPSED_MS, LATENCY_DEFAULTS.retryMaxElapsedMs, 0, 600_000),
    verifierTimeoutMs: readInt(env.EPISTEMIC_TIMEOUT_MS, LATENCY_DEFAULTS.verifierTimeoutMs, 1_000, 60_000),
    olderAssistantMaxChars: readInt(env.OLDER_ASSISTANT_MAX_CHARS, LATENCY_DEFAULTS.olderAssistantMaxChars, 0, 100_000),
    recentMessagesKept: LATENCY_DEFAULTS.recentMessagesKept,
  };
}

/** True when the turn has already waited long enough that a second full model call is not worth it. */
export function shouldSkipQualityRetry(elapsedMs: number, maxElapsedMs: number): boolean {
  return maxElapsedMs > 0 && Number.isFinite(elapsedMs) && elapsedMs > maxElapsedMs;
}

/**
 * Shortens only assistant messages that are older than the last `recentKept` messages.
 * User messages are never touched, so nothing the person wrote is lost from the model input.
 */
export function trimOlderAssistantMessages<T extends { role: string; content: string }>(
  history: T[],
  recentKept: number,
  maxChars: number,
): T[] {
  if (maxChars <= 0 || history.length <= recentKept) return history;
  const cut = history.length - recentKept;
  return history.map((m, i) => (
    i < cut && m.role === 'assistant' && m.content.length > maxChars
      ? { ...m, content: `${m.content.slice(0, maxChars).trimEnd()}…` }
      : m
  ));
}

export interface PhaseTimer {
  /** Records the time since the previous mark under `name` (milliseconds). */
  mark(name: string): void;
  /** Phase durations plus `totalMs` since the timer was created. */
  summary(): Record<string, number>;
}

export function createPhaseTimer(now: () => number = Date.now): PhaseTimer {
  const start = now();
  let last = start;
  const phases: Record<string, number> = {};
  return {
    mark(name) {
      const t = now();
      phases[name] = (phases[name] || 0) + (t - last);
      last = t;
    },
    summary() {
      return { ...phases, totalMs: now() - start };
    },
  };
}
