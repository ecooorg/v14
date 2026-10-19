// P09 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P09-SPEC.md and are expected to FAIL until P09 is implemented. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeCall, newRouterState } from '../server/router.ts';
import { REGISTRY_SEED, registryEntrySchema } from '../server/modelRegistry.ts';
import { providerResponseSchema } from '../server/adapter.ts';
import { createOpenAICompatibleAdapter } from '../server/openaiCompatAdapter.ts';
import { createQuotaTracker, DEFAULT_DAILY_UNITS, budgetLevel, runBudget } from '../server/budget.ts';
import { applyHealthEvent, hydrateRouterState, rehydrateQuota, AUTH_DISABLE_TTL_MS } from '../server/modelHealth.ts';

const NOW = 1_000_000;
const entry = (providerId, modelId) => registryEntrySchema.parse({ ...REGISTRY_SEED[0], providerId, modelId, costTier: 'free' });
const req = { requestId: 'r', prompt: 'hello', json: true, metadata: {} };

// Scripted adapter: each call consumes the next outcome ('ok' or an error class string, or an object with extra fields).
const stub = (id, script) => {
  let i = 0; const calls = [];
  return { id, calls, capabilities: () => ['json_output'], async call(r) {
    calls.push({ modelId: r.modelId, prompt: r.prompt });
    const o = script[Math.min(i++, script.length - 1)];
    const cls = typeof o === 'string' ? o : o.cls; const extra = typeof o === 'object' ? o.extra ?? {} : {};
    const base = { providerId: id, modelId: r.modelId, latencyMs: 40 };
    if (cls === 'ok') return { ...base, status: 'ok', output: { a: 1 }, usage: { input: 10, cached: 0, output: 5 }, retryable: false };
    return { ...base, status: 'error', usage: { input: 0, cached: 0, output: 0 }, errorClass: cls, retryable: cls === 'PROVIDER_TRANSIENT' || cls === 'INVALID_OUTPUT', ...extra };
  } };
};
const ctxOf = (registry, adapters, extra = {}) => {
  const sleeps = []; const events = [];
  return { sleeps, events, ctx: { registry, adapters, state: newRouterState(), required: ['json_output'], now: () => NOW, backoffMs: () => 123, sleep: async (ms) => { sleeps.push(ms); }, onHealth: (e) => { events.push(e); }, ...extra } };
};

test('TRANSIENT: one retry on the same model after the backoff, then success', async () => {
  const p1 = stub('p1', ['PROVIDER_TRANSIENT', 'ok']);
  const { ctx, sleeps } = ctxOf([entry('p1', 'm1')], { p1 });
  const r = await routeCall(req, ctx);
  assert.equal(r.status, 'ok');
  assert.deepEqual(p1.calls.map((c) => c.modelId), ['m1', 'm1']);
  assert.deepEqual(sleeps, [123]);
});

test('TRANSIENT: no retry when the deadline leaves no room for the wait; next model is used', async () => {
  const p1 = stub('p1', ['PROVIDER_TRANSIENT']); const p2 = stub('p2', ['ok']);
  const { ctx, sleeps } = ctxOf([entry('p1', 'm1'), entry('p2', 'm2')], { p1, p2 }, { deadlineAt: NOW + 100 });
  const r = await routeCall(req, ctx);
  assert.equal(r.status, 'ok');
  assert.equal(p1.calls.length, 1); assert.equal(p2.calls.length, 1); assert.deepEqual(sleeps, []);
});

test('TRANSIENT: second failure puts the model in cooldown and moves on', async () => {
  const p1 = stub('p1', ['PROVIDER_TRANSIENT']); const p2 = stub('p2', ['ok']);
  const { ctx } = ctxOf([entry('p1', 'm1'), entry('p2', 'm2')], { p1, p2 });
  const r = await routeCall(req, ctx);
  assert.equal(r.status, 'ok'); assert.equal(p1.calls.length, 2);
  assert.equal(ctx.state.cooldownUntil.get('p1/m1'), NOW + 60_000);
});

test('QUOTA: no retry, cooldown until reset = max(180 s, retryAfterMs) capped at 24 h, next candidate', async () => {
  const run = async (extra) => {
    const p1 = stub('p1', [{ cls: 'PROVIDER_QUOTA', extra }]); const p2 = stub('p2', ['ok']);
    const { ctx } = ctxOf([entry('p1', 'm1'), entry('p2', 'm2')], { p1, p2 });
    const r = await routeCall(req, ctx);
    assert.equal(r.status, 'ok'); assert.equal(p1.calls.length, 1);
    return ctx.state.cooldownUntil.get('p1/m1');
  };
  assert.equal(await run({}), NOW + 180_000);
  assert.equal(await run({ retryAfterMs: 600_000 }), NOW + 600_000);
  assert.equal(await run({ retryAfterMs: 10 * 86_400_000 }), NOW + 86_400_000);
  assert.equal(await run({ retryAfterMs: 5_000 }), NOW + 180_000);
});

test('AUTH: the whole provider is disabled, its other models are skipped, fallback goes to another provider, event emitted', async () => {
  const p1 = stub('p1', ['PROVIDER_AUTH']); const p2 = stub('p2', ['ok']);
  const { ctx, events } = ctxOf([entry('p1', 'm1'), entry('p1', 'm1b'), entry('p2', 'm2')], { p1, p2 });
  const r = await routeCall(req, ctx);
  assert.equal(r.status, 'ok');
  assert.deepEqual(p1.calls.map((c) => c.modelId), ['m1']);
  assert.ok(ctx.state.disabledProviders.has('p1'));
  assert.ok(events.some((e) => e.type === 'provider_disabled' && e.providerId === 'p1' && e.reason === 'PROVIDER_AUTH'));
});

test('AUTH: with no other provider the result is blocked (no_provider_after_auth)', async () => {
  const { ctx } = ctxOf([entry('p1', 'm1')], { p1: stub('p1', ['PROVIDER_AUTH']) });
  const r = await routeCall(req, ctx);
  assert.equal(r.status, 'blocked'); assert.equal(r.decision.reason, 'no_provider_after_auth');
});

test('INVALID_REQUEST: no retry, error with category system', async () => {
  const p1 = stub('p1', ['INVALID_REQUEST']); const p2 = stub('p2', ['ok']);
  const { ctx } = ctxOf([entry('p1', 'm1'), entry('p2', 'm2')], { p1, p2 });
  const r = await routeCall(req, ctx);
  assert.equal(r.status, 'error'); assert.equal(r.decision.reason, 'INVALID_REQUEST'); assert.equal(r.decision.category, 'system');
  assert.equal(p1.calls.length, 1); assert.equal(p2.calls.length, 0);
});

test('INVALID_OUTPUT: one retry with a repair hint on the same model, then the next model, then FAIL', async () => {
  const p1 = stub('p1', ['INVALID_OUTPUT', 'ok']);
  const a = await routeCall(req, ctxOf([entry('p1', 'm1')], { p1 }).ctx);
  assert.equal(a.status, 'ok');
  assert.equal(p1.calls.length, 2); assert.notEqual(p1.calls[1].prompt, p1.calls[0].prompt); assert.match(p1.calls[1].prompt, /JSON/);

  const q1 = stub('q1', ['INVALID_OUTPUT']); const q2 = stub('q2', ['ok']);
  const b = await routeCall(req, ctxOf([entry('q1', 'm1'), entry('q2', 'm2')], { q1, q2 }).ctx);
  assert.equal(b.status, 'ok'); assert.equal(q1.calls.length, 2); assert.equal(q2.calls.length, 1);

  const c = await routeCall(req, ctxOf([entry('z1', 'm1'), entry('z2', 'm2')], { z1: stub('z1', ['INVALID_OUTPUT']), z2: stub('z2', ['INVALID_OUTPUT']) }).ctx);
  assert.equal(c.status, 'error'); assert.equal(c.decision.reason, 'candidates_exhausted');
});

test('POLICY_REJECTED: no retry, escalate to a human', async () => {
  const p1 = stub('p1', ['POLICY_REJECTED']); const p2 = stub('p2', ['ok']);
  const r = await routeCall(req, ctxOf([entry('p1', 'm1'), entry('p2', 'm2')], { p1, p2 }).ctx);
  assert.equal(r.status, 'error'); assert.equal(r.decision.reason, 'POLICY_REJECTED'); assert.equal(r.decision.escalate, 'human');
  assert.equal(p1.calls.length, 1); assert.equal(p2.calls.length, 0);
});

test('Run limit: four model calls, then blocked (call_limit)', async () => {
  const adapters = { a: stub('a', ['PROVIDER_TRANSIENT']), b: stub('b', ['PROVIDER_TRANSIENT']), c: stub('c', ['PROVIDER_TRANSIENT']) };
  const r = await routeCall(req, ctxOf([entry('a', 'm'), entry('b', 'm'), entry('c', 'm')], adapters).ctx);
  assert.equal(r.status, 'blocked'); assert.equal(r.decision.reason, 'call_limit');
  assert.equal(adapters.a.calls.length + adapters.b.calls.length + adapters.c.calls.length, 4);
});

test('health events: every call and every cooldown is reported', async () => {
  const p1 = stub('p1', ['PROVIDER_QUOTA']); const p2 = stub('p2', ['ok']);
  const { ctx, events } = ctxOf([entry('p1', 'm1'), entry('p2', 'm2')], { p1, p2 });
  await routeCall(req, ctx);
  assert.deepEqual(events.filter((e) => e.type === 'call').map((e) => [e.model, e.ok, e.errorClass ?? null]), [['p1/m1', false, 'PROVIDER_QUOTA'], ['p2/m2', true, null]]);
  assert.ok(events.some((e) => e.type === 'cooldown' && e.model === 'p1/m1' && e.until === NOW + 180_000));
  assert.equal(events.find((e) => e.type === 'call').latencyMs, 40);
});

test('health fold: counts, latency EMA (alpha 0.2), last error, cooldown', () => {
  const rows = new Map();
  applyHealthEvent(rows, { type: 'call', model: 'p/m', ok: true, latencyMs: 100 }, NOW);
  applyHealthEvent(rows, { type: 'call', model: 'p/m', ok: true, latencyMs: 200 }, NOW);
  applyHealthEvent(rows, { type: 'call', model: 'p/m', ok: false, latencyMs: 5, errorClass: 'PROVIDER_QUOTA' }, NOW);
  applyHealthEvent(rows, { type: 'cooldown', model: 'p/m', until: NOW + 5000 }, NOW);
  const r = rows.get('p/m');
  assert.equal(r.successes, 2); assert.equal(r.failures, 1); assert.equal(r.lastErrorClass, 'PROVIDER_QUOTA'); assert.equal(r.cooldownUntil, NOW + 5000);
  assert.ok(Math.abs(r.avgLatencyMs - 120) < 1e-9 || Math.abs(r.avgLatencyMs - (0.8 * 120 + 0.2 * 5)) < 1e-9);   // 120 after the two successes; failures may or may not feed the average
});

test('hydrate: future cooldowns and recent provider disables are restored; old ones are not', () => {
  const state = newRouterState();
  hydrateRouterState(state, [
    { key: 'p/m1', kind: 'model', cooldownUntil: NOW + 5000, disabledAt: null },
    { key: 'p/m2', kind: 'model', cooldownUntil: NOW - 5000, disabledAt: null },
    { key: 'a', kind: 'provider', cooldownUntil: null, disabledAt: NOW - 1000 },
    { key: 'b', kind: 'provider', cooldownUntil: null, disabledAt: NOW - AUTH_DISABLE_TTL_MS - 1000 },
  ], NOW);
  assert.equal(AUTH_DISABLE_TTL_MS, 6 * 3600_000);
  assert.equal(state.cooldownUntil.get('p/m1'), NOW + 5000); assert.equal(state.cooldownUntil.has('p/m2'), false);
  assert.ok(state.disabledProviders.has('a')); assert.equal(state.disabledProviders.has('b'), false);
});

test('quota is restored from ledger rows', () => {
  const t = createQuotaTracker();
  rehydrateQuota(t, [
    { providerId: 'p', modelId: 'm', tokens: 700, atMs: NOW - 10_000 },
    { providerId: 'p', modelId: 'm', tokens: 300, atMs: NOW - 3_600_000 },
    { providerId: 'p', modelId: 'm', tokens: 999, atMs: NOW - 2 * 86_400_000 },
  ], NOW);
  assert.deepEqual(t.usage('p/m', NOW), { rpm: 1, tpm: 700, rpd: 2, tpd: 1000 });
});

test('day cap: levels at 80 % and 100 %, run budget never negative', () => {
  assert.equal(DEFAULT_DAILY_UNITS, 300);
  assert.equal(budgetLevel(239, 300).level, 'ok');
  assert.equal(budgetLevel(240, 300).level, 'warn');
  assert.equal(budgetLevel(299, 300).level, 'warn');
  assert.equal(budgetLevel(300, 300).level, 'stop');
  assert.equal(budgetLevel(150, 300).percent, 50);
  assert.equal(runBudget(0, { dayCap: 300, taskUnits: 30 }), 30);
  assert.equal(runBudget(290, { dayCap: 300, taskUnits: 30 }), 10);
  assert.equal(runBudget(300, { dayCap: 300, taskUnits: 30 }), 0);
  assert.equal(runBudget(999, { dayCap: 300, taskUnits: 30 }), 0);
});

test('adapter: 429 with retry-after fills retryAfterMs; the schema accepts it', async () => {
  const mk = (headers) => createOpenAICompatibleAdapter({ providerId: 'g', baseUrl: 'http://x/v1', apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Rate limit reached on tokens per day (TPD)' } }), { status: 429, headers }) });
  const withHeader = await mk({ 'retry-after': '120' }).call({ requestId: 'r', modelId: 'm', prompt: 'x', json: true, metadata: {} }, {});
  assert.equal(withHeader.errorClass, 'PROVIDER_QUOTA'); assert.equal(withHeader.retryAfterMs, 120_000);
  providerResponseSchema.parse(withHeader);
  const without = await mk({}).call({ requestId: 'r', modelId: 'm', prompt: 'x', json: true, metadata: {} }, {});
  assert.equal(without.retryAfterMs, undefined);
});
