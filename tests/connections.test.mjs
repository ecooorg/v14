import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { REGISTRY_SEED } from '../server/modelRegistry.ts';
import { sha256Hex, artifactInputSchema } from '../server/artifactRepository.ts';
import { ledgerEntryFromResponse } from '../server/ledger.ts';
import { routeCall, newRouterState } from '../server/router.ts';
import { createFakeAdapter } from '../server/fakeProvider.ts';

const SECRET = 'sk-test-SECRET-value-123456';
function run(env, ...a) {
  return new Promise((resolve) => {
    const clean = { ...process.env }; delete clean.DATABASE_URL; delete clean.GEMINI_API_KEY;
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/verify-connections.mjs', ...a], { env: { ...clean, ...env } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}
function fakeGemini(mode) {
  const server = http.createServer((req, res) => {
    const ok = req.headers['x-goog-api-key'] === SECRET;
    res.setHeader('content-type', 'application/json');
    if (mode === 'drift') { res.statusCode = 404; return res.end('{}'); }
    if (!ok) { res.statusCode = 400; return res.end('{"error":"API key not valid"}'); }
    if (req.url.includes('generateContent')) return res.end(JSON.stringify({ candidates: [{}], usageMetadata: {} }));
    res.end(JSON.stringify({ models: [{ name: `models/${REGISTRY_SEED[0].modelId}` }] }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('verify:connections OK against a fake Gemini, secret never printed', async () => {
  const s = await fakeGemini('ok');
  const { code, out } = await run({ GEMINI_API_KEY: SECRET, GEMINI_BASE_URL_OVERRIDE: `http://127.0.0.1:${s.address().port}` }, '--only', 'gemini', '--json');
  s.close();
  assert.equal(code, 0);
  const j = JSON.parse(out);
  assert.deepEqual(j.results.map((r) => r.status), ['OK', 'OK']);
  assert.ok(!out.includes(SECRET));
});

test('verify:connections: wrong key is FAIL (exit 2), 404 is DRIFT (exit 2), missing key is BLOCKED (exit 3)', async () => {
  let s = await fakeGemini('ok');
  let r = await run({ GEMINI_API_KEY: 'wrong-key-value', GEMINI_BASE_URL_OVERRIDE: `http://127.0.0.1:${s.address().port}` }, '--only', 'gemini', '--json');
  s.close(); assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).results[0].reason, 'http_400');
  s = await fakeGemini('drift');
  r = await run({ GEMINI_API_KEY: SECRET, GEMINI_BASE_URL_OVERRIDE: `http://127.0.0.1:${s.address().port}` }, '--only', 'gemini', '--json');
  s.close(); assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).results[0].status, 'DRIFT');
  r = await run({}, '--only', 'gemini', '--json');
  assert.equal(r.code, 3); assert.equal(JSON.parse(r.out).results[0].reason, 'missing_secret:GEMINI_API_KEY');
});

test('verify:connections --dry-run makes no network calls', async () => {
  const r = await run({ GEMINI_API_KEY: SECRET, GEMINI_BASE_URL_OVERRIDE: 'http://127.0.0.1:1' }, '--dry-run', '--json');
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.out).results.every((x) => x.status === 'NOT_RUN'));
  assert.ok(!r.out.includes(SECRET));
});

test('connectors.yaml and CONNECTIONS.md agree on connectors and variable names', () => {
  const m = JSON.parse(fs.readFileSync('connectors.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
  const doc = fs.readFileSync('docs/CONNECTIONS.md', 'utf8');
  for (const [id, c] of Object.entries(m.connectors)) {
    assert.ok(doc.includes(`\`${id}\``), `doc mentions connector ${id}`);
    for (const n of [...c.env.required, ...(c.env.optional || [])]) assert.ok(doc.includes(n), `doc mentions ${n}`);
  }
  assert.ok(!JSON.stringify(m).match(/sk-|AIza/), 'no secret-like values in the manifest');
});

test('artifact input: hash and validation (no database needed)', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const base = { projectId: 'p1', filename: 'a.md', text: 'x', createdBy: 'human' };
  assert.equal(artifactInputSchema.safeParse(base).success, true);
  assert.equal(artifactInputSchema.safeParse({ ...base, filename: '../a.md' }).success, false);
  assert.equal(artifactInputSchema.safeParse({ ...base, extra: 1 }).success, false);
});

test('ledger: router reports every call, including failed ones', async () => {
  const rows = [];
  const reg = [{ ...REGISTRY_SEED[0], providerId: 'p1' }];
  const p1 = createFakeAdapter('p1', ['server_error', 'success']);
  const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, {
    registry: reg, adapters: { p1 }, state: newRouterState(), required: ['json_output'], sleep: async () => {}, backoffMs: () => 0,
    onCall: (resp, info) => { rows.push(ledgerEntryFromResponse(resp, { runId: 'run1', retries: info.retries })); },
  });
  assert.equal(r.status, 'ok');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.status), ['error', 'ok']);
  assert.equal(rows[0].errorClass, 'PROVIDER_TRANSIENT');
  assert.deepEqual([rows[1].inputTokens, rows[1].outputTokens, rows[1].retries], [10, 5, 1]);
});
