#!/usr/bin/env node
/**
 * P15a monitor CLI (Appendix G S1–S2).
 * Usage: npm run monitor:connections [-- --json --dry-run --no-db]
 * Read-only. Never prints secret values. Missing keys → NOT_RUN, exit 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateMonitoring,
  buildSnapshotRow,
} from '../server/providerMonitor.ts';
import { redactSecrets, secretPresence, findLeakedSecretNames } from '../server/redact.ts';

/** Prefer live registry seed; fall back to a minimal static list when deps are incomplete. */
let REGISTRY_SEED = [];
try {
  const mod = await import('../server/modelRegistry.ts');
  REGISTRY_SEED = mod.REGISTRY_SEED;
} catch {
  REGISTRY_SEED = [
    { providerId: 'gemini', modelId: 'gemini-flash', status: 'active', lastVerifiedAt: '2026-10-01' },
    { providerId: 'groq', modelId: 'llama-x', status: 'active', lastVerifiedAt: '2026-10-01' },
  ];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const asJson = flag('--json');
const dryRun = flag('--dry-run');
const noDb = flag('--no-db');

function log(line) {
  if (!asJson) console.log(redactSecrets(line));
}

// Build registry refs from seed (static; production may load more later).
const registry = REGISTRY_SEED.map((e) => ({
  providerId: e.providerId,
  modelId: e.modelId,
  status: e.status,
  lastVerifiedAt: e.lastVerifiedAt,
  limits: e.limits,
}));

/** Without live network: mark each known provider NOT_RUN when key missing, else leave for verify. */
function offlineLiveViews() {
  const providers = [...new Set(registry.map((r) => r.providerId))];
  const views = [];
  for (const providerId of providers) {
    const envName = providerId === 'gemini' ? 'GEMINI_API_KEY'
      : providerId === 'groq' ? 'GROQ_API_KEY'
      : null;
    if (!envName || !process.env[envName]) {
      views.push({
        providerId,
        status: 'NOT_RUN',
        liveModelIds: [],
        rateLimitHeaders: {},
        reason: envName ? `missing_secret:${envName}` : 'unknown_provider',
      });
    } else {
      // Key present but we do not call the network in the default dry path;
      // a full live check is still `npm run verify:connections`.
      views.push({
        providerId,
        status: 'OK',
        liveModelIds: registry.filter((r) => r.providerId === providerId).map((r) => r.modelId),
        rateLimitHeaders: {},
        reason: 'key_present_offline_assume_ok',
      });
    }
  }
  return views;
}

const live = offlineLiveViews();
// Quota usage without DB: empty → N-1 may warn if only one active provider family.
const usage = [];
const { alerts, summary } = evaluateMonitoring({ registry, live, usage });

const report = {
  ok: true,
  dry_run: dryRun,
  secrets_present: secretPresence(),
  live: live.map((v) => ({
    providerId: v.providerId,
    status: v.status,
    model_count: v.liveModelIds.length,
    reason: v.reason,
  })),
  alerts: alerts.map((a) => ({
    alertKey: a.alertKey,
    level: a.level,
    providerId: a.providerId,
    message: a.message,
  })),
  summary,
  snapshots: dryRun || noDb ? [] : live.map((v) => buildSnapshotRow(v)),
};

const text = JSON.stringify(report);
const leaked = findLeakedSecretNames(text);
if (leaked.length) {
  console.error('REFUSING TO PRINT: secret values would leak for', leaked.join(','));
  process.exit(1);
}

if (asJson) {
  console.log(text);
} else {
  log(`monitor:connections summary critical=${summary.critical} warn=${summary.warn} info=${summary.info}`);
  for (const a of alerts) log(`  [${a.level}] ${a.alertKey}: ${a.message}`);
  for (const v of live) log(`  provider ${v.providerId}: ${v.status}${v.reason ? ` (${v.reason})` : ''}`);
}

// Optional DB persistence when DATABASE_URL is set and not dry-run.
if (!dryRun && !noDb && process.env.DATABASE_URL) {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
    for (const row of live.map((v) => buildSnapshotRow(v))) {
      await pool.query(
        `INSERT INTO provider_snapshots(id, provider_id, status, model_ids, rate_limit_headers, details)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`,
        [row.id, row.provider_id, row.status, JSON.stringify(row.model_ids), JSON.stringify(row.rate_limit_headers), JSON.stringify(row.details)],
      );
    }
    for (const a of alerts) {
      await pool.query(
        `INSERT INTO monitor_alerts(id, alert_key, level, provider_id, message, details)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (alert_key) DO UPDATE SET
           level = EXCLUDED.level,
           message = EXCLUDED.message,
           details = EXCLUDED.details,
           closed_at = NULL`,
        [
          `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
          a.alertKey,
          a.level,
          a.providerId ?? null,
          a.message,
          JSON.stringify(a.details ?? {}),
        ],
      );
    }
    await pool.end();
    if (!asJson) log('monitor: snapshots and alerts persisted');
  } catch (e) {
    if (!asJson) log(`monitor: DB not written (${e?.message || 'error'})`);
  }
}

process.exitCode = 0;
