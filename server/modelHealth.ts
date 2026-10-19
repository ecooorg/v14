import { getPool } from './database.ts';
import type { RouterState } from './router.ts';
import type { QuotaTracker } from './budget.ts';

/** Model health (TZ 7.5): pure fold of Router events plus PostgreSQL persistence. */
export const AUTH_DISABLE_TTL_MS = 6 * 3600_000;
const DAY = 86_400_000;
const ALPHA = 0.2;

export type HealthEvent =
  | { type: 'call'; model: string; ok: boolean; latencyMs: number; errorClass?: string }
  | { type: 'cooldown'; model: string; until: number }
  | { type: 'provider_disabled'; providerId: string; reason: string };

export interface HealthRow {
  key: string; kind: 'model' | 'provider'; successes: number; failures: number; avgLatencyMs: number | null;
  lastErrorClass: string | null; cooldownUntil: number | null; disabledAt: number | null;
}
const blank = (key: string, kind: 'model' | 'provider'): HealthRow => ({ key, kind, successes: 0, failures: 0, avgLatencyMs: null, lastErrorClass: null, cooldownUntil: null, disabledAt: null });

export function applyHealthEvent(rows: Map<string, HealthRow>, e: HealthEvent, now: number): void {
  if (e.type === 'provider_disabled') {
    const r = rows.get(e.providerId) ?? blank(e.providerId, 'provider');
    r.disabledAt = now; r.lastErrorClass = e.reason; rows.set(e.providerId, r);
    return;
  }
  const r = rows.get(e.model) ?? blank(e.model, 'model');
  if (e.type === 'call') {
    if (e.ok) {
      r.successes++;
      r.avgLatencyMs = r.avgLatencyMs === null ? e.latencyMs : (1 - ALPHA) * r.avgLatencyMs + ALPHA * e.latencyMs;   // EMA
    } else { r.failures++; r.lastErrorClass = e.errorClass ?? null; }
  } else r.cooldownUntil = e.until;
  rows.set(e.model, r);
}

/** Restores future cooldowns and provider disables younger than the TTL; expired disables are lifted. */
export function hydrateRouterState(state: RouterState, rows: Pick<HealthRow, 'key' | 'kind' | 'cooldownUntil' | 'disabledAt'>[], now: number): RouterState {
  for (const r of rows) {
    if (r.kind === 'model') { if (r.cooldownUntil && r.cooldownUntil > now) state.cooldownUntil.set(r.key, Math.max(r.cooldownUntil, state.cooldownUntil.get(r.key) ?? 0)); }
    else if (r.disabledAt !== null) { if (now - r.disabledAt < AUTH_DISABLE_TTL_MS) state.disabledProviders.add(r.key); else state.disabledProviders.delete(r.key); }
  }
  return state;
}

export interface QuotaRow { providerId: string; modelId: string; tokens: number; atMs: number }
export function rehydrateQuota(tracker: QuotaTracker, rows: QuotaRow[], now: number): void {
  [...rows].filter((r) => r.atMs > now - DAY && r.atMs <= now).sort((a, b) => a.atMs - b.atMs)
    .forEach((r) => tracker.record(`${r.providerId}/${r.modelId}`, r.tokens, r.atMs));
}

// ---- database part ----
let cache: { at: number; rows: HealthRow[] } | undefined;
const CACHE_MS = 5000;
const toRow = (x: any): HealthRow => ({
  key: x.key, kind: x.kind, successes: x.successes, failures: x.failures, avgLatencyMs: x.avg_latency_ms,
  lastErrorClass: x.last_error_class, cooldownUntil: x.cooldown_until === null ? null : Number(x.cooldown_until), disabledAt: x.disabled_at === null ? null : Number(x.disabled_at),
});

export async function loadHealthRows(): Promise<HealthRow[]> {
  const pool = await getPool();
  return (await pool.query('SELECT key,kind,successes,failures,avg_latency_ms,last_error_class,cooldown_until,disabled_at FROM model_health')).rows.map(toRow);
}

export async function saveHealthEvent(e: HealthEvent, now = Date.now()): Promise<void> {
  const pool = await getPool();
  const key = e.type === 'provider_disabled' ? e.providerId : e.model;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT key,kind,successes,failures,avg_latency_ms,last_error_class,cooldown_until,disabled_at FROM model_health WHERE key=$1 FOR UPDATE', [key]);
    const rows = new Map<string, HealthRow>(cur.rows.length ? [[key, toRow(cur.rows[0])]] : []);
    applyHealthEvent(rows, e, now);
    const r = rows.get(key)!;
    await client.query(
      `INSERT INTO model_health(key,kind,successes,failures,avg_latency_ms,last_error_class,cooldown_until,disabled_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (key) DO UPDATE SET successes=$3,failures=$4,avg_latency_ms=$5,last_error_class=$6,cooldown_until=$7,disabled_at=$8,updated_at=now()`,
      [r.key, r.kind, r.successes, r.failures, r.avgLatencyMs, r.lastErrorClass, r.cooldownUntil, r.disabledAt]);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  cache = undefined;
}

/** Hydrates a router state from the database (short cache so several replicas converge). */
export async function loadRouterState(state: RouterState, now = Date.now()): Promise<RouterState> {
  if (!cache || now - cache.at > CACHE_MS) cache = { at: now, rows: await loadHealthRows() };
  return hydrateRouterState(state, cache.rows, now);
}

export async function loadQuotaRows(sinceMs: number): Promise<QuotaRow[]> {
  const pool = await getPool();
  const r = await pool.query('SELECT provider_id, model_id, input_tokens + output_tokens AS tokens, created_at FROM usage_ledger WHERE created_at >= $1 ORDER BY created_at', [new Date(sinceMs)]);
  return r.rows.map((x: any) => ({ providerId: x.provider_id, modelId: x.model_id, tokens: Number(x.tokens), atMs: new Date(x.created_at).getTime() }));
}
