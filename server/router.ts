import type { Capability, ProviderAdapter, ProviderRequest, ProviderResponse } from './adapter.js';
import type { HealthEvent } from './modelHealth.js';
import type { RegistryEntry } from './modelRegistry.js';
import { BUDGET_POLICY_VERSION, DEFAULT_OUTPUT_ESTIMATE, unitsFor, type QuotaTracker } from './budget.js';

export const ROUTER_POLICY_VERSION = `router-v1/${BUDGET_POLICY_VERSION}`;

/** Router v1 (TZ 7.3, 7.4; ADR-07): deterministic selection from the registry and fallback by the matrix. Not wired to Simple Mode (ADR-02). */
export interface RouterState { cooldownUntil: Map<string, number>; disabledProviders: Set<string> }
export const newRouterState = (): RouterState => ({ cooldownUntil: new Map(), disabledProviders: new Set() });

const QUALITY_RANK = { A: 0, B: 1, C: 2 } as const;
const COST_RANK = { self_hosted: 0, free: 1, paid: 2 } as const;
const COOLDOWN_TRANSIENT_MS = 60_000;   // same values as server.ts
const COOLDOWN_QUOTA_MS = 180_000;
const COOLDOWN_QUOTA_MAX_MS = 86_400_000;
const REPAIR_HINT = '\n\nPREVIOUS RESPONSE was not valid JSON. Reply with one valid JSON object only.';
const key = (e: RegistryEntry) => `${e.providerId}/${e.modelId}`;

export interface Rejected { model: string; reason: string }
export interface SelectOptions { sensitivity?: 'normal' | 'high'; paidApproved?: string[]; estimatedInputTokens?: number; maxOutputTokens?: number; quota?: QuotaTracker }
/** Output cap actually sent to a model: the request's wish, never above the model's own limit. */
export const outputCap = (e: RegistryEntry, requested?: number): number | undefined =>
  e.maxOutputTokens ? Math.min(requested ?? e.maxOutputTokens, e.maxOutputTokens) : requested;

export function selectCandidates(registry: RegistryEntry[], state: RouterState, required: Capability[], now: number, minQuality: 'A' | 'B' | 'C' = 'C', adapters?: Record<string, unknown>, opts: SelectOptions = {}) {
  const rejected: Rejected[] = [];
  const ok: { e: RegistryEntry; idx: number }[] = [];
  registry.forEach((e, idx) => {
    const m = key(e);
    const miss = required.find((c) => !e.capabilities.includes(c));
    if (e.status !== 'active') rejected.push({ model: m, reason: `status:${e.status}` });
    else if (state.disabledProviders.has(e.providerId)) rejected.push({ model: m, reason: 'provider_disabled' });
    else if (miss) rejected.push({ model: m, reason: `missing_capability:${miss}` });
    else if (QUALITY_RANK[e.qualityClass] > QUALITY_RANK[minQuality]) rejected.push({ model: m, reason: 'quality_below_minimum' });
    else if ((state.cooldownUntil.get(m) || 0) > now) rejected.push({ model: m, reason: 'cooldown' });
    else if (adapters && !adapters[e.providerId]) rejected.push({ model: m, reason: 'no_adapter' });
    else if (opts.sensitivity === 'high' && e.dataPolicy !== 'paid' && e.dataPolicy !== 'self_hosted') rejected.push({ model: m, reason: `sensitivity:${e.dataPolicy}` });
    else if (e.costTier === 'paid' && !(opts.paidApproved ?? []).includes(e.providerId)) rejected.push({ model: m, reason: 'paid_not_approved' });
    else {
      const inTok = opts.estimatedInputTokens ?? 0;
      const outTok = outputCap(e, opts.maxOutputTokens) ?? DEFAULT_OUTPUT_ESTIMATE;
      const used = opts.quota?.usage(m, now);
      const lim = e.limits;
      const quotaHit = !used || !lim ? undefined
        : lim.rpm !== undefined && used.rpm + 1 > lim.rpm ? 'rpm'
        : lim.tpm !== undefined && used.tpm + inTok + outTok > lim.tpm ? 'tpm'
        : lim.rpd !== undefined && used.rpd + 1 > lim.rpd ? 'rpd'
        : lim.tpd !== undefined && used.tpd + inTok + outTok > lim.tpd ? 'tpd' : undefined;
      if (e.contextLimit && inTok + outTok > e.contextLimit) rejected.push({ model: m, reason: 'context_too_large' });
      else if (e.inputBudgetTokens && inTok > e.inputBudgetTokens) rejected.push({ model: m, reason: 'input_budget_exceeded' });
      else if (quotaHit) rejected.push({ model: m, reason: `quota:${quotaHit}` });
      else ok.push({ e, idx });
    }
  });
  // quality class, then cost tier (self_hosted < free < paid), then registry order (model_health latency is recorded but not used for ordering until the P10 evidence)
  ok.sort((a, b) => QUALITY_RANK[a.e.qualityClass] - QUALITY_RANK[b.e.qualityClass] || COST_RANK[a.e.costTier] - COST_RANK[b.e.costTier] || a.idx - b.idx);
  return { candidates: ok.map((x) => x.e), rejected };
}

export interface RouteContext {
  registry: RegistryEntry[]; adapters: Record<string, ProviderAdapter>; state: RouterState;
  required?: Capability[]; minQuality?: 'A' | 'B' | 'C'; maxCalls?: number; timeoutMs?: number;
  /** Router v1 inputs (all optional; ADR-07). `budget` is decreased by the units actually spent. */
  sensitivity?: 'normal' | 'high'; paidApproved?: string[]; budget?: { remainingUnits: number }; quota?: QuotaTracker; estimatedInputTokens?: number;
  onCall?: (resp: ProviderResponse, info: { retries: number; entry: RegistryEntry; units: number }) => void | Promise<void>;
  /** P09: deadline (ms) that bounds retry waits; health hook (TZ 7.5). */
  deadlineAt?: number; onHealth?: (e: HealthEvent) => void | Promise<void>;
  now?: () => number; sleep?: (ms: number) => Promise<void>; backoffMs?: () => number;
}
export interface RouteDecision { candidates: string[]; rejected: Rejected[]; attempts: { model: string; status: string; errorClass?: string }[]; reason?: string; policy: string; unitsSpent: number; category?: 'system'; escalate?: 'human' }
export interface RouteResult { status: 'ok' | 'error' | 'blocked'; response?: ProviderResponse; decision: RouteDecision }

export async function routeCall(req: Omit<ProviderRequest, 'modelId'>, ctx: RouteContext): Promise<RouteResult> {
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = ctx.backoffMs ?? (() => 700 + Math.floor(Math.random() * 1100));
  const maxCalls = ctx.maxCalls ?? 4;
  const estIn = ctx.estimatedInputTokens ?? Math.ceil(req.prompt.length / 4);
  const { candidates, rejected } = selectCandidates(ctx.registry, ctx.state, ctx.required ?? [], now(), ctx.minQuality, ctx.adapters,
    { sensitivity: ctx.sensitivity, paidApproved: ctx.paidApproved, estimatedInputTokens: estIn, maxOutputTokens: req.maxOutputTokens, quota: ctx.quota });
  const decision: RouteDecision = { candidates: candidates.map(key), rejected, attempts: [], policy: ROUTER_POLICY_VERSION, unitsSpent: 0 };
  let budgetBlocked = false;
  const health = async (e: HealthEvent) => { try { await ctx.onHealth?.(e); } catch { /* health must not break the run */ } };
  const cooldown = async (m: string, ms: number) => { const until = now() + ms; ctx.state.cooldownUntil.set(m, until); await health({ type: 'cooldown', model: m, until }); };
  if (!candidates.length) return { status: 'blocked', decision: { ...decision, reason: 'no_suitable_model' } };

  let calls = 0;
  let last: ProviderResponse | undefined;
  outer: for (const entry of candidates) {
    if (ctx.state.disabledProviders.has(entry.providerId)) continue;
    let retriedTransient = false, retriedOutput = false, hint = '';
    for (;;) {
      if (calls >= maxCalls) return { status: 'blocked', response: last, decision: { ...decision, reason: 'call_limit' } };
      const cap = outputCap(entry, req.maxOutputTokens);
      if (ctx.budget && unitsFor(estIn, cap ?? DEFAULT_OUTPUT_ESTIMATE) > ctx.budget.remainingUnits) {   // budget is checked before the call; never a silent overspend
        decision.rejected.push({ model: key(entry), reason: 'budget_exceeded' });
        budgetBlocked = true;
        continue outer;
      }
      calls++;
      const resp = await ctx.adapters[entry.providerId].call({ ...req, ...(cap !== undefined ? { maxOutputTokens: cap } : {}), modelId: entry.modelId, prompt: req.prompt + hint }, { timeoutMs: ctx.timeoutMs });
      last = resp;
      const tokens = resp.usage.input + resp.usage.output;
      const units = tokens > 0 ? unitsFor(resp.usage.input, resp.usage.output) : 0;
      decision.unitsSpent += units;
      if (ctx.budget) ctx.budget.remainingUnits -= units;
      ctx.quota?.record(key(entry), tokens, now());   // every attempted call counts as a request
      await ctx.onCall?.(resp, { retries: decision.attempts.length, entry, units });   // ledger hook: every call is reported
      await health({ type: 'call', model: key(entry), ok: resp.status === 'ok', latencyMs: resp.latencyMs, ...(resp.errorClass ? { errorClass: resp.errorClass } : {}) });
      decision.attempts.push({ model: key(entry), status: resp.status, ...(resp.errorClass ? { errorClass: resp.errorClass } : {}) });
      if (resp.status === 'ok') return { status: 'ok', response: resp, decision };
      switch (resp.errorClass) {
        case 'PROVIDER_TRANSIENT':
          if (!retriedTransient && calls < maxCalls) {
            const wait = backoff();
            if (ctx.deadlineAt === undefined || now() + wait < ctx.deadlineAt) { retriedTransient = true; await sleep(wait); continue; }
          }
          await cooldown(key(entry), COOLDOWN_TRANSIENT_MS);
          continue outer;
        case 'PROVIDER_QUOTA':
          await cooldown(key(entry), Math.min(COOLDOWN_QUOTA_MAX_MS, Math.max(COOLDOWN_QUOTA_MS, resp.retryAfterMs ?? 0)));
          continue outer;
        case 'PROVIDER_AUTH':
          ctx.state.disabledProviders.add(entry.providerId);
          await health({ type: 'provider_disabled', providerId: entry.providerId, reason: 'PROVIDER_AUTH' });
          continue outer;
        case 'INVALID_OUTPUT':
          if (!retriedOutput) { retriedOutput = true; hint = REPAIR_HINT; continue; }
          continue outer;
        case 'INVALID_REQUEST':
          return { status: 'error', response: resp, decision: { ...decision, reason: resp.errorClass, category: 'system' } };
        default:   // POLICY_REJECTED: no retries, a human decides
          return { status: 'error', response: resp, decision: { ...decision, reason: resp.errorClass, escalate: 'human' } };
      }
    }
  }
  if (budgetBlocked && decision.attempts.length === 0) return { status: 'blocked', decision: { ...decision, reason: 'budget_exceeded' } };
  const allAuth = decision.attempts.length > 0 && decision.attempts.every((a) => a.errorClass === 'PROVIDER_AUTH');
  return allAuth
    ? { status: 'blocked', response: last, decision: { ...decision, reason: 'no_provider_after_auth' } }
    : { status: 'error', response: last, decision: { ...decision, reason: 'candidates_exhausted' } };
}
