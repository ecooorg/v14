// P08 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe the contract of ARCHIVE/P08-SPEC.md and are expected to FAIL until P08 is implemented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeCall, newRouterState } from '../server/router.ts';
import { createFakeAdapter } from '../server/fakeProvider.ts';
import { REGISTRY_SEED, registryEntrySchema } from '../server/modelRegistry.ts';
import { unitsFor, shadowCostUsd, createQuotaTracker, DEFAULT_TASK_UNITS, BUDGET_POLICY_VERSION } from '../server/budget.ts';

const base = REGISTRY_SEED[0];
const entry = (over) => registryEntrySchema.parse({ ...base, ...over });
const req = { requestId: 'r', prompt: 'x'.repeat(400), json: true, metadata: {} };   // ~100 estimated input tokens
const ctxOf = (registry, adapters, extra = {}) => ({
  registry, adapters, state: newRouterState(), required: ['json_output'],
  sleep: async () => {}, backoffMs: () => 0, now: () => 1_000_000, ...extra,
});
const fake = (id, script = ['success']) => createFakeAdapter(id, script);

test('units formula and default budget', () => {
  assert.equal(BUDGET_POLICY_VERSION, 'units-v1');
  assert.equal(DEFAULT_TASK_UNITS, 30);
  assert.equal(unitsFor(0, 0), 1);
  assert.equal(unitsFor(1000, 0), 1);
  assert.equal(unitsFor(1001, 0), 2);
  assert.equal(unitsFor(600, 1500), 3);
});

test('shadow cost: price when known, null when unknown', () => {
  assert.equal(shadowCostUsd({ input: 1_000_000, cached: 0, output: 1_000_000 }, { inputPerMTok: 0.15, outputPerMTok: 0.6 }), 0.75);
  assert.equal(shadowCostUsd({ input: 10, cached: 0, output: 10 }, undefined), null);
});

test('registry: costTier required, self_hosted data policy accepted', () => {
  const { costTier, ...noTier } = base;
  assert.equal(registryEntrySchema.safeParse(noTier).success, false);
  assert.equal(entry({ providerId: 'own', costTier: 'self_hosted', dataPolicy: 'self_hosted' }).costTier, 'self_hosted');
});

test('order: quality class first, then self_hosted < free < paid, then registry order; deterministic', async () => {
  const reg = [
    entry({ providerId: 'pay', costTier: 'paid', dataPolicy: 'paid', qualityClass: 'A' }),
    entry({ providerId: 'fre', costTier: 'free', qualityClass: 'B' }),
    entry({ providerId: 'own', costTier: 'self_hosted', dataPolicy: 'self_hosted', qualityClass: 'B' }),
    entry({ providerId: 'fr2', costTier: 'free', qualityClass: 'B' }),
  ];
  const a = { pay: fake('pay'), fre: fake('fre'), own: fake('own'), fr2: fake('fr2') };
  const r1 = await routeCall(req, ctxOf(reg, a, { paidApproved: ['pay'] }));
  const r2 = await routeCall(req, ctxOf(reg, a, { paidApproved: ['pay'] }));
  assert.deepEqual(r1.decision.candidates.map((c) => c.split('/')[0]), ['pay', 'own', 'fre', 'fr2']);
  assert.deepEqual(r1.decision.candidates, r2.decision.candidates);
  assert.equal(r1.decision.policy, 'router-v1/units-v1');
});

test('paid provider is never called without approval', async () => {
  const pay = fake('pay');
  const r = await routeCall(req, ctxOf([entry({ providerId: 'pay', costTier: 'paid', dataPolicy: 'paid' })], { pay }));
  assert.equal(r.status, 'blocked');
  assert.equal(pay.calls.length, 0);
  assert.ok(r.decision.rejected.some((x) => x.reason === 'paid_not_approved'));
  assert.equal(r.decision.reason, 'no_suitable_model');
});

test('sensitivity high admits only paid or self_hosted data policies', async () => {
  const reg = [
    entry({ providerId: 'fre', costTier: 'free', dataPolicy: 'free' }),
    entry({ providerId: 'unk', costTier: 'free', dataPolicy: 'unknown' }),
    entry({ providerId: 'own', costTier: 'self_hosted', dataPolicy: 'self_hosted' }),
  ];
  const a = { fre: fake('fre'), unk: fake('unk'), own: fake('own') };
  const r = await routeCall(req, ctxOf(reg, a, { sensitivity: 'high' }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.decision.candidates, ['own/' + reg[2].modelId]);
  assert.equal(r.decision.rejected.filter((x) => x.reason.startsWith('sensitivity:')).length, 2);
  assert.equal(a.fre.calls.length + a.unk.calls.length, 0);
});

test('sensitivity high with only free providers: honest refusal, no call', async () => {
  const f = fake('fre');
  const r = await routeCall(req, ctxOf([entry({ providerId: 'fre', costTier: 'free', dataPolicy: 'free' })], { fre: f }, { sensitivity: 'high' }));
  assert.equal(r.status, 'blocked');
  assert.equal(f.calls.length, 0);
});

test('quota: model over its token-per-minute limit is rejected before the call, next model used', async () => {
  const quota = createQuotaTracker();
  const reg = [
    entry({ providerId: 'p1', costTier: 'free', limits: { tpm: 1000 } }),
    entry({ providerId: 'p2', costTier: 'free' }),
  ];
  quota.record(`p1/${reg[0].modelId}`, 950, 999_000);   // 950 tokens used 1 s ago
  const a = { p1: fake('p1'), p2: fake('p2') };
  const r = await routeCall(req, ctxOf(reg, a, { quota }));
  assert.equal(r.status, 'ok');
  assert.equal(a.p1.calls.length, 0);
  assert.ok(r.decision.rejected.some((x) => x.reason === 'quota:tpm'));
});

test('quota: request-per-minute limit, and window expiry', async () => {
  const quota = createQuotaTracker();
  const reg = [entry({ providerId: 'p1', costTier: 'free', limits: { rpm: 1 } })];
  const a = { p1: fake('p1') };
  const mk = (now) => ctxOf(reg, a, { quota, now: () => now });
  assert.equal((await routeCall(req, mk(1_000_000))).status, 'ok');
  const second = await routeCall(req, mk(1_010_000));
  assert.equal(second.status, 'blocked');
  assert.ok(second.decision.rejected.some((x) => x.reason === 'quota:rpm'));
  assert.equal((await routeCall(req, mk(1_070_000))).status, 'ok');   // 70 s later the minute window has passed
});

test('quota: every attempted call is recorded, failed calls count as requests', async () => {
  const quota = createQuotaTracker();
  const reg = [entry({ providerId: 'p1', costTier: 'free' })];
  await routeCall(req, ctxOf(reg, { p1: fake('p1', ['invalid_request']) }, { quota }));
  assert.equal(quota.usage(`p1/${reg[0].modelId}`, 1_000_000).rpm, 1);
});

test('input budget and context limit reject a model that cannot take the request', async () => {
  const big = { ...req, prompt: 'x'.repeat(4000) };   // ~1000 tokens
  const reg = [
    entry({ providerId: 'small', costTier: 'free', inputBudgetTokens: 500 }),
    entry({ providerId: 'tiny', costTier: 'free', contextLimit: 800 }),
    entry({ providerId: 'ok', costTier: 'free' }),
  ];
  const a = { small: fake('small'), tiny: fake('tiny'), ok: fake('ok') };
  const r = await routeCall(big, ctxOf(reg, a));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.decision.rejected.map((x) => x.reason).sort(), ['context_too_large', 'input_budget_exceeded']);
  assert.equal(a.small.calls.length + a.tiny.calls.length, 0);
});

test('output is capped by the model maxOutputTokens', async () => {
  const f = fake('p1');
  await routeCall({ ...req, maxOutputTokens: 9000 }, ctxOf([entry({ providerId: 'p1', costTier: 'free', maxOutputTokens: 1500 })], { p1: f }));
  assert.equal(f.calls[0].maxOutputTokens, 1500);
});

test('budget: not enough units -> blocked with budget_exceeded, no call', async () => {
  const f = fake('p1');
  const budget = { remainingUnits: 1 };
  const r = await routeCall({ ...req, maxOutputTokens: 3000 }, ctxOf([entry({ providerId: 'p1', costTier: 'free' })], { p1: f }, { budget }));
  assert.equal(r.status, 'blocked');
  assert.equal(r.decision.reason, 'budget_exceeded');
  assert.equal(f.calls.length, 0);
  assert.equal(budget.remainingUnits, 1);
});

test('budget: actual units are subtracted and reported', async () => {
  const f = fake('p1');   // fake provider reports usage input 10, output 5 -> 1 unit
  const budget = { remainingUnits: 10 };
  const r = await routeCall({ ...req, maxOutputTokens: 500 }, ctxOf([entry({ providerId: 'p1', costTier: 'free' })], { p1: f }, { budget }));
  assert.equal(r.status, 'ok');
  assert.equal(r.decision.unitsSpent, 1);
  assert.equal(budget.remainingUnits, 9);
});

test('decision is complete: candidates, rejected with reasons, attempts, policy', async () => {
  const reg = [entry({ providerId: 'p1', costTier: 'free', status: 'disabled' }), entry({ providerId: 'p2', costTier: 'free' })];
  const r = await routeCall(req, ctxOf(reg, { p1: fake('p1'), p2: fake('p2') }));
  assert.deepEqual(r.decision.rejected, [{ model: `p1/${reg[0].modelId}`, reason: 'status:disabled' }]);
  assert.equal(r.decision.attempts.length, 1);
  assert.equal(r.decision.attempts[0].status, 'ok');
});

test('existing callers without the new context fields behave as before', async () => {
  const r = await routeCall(req, { registry: [entry({ providerId: 'p1', costTier: 'free' })], adapters: { p1: fake('p1') }, state: newRouterState(), required: ['json_output'] });
  assert.equal(r.status, 'ok');
});
