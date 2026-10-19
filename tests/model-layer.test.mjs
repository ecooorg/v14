import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ProviderError, classifyHttpStatus, FALLBACK_MATRIX, PROVIDER_ERROR_CLASSES,
  providerResponseSchema, errorResponse,
} from '../server/adapter.ts';
import { REGISTRY_SEED, validateRegistry, supports, staleEntries, registryEntrySchema } from '../server/modelRegistry.ts';

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
