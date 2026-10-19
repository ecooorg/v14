/**
 * P15a / BX-27.a — pure monitoring logic (Appendix G S1–S2).
 * Read-only: never mutates registry, Router, or budgets.
 * Secret values must never appear in results (use redact helpers).
 */

export type MonitorStatus = 'OK' | 'DRIFT' | 'FAIL' | 'NOT_RUN' | 'BLOCKED';
export type AlertLevel = 'info' | 'warn' | 'critical';

export interface RegistryModelRef {
  providerId: string;
  modelId: string;
  status: 'active' | 'disabled' | 'cooldown';
  lastVerifiedAt: string; // YYYY-MM-DD
  limits?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number };
}

export interface LiveProviderView {
  providerId: string;
  /** Outcome of the connection check for this provider. */
  status: MonitorStatus;
  /** Model ids reported by the provider list endpoint (no secrets). */
  liveModelIds: string[];
  /** Selected rate-limit header values (numbers/strings only). */
  rateLimitHeaders: Record<string, string | number>;
  reason?: string;
}

export interface QuotaUsage {
  providerId: string;
  /** Tokens (or calls) used in the current daily window. */
  used: number;
  /** Configured daily limit; null when unknown. */
  dailyLimit: number | null;
  errors429: number;
  otherErrors: number;
}

export interface AlertCandidate {
  alertKey: string;
  level: AlertLevel;
  providerId?: string;
  message: string;
  details?: Record<string, unknown>;
}

const DAY_MS = 86_400_000;
const NINETY_DAYS_MS = 90 * DAY_MS;

/** Parse YYYY-MM-DD as UTC midnight; invalid → null. */
export function parseVerifiedAt(s: string, now = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) ? t : null;
}

/** S1: registry models missing from the live list → DRIFT alerts (one key per model). */
export function detectModelDrift(
  registry: RegistryModelRef[],
  live: LiveProviderView[],
): AlertCandidate[] {
  const liveByProvider = new Map<string, Set<string>>();
  for (const v of live) {
    if (v.status === 'NOT_RUN' || v.status === 'BLOCKED') continue;
    liveByProvider.set(v.providerId, new Set(v.liveModelIds));
  }
  const alerts: AlertCandidate[] = [];
  for (const m of registry) {
    if (m.status === 'disabled') continue;
    const set = liveByProvider.get(m.providerId);
    if (!set) continue; // provider not checked or NOT_RUN — no DRIFT from absence of data
    if (!set.has(m.modelId)) {
      alerts.push({
        alertKey: `drift:missing_model:${m.providerId}:${m.modelId}`,
        level: 'critical',
        providerId: m.providerId,
        message: `Registry model ${m.providerId}/${m.modelId} missing from live provider list`,
        details: { modelId: m.modelId },
      });
    }
  }
  return alerts;
}

/** S1: lastVerifiedAt older than 90 days. */
export function detectStaleVerification(
  registry: RegistryModelRef[],
  now = Date.now(),
): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];
  for (const m of registry) {
    if (m.status === 'disabled') continue;
    const t = parseVerifiedAt(m.lastVerifiedAt, now);
    if (t === null || now - t > NINETY_DAYS_MS) {
      alerts.push({
        alertKey: `stale:verified:${m.providerId}:${m.modelId}`,
        level: 'warn',
        providerId: m.providerId,
        message: `Model ${m.providerId}/${m.modelId} lastVerifiedAt is older than 90 days or invalid`,
        details: { lastVerifiedAt: m.lastVerifiedAt },
      });
    }
  }
  return alerts;
}

/** S2: quota headroom warnings (80% / 100%). */
export function detectQuotaPressure(usage: QuotaUsage[]): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];
  for (const u of usage) {
    if (u.dailyLimit === null || u.dailyLimit <= 0) continue;
    const ratio = u.used / u.dailyLimit;
    if (ratio >= 1) {
      alerts.push({
        alertKey: `quota:exhausted:${u.providerId}`,
        level: 'critical',
        providerId: u.providerId,
        message: `Provider ${u.providerId} daily quota exhausted (${u.used}/${u.dailyLimit})`,
        details: { used: u.used, dailyLimit: u.dailyLimit, errors429: u.errors429 },
      });
    } else if (ratio >= 0.8) {
      alerts.push({
        alertKey: `quota:high:${u.providerId}`,
        level: 'warn',
        providerId: u.providerId,
        message: `Provider ${u.providerId} daily quota ≥80% (${u.used}/${u.dailyLimit})`,
        details: { used: u.used, dailyLimit: u.dailyLimit, errors429: u.errors429 },
      });
    }
  }
  return alerts;
}

/**
 * S2 rule N-1: at least two independent active providers with headroom >20%.
 * Headroom unknown (no limit) counts as healthy if the provider is active and not exhausted via errors.
 */
export function detectN1Violation(
  activeProviderIds: string[],
  usage: QuotaUsage[],
): AlertCandidate[] {
  const usageMap = new Map(usage.map((u) => [u.providerId, u]));
  const healthy: string[] = [];
  for (const id of activeProviderIds) {
    const u = usageMap.get(id);
    if (!u || u.dailyLimit === null || u.dailyLimit <= 0) {
      healthy.push(id);
      continue;
    }
    const remaining = 1 - u.used / u.dailyLimit;
    if (remaining > 0.2) healthy.push(id);
  }
  if (healthy.length >= 2) return [];
  return [{
    alertKey: 'n1:single_provider',
    level: 'warn',
    message: healthy.length === 0
      ? 'No active provider has quota headroom >20%'
      : `Only one independent active provider has quota headroom >20% (${healthy[0]})`,
    details: { healthyProviders: healthy, activeProviders: activeProviderIds },
  }];
}

/** Merge alert lists; later duplicates of the same alertKey are dropped (first wins). */
export function dedupeAlerts(alerts: AlertCandidate[]): AlertCandidate[] {
  const seen = new Set<string>();
  const out: AlertCandidate[] = [];
  for (const a of alerts) {
    if (seen.has(a.alertKey)) continue;
    seen.add(a.alertKey);
    out.push(a);
  }
  return out;
}

/** Full S1+S2 evaluation from pure inputs. */
export function evaluateMonitoring(input: {
  registry: RegistryModelRef[];
  live: LiveProviderView[];
  usage: QuotaUsage[];
  now?: number;
}): { alerts: AlertCandidate[]; summary: Record<string, number> } {
  const now = input.now ?? Date.now();
  const activeProviders = [...new Set(
    input.registry.filter((m) => m.status === 'active').map((m) => m.providerId),
  )];
  const alerts = dedupeAlerts([
    ...detectModelDrift(input.registry, input.live),
    ...detectStaleVerification(input.registry, now),
    ...detectQuotaPressure(input.usage),
    ...detectN1Violation(activeProviders, input.usage),
  ]);
  const summary = { total: alerts.length, critical: 0, warn: 0, info: 0 };
  for (const a of alerts) summary[a.level]++;
  return { alerts, summary };
}

/** Build a snapshot record suitable for INSERT (no secrets). */
export function buildSnapshotRow(
  live: LiveProviderView,
  idFactory: () => string = () => `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
): {
  id: string;
  provider_id: string;
  status: MonitorStatus;
  model_ids: string[];
  rate_limit_headers: Record<string, string | number>;
  details: Record<string, unknown>;
} {
  return {
    id: idFactory(),
    provider_id: live.providerId,
    status: live.status,
    model_ids: [...live.liveModelIds],
    rate_limit_headers: { ...live.rateLimitHeaders },
    details: live.reason ? { reason: live.reason } : {},
  };
}
