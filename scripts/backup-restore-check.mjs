#!/usr/bin/env node
/**
 * P24 / BX-25 — backup & restore readiness check (no secret values).
 * Usage: npm run ops:backup-check [-- --json] [-- --live]
 *
 * Without DATABASE_URL: verifies migration files on disk (exit 0).
 * With --live and DATABASE_URL: counts schema_migrations and reports OK.
 * Does not create or download Railway backups (owner uses the Railway dashboard).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const live = args.includes('--live');

const migDir = path.join(root, 'migrations');
const files = fs.existsSync(migDir)
  ? fs.readdirSync(migDir).filter((f) => /^\d+_[a-z0-9_-]+\.sql$/i.test(f)).sort()
  : [];

const report = {
  ok: true,
  migrations_on_disk: files.length,
  migration_files: files,
  procedure: {
    backup: 'Railway PostgreSQL: enable daily backups in the service panel (A-06). Download a dump from the dashboard when testing restore.',
    restore_drill: [
      '1. Provision a disposable PostgreSQL (local Docker or a throwaway Railway DB).',
      '2. Apply the dump or run npm run db:migrate on an empty database.',
      '3. Confirm schema_migrations row count matches migrations_on_disk.',
      '4. Hit GET /ready and GET /api/ops on an app pointed at that DB.',
      '5. Destroy the disposable instance.',
    ],
    rpo_rto: 'Targets in docs/ADR-09-backup-rpo-rto.md (RPO ≤ 24h, RTO ≤ 4h).',
    rollback: 'See docs/OPS_ROLLBACK.md — redeploy previous successful build; do not roll back data.',
  },
  live: null,
};

if (live) {
  if (!process.env.DATABASE_URL) {
    report.ok = false;
    report.live = { status: 'NOT_RUN', reason: 'DATABASE_URL missing' };
  } else {
    try {
      const pg = await import('pg');
      const pool = new pg.default.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      });
      const r = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
      const n = Number(r.rows[0]?.n ?? 0);
      await pool.end();
      report.live = {
        status: n >= files.length ? 'OK' : 'DRIFT',
        schema_migrations: n,
        expected_at_least: files.length,
      };
      if (n < files.length) report.ok = false;
    } catch (e) {
      report.ok = false;
      report.live = { status: 'FAIL', reason: String(e?.message || e).slice(0, 160) };
    }
  }
}

if (files.length === 0) {
  report.ok = false;
}

if (asJson) {
  console.log(JSON.stringify(report));
} else {
  console.log(`ops:backup-check migrations_on_disk=${report.migrations_on_disk} ok=${report.ok}`);
  if (report.live) console.log(`live: ${JSON.stringify(report.live)}`);
  console.log('Restore drill steps are listed in the JSON report (--json) and docs/ADR-09-backup-rpo-rto.md');
}

process.exitCode = report.ok ? 0 : 2;
