/**
 * P24 / BX-25 — ops metrics and alert evaluation (pure + optional DB gather).
 * Secrets never appear in the payload.
 */

export interface OpsSnapshotInput {
  queueQueued: number;
  queueLeased: number;
  abandoned24h: number;
  runsFinished24h: number;
  avgRunDurationMs: number | null;
  disabledProviders: string[];
  migrationCount: number;
  oldestQueuedAgeSec: number | null;
  memoryRssMb: number;
  memoryRssLimitMb: number | null;
  now?: number;
}

export type OpsAlertLevel = 'info' | 'warn' | 'critical';

export interface OpsAlert {
  id: string;
  level: OpsAlertLevel;
  message: string;
}

export interface OpsSnapshot {
  generatedAt: string;
  queue: { queued: number; leased: number; oldestQueuedAgeSec: number | null };
  jobs: { abandoned24h: number };
  runs: { finished24h: number; avgDurationMs: number | null };
  providers: { disabled: string[] };
  schema: { migrationCount: number };
  process: { rssMb: number; rssLimitMb: number | null; rssRatio: number | null };
  alerts: OpsAlert[];
}

const QUEUE_STALE_SEC = 30 * 60; // 30 minutes without progress
const RAM_WARN = 0.7;

/** Pure alert rules (TZ 15.5 minimal set + capacity). */
export function evaluateOpsAlerts(input: OpsSnapshotInput): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  if (input.oldestQueuedAgeSec != null && input.oldestQueuedAgeSec >= QUEUE_STALE_SEC && input.queueQueued > 0) {
    alerts.push({
      id: 'queue:stale',
      level: 'critical',
      message: `Oldest queued job is ${input.oldestQueuedAgeSec}s old (threshold ${QUEUE_STALE_SEC}s)`,
    });
  }
  if (input.abandoned24h > 0) {
    alerts.push({
      id: 'queue:abandoned',
      level: 'warn',
      message: `${input.abandoned24h} job(s) ABANDONED in the last 24h`,
    });
  }
  if (input.disabledProviders.length > 0) {
    alerts.push({
      id: 'provider:disabled',
      level: 'warn',
      message: `Provider(s) disabled: ${input.disabledProviders.join(', ')}`,
    });
  }
  const limit = input.memoryRssLimitMb;
  if (limit != null && limit > 0) {
    const ratio = input.memoryRssMb / limit;
    if (ratio >= RAM_WARN) {
      alerts.push({
        id: 'capacity:ram',
        level: ratio >= 0.9 ? 'critical' : 'warn',
        message: `Process RSS ${input.memoryRssMb} MB is ${(ratio * 100).toFixed(0)}% of ${limit} MB limit`,
      });
    }
  }
  return alerts;
}

export function buildOpsSnapshot(input: OpsSnapshotInput): OpsSnapshot {
  const limit = input.memoryRssLimitMb;
  const rssRatio = limit != null && limit > 0 ? input.memoryRssMb / limit : null;
  return {
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
    queue: {
      queued: input.queueQueued,
      leased: input.queueLeased,
      oldestQueuedAgeSec: input.oldestQueuedAgeSec,
    },
    jobs: { abandoned24h: input.abandoned24h },
    runs: { finished24h: input.runsFinished24h, avgDurationMs: input.avgRunDurationMs },
    providers: { disabled: [...input.disabledProviders] },
    schema: { migrationCount: input.migrationCount },
    process: { rssMb: input.memoryRssMb, rssLimitMb: limit, rssRatio },
    alerts: evaluateOpsAlerts(input),
  };
}

/** Current process RSS in MB (best-effort). */
export function processRssMb(): number {
  const rss = process.memoryUsage().rss;
  return Math.round((rss / (1024 * 1024)) * 10) / 10;
}

/**
 * Gather live counts from PostgreSQL. Safe when tables are missing (zeros).
 * Expects a minimal query interface (pg Pool or client).
 */
export async function gatherOpsInput(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}, opts?: { memoryRssLimitMb?: number | null }): Promise<OpsSnapshotInput> {
  const q = async (sql: string, params?: unknown[]) => {
    try {
      return await db.query(sql, params);
    } catch {
      return { rows: [] };
    }
  };

  const queued = await q(`SELECT count(*)::int AS n FROM jobs WHERE status='QUEUED'`);
  const leased = await q(`SELECT count(*)::int AS n FROM jobs WHERE status='LEASED'`);
  const abandoned = await q(
    `SELECT count(*)::int AS n FROM jobs WHERE status='ABANDONED' AND finished_at >= now() - interval '24 hours'`,
  );
  const oldest = await q(
    `SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS age FROM jobs WHERE status='QUEUED'`,
  );
  const runs = await q(
    `SELECT count(*)::int AS n,
            avg(EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000)::float AS avg_ms
     FROM runs WHERE finished_at IS NOT NULL AND finished_at >= now() - interval '24 hours'`,
  );
  const disabled = await q(
    `SELECT key FROM model_health WHERE kind='provider' AND disabled_at IS NOT NULL`,
  );
  const migrations = await q(`SELECT count(*)::int AS n FROM schema_migrations`);

  const avgMs = runs.rows[0]?.avg_ms;
  return {
    queueQueued: Number(queued.rows[0]?.n ?? 0),
    queueLeased: Number(leased.rows[0]?.n ?? 0),
    abandoned24h: Number(abandoned.rows[0]?.n ?? 0),
    runsFinished24h: Number(runs.rows[0]?.n ?? 0),
    avgRunDurationMs: avgMs == null || Number.isNaN(Number(avgMs)) ? null : Math.round(Number(avgMs)),
    disabledProviders: disabled.rows.map((r) => String(r.key)),
    migrationCount: Number(migrations.rows[0]?.n ?? 0),
    oldestQueuedAgeSec: oldest.rows[0]?.age == null ? null : Number(oldest.rows[0].age),
    memoryRssMb: processRssMb(),
    memoryRssLimitMb: opts?.memoryRssLimitMb ?? (Number(process.env.OPS_RSS_LIMIT_MB) || null),
  };
}

/** Minimal HTML for /ops (no external assets, no secrets). */
export function renderOpsHtml(snap: OpsSnapshot, version: string): string {
  const rows = [
    ['Generated', snap.generatedAt],
    ['Version', version],
    ['Queue queued', String(snap.queue.queued)],
    ['Queue leased', String(snap.queue.leased)],
    ['Oldest queued age (s)', snap.queue.oldestQueuedAgeSec == null ? '—' : String(snap.queue.oldestQueuedAgeSec)],
    ['Abandoned 24h', String(snap.jobs.abandoned24h)],
    ['Runs finished 24h', String(snap.runs.finished24h)],
    ['Avg run duration (ms)', snap.runs.avgDurationMs == null ? '—' : String(snap.runs.avgDurationMs)],
    ['Disabled providers', snap.providers.disabled.length ? snap.providers.disabled.join(', ') : 'none'],
    ['Migrations applied', String(snap.schema.migrationCount)],
    ['RSS MB', String(snap.process.rssMb)],
  ];
  const body = rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
  const alerts = snap.alerts.length
    ? `<ul>${snap.alerts.map((a) => `<li><strong>${escapeHtml(a.level)}</strong> ${escapeHtml(a.message)}</li>`).join('')}</ul>`
    : '<p>No alerts.</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>BiForge /ops</title>
<style>body{font-family:system-ui,sans-serif;margin:1.5rem;background:#0b0f14;color:#e7ecf3}
table{border-collapse:collapse}th,td{border:1px solid #334;padding:.4rem .7rem;text-align:left}
th{background:#151b24}a{color:#8ab4ff}</style></head><body>
<h1>BiForge operations</h1>
<table>${body}</table>
<h2>Alerts</h2>${alerts}
<p><a href="/api/ops">JSON</a></p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
