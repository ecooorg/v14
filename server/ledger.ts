import { getPool } from './database.ts';
import type { ProviderResponse } from './adapter.js';

/** Ledger-min (TZ 7.8): one row per provider call. Units and shadow cost: ADR-07. */
export interface LedgerEntry {
  runId?: string; providerId: string; modelId: string;
  inputTokens: number; cachedTokens: number; outputTokens: number;
  latencyMs: number; retries: number; status: string; errorClass?: string; routeDecisionId?: string;
  units?: number; costEstimate?: number | null;   // units (ADR-07) and shadow cost in USD (null when the price is unknown)
}
export function ledgerEntryFromResponse(r: ProviderResponse, ctx: { runId?: string; retries?: number; routeDecisionId?: string; units?: number; costEstimate?: number | null } = {}): LedgerEntry {
  return {
    runId: ctx.runId, providerId: r.providerId, modelId: r.modelId,
    inputTokens: r.usage.input, cachedTokens: r.usage.cached, outputTokens: r.usage.output,
    latencyMs: Math.round(r.latencyMs), retries: ctx.retries ?? 0, status: r.status, errorClass: r.errorClass, routeDecisionId: ctx.routeDecisionId,
    units: ctx.units ?? 0, costEstimate: ctx.costEstimate ?? null,
  };
}

export async function writeLedgerEntry(e: LedgerEntry): Promise<void> {
  const pool = await getPool();
  const id = `${Date.now().toString(36).padStart(9, '0')}_${Math.random().toString(16).slice(2, 14)}`;
  await pool.query(
    `INSERT INTO usage_ledger(id,run_id,provider_id,model_id,input_tokens,cached_tokens,output_tokens,latency_ms,retries,status,error_class,route_decision_id,units,cost_estimate)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, e.runId ?? null, e.providerId, e.modelId, e.inputTokens, e.cachedTokens, e.outputTokens, e.latencyMs, e.retries, e.status, e.errorClass ?? null, e.routeDecisionId ?? null, e.units ?? 0, e.costEstimate ?? null]);
}
