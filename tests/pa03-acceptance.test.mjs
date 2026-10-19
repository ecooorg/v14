import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectStagingEvidence, renderSummary } from '../scripts/staging-drills.mjs';

const response = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('PA-03 refuses missing or non-staging service URLs without making network calls', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('must not be called'); };
  const missing = await collectStagingEvidence({ env: {}, fetcher });
  assert.equal(missing.checks.find((c) => c.id === 'staging_url').status, 'NOT_RUN');
  assert.equal(missing.scenario181.length, 12);
  assert.equal(missing.safety.writesPerformed, false);
  const production = await collectStagingEvidence({ env: { STAGING_SERVICE_URL: 'https://app.example.com' }, fetcher });
  assert.equal(production.checks.find((c) => c.id === 'staging_url').status, 'NOT_RUN');
  assert.equal(calls, 0);
});

test('PA-03 records health, readiness, authenticated ops, and bounded GET-only probe', async () => {
  const methods = [];
  const fetcher = async (url, options = {}) => {
    methods.push(options.method || 'GET');
    const u = new URL(url);
    if (u.pathname === '/health') return response(200, { status: 'ok', commit: 'abc123456789' });
    if (u.pathname === '/ready') return response(200, { status: 'ready' });
    if (u.pathname === '/api/login') return response(200, { success: true }, { 'set-cookie': 'session=synthetic; Path=/; HttpOnly' });
    if (u.pathname === '/ops') return response(200, '<h1>BiForge operations</h1>');
    if (u.pathname === '/api/ops') return response(200, { queue: { queued: 0 }, alerts: [] });
    return response(404, { error: 'not_found' });
  };
  let t = 100;
  const report = await collectStagingEvidence({
    env: { STAGING_SERVICE_URL: 'https://staging.example.com', STAGING_APP_PASSWORD: 'synthetic-test-only', GITHUB_SHA: 'abc123' },
    fetcher,
    clock: () => { t += 5; return t; },
  });
  for (const id of ['health', 'ready', 'staging_login', 'ops_html', 'ops_json', 'bounded_load']) {
    assert.equal(report.checks.find((c) => c.id === id).status, 'PASS', id);
  }
  assert.equal(report.checks.find((c) => c.id === 'bounded_load').requests, 20);
  assert.ok(methods.every((method) => method === 'GET' || method === 'POST'));
  assert.ok(methods.filter((method) => method === 'POST').length === 1, 'only login may POST');
  assert.equal(report.safety.modelCalls, 0);
  assert.equal(report.safety.restorePerformed, false);
  assert.ok(report.scenario181.every((item) => item.status === 'NOT_RUN'));
  assert.match(renderSummary(report), /Restore and rollback remain NOT_RUN/);
});

test('PA-03 reports live endpoint failures without leaking secrets', async () => {
  const report = await collectStagingEvidence({
    env: { STAGING_SERVICE_URL: 'https://staging.example.com', STAGING_APP_PASSWORD: 'do-not-print-this' },
    fetcher: async () => response(503, { error: 'unavailable' }),
  });
  assert.equal(report.checks.find((c) => c.id === 'health').status, 'FAIL');
  assert.equal(report.overall, 'FAIL');
  assert.ok(!JSON.stringify(report).includes('do-not-print-this'));
});


test('PA-03 workflow is manual, read-only at repository level, and does not deploy or write commits', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/staging-drills.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /contents:\s*read/);
  assert.doesNotMatch(workflow, /schedule:|contents:\s*write|git push|railway deploy|gh pr merge/i);
  assert.match(workflow, /STAGING_SERVICE_URL/);
  assert.match(workflow, /hostname does not identify a staging database/);
});
