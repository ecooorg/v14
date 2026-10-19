// P12 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P12-SPEC.md and are expected to FAIL until P12 is implemented. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  JOB_STATES, DEFAULT_LEASE_MS, DEFAULT_HEARTBEAT_MS, DEFAULT_POLL_MS, QueueError, leaseUntil, isLeaseExpired, validateTiming, jobStatusForRun,
} from '../server/queueMachine.ts';
import { createWorker } from '../server/worker.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof QueueError, `QueueError expected, got ${e}`); return e.code; } return null; };

test('states and defaults', () => {
  assert.deepEqual(JOB_STATES, ['QUEUED', 'LEASED', 'DONE', 'ABANDONED', 'CANCELLED']);
  assert.equal(DEFAULT_LEASE_MS, 60000); assert.equal(DEFAULT_HEARTBEAT_MS, 20000); assert.equal(DEFAULT_POLL_MS, 2000);
});

test('QueueError carries a code and an HTTP status', () => {
  const st = { LEASE_LOST: 409, NOT_FOUND: 404, INVALID_TIMING: 400, INVALID_STATUS: 400 };
  for (const [c, s] of Object.entries(st)) { const e = new QueueError(c, 'm'); assert.equal(e.code, c); assert.equal(e.status, s); assert.ok(e instanceof Error); }
});

test('lease arithmetic: expired exactly at lease_until', () => {
  const now = new Date(1_000_000);
  const until = leaseUntil(now, 500);
  assert.ok(until instanceof Date); assert.equal(until.getTime(), 1_000_500);
  assert.equal(isLeaseExpired(until, new Date(1_000_499)), false);
  assert.equal(isLeaseExpired(until, new Date(1_000_500)), true);
  assert.equal(isLeaseExpired(until, new Date(1_000_501)), true);
});

test('timing: heartbeat must fit twice into the lease', () => {
  assert.equal(code(() => validateTiming({ leaseMs: 60000, heartbeatMs: 20000 })), null);
  assert.equal(code(() => validateTiming({ leaseMs: 1000, heartbeatMs: 500 })), null);
  for (const bad of [{ leaseMs: 1000, heartbeatMs: 501 }, { leaseMs: 0, heartbeatMs: 0 }, { leaseMs: -1000, heartbeatMs: 100 }, { leaseMs: 1000, heartbeatMs: 0 }, { leaseMs: 1000.5, heartbeatMs: 100 }, { leaseMs: 1000, heartbeatMs: 10.5 }]) {
    assert.equal(code(() => validateTiming(bad)), 'INVALID_TIMING', JSON.stringify(bad));
  }
});

test('job status follows the final Run status; non-final statuses are refused', () => {
  for (const s of ['SUCCEEDED', 'FAILED', 'TIMED_OUT']) assert.equal(jobStatusForRun(s), 'DONE', s);
  assert.equal(jobStatusForRun('CANCELLED'), 'CANCELLED'); assert.equal(jobStatusForRun('ABANDONED'), 'ABANDONED');
  for (const s of ['QUEUED', 'RUNNING']) assert.throws(() => jobStatusForRun(s), s);
});

test('createWorker validates its options and exposes tick/start/stop', () => {
  const handler = async () => ({ status: 'SUCCEEDED' });
  const w = createWorker({ workerId: 'w', handler });
  for (const f of ['tick', 'start', 'stop']) assert.equal(typeof w[f], 'function', f);
  assert.equal(code(() => createWorker({ workerId: 'w', handler, leaseMs: 1000, heartbeatMs: 600 })), 'INVALID_TIMING');
  assert.throws(() => createWorker({ workerId: '', handler }));
});

test('migration 006, SKIP LOCKED claim, npm scripts', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations/006_jobs.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS jobs\b/);
  assert.match(sql, /run_id[^,]*\bUNIQUE\b|UNIQUE\s*\(\s*run_id\s*\)/i);
  for (const col of ['seq', 'status', 'lease_owner', 'lease_until', 'heartbeat_at', 'available_at', 'claims']) assert.match(sql, new RegExp(`\\b${col}\\b`), col);
  const svc = fs.readFileSync(path.join(root, 'server/queueService.ts'), 'utf8');
  assert.match(svc, /FOR UPDATE SKIP LOCKED/i);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:p12']); assert.ok(pkg.scripts.check.includes('npm run test:p12'));
  assert.ok(pkg.scripts['test:database:live'].includes('tests/p12-live-acceptance.test.mjs'));
});
