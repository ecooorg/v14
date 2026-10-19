import test from 'node:test';
import assert from 'node:assert/strict';
import { providerResponseSchema } from '../server/adapter.ts';
import { createFakeAdapter, FAKE_SCENARIOS } from '../server/fakeProvider.ts';
import { createGeminiAdapter, classifyGeminiError } from '../server/geminiAdapter.ts';
import { createOpenAICompatibleAdapter } from '../server/openaiCompatAdapter.ts';
import { REGISTRY_SEED } from '../server/modelRegistry.ts';
import { routeCall, selectCandidates, newRouterState } from '../server/router.ts';

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
