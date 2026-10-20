/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN conformance.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { providerResponseSchema } = await import("../server/adapter.ts");
const { createFakeAdapter, FAKE_SCENARIOS } = await import("../server/fakeProvider.ts");
const { createGeminiAdapter, classifyGeminiError } = await import("../server/geminiAdapter.ts");
const { createOpenAICompatibleAdapter } = await import("../server/openaiCompatAdapter.ts");
const { REGISTRY_SEED } = await import("../server/modelRegistry.ts");
const { routeCall, selectCandidates, newRouterState } = await import("../server/router.ts");

const req = { requestId: 'r1', modelId: 'm', prompt: 'hi', json: true, metadata: {} };
const usage = { promptTokenCount: 3, candidatesTokenCount: 4, cachedContentTokenCount: 1 };

// Gemini client stubs per scenario (what the real SDK would throw or return)
const geminiStub = {
  success: async () => ({ text: '{"a":1}', usageMetadata: usage, candidates: [{ finishReason: 'STOP' }] }),
  rate_limit: async () => { throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }); },
  server_error: async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); },
  timeout: async (a) => new Promise((_, rej) => a.config.abortSignal.addEventListener('abort', () => rej(new Error('This operation was aborted')))),
  bad_json: async () => ({ text: 'nope', candidates: [{ finishReason: 'STOP' }] }),
  truncated: async () => ({ text: '{"a":', candidates: [{ finishReason: 'MAX_TOKENS' }] }),
  auth: async () => { throw Object.assign(new Error('API key not valid'), { status: 400 }); },
  empty: async () => ({ text: '' }),
  quota: async () => { throw Object.assign(new Error('Quota exceeded: daily limit'), { status: 429 }); },
  policy: async () => ({ text: '', promptFeedback: { blockReason: 'SAFETY' } }),
  invalid_request: async () => { throw Object.assign(new Error('Bad argument'), { status: 400 }); },
};
const httpStub = {
  success: () => [200, { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1 } } }],
  rate_limit: () => [429, { error: { message: 'Rate limit reached on tokens per minute (TPM)' } }],
  server_error: () => [503, { error: { message: 'unavailable' } }],
  timeout: 'hang',
  bad_json: () => [200, { choices: [{ message: { content: 'nope' }, finish_reason: 'stop' }] }],
  truncated: () => [200, { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }],
  auth: () => [401, { error: { message: 'Invalid API Key' } }],
  empty: () => [200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }],
  quota: () => [429, { error: { message: 'Rate limit reached on tokens per day (TPD)' } }],
  policy: () => [200, { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }],
  invalid_request: () => [400, { error: { message: 'bad' } }],
};
const compat = (s) => createOpenAICompatibleAdapter({ providerId: 'groq', baseUrl: 'http://x/v1', apiKey: 'k', fetchImpl: async (_u, init) => {
  if (httpStub[s] === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('This operation was aborted'))));
  const [status, body] = httpStub[s]();
  return new Response(JSON.stringify(body), { status });
} });
const adapters = {
  compat,
  fake: (s) => createFakeAdapter('fake', [s]),
  gemini: (s) => createGeminiAdapter({ models: { generateContent: geminiStub[s] } }),
};

for (const [name, make] of Object.entries(adapters)) {
  for (const [scenario, expected] of Object.entries(FAKE_SCENARIOS)) {
    test(`conformance ${name}: ${scenario}`, async () => {
      const r = await make(scenario).call(req, { timeoutMs: 30 });
      providerResponseSchema.parse(r);
      if (expected === null) {
        assert.equal(r.status, 'ok');
        assert.deepEqual(r.output, name === 'gemini' || name === 'compat' ? { a: 1 } : { ok: true });
      } else {
        assert.equal(r.status, 'error');
        assert.equal(r.errorClass, expected);
        assert.equal(r.retryable, expected === 'PROVIDER_TRANSIENT' || expected === 'INVALID_OUTPUT');
      }
    });
  }
}

test('gemini adapter maps usage and never exposes the key', async () => {
  const r = await adapters.gemini('success').call(req, {});
  assert.deepEqual(r.usage, { input: 3, cached: 1, output: 4 });
  assert.equal(classifyGeminiError(new Error('x'), true), 'PROVIDER_TRANSIENT');
});

// ---- Router-min ----
const reg = REGISTRY_SEED.map((e) => ({ ...e, providerId: 'a', modelId: e.modelId }));
const regTwo = [{ ...reg[0], providerId: 'p1' }, { ...reg[1], providerId: 'p2' }];
const base = (adapterMap, registry = regTwo, extra = {}) => ({
  registry, adapters: adapterMap, state: newRouterState(), required: ['json_output'],
  sleep: async () => {}, backoffMs: () => 0, ...extra,
});

test('router: deterministic selection with recorded rejections', () => {
  const r2 = reg.map((e, i) => (i === 1 ? { ...e, status: 'disabled' } : i === 2 ? { ...e, capabilities: [] } : e));
  const a = selectCandidates(r2, newRouterState(), ['json_output'], 0);
  const b = selectCandidates(r2, newRouterState(), ['json_output'], 0);
  assert.deepEqual(a, b);
  assert.equal(a.candidates.length, reg.length - 2);
  assert.deepEqual(a.rejected.map((x) => x.reason), ['status:disabled', 'missing_capability:json_output']);
});

test('router: blocked when nothing suitable', async () => {
  const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, base({ p1: createFakeAdapter('p1') }, regTwo, { required: ['vision'] }));
  assert.equal(r.status, 'blocked');
  assert.equal(r.decision.reason, 'no_suitable_model');
});

test('router: transient retries once on same model, then next model', async () => {
  const p1 = createFakeAdapter('p1', ['server_error']), p2 = createFakeAdapter('p2');
  const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, base({ p1, p2 }));
  assert.equal(r.status, 'ok');
  assert.equal(p1.calls.length, 2);
  assert.equal(p2.calls.length, 1);
});

test('router: quota cooldown without retry; auth disables provider', async () => {
  const p1 = createFakeAdapter('p1', ['quota']), p2 = createFakeAdapter('p2');
  const ctx = base({ p1, p2 });
  assert.equal((await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, ctx)).status, 'ok');
  assert.equal(p1.calls.length, 1);
  assert.equal(selectCandidates(regTwo, ctx.state, [], Date.now()).rejected[0].reason, 'cooldown');
  const a1 = createFakeAdapter('p1', ['auth']);
  const ctx2 = base({ p1: a1 }, [regTwo[0]]);
  const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, ctx2);
  assert.equal(r.status, 'blocked');
  assert.ok(ctx2.state.disabledProviders.has('p1'));
});

test('router: invalid output retries with hint, then next model', async () => {
  const p1 = createFakeAdapter('p1', ['bad_json']), p2 = createFakeAdapter('p2');
  const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, base({ p1, p2 }));
  assert.equal(r.status, 'ok');
  assert.equal(p1.calls.length, 2);
  assert.match(p1.calls[1].prompt, /not valid JSON/);
});

test('router: invalid request and policy stop at once; call limit holds', async () => {
  for (const s of ['invalid_request', 'policy']) {
    const p1 = createFakeAdapter('p1', [s]), p2 = createFakeAdapter('p2');
    const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, base({ p1, p2 }));
    assert.equal(r.status, 'error');
    assert.equal(p2.calls.length, 0);
  }
  const p1 = createFakeAdapter('p1', ['server_error']);
  const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, base({ a: p1 }, reg, { maxCalls: 4 }));
  assert.equal(p1.calls.length, 4);
  assert.equal(r.decision.reason, 'call_limit');
});
}
// ===== END conformance.test.mjs =====

// ===== BEGIN model-layer.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const { ProviderError, classifyHttpStatus, FALLBACK_MATRIX, PROVIDER_ERROR_CLASSES, providerResponseSchema, errorResponse } = await import("../server/adapter.ts");
const { REGISTRY_SEED, validateRegistry, supports, staleEntries, registryEntrySchema } = await import("../server/modelRegistry.ts");

const usage = { input: 1, cached: 0, output: 2 };

test('error classes: matrix covers all, retryable flags follow TZ 7.4', () => {
  assert.deepEqual(Object.keys(FALLBACK_MATRIX).sort(), [...PROVIDER_ERROR_CLASSES].sort());
  assert.equal(new ProviderError('PROVIDER_TRANSIENT', 'x').retryable, true);
  assert.equal(new ProviderError('PROVIDER_QUOTA', 'x').retryable, false);
  assert.equal(new ProviderError('INVALID_OUTPUT', 'x').retryable, true);
});

test('HTTP status classification', () => {
  assert.equal(classifyHttpStatus(429), 'PROVIDER_TRANSIENT');
  assert.equal(classifyHttpStatus(429, { quotaExhausted: true }), 'PROVIDER_QUOTA');
  assert.equal(classifyHttpStatus(503), 'PROVIDER_TRANSIENT');
  assert.equal(classifyHttpStatus(401), 'PROVIDER_AUTH');
  assert.equal(classifyHttpStatus(400), 'INVALID_REQUEST');
  assert.equal(classifyHttpStatus(200, { blocked: true }), 'POLICY_REJECTED');
});

test('normalized response schema', () => {
  const ok = { status: 'ok', output: 'hi', usage, latencyMs: 5, providerId: 'p', modelId: 'm', retryable: false };
  assert.equal(providerResponseSchema.safeParse(ok).success, true);
  assert.equal(providerResponseSchema.safeParse({ ...ok, output: undefined }).success, false);
  assert.equal(providerResponseSchema.safeParse({ ...ok, errorClass: 'PROVIDER_AUTH' }).success, false);
  assert.equal(providerResponseSchema.safeParse({ ...ok, status: 'error', output: undefined }).success, false);
  const err = errorResponse(new ProviderError('PROVIDER_QUOTA', 'q'), { providerId: 'p', modelId: 'm', latencyMs: 1 });
  assert.equal(err.errorClass, 'PROVIDER_QUOTA');
  assert.equal(err.retryable, false);
});

test('registry seed is valid, matches default cascades, holds no secrets', () => {
  validateRegistry(REGISTRY_SEED);
  const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const m = src.match(/MODEL_CASCADE_LIGHT \|\|\s*'([^']+)'/);
  assert.deepEqual(REGISTRY_SEED.map((e) => e.modelId), m[1].split(','));
  for (const e of REGISTRY_SEED) assert.match(e.secretEnvRef, /^[A-Z][A-Z0-9_]*$/);
  assert.equal(registryEntrySchema.safeParse({ ...REGISTRY_SEED[0], apiKey: 'x' }).success, false);
  assert.throws(() => validateRegistry([REGISTRY_SEED[0], REGISTRY_SEED[0]]));
});

test('capability must be confirmed; stale entries flagged', () => {
  const e = REGISTRY_SEED[0];
  assert.equal(supports(e, ['json_output']), true);
  assert.equal(supports(e, ['vision']), false);
  assert.equal(supports({ ...e, status: 'disabled' }, []), false);
  assert.equal(staleEntries([e], new Date('2026-10-11')).length, 0);
  assert.equal(staleEntries([e], new Date('2027-02-01')).length, 1);
});

test('groq seed: primary active, others disabled, openai-compatible, free, budgets in registry, no duplicates', async () => {
  const { GROQ_SEED, REGISTRY_ALL } = await import('../server/modelRegistry.ts');
  validateRegistry(REGISTRY_ALL);
  assert.deepEqual(GROQ_SEED.map((e) => e.modelId), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
  for (const e of GROQ_SEED) {
    assert.equal(e.status, e.modelId === 'openai/gpt-oss-120b' ? 'active' : 'disabled'); assert.equal(e.adapter, 'openai-compatible'); assert.equal(e.qualityClass, 'B');
    assert.equal(e.qualityProvisional, true); assert.equal(e.dataPolicy, 'free'); assert.equal(e.inputBudgetTokens, 3500); assert.equal(e.secretEnvRef, 'GROQ_API_KEY');
  }
});
}
// ===== END model-layer.test.mjs =====

// ===== BEGIN p08-acceptance.test.mjs =====
{
// P08 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe the contract of ARCHIVE/P08-SPEC.md and are expected to FAIL until P08 is implemented.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { routeCall, newRouterState } = await import("../server/router.ts");
const { createFakeAdapter } = await import("../server/fakeProvider.ts");
const { REGISTRY_SEED, registryEntrySchema } = await import("../server/modelRegistry.ts");
const { unitsFor, shadowCostUsd, createQuotaTracker, DEFAULT_TASK_UNITS, BUDGET_POLICY_VERSION } = await import("../server/budget.ts");

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
}
// ===== END p08-acceptance.test.mjs =====

// ===== BEGIN p09-acceptance.test.mjs =====
{
// P09 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P09-SPEC.md and are expected to FAIL until P09 is implemented. No database needed.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { routeCall, newRouterState } = await import("../server/router.ts");
const { REGISTRY_SEED, registryEntrySchema } = await import("../server/modelRegistry.ts");
const { providerResponseSchema } = await import("../server/adapter.ts");
const { createOpenAICompatibleAdapter } = await import("../server/openaiCompatAdapter.ts");
const { createQuotaTracker, DEFAULT_DAILY_UNITS, budgetLevel, runBudget } = await import("../server/budget.ts");
const { applyHealthEvent, hydrateRouterState, rehydrateQuota, AUTH_DISABLE_TTL_MS } = await import("../server/modelHealth.ts");

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
}
// ===== END p09-acceptance.test.mjs =====

// ===== BEGIN p10-acceptance.test.mjs =====
{
// P10 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P10-SPEC.md and are expected to FAIL until P10 is implemented. No database, no network.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const os = (await import("node:os")).default;
const path = (await import("node:path")).default;
const { execFileSync, spawnSync } = await import("node:child_process");
const { REGISTRY_SEED, registryEntrySchema } = await import("../server/modelRegistry.ts");
const { loadGoldenTasks, scoreAnalysis, scoreVerify, buildEvalPrompt, createGoldenFakeAdapter, runGoldenEval, suggestQualityClass, renderReport } = await import("../server/goldenEval.ts");

const tasks = loadGoldenTasks();
const entry = (providerId, modelId, extra = {}) => registryEntrySchema.parse({ ...REGISTRY_SEED[0], providerId, modelId, costTier: 'free', ...extra });
const models = () => [
  { entry: entry('fs', 'a', { pricing: { inputPerMTok: 1, outputPerMTok: 2 } }), adapter: createGoldenFakeAdapter('fs', 'strong', tasks) },
  { entry: entry('fw', 'b'), adapter: createGoldenFakeAdapter('fw', 'weak', tasks) },
];
const run = (m = models()) => runGoldenEval({ tasks, models: m, mode: 'fake', date: '2026-10-11' });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('task set: 18 tasks, both languages, both kinds, defects inside the artifact, clean controls', () => {
  assert.ok(tasks.length >= 15 && tasks.length <= 20);
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  for (const lang of ['ru', 'en']) assert.ok(tasks.filter((t) => t.lang === lang).length >= 6, lang);
  const analysis = tasks.filter((t) => t.kind === 'analysis'), verify = tasks.filter((t) => t.kind === 'verify');
  assert.ok(analysis.length >= 8 && verify.length >= 6);
  assert.ok(verify.filter((t) => t.defects.length > 0).length >= 5);
  assert.ok(verify.filter((t) => t.defects.length === 0).length >= 2);
  for (const t of verify) for (const d of t.defects) assert.ok(d.line >= 1 && d.line <= t.artifact.split('\n').length, `${t.id} ${d.id}`);
});

test('loadGoldenTasks rejects an invalid file', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g-')), 't.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, tasks: tasks.slice(0, 3) }));
  assert.throws(() => loadGoldenTasks(f));
});

test('scoreAnalysis: reference passes; missing mention, too few ops and invalid shape fail', () => {
  const t = tasks.find((x) => x.kind === 'analysis');
  assert.equal(scoreAnalysis(t, t.reference).pass, true);
  const noOps = scoreAnalysis(t, { summary: t.reference.summary, patch: { ops: [] } });
  assert.equal(noOps.pass, false);
  const miss = scoreAnalysis(t, { summary: 'nothing', patch: { ops: t.reference.patch.ops.map((o) => ({ ...o, item: { text: 'x', ref: 'msg:1' } })) } });
  assert.equal(miss.pass, false); assert.ok(miss.missing.length > 0);
  assert.equal(scoreAnalysis(t, 'garbage').invalid, true);
});

test('scoreVerify: exact lines pass; miss, wrong line and false alarm on a clean task are counted', () => {
  const t = tasks.find((x) => x.kind === 'verify' && x.defects.length > 0);
  const clean = tasks.find((x) => x.kind === 'verify' && x.defects.length === 0);
  const hit = t.defects.map((d) => ({ severity: d.severity, line: d.line, text: 'x' }));
  const ok = scoreVerify(t, { findings: hit });
  assert.deepEqual([ok.pass, ok.tp, ok.fn, ok.fp], [true, t.defects.length, 0, 0]);
  const none = scoreVerify(t, { findings: [] });
  assert.deepEqual([none.pass, none.tp, none.fn], [false, 0, t.defects.length]);
  const wrong = scoreVerify(t, { findings: [{ severity: 'low', line: 999, text: 'x' }] });
  assert.equal(wrong.fp, 1); assert.equal(wrong.fn, t.defects.length);
  assert.equal(scoreVerify(clean, { findings: [] }).pass, true);
  assert.equal(scoreVerify(clean, { findings: [{ severity: 'low', line: 1, text: 'x' }] }).fp, 1);
  assert.equal(scoreVerify(t, { nope: 1 }).invalid, true);
});

test('prompt: verify prompt numbers the lines and does not reveal defects', () => {
  const t = tasks.find((x) => x.kind === 'verify' && x.defects.length > 0);
  const p = buildEvalPrompt(t);
  assert.match(p, /^1: /m); assert.ok(p.includes(t.criteria[0]));
  for (const d of t.defects) assert.equal(p.includes(d.note), false);
  assert.ok(buildEvalPrompt(tasks.find((x) => x.kind === 'analysis')).includes('JSON'));
});

test('run: strong fake passes everything, weak fake does not; counts, units and cost are filled', async () => {
  const r = await run();
  assert.equal(r.mode, 'fake'); assert.equal(r.date, '2026-10-11'); assert.equal(r.tasks, tasks.length);
  const [s, w] = r.models;
  assert.equal(s.model, 'fs/a'); assert.equal(w.model, 'fw/b');
  assert.equal(s.analysis.passed, s.analysis.total); assert.equal(s.verify.passed, s.verify.total);
  assert.equal(s.verify.f1, 1); assert.equal(s.verify.fp, 0);
  assert.ok(w.analysis.passed < w.analysis.total); assert.ok(w.verify.passed < w.verify.total); assert.ok(w.verify.f1 < 1);
  assert.equal(s.tasks.length, tasks.length);
  assert.ok(s.units >= tasks.length); assert.ok(s.costUsd > 0); assert.equal(w.costUsd, null);
});

test('run is deterministic and survives an adapter error', async () => {
  assert.deepEqual(await run(), await run());
  const failing = { id: 'bad', capabilities: () => ['json_output'], async call(r) { return { status: 'error', usage: { input: 0, cached: 0, output: 0 }, latencyMs: 1, providerId: 'bad', modelId: r.modelId, retryable: false, errorClass: 'PROVIDER_AUTH' }; } };
  const r = await runGoldenEval({ tasks, models: [{ entry: entry('bad', 'm'), adapter: failing }], mode: 'fake', date: '2026-10-11' });
  const m = r.models[0];
  assert.equal(m.errors, tasks.length); assert.equal(m.analysis.passed, 0); assert.equal(m.tasks[0].errorClass, 'PROVIDER_AUTH');
});

test('quality class: thresholds 0.85 / 0.6, always provisional', async () => {
  const mk = (p, f1) => ({ analysis: { passed: p, total: 10 }, verify: { f1 } });
  assert.equal(suggestQualityClass(mk(9, 0.9)).class, 'A');
  assert.equal(suggestQualityClass(mk(7, 0.6)).class, 'B');
  assert.equal(suggestQualityClass(mk(3, 0.2)).class, 'C');
  assert.equal(suggestQualityClass(mk(10, 1)).provisional, true);
  const r = await run();
  assert.equal(suggestQualityClass(r.models[0]).class, 'A'); assert.notEqual(suggestQualityClass(r.models[1]).class, 'A');
});

test('report: required sections, every task and model, hypothesis and owner wording, cross-model line', async () => {
  const r = await run();
  const md = renderReport(r);
  assert.match(md, /^# Golden-eval report/m);
  assert.match(md, /^Mode: fake$/m); assert.match(md, /^Date: 2026-10-11$/m); assert.match(md, new RegExp(`^Tasks: ${tasks.length}$`, 'm'));
  for (const h of ['## Summary', '## Per-task results', '## Cross-model check', '## Limits']) assert.ok(md.includes(h), h);
  for (const t of tasks) assert.ok(md.includes(t.id), t.id);
  for (const m of ['fs/a', 'fw/b']) assert.ok(md.includes(m));
  assert.match(md, /provisional/); assert.match(md, /hypothesis/i); assert.match(md, /cross_model/); assert.match(md, /owner/i);
  assert.equal(md.includes('NOT_RUN(no_second_provider)'), false);
  const one = renderReport(await run([models()[0]]));
  assert.ok(one.includes('NOT_RUN(no_second_provider)'));
  assert.equal(renderReport(r), md);
});

test('CLI: --fake writes a deterministic report; without --fake it refuses with code 2', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g-')), 'r.md');
  const args = ['--import', 'tsx', path.join(root, 'scripts/golden-eval.mjs'), '--fake', '--date', '2026-10-11', '--out', out];
  execFileSync(process.execPath, args, { cwd: root });
  const a = fs.readFileSync(out, 'utf8');
  execFileSync(process.execPath, args, { cwd: root });
  assert.equal(fs.readFileSync(out, 'utf8'), a);
  assert.match(a, /^Mode: fake$/m); assert.ok(a.includes('fake-strong/model-a') && a.includes('fake-weak/model-b'));
  const live = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/golden-eval.mjs')], { cwd: root });
  assert.equal(live.status, 2);
});

test('deliverables: golden-eval script, npm scripts, check includes test:p10', () => {
  // ARCHIVE/GOLDEN-EVAL-REPORT.md is optional (off-repo history). Prove the generator works into a temp file.
  const out = path.join(root, 'tests/p10-golden-tmp.md');
  try { fs.unlinkSync(out); } catch { /* missing */ }
  const args = ['--import', 'tsx', path.join(root, 'scripts/golden-eval.mjs'), '--fake', '--date', '2026-10-16', '--out', out];
  execFileSync(process.execPath, args, { cwd: root });
  const report = fs.readFileSync(out, 'utf8');
  assert.match(report, /^Mode: fake$/m); assert.match(report, /^# Golden-eval report/m);
  try { fs.unlinkSync(out); } catch { /* ignore */ }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['eval:golden'] && pkg.scripts['test:models']);
  assert.ok(pkg.scripts.check.includes('npm run test:models'));
});
}
// ===== END p10-acceptance.test.mjs =====

// ===== BEGIN p11-acceptance.test.mjs =====
{
// P11 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P11-SPEC.md and are expected to FAIL until P11 is implemented. No database needed.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { TASK_STATES, RUN_STATES, DEFAULT_MAX_ATTEMPTS, TaskError, canRunTransition, assertTaskTransition, runEffectOnTask, taskFingerprint } = await import("../server/taskMachine.ts");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof TaskError, `TaskError expected, got ${e}`); return e.code; } return null; };
const ok = (from, to, ctx = {}) => assert.equal(code(() => assertTaskTransition(from, to, ctx)), null, `${from} -> ${to}`);
const bad = (from, to, expected, ctx = {}) => assert.equal(code(() => assertTaskTransition(from, to, ctx)), expected, `${from} -> ${to}`);
const run = { via: 'run' };
const validation = { passed: true, evidence: ['ci:1'] };

test('states and defaults', () => {
  assert.deepEqual(TASK_STATES, ['DRAFT', 'READY', 'QUEUED', 'RUNNING', 'VALIDATING', 'PASS', 'FAIL', 'BLOCKED', 'CANCELLED']);
  assert.deepEqual(RUN_STATES, ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED']);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
});

test('task: the main path and the allowed side exits', () => {
  ok('DRAFT', 'READY'); ok('READY', 'QUEUED', run); ok('QUEUED', 'RUNNING', run); ok('RUNNING', 'VALIDATING', run); ok('VALIDATING', 'PASS', { validation });
  ok('DRAFT', 'CANCELLED'); ok('READY', 'CANCELLED'); ok('READY', 'BLOCKED'); ok('QUEUED', 'FAIL', run); ok('RUNNING', 'FAIL', run);
  ok('RUNNING', 'BLOCKED', run); ok('RUNNING', 'CANCELLED', run); ok('VALIDATING', 'FAIL'); ok('VALIDATING', 'BLOCKED'); ok('VALIDATING', 'CANCELLED');
  ok('BLOCKED', 'READY'); ok('BLOCKED', 'FAIL'); ok('BLOCKED', 'CANCELLED'); ok('FAIL', 'CANCELLED'); ok('FAIL', 'READY', { attemptsUsed: 1, maxAttempts: 3 });
});

test('task: everything else is an INVALID_TRANSITION (exhaustive)', () => {
  const allowed = new Set(['DRAFT>READY', 'DRAFT>CANCELLED', 'READY>QUEUED', 'READY>BLOCKED', 'READY>CANCELLED', 'QUEUED>RUNNING', 'QUEUED>BLOCKED', 'QUEUED>CANCELLED', 'QUEUED>FAIL',
    'RUNNING>VALIDATING', 'RUNNING>FAIL', 'RUNNING>BLOCKED', 'RUNNING>CANCELLED', 'VALIDATING>PASS', 'VALIDATING>FAIL', 'VALIDATING>BLOCKED', 'VALIDATING>CANCELLED',
    'PASS>VALIDATING', 'FAIL>READY', 'FAIL>CANCELLED', 'BLOCKED>READY', 'BLOCKED>FAIL', 'BLOCKED>CANCELLED']);
  for (const a of TASK_STATES) for (const b of TASK_STATES) {
    if (allowed.has(`${a}>${b}`)) continue;
    assert.equal(code(() => assertTaskTransition(a, b, { ...run, validation, attemptsUsed: 0, maxAttempts: 3, reason: 'input_changed' })), 'INVALID_TRANSITION', `${a} -> ${b}`);
  }
});

test('task: moves into or out of QUEUED/RUNNING belong to the Run API', () => {
  bad('READY', 'QUEUED', 'RUN_API_REQUIRED'); bad('QUEUED', 'RUNNING', 'RUN_API_REQUIRED'); bad('RUNNING', 'VALIDATING', 'RUN_API_REQUIRED');
  bad('RUNNING', 'CANCELLED', 'RUN_API_REQUIRED'); bad('QUEUED', 'CANCELLED', 'RUN_API_REQUIRED');
});

test('PASS is impossible without a validation with evidence', () => {
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED');
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED', { validation: { passed: false, evidence: ['x'] } });
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED', { validation: { passed: true, evidence: [] } });
  bad('VALIDATING', 'PASS', 'VALIDATION_REQUIRED', { validation: { passed: true, evidence: [''] } });
  for (const from of TASK_STATES) if (from !== 'VALIDATING') assert.equal(code(() => assertTaskTransition(from, 'PASS', { ...run, validation })), 'INVALID_TRANSITION', from);
});

test('PASS returns to VALIDATING only when the input changed; retry is limited by attempts', () => {
  bad('PASS', 'VALIDATING', 'INVALID_TRANSITION'); ok('PASS', 'VALIDATING', { reason: 'input_changed' });
  bad('FAIL', 'READY', 'ATTEMPTS_EXHAUSTED', { attemptsUsed: 3, maxAttempts: 3 });
  bad('FAIL', 'READY', 'ATTEMPTS_EXHAUSTED', { attemptsUsed: 5, maxAttempts: 3 });
});

test('run: transitions', () => {
  assert.equal(canRunTransition('QUEUED', 'RUNNING'), true); assert.equal(canRunTransition('QUEUED', 'CANCELLED'), true);
  for (const to of ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED']) assert.equal(canRunTransition('RUNNING', to), true, to);
  assert.equal(canRunTransition('QUEUED', 'SUCCEEDED'), false); assert.equal(canRunTransition('QUEUED', 'ABANDONED'), false); assert.equal(canRunTransition('RUNNING', 'QUEUED'), false);
  for (const final of ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ABANDONED']) for (const to of RUN_STATES) assert.equal(canRunTransition(final, to), false, `${final} -> ${to}`);
});

test('run effect on the task: no run status ever leads to PASS; a lost run is BLOCKED(recovery)', () => {
  assert.deepEqual(runEffectOnTask('SUCCEEDED'), { state: 'VALIDATING' });
  assert.deepEqual(runEffectOnTask('FAILED'), { state: 'FAIL' }); assert.deepEqual(runEffectOnTask('TIMED_OUT'), { state: 'FAIL' });
  assert.deepEqual(runEffectOnTask('CANCELLED'), { state: 'CANCELLED' });
  assert.deepEqual(runEffectOnTask('ABANDONED'), { state: 'BLOCKED', blockedReason: 'recovery' });
  for (const s of RUN_STATES.filter((x) => !['QUEUED', 'RUNNING'].includes(x))) assert.notEqual(runEffectOnTask(s).state, 'PASS');
});

test('fingerprint: stable, order-insensitive for keys and artifact refs, sensitive to content', () => {
  const a = { task: 't', artifactRefs: ['artifact:a@1', 'artifact:b@2'], stateVersion: 2, profile: 'analyst', profileVersion: '1', criteria: ['c1'] };
  const f = taskFingerprint(a);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(taskFingerprint({ criteria: ['c1'], profileVersion: '1', profile: 'analyst', stateVersion: 2, artifactRefs: ['artifact:b@2', 'artifact:a@1'], task: 't' }), f);
  for (const change of [{ task: 'u' }, { artifactRefs: ['artifact:a@1'] }, { stateVersion: 3 }, { profile: 'x' }, { profileVersion: '2' }, { criteria: ['c2'] }, { criteria: ['c1', 'c2'] }]) assert.notEqual(taskFingerprint({ ...a, ...change }), f, JSON.stringify(change));
});

test('TaskError carries a code and an HTTP status', () => {
  const st = { NOT_FOUND: 404, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, INVALID_TRANSITION: 409, RUN_API_REQUIRED: 409, VALIDATION_REQUIRED: 409, ATTEMPTS_EXHAUSTED: 409, INPUT_LOCKED: 409 };
  for (const [c, s] of Object.entries(st)) { const e = new TaskError(c, 'm'); assert.equal(e.code, c); assert.equal(e.status, s); assert.ok(e instanceof Error); }
});

test('migration 005 and npm scripts', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations/005_tasks_runs.sql'), 'utf8');
  for (const t of ['tasks', 'runs', 'task_events']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
  assert.match(sql, /UNIQUE\s*\(\s*project_id\s*,\s*idempotency_key\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*task_id\s*,\s*attempt\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*task_id\s*,\s*idempotency_key\s*\)/i);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:models']); assert.ok(pkg.scripts.check.includes('npm run test:models'));
  assert.ok(pkg.scripts['test:database:live'].includes('tests/database.test.mjs'));
});
}
// ===== END p11-acceptance.test.mjs =====

// ===== BEGIN p12-acceptance.test.mjs =====
{
// P12 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P12-SPEC.md and are expected to FAIL until P12 is implemented. No database needed.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { JOB_STATES, DEFAULT_LEASE_MS, DEFAULT_HEARTBEAT_MS, DEFAULT_POLL_MS, QueueError, leaseUntil, isLeaseExpired, validateTiming, jobStatusForRun } = await import("../server/queueMachine.ts");
const { createWorker } = await import("../server/worker.ts");

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
  assert.ok(pkg.scripts['test:models']); assert.ok(pkg.scripts.check.includes('npm run test:models'));
  assert.ok(pkg.scripts['test:database:live'].includes('tests/database.test.mjs'));
});
}
// ===== END p12-acceptance.test.mjs =====

// ===== BEGIN p13-acceptance.test.mjs =====
{
// P13 acceptance (no database): budgets, Task Graph v1 validation, approvals rules. Describes ARCHIVE/P13-SPEC.md.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { BUDGET_KEYS, APPROVAL_MODES, APPROVAL_KINDS, MAX_PLAN_TASKS, DEFAULT_MAX_CONCURRENT_RUNS, PlanError, emptyUsage, checkBudget, raisesBudget, validatePlan, planFromTemplate, planUnits, budgetLimitsSchema } = await import("../server/planMachine.ts");
const { runEffectOnTask, TaskError } = await import("../server/taskMachine.ts");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const node = (key, deps = [], extra = {}) => ({ key, title: key, task: `do ${key}`, deps, ...extra });
const reason = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof PlanError, String(e)); assert.equal(e.code, 'PLAN_INVALID'); return e.details.reason; } return null; };

test('limits cover TZ 8.4 and nothing else; unknown keys are refused', () => {
  assert.deepEqual([...BUDGET_KEYS], ['max_model_calls', 'max_tokens', 'max_cost_units', 'max_wall_clock_ms', 'max_attempts', 'max_code_tasks']);
  assert.ok(budgetLimitsSchema.safeParse({ max_tokens: 10 }).success);
  assert.equal(budgetLimitsSchema.safeParse({ max_tokens: -1 }).success, false);
  assert.equal(budgetLimitsSchema.safeParse({ max_dollars: 1 }).success, false);
});

test('checkBudget: used + requested over a limit is a violation; a missing limit is no limit', () => {
  const used = { ...emptyUsage(), calls: 2, tokens: 900 };
  assert.deepEqual(checkBudget('task', { max_model_calls: 3 }, used, { calls: 1 }), []);
  const v = checkBudget('task', { max_model_calls: 2, max_tokens: null }, used, { calls: 1 });
  assert.deepEqual(v, [{ scope: 'task', limit: 'max_model_calls', max: 2, used: 2, requested: 1 }]);
  assert.deepEqual(checkBudget('run', { max_tokens: 1000 }, used, { tokens: 101 }).map((x) => x.limit), ['max_tokens']);
  assert.deepEqual(checkBudget('run', null, used, { calls: 99 }), []);
});

test('raisesBudget: higher number or a removed limit raises; lowering or first set does not', () => {
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: 11 }), true);
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: null }), true);
  assert.equal(raisesBudget({ max_tokens: 10 }, {}), true);
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: 10 }), false);
  assert.equal(raisesBudget({ max_tokens: 10 }, { max_tokens: 5 }), false);
  assert.equal(raisesBudget(null, { max_tokens: 5 }), false);
  assert.equal(raisesBudget({}, { max_tokens: 5 }), false);
});

test('plan validator: cycle, self-dependency, unknown dependency, duplicates, empty, more than 12 tasks', () => {
  assert.equal(MAX_PLAN_TASKS, 12);
  assert.equal(reason(() => validatePlan([node('a', ['b']), node('b', ['a'])])), 'cycle');
  assert.equal(reason(() => validatePlan([node('a', ['a'])])), 'cycle');
  assert.equal(reason(() => validatePlan([node('a', ['x'])])), 'unknown_dependency');
  assert.equal(reason(() => validatePlan([node('a'), node('a')])), 'duplicate_key');
  assert.equal(reason(() => validatePlan([])), 'empty');
  assert.equal(reason(() => validatePlan(Array.from({ length: 13 }, (_, i) => node(`n${i}`)))), 'too_many_tasks');
  assert.equal(validatePlan(Array.from({ length: 12 }, (_, i) => node(`n${i}`))).length, 12);
  assert.equal(reason(() => validatePlan([{ key: 'A B', title: 't', task: 'x' }])), 'schema');
  assert.equal(reason(() => validatePlan([{ ...node('a'), extra: 1 }])), 'schema');
  assert.equal(validatePlan([node('a'), node('b', ['a']), node('c', ['a', 'b'])]).length, 3);
});

test('plan validator: total units must fit the project limit', () => {
  const nodes = [node('a', [], { units: 6 }), node('b', ['a'], { units: 5 })];
  assert.equal(planUnits(validatePlan(nodes, null)), 11);
  assert.equal(planUnits(validatePlan(nodes, 11)), 11);
  assert.equal(reason(() => validatePlan(nodes, 10)), 'budget');
});

test('static template: specification -> architecture -> review -> approval', () => {
  const nodes = planFromTemplate('spec_arch_review_approval', { goal: 'Ship it' });
  assert.deepEqual(nodes.map((n) => n.key), ['specification', 'architecture', 'review', 'approval']);
  assert.deepEqual(nodes.map((n) => n.deps), [[], ['specification'], ['architecture'], ['review']]);
  assert.ok(nodes.every((n) => n.task.includes('Ship it')));
  assert.throws(() => planFromTemplate('nope', { goal: 'x' }), (e) => e.code === 'TEMPLATE_UNKNOWN');
  assert.throws(() => planFromTemplate('spec_arch_review_approval', { goal: '  ' }), (e) => e.code === 'PLAN_INVALID');
});

test('approvals: supervised and manual only, no autonomous mode and no flag for it (TZ 8.6)', () => {
  assert.deepEqual([...APPROVAL_MODES], ['supervised', 'manual']);
  assert.deepEqual([...APPROVAL_KINDS], ['plan', 'budget', 'merge_ready', 'state_decision', 'destructive', 'task_start']);
  assert.equal(DEFAULT_MAX_CONCURRENT_RUNS, 2);
  for (const f of ['migrations/007_budgets_plans_approvals.sql', 'server/planMachine.ts', 'server/planService.ts', '.env.example']) {
    assert.ok(!/autonomous/i.test(fs.readFileSync(path.join(root, f), 'utf8').replace(/--[^\n]*|\/\/[^\n]*/g, '')), `${f} must not mention autonomous`);
  }
});

test('PlanError carries a code and an HTTP status', () => {
  const st = { BUDGET_EXCEEDED: 409, PLAN_INVALID: 400, PLAN_NOT_APPROVED: 409, DEPENDENCY_NOT_READY: 409, ARTIFACT_WRITE_CONFLICT: 409, HUMAN_REQUIRED: 403, APPROVAL_NOT_FOUND: 404, APPROVAL_CLOSED: 409 };
  for (const [c, s] of Object.entries(st)) { const e = new PlanError(c, 'm'); assert.equal(e.status, s); assert.equal(e.code, c); }
});

test('a budget stop moves the Task to BLOCKED(budget); it never leads to PASS', () => {
  assert.deepEqual(runEffectOnTask('FAILED', 'budget'), { state: 'BLOCKED', blockedReason: 'budget' });
  assert.deepEqual(runEffectOnTask('TIMED_OUT', 'budget'), { state: 'BLOCKED', blockedReason: 'budget' });
  assert.throws(() => runEffectOnTask('SUCCEEDED', 'budget'), TaskError);
  assert.deepEqual(runEffectOnTask('FAILED'), { state: 'FAIL' });   // unchanged without the reason
});
}
// ===== END p13-acceptance.test.mjs =====

// ===== BEGIN p13a-acceptance.test.mjs =====
{
// P13a acceptance (no database): patch tools, preflight, report, CI summary. Describes ARCHIVE/P13a-SPEC.md.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const os = (await import("node:os")).default;
const path = (await import("node:path")).default;
const { spawnSync } = await import("node:child_process");
const JSZip = (await import("jszip")).default;
const { readTree, readZipTree, diffTrees, summaryLine, buildZip, preflight, allowlistFromToml, scanSecrets, firstFailure, ciSummary, overallStatus, renderReport } = await import("../scripts/patch-tools.mjs");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const B = (s) => Buffer.from(s);
const tree = (o) => new Map(Object.entries(o).map(([k, v]) => [k, B(v)]));
const pf = (o, deleted = []) => preflight({ files: tree(o), deleted, allowlist: allowlistFromToml(fs.readFileSync(path.join(root, '.gitleaks.toml'), 'utf8')) });
const fakeKey = 'gh' + 'p_' + 'a'.repeat(36); // built at run time: no secret literal in the repository

test('diff: changed files are replaced, new files added, missing files listed for deletion', () => {
  const d = diffTrees(tree({ 'a.md': '1', 'b.md': '2', 'c.md': '3' }), tree({ 'a.md': '1', 'b.md': '22', 'd.md': '4' }));
  assert.deepEqual(d, { replace: ['b.md'], add: ['d.md'], del: ['c.md'] });
  assert.match(summaryLine(d), /^заменить 1, добавить 1, удалить 1\n/);
  assert.match(summaryLine(d), /заменить: b\.md/);
  assert.equal(summaryLine({ replace: [], add: [], del: [] }), 'заменить 0, добавить 0, удалить 0');
});

test('zip: a GitHub wrapper folder is stripped; a flat zip is kept; the archive has no wrapper and no manifest', async () => {
  const wrapped = new JSZip(); wrapped.file('repo-main/server/a.ts', 'x'); wrapped.file('repo-main/README.md', 'y');
  assert.deepEqual([...(await readZipTree(await wrapped.generateAsync({ type: 'nodebuffer' }))).keys()].sort(), ['README.md', 'server/a.ts']);
  const flat = new JSZip(); flat.file('server/a.ts', 'x'); flat.file('README.md', 'y');
  assert.deepEqual([...(await readZipTree(await flat.generateAsync({ type: 'nodebuffer' }))).keys()].sort(), ['README.md', 'server/a.ts']);
  const built = await readZipTree(await buildZip(tree({ 'server/a.ts': 'x', 'docs/b.md': 'y' })));
  assert.deepEqual([...built.keys()].sort(), ['docs/b.md', 'server/a.ts']);
  assert.deepEqual(Object.keys((await JSZip.loadAsync(await buildZip(tree({ 'docs/b.md': 'y' })))).files), ['docs/b.md']); // no folder entries
});

test('preflight accepts a clean flat patch (including names that only look like a manifest)', () => {
  assert.deepEqual(pf({
    'README.md': 'x', 'package.json': '{}', 'server/files.ts': 'x', 'migrations/008_artifact_manifests.sql': 'x', 'public/manifest.json': '{}',
    '.github/workflows/ci.yml': 'x', 'docs/NEXT.md': 'x', 'tests/p13a-acceptance.test.mjs': 'x',
  }), []);
});

test('preflight rejects a manifest, nested folders, a wrapper or new top-level folder, unsafe paths', () => {
  for (const bad of ['manifest.json', 'MANIFEST.txt', 'file-list.txt', 'changed_files.md', 'MANIFEST']) assert.match(pf({ [bad]: 'x' })[0], /manifest or file-list/, bad);
  assert.match(pf({ 'docs/archive/old.md': 'x' })[0], /nested folder/);
  assert.match(pf({ 'src/a/b.ts': 'x' })[0], /nested folder/);
  assert.match(pf({ '.github/other/x.yml': 'x' })[0], /nested folder/);
  assert.match(pf({ 'bf-main/server/a.ts': 'x' })[0], /nested folder|top-level folder/);
  assert.match(pf({ 'tools/a.ts': 'x' })[0], /top-level folder "tools"/);
  for (const bad of ['../x.md', '/abs.md', 'docs\\a.md', 'docs//a.md']) assert.match(pf({ [bad]: 'x' })[0], /unsafe path/, bad);
});

test('preflight rejects secrets (several formats) and respects the allowlist of .gitleaks.toml', () => {
  assert.match(pf({ 'docs/a.md': `token ${fakeKey}` })[0], /github_token/);
  assert.match(pf({ 'server/a.ts': 'const k = "AIza' + 'A'.repeat(35) + '"' })[0], /google_api_key/);
  assert.match(pf({ 'server/a.ts': '-----BEGIN RSA PRIVATE ' + 'KEY-----' })[0], /private_key/);
  assert.match(pf({ 'docs/a.md': 'postgres://admin:S3cretValue@db.example.com/x' })[0], /url_password/);
  assert.match(pf({ 'server/a.ts': 'const apiKey = "' + 'a1B2'.repeat(8) + '";' })[0], /quoted_secret/);
  assert.deepEqual(pf({ 'docs/a.md': 'postgres://user:password@host/db and postgres://u:p@localhost/db and process.env.GEMINI_API_KEY' }), []);
  assert.deepEqual(pf({ 'tests/fixture.mjs': fakeKey }), []);
  assert.deepEqual(scanSecrets('plain text'), []);
});

test('preflight rejects a change or deletion of tests/acceptance/**', () => {
  assert.ok(pf({ 'tests/acceptance/a.test.mjs': 'x' }).some((x) => /protected path/.test(x)));
  assert.match(pf({}, ['tests/acceptance/a.test.mjs'])[0], /protected path/);
  assert.deepEqual(pf({}, ['docs/old.md']), []);
});

test('the real repository passes the preflight (no false positives)', () => {
  const files = readTree(root);
  assert.ok(files.size > 100);
  assert.deepEqual(preflight({ files, allowlist: allowlistFromToml(fs.readFileSync(path.join(root, '.gitleaks.toml'), 'utf8')) }), []);
});

test('first failure is found in TAP, spec and error output; nothing found gives null', () => {
  assert.equal(firstFailure('ok 1 - a\nnot ok 2 - budget blocks the call\n  ---'), 'budget blocks the call');
  assert.equal(firstFailure('✔ fine\n✖ plan is refused (12.5ms)\n'), 'plan is refused');
  assert.match(firstFailure('x\nAssertionError [ERR_ASSERTION]: 1 !== 2'), /AssertionError/);
  assert.equal(firstFailure('all good'), null);
});

test('CI summary: green is one line; red names the first failed test, or says there is no test log', () => {
  assert.deepEqual(ciSummary('success', []), { ok: true, text: 'CI: green' });
  assert.equal(ciSummary('failure', ['ok 1 - a', 'not ok 1 - live restart test']).text, 'CI: red. First failed: live restart test');
  assert.match(ciSummary('failure', []).text, /no test log/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
  fs.writeFileSync(path.join(dir, 'ci-check.log'), 'not ok 3 - something broke\n');
  const r = spawnSync('node', [path.join(root, 'scripts/ci-summary.mjs'), path.join(dir, 'ci-check.log'), path.join(dir, 'missing.log')], { env: { ...process.env, CI_STATUS: 'failure' }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^::error title=BiForge CI::CI: red\. First failed: something broke/);
});

test('the CI workflow writes the summary after every run and adds no new secret', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /if: always\(\)\n\s+run: node scripts\/ci-summary\.mjs ci-check\.log ci-live\.log ci-api\.log/);
  assert.match(ci, /CI_STATUS: \$\{\{ job\.status \}\}/);
  assert.deepEqual([...new Set([...ci.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))], ['GITHUB_TOKEN']);
});

test('report: statuses come from the commands; NOT_RUN and BLOCKED are never shown as PASS', () => {
  const cmds = [{ cmd: 'npm run check', status: 'PASS', note: 'exit 0' }, { cmd: 'live', status: 'NOT_RUN', note: 'DATABASE_URL is not set' }];
  assert.equal(overallStatus([], [cmds[0]]), 'PASS');
  assert.equal(overallStatus([], cmds), 'PARTIAL');
  assert.equal(overallStatus([], [...cmds, { cmd: 'b', status: 'BLOCKED', note: '' }]), 'PARTIAL');
  assert.equal(overallStatus([], [...cmds, { cmd: 'b', status: 'FAIL', note: '' }]), 'PARTIAL');
  assert.equal(overallStatus(['x: nested folder'], cmds), 'FAIL');
  const md = renderReport({ patch: 'P99', agent: 'tool', base: 'base.zip', diff: { replace: ['a.md'], add: [], del: ['c.md'] }, violations: [], commands: cmds, notes: '', ownerSteps: ['one', 'two', 'three'], status: 'PARTIAL' });
  assert.match(md, /\| `live` \| NOT_RUN \| DATABASE_URL is not set \|/);
  assert.match(md, /3\. three/);
  assert.match(md, /delete \(by hand\)/);
});

test('pack end to end: only changed and new files in the archive, report written, a bad patch gives no archive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  const write = (base, rel, text) => { const f = path.join(dir, base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const rel of ['a.md', 'docs/keep.md', 'docs/gone.md']) write('base', rel, `v1 ${rel}`);
  const fixturePackage = JSON.stringify({ scripts: { check: 'npm run check:docs', 'check:docs': 'node -e \"console.log(\\\'docs ok\\\')\"', 'fail-check': 'node -e \"process.exit(1)\"' } });
  write('base', 'package.json', fixturePackage); write('work', 'package.json', fixturePackage);
  for (const [rel, t] of [['a.md', 'v2'], ['docs/keep.md', 'v1 docs/keep.md'], ['server/new.ts', 'new']]) write('work', rel, t);
  const run = (extra) => spawnSync('node', [path.join(root, 'scripts/patch-pack.mjs'), '--base', path.join(dir, 'base'), '--patch', 'P99', '--agent', 'test', '--skip', 'ci,typecheck,check,check-version,live,build', ...extra],
    { cwd: path.join(dir, 'work'), env: { ...process.env, DATABASE_URL: '1' }, encoding: 'utf8' });
  const ok = run([]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /заменить 1, добавить 1, удалить 1/);
  const zip = await readZipTree(fs.readFileSync(path.join(dir, 'work/bf-P99.zip')));
  assert.deepEqual([...zip.keys()].sort(), ['a.md', 'server/new.ts']);
  const report = fs.readFileSync(path.join(dir, 'work/patch-report.md'), 'utf8');
  assert.match(report, /\| `npm run check \(expanded independent steps\)` \| NOT_RUN \| skipped by --skip check \|/);
  assert.doesNotMatch(report, /\| PASS \|/);
  // A failing quality check must still leave a verified archive and a PARTIAL report.
  fs.mkdirSync(path.join(dir, 'work/node_modules'), { recursive: true });
  const partial = run(['--steps', 'fail-check']);
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'work/bf-P99.zip')), true);
  const partialReport = fs.readFileSync(path.join(dir, 'work/patch-report.md'), 'utf8');
  assert.match(partialReport, /`PARTIAL`/);
  assert.match(partialReport, /fail-check.*FAIL/s);
  write('work', 'docs/deep/x.md', 'nested'); fs.rmSync(path.join(dir, 'work/bf-P99.zip'));
  const bad = run([]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /nested folder/);
  assert.equal(fs.existsSync(path.join(dir, 'work/bf-P99.zip')), false);
});


test('patch packer produces a verified bf-<id>.zip and reads the archive back', () => {
  const packer = fs.readFileSync(path.join(root, 'scripts/patch-pack.mjs'), 'utf8');
  assert.match(packer, /opt\('out', `bf-\$\{archiveId\}\.zip`\)/);
  assert.match(packer, /readZipTree\(archiveBuffer\)/);
  assert.match(packer, /content mismatch for/);
});
}
// ===== END p13a-acceptance.test.mjs =====

// ===== BEGIN p14-acceptance.test.mjs =====
{
// P14 acceptance (no database): artifact rules, boundaries, type by content, safe listing, manifest checksum. Describes ARCHIVE/P14-SPEC.md.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { MAX_ARTIFACT_BYTES, MAX_VERSIONS_PER_ARTIFACT, MAX_ARTIFACTS_PER_PROJECT, MAX_DIFF_LINES, PREVIEW_CHARS, ArtifactFormatError, checkFilename, sniffType, securityStatusOf, previewOf, lineDiff, listZipEntries, manifestHashOf, storageRefOf, sha256Hex } = await import("../server/artifactFormat.ts");
const { artifactInputSchema, saveArtifact } = await import("../server/artifactRepository.ts");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bytes = (...v) => new Uint8Array(v);
const fmt = (fn, code) => assert.throws(fn, (e) => e instanceof ArtifactFormatError && e.code === code, code);

test('limits are the TZ values', () => {
  assert.deepEqual([MAX_ARTIFACT_BYTES, MAX_VERSIONS_PER_ARTIFACT, MAX_ARTIFACTS_PER_PROJECT], [5 * 1024 * 1024, 200, 1000]);
});

test('file name boundaries: 255 characters pass, 256, empty, dots, separators and control characters fail', () => {
  assert.equal(checkFilename('a'.repeat(255)).length, 255);
  assert.equal(checkFilename('  report.md  '), 'report.md');
  assert.equal(checkFilename('..a'), '..a');
  assert.equal(checkFilename('отчёт №1.md'), 'отчёт №1.md');
  for (const bad of ['a'.repeat(256), '', '   ', '.', '..', 'a/b', 'a\\b', '../x', 'a\0b', 'a\nb', 'a\x7fb']) fmt(() => checkFilename(bad), 'FILENAME');
});

test('input schema: exactly one of text and data; unknown keys refused; empty content is allowed', () => {
  const base = { projectId: 'p1', filename: 'a.bin', createdBy: 'human' };
  assert.equal(artifactInputSchema.safeParse({ ...base, text: '' }).success, true);
  assert.equal(artifactInputSchema.safeParse({ ...base, data: bytes(1) }).success, true);
  assert.equal(artifactInputSchema.safeParse({ ...base }).success, false);
  assert.equal(artifactInputSchema.safeParse({ ...base, text: 'x', data: bytes(1) }).success, false);
  assert.equal(artifactInputSchema.safeParse({ ...base, text: 'x', storageRef: 'pg:1' }).success, false);
});

test('size limit: one byte over 5 MB is refused before any database access', async () => {
  await assert.rejects(() => saveArtifact({ projectId: 'p1', filename: 'big.bin', createdBy: 'human', data: new Uint8Array(MAX_ARTIFACT_BYTES + 1) }),
    (e) => e instanceof ArtifactFormatError && e.code === 'TOO_LARGE');
  await assert.rejects(() => saveArtifact({ projectId: 'p1', filename: '../x', createdBy: 'human', text: 'x' }));
});

test('type is taken from content, not from the declared mime (TZ 10.4)', () => {
  assert.deepEqual(sniffType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31), 'text/plain'), { mime: 'application/pdf', kind: 'binary' });
  assert.deepEqual(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'text/markdown'), { mime: 'image/png', kind: 'binary' });
  assert.equal(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0)).mime, 'image/jpeg');
  assert.equal(sniffType(bytes(0x50, 0x4b, 0x03, 0x04, 0)).kind, 'archive');
  for (const exe of [bytes(0x4d, 0x5a, 0x90), bytes(0x7f, 0x45, 0x4c, 0x46), bytes(0xca, 0xfe, 0xba, 0xbe), new TextEncoder().encode('#!/bin/sh\nrm -rf /')]) {
    assert.equal(sniffType(exe, 'text/plain').kind, 'executable');
  }
  assert.equal(securityStatusOf('executable'), 'flagged_executable');
  assert.equal(securityStatusOf('binary'), 'inspected');
  // a declared PDF that is plain text is text; unknown bytes are a plain binary artifact
  assert.deepEqual(sniffType(new TextEncoder().encode('hello'), 'application/pdf'), { mime: 'text/plain', kind: 'text' });
  assert.deepEqual(sniffType(new TextEncoder().encode('{"a":1}'), 'application/json'), { mime: 'application/json', kind: 'text' });
  assert.deepEqual(sniffType(new TextEncoder().encode('# t'), 'text/markdown'), { mime: 'text/markdown', kind: 'text' });
  assert.deepEqual(sniffType(bytes(0xff, 0xfe, 0xfd)), { mime: 'application/octet-stream', kind: 'binary' });
  assert.deepEqual(sniffType(bytes(0x68, 0x00, 0x69)), { mime: 'application/octet-stream', kind: 'binary' });
  assert.deepEqual(sniffType(bytes()), { mime: 'text/plain', kind: 'text' });
});

test('preview exists only for text and is capped', () => {
  assert.equal(previewOf(new TextEncoder().encode('x'.repeat(PREVIEW_CHARS + 50)), 'text').length, PREVIEW_CHARS);
  for (const kind of ['binary', 'archive', 'executable']) assert.equal(previewOf(bytes(65, 66), kind), null);
});

test('line diff: same, added, removed, empty sides, and the line cap', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb').map((d) => d.op), [' ', ' ']);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), [{ op: ' ', line: 'a' }, { op: '-', line: 'b' }, { op: ' ', line: 'c' }, { op: '+', line: 'd' }]);
  assert.deepEqual(lineDiff('', 'x'), [{ op: '+', line: 'x' }]);
  assert.deepEqual(lineDiff('x', ''), [{ op: '-', line: 'x' }]);
  assert.deepEqual(lineDiff('', ''), []);
  const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
  assert.equal(lineDiff(lines(MAX_DIFF_LINES), lines(MAX_DIFF_LINES)).length, MAX_DIFF_LINES);
  fmt(() => lineDiff(lines(MAX_DIFF_LINES + 1), 'x'), 'TOO_MANY_LINES');
});

function zip(names) {
  const enc = new TextEncoder(); const parts = []; const offsets = []; let pos = 0;
  const push = (u8) => { parts.push(u8); pos += u8.length; };
  for (const n of names) { offsets.push(pos); const h = new Uint8Array(30 + enc.encode(n).length); new DataView(h.buffer).setUint32(0, 0x04034b50, true); h.set(enc.encode(n), 30); push(h); }
  const cdStart = pos;
  names.forEach((n, i) => { const nb = enc.encode(n); const c = new Uint8Array(46 + nb.length); const dv = new DataView(c.buffer); dv.setUint32(0, 0x02014b50, true); dv.setUint16(28, nb.length, true); dv.setUint32(42, offsets[i], true); c.set(nb, 46); push(c); });
  const e = new Uint8Array(22); const dv = new DataView(e.buffer); dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, names.length, true); dv.setUint16(10, names.length, true); dv.setUint32(12, pos - cdStart, true); dv.setUint32(16, cdStart, true); push(e);
  const out = new Uint8Array(pos); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

test('archive: names are listed, never extracted; escaping names are marked unsafe; non-ZIP and broken data give no list', () => {
  const r = listZipEntries(zip(['a.txt', 'dir/b.md', '../evil.sh', '/abs', 'C:\\x', 'ok/..bak']));
  assert.deepEqual(r.entries.map((e) => [e.name, e.unsafe]), [['a.txt', false], ['dir/b.md', false], ['../evil.sh', true], ['/abs', true], ['C:\\x', true], ['ok/..bak', false]]);
  assert.equal(r.truncated, false);
  assert.equal(listZipEntries(new TextEncoder().encode('plain')), null);
  assert.deepEqual(listZipEntries(bytes(0x50, 0x4b, 0x03, 0x04, 1, 2, 3)), { entries: [], truncated: false });
});

test('manifest checksum changes with every field; storage reference is a pg reference', () => {
  const m = { artifactId: 'a', version: 1, projectId: 'p', hash: sha256Hex('x'), size: 1, storageRef: storageRefOf('r1') };
  const base = manifestHashOf(m);
  assert.equal(base, manifestHashOf({ ...m }));
  for (const change of [{ artifactId: 'b' }, { version: 2 }, { projectId: 'q' }, { hash: sha256Hex('y') }, { size: 2 }, { storageRef: 'pg:r2' }]) assert.notEqual(manifestHashOf({ ...m, ...change }), base);
  assert.equal(m.storageRef, 'pg:r1');
});

test('migration 008: adds a manifest table only, backfills older versions idempotently, same formula as the code', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations/008_artifact_manifests.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS artifact_manifests/);
  assert.match(sql, /ON CONFLICT \(artifact_id, version\) DO NOTHING/);
  assert.match(sql, /a\.artifact_id \|\| '\|' \|\| a\.version \|\| '\|' \|\| a\.project_id \|\| '\|' \|\| a\.hash \|\| '\|' \|\| a\.size \|\| '\|pg:' \|\| a\.id/);
  assert.doesNotMatch(sql, /DROP |ALTER TABLE artifacts|(?<!ON )DELETE |TRUNCATE/i);
  const names = fs.readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(names.map((n) => n.slice(0, 3)), names.map((_, i) => String(i + 1).padStart(3, '0')));
});
}
// ===== END p14-acceptance.test.mjs =====

// ===== BEGIN p15-acceptance.test.mjs =====
{
// P15 static/invariant acceptance. Live provider, PostgreSQL, and scenario 18.1 remain REAL_ONLY checks; E-01 is closed by PA-05.
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('P13b routes expose plans, approvals, queueing and explicit evidence-backed validation', () => {
  const server = read('server.ts');
  for (const route of [
    "'/api/projects/:projectId/plans'",
    "'/api/projects/:projectId/approvals'",
    "'/api/projects/:projectId/budgets/:scope/:scopeId'",
    "'/api/projects/:projectId/approvals/:approvalId/decision'",
    "'/api/projects/:projectId/tasks/:taskId/queue'",
    "'/api/projects/:projectId/tasks/:taskId/validate'",
  ]) assert.ok(server.includes(route), `missing route ${route}`);
  assert.match(server, /actorKind:\s*'human'/);
  assert.match(server, /evidence: z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)/);
});

test('worker starts only in authenticated, configured Project Mode and writes run-linked evidence', () => {
  const server = read('server.ts');
  assert.match(server, /PROJECT_MODE_ENABLED && process\.env\.DATABASE_URL && ai/);
  assert.match(server, /projectWorker = createWorker\(/);
  assert.match(server, /await projectWorker\.start\(\)/);
  assert.match(server, /taskId: task\.id, runId: run\.id/);
  assert.match(server, /artifact:\$\{result\.artifact\.artifactId\}@\$\{result\.artifact\.version\}/);
});

test('each worker model call is budget-guarded before provider execution and ledger uses the DB Run id', () => {
  const analysis = read('server/analysisService.ts');
  assert.match(analysis, /if \(input\.taskId\) await guardModelCall\(/);
  assert.match(analysis, /runId, request: \{ tokens:/);
  assert.match(analysis, /await writeLedgerEntry\(ledgerEntryFromResponse\(resp, \{ runId/);
  assert.match(analysis, /input\.artifactFilename \?\? 'analysis\.md'/);
});

test('plan approval creates READY tasks; queue requires approved plan and dependency PASS', () => {
  const plans = read('server/planService.ts');
  assert.match(plans, /status='APPROVED'/);
  assert.match(plans, /to: 'READY'/);
  assert.match(plans, /plan\.status !== 'APPROVED'/);
  assert.match(plans, /state !== 'PASS'/);
  assert.match(plans, /kind: 'budget'/);
});

test('Task PASS is impossible without explicit successful validation evidence', () => {
  const machine = read('server/taskMachine.ts');
  assert.match(machine, /if \(!v \|\| v\.passed !== true \|\| !Array\.isArray\(v\.evidence\) \|\| v\.evidence\.length < 1/);
  const server = read('server.ts');
  assert.match(server, /to: input\.passed \? 'PASS' : 'FAIL'/);
});

}
// ===== END p15-acceptance.test.mjs =====

// ===== BEGIN p15a-acceptance.test.mjs =====
{
/**
 * P15a acceptance — pure monitoring logic (Appendix G.8 criteria where testable offline).
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { spawn } = await import("node:child_process");
const { detectModelDrift, detectStaleVerification, detectQuotaPressure, detectN1Violation, evaluateMonitoring, dedupeAlerts, buildSnapshotRow } = await import("../server/providerMonitor.ts");

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
}
// ===== END p15a-acceptance.test.mjs =====
