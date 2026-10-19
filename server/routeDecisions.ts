import crypto from 'node:crypto';
import { getPool } from './database.ts';
import type { RouteDecision } from './router.ts';

/** Sortable id; created before the call so ledger rows can reference the decision. */
export const newRouteDecisionId = (): string => `${Date.now().toString(36).padStart(9, '0')}_${crypto.randomBytes(6).toString('hex')}`;

/** Router v1 (TZ 7.3 item 6): every decision is stored with candidates, rejected models and reasons, attempts and the policy version. */
export async function writeRouteDecision(id: string, d: RouteDecision, ctx: { runId?: string; sensitivity: 'normal' | 'high'; status: string }): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO route_decisions(id,run_id,policy_version,sensitivity,status,reason,candidates,rejected,attempts,units_spent)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
    [id, ctx.runId ?? null, d.policy, ctx.sensitivity, ctx.status, d.reason ?? null, JSON.stringify(d.candidates), JSON.stringify(d.rejected), JSON.stringify(d.attempts), d.unitsSpent]);
}
