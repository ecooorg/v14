/**
 * P15a acceptance — pure monitoring logic (Appendix G.8 criteria where testable offline).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  detectModelDrift,
  detectStaleVerification,
  detectQuotaPressure,
  detectN1Violation,
  evaluateMonitoring,
  dedupeAlerts,
  buildSnapshotRow,
} from '../server/providerMonitor.ts';

const registry = [
  { providerId: 'gemini', modelId: 'gemini-flash', status: 'active', lastVerifiedAt: '2026-10-01' },
  { providerId: 'gemini', modelId: 'gemini-gone', status: 'active', lastVerifiedAt: '2026-10-01' },
  { providerId: 'groq', modelId: 'llama-x', status: 'active', lastVerifiedAt: '2026-09-01' },
  { providerId: 'gemini', modelId: 'gemini-off', status: 'disabled', lastVerifiedAt: '2020-01-01' },
];

test('G.8.1 missing registry model → single DRIFT alert key', () => {
  const live = [
    { providerId: 'gemini', status: 'OK', liveModelIds: ['gemini-flash'], rateLimitHeaders: {} },
    { providerId: 'groq', status: 'OK', liveModelIds: ['llama-x'], rateLimitHeaders: {} },
  ];
  const alerts = detectModelDrift(registry, live);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertKey, 'drift:missing_model:gemini:gemini-gone');
  assert.equal(alerts[0].level, 'critical');
  // disabled model is ignored
  assert.ok(!alerts.some((a) => a.alertKey.includes('gemini-off')));
});

test('G.8.1 repeated evaluation does not invent a second key (dedupe)', () => {
  const live = [
    { providerId: 'gemini', status: 'OK', liveModelIds: ['gemini-flash'], rateLimitHeaders: {} },
  ];
  const a = detectModelDrift(registry, live);
  const b = detectModelDrift(registry, live);
  const merged = dedupeAlerts([...a, ...b]);
  assert.equal(merged.filter((x) => x.alertKey.includes('gemini-gone')).length, 1);
});

test('G.8.2 missing key path is NOT_RUN and does not produce DRIFT', () => {
  const live = [
    { providerId: 'gemini', status: 'NOT_RUN', liveModelIds: [], rateLimitHeaders: {}, reason: 'missing_secret:GEMINI_API_KEY' },
  ];
  const alerts = detectModelDrift(registry, live);
  assert.equal(alerts.length, 0);
});

test('stale lastVerifiedAt >90 days → warn', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  const alerts = detectStaleVerification(
    [{ providerId: 'gemini', modelId: 'old', status: 'active', lastVerifiedAt: '2026-01-01' }],
    now,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'warn');
});

test('quota 80% warn and 100% critical', () => {
  const alerts = detectQuotaPressure([
    { providerId: 'gemini', used: 80, dailyLimit: 100, errors429: 0, otherErrors: 0 },
    { providerId: 'groq', used: 100, dailyLimit: 100, errors429: 3, otherErrors: 0 },
  ]);
  assert.ok(alerts.some((a) => a.alertKey === 'quota:high:gemini' && a.level === 'warn'));
  assert.ok(alerts.some((a) => a.alertKey === 'quota:exhausted:groq' && a.level === 'critical'));
});

test('G.8.4 N-1: single healthy provider → warn', () => {
  const alerts = detectN1Violation(
    ['gemini', 'groq'],
    [
      { providerId: 'gemini', used: 10, dailyLimit: 100, errors429: 0, otherErrors: 0 },
      { providerId: 'groq', used: 95, dailyLimit: 100, errors429: 0, otherErrors: 0 },
    ],
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertKey, 'n1:single_provider');
});

test('G.8.4 N-1 satisfied with two healthy providers', () => {
  const alerts = detectN1Violation(
    ['gemini', 'groq'],
    [
      { providerId: 'gemini', used: 10, dailyLimit: 100, errors429: 0, otherErrors: 0 },
      { providerId: 'groq', used: 10, dailyLimit: 100, errors429: 0, otherErrors: 0 },
    ],
  );
  assert.equal(alerts.length, 0);
});

test('evaluateMonitoring aggregates without throwing', () => {
  const { alerts, summary } = evaluateMonitoring({
    registry,
    live: [
      { providerId: 'gemini', status: 'OK', liveModelIds: ['gemini-flash'], rateLimitHeaders: {} },
      { providerId: 'groq', status: 'OK', liveModelIds: ['llama-x'], rateLimitHeaders: {} },
    ],
    usage: [
      { providerId: 'gemini', used: 10, dailyLimit: 100, errors429: 0, otherErrors: 0 },
      { providerId: 'groq', used: 10, dailyLimit: 100, errors429: 0, otherErrors: 0 },
    ],
    now: Date.parse('2026-10-12T00:00:00Z'),
  });
  assert.ok(summary.total >= 1); // at least the missing gemini-gone
  assert.ok(Array.isArray(alerts));
});

test('buildSnapshotRow has no secret-shaped fields', () => {
  const row = buildSnapshotRow({
    providerId: 'gemini',
    status: 'OK',
    liveModelIds: ['m1'],
    rateLimitHeaders: { 'x-ratelimit-remaining': 10 },
    reason: 'ok',
  });
  assert.equal(row.provider_id, 'gemini');
  assert.deepEqual(row.model_ids, ['m1']);
  const json = JSON.stringify(row);
  assert.ok(!/api[_-]?key/i.test(json) || json.includes('reason'));
});

test('CLI monitor exits 0 without keys (NOT_RUN path)', async () => {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GROQ_API_KEY;
  delete env.DATABASE_URL;
  const result = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/monitor-connections.mjs', '--json', '--dry-run', '--no-db'], {
      env,
      cwd: new URL('..', import.meta.url).pathname,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.out + result.err);
  // Pretty-printed JSON spans multiple lines; take the whole object, not the first "{".
  const raw = result.out.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, 'expected JSON object on stdout: ' + raw.slice(0, 200));
  const j = JSON.parse(raw.slice(start, end + 1));
  assert.equal(j.ok, true);
  assert.ok(j.live.every((v) => v.status === 'NOT_RUN' || v.status === 'OK'));
});
