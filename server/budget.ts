/** Budget units, quota windows and shadow cost (ADR-07, policy units-v1). No vendor or model names here. */
export const BUDGET_POLICY_VERSION = 'units-v1';
export const DEFAULT_TASK_UNITS = 30;
/** Day cap per project, per 24 h (TZ 14.4). */
export const DEFAULT_DAILY_UNITS = 300;

export type BudgetLevel = 'ok' | 'warn' | 'stop';
export function budgetLevel(used: number, cap: number): { percent: number; level: BudgetLevel } {
  const percent = cap > 0 ? Math.floor((used / cap) * 100) : 100;
  return { percent, level: cap <= 0 || used >= cap ? 'stop' : used * 100 >= cap * 80 ? 'warn' : 'ok' };
}
/** Units available to one run: the task budget, never more than what is left of the day cap, never negative. */
export const runBudget = (usedToday: number, o: { dayCap: number; taskUnits: number }): number => Math.max(0, Math.min(o.taskUnits, o.dayCap - usedToday));

/** Output size assumed for the pre-call estimate when neither the request nor the model sets one. */
export const DEFAULT_OUTPUT_ESTIMATE = 1000;

/** 1 unit = 1000 tokens (input + output, cached included in input), minimum 1. */
export const unitsFor = (inputTokens: number, outputTokens: number): number =>
  Math.max(1, Math.ceil((Math.max(0, inputTokens) + Math.max(0, outputTokens)) / 1000));

export interface Pricing { inputPerMTok?: number; outputPerMTok?: number }
/** What the call would cost at the published price; null when the price is unknown (never a guess). */
export function shadowCostUsd(usage: { input: number; output: number }, pricing?: Pricing): number | null {
  if (!pricing || pricing.inputPerMTok === undefined || pricing.outputPerMTok === undefined) return null;
  return (usage.input * pricing.inputPerMTok + usage.output * pricing.outputPerMTok) / 1_000_000;
}

const MIN = 60_000, DAY = 86_400_000;
export interface QuotaUsage { rpm: number; tpm: number; rpd: number; tpd: number }
export interface QuotaTracker {
  record(modelKey: string, tokens: number, atMs: number): void;
  usage(modelKey: string, atMs: number): QuotaUsage;
}
/** In-memory rolling windows (60 s and 24 h). Restored from the ledger by `rehydrateQuota` (modelHealth.ts). */
export function createQuotaTracker(): QuotaTracker {
  const events = new Map<string, { t: number; tokens: number }[]>();
  return {
    record(modelKey, tokens, atMs) {
      const list = (events.get(modelKey) ?? []).filter((e) => e.t > atMs - DAY);
      list.push({ t: atMs, tokens: Math.max(0, tokens) });
      events.set(modelKey, list);
    },
    usage(modelKey, atMs) {
      const list = events.get(modelKey) ?? [];
      const day = list.filter((e) => e.t > atMs - DAY && e.t <= atMs);
      const min = day.filter((e) => e.t > atMs - MIN);
      return { rpm: min.length, tpm: min.reduce((a, e) => a + e.tokens, 0), rpd: day.length, tpd: day.reduce((a, e) => a + e.tokens, 0) };
    },
  };
}
