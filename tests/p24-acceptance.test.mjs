/**
 * P24 / BX-25 — ops metrics, alerts, backup-check (offline).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  evaluateOpsAlerts,
  buildOpsSnapshot,
  processRssMb,
  renderOpsHtml,
} from '../server/opsMetrics.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('alert: stale queue is critical', () => {
  const alerts = evaluateOpsAlerts({
    queueQueued: 2, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: [], migrationCount: 1, oldestQueuedAgeSec: 3600,
    memoryRssMb: 100, memoryRssLimitMb: 1024,
  });
  assert.ok(alerts.some((a) => a.id === 'queue:stale' && a.level === 'critical'));
});

test('alert: disabled provider is warn', () => {
  const alerts = evaluateOpsAlerts({
    queueQueued: 0, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: ['gemini'], migrationCount: 1, oldestQueuedAgeSec: null,
    memoryRssMb: 50, memoryRssLimitMb: 1024,
  });
  assert.ok(alerts.some((a) => a.id === 'provider:disabled'));
});

test('alert: high RSS ratio warns', () => {
  const alerts = evaluateOpsAlerts({
    queueQueued: 0, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: [], migrationCount: 1, oldestQueuedAgeSec: null,
    memoryRssMb: 800, memoryRssLimitMb: 1000,
  });
  assert.ok(alerts.some((a) => a.id === 'capacity:ram'));
});

test('buildOpsSnapshot includes alerts and no secret-looking keys', () => {
  const snap = buildOpsSnapshot({
    queueQueued: 1, queueLeased: 1, abandoned24h: 0, runsFinished24h: 3, avgRunDurationMs: 1200,
    disabledProviders: [], migrationCount: 14, oldestQueuedAgeSec: 10,
    memoryRssMb: processRssMb(), memoryRssLimitMb: 1024,
  });
  assert.equal(snap.schema.migrationCount, 14);
  assert.ok(Array.isArray(snap.alerts));
  const json = JSON.stringify(snap);
  assert.ok(!/api[_-]?key|password|secret/i.test(json) || json.includes('alerts'));
});

test('renderOpsHtml escapes and lists metrics', () => {
  const snap = buildOpsSnapshot({
    queueQueued: 0, queueLeased: 0, abandoned24h: 0, runsFinished24h: 0, avgRunDurationMs: null,
    disabledProviders: [], migrationCount: 1, oldestQueuedAgeSec: null,
    memoryRssMb: 10, memoryRssLimitMb: null,
  });
  const html = renderOpsHtml(snap, '24');
  assert.match(html, /BiForge operations/);
  assert.match(html, /<table>/);
  assert.ok(!html.includes('<script>'));
});

test('ADR-09 and OPS_ROLLBACK exist', () => {
  for (const f of ['docs/ADR-09-backup-rpo-rto.md', 'docs/OPS_ROLLBACK.md', 'docs/P24-SPEC.md']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('ops:backup-check exits 0 offline with migrations on disk', async () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/backup-restore-check.mjs', '--json'], {
      env,
      cwd: root,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.out + result.err);
  const raw = result.out.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const j = JSON.parse(raw.slice(start, end + 1));
  assert.equal(j.ok, true);
  assert.ok(j.migrations_on_disk >= 1);
});
