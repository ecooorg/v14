import { providerResponseSchema, errorResponse, ProviderError, type ProviderAdapter, type ProviderErrorClass, type ProviderRequest, type ProviderResponse } from './adapter.js';

/** Scenarios of the conformance set (TZ 7.2) and the error class each one must produce. */
export const FAKE_SCENARIOS = {
  success: null,
  rate_limit: 'PROVIDER_TRANSIENT',
  server_error: 'PROVIDER_TRANSIENT',
  timeout: 'PROVIDER_TRANSIENT',
  bad_json: 'INVALID_OUTPUT',
  truncated: 'INVALID_OUTPUT',
  auth: 'PROVIDER_AUTH',
  empty: 'PROVIDER_TRANSIENT',
  quota: 'PROVIDER_QUOTA',
  policy: 'POLICY_REJECTED',
  invalid_request: 'INVALID_REQUEST',
} as const satisfies Record<string, ProviderErrorClass | null>;
export type FakeScenario = keyof typeof FAKE_SCENARIOS;

/** Fake provider: each call consumes the next scenario of the script (the last one repeats). No network, no keys. */
export function createFakeAdapter(providerId: string, script: FakeScenario[] = ['success'], output: unknown = { ok: true }): ProviderAdapter & { calls: ProviderRequest[] } {
  let i = 0;
  const calls: ProviderRequest[] = [];
  return {
    id: providerId,
    calls,
    capabilities: () => ['json_output'],
    async call(req): Promise<ProviderResponse> {
      calls.push(req);
      const scenario = script[Math.min(i++, script.length - 1)];
      const cls = FAKE_SCENARIOS[scenario];
      if (cls) return errorResponse(new ProviderError(cls, `fake:${scenario}`), { providerId, modelId: req.modelId, latencyMs: 1 });
      return providerResponseSchema.parse({
        status: 'ok', output, latencyMs: 1, providerId, modelId: req.modelId, retryable: false,
        usage: { input: 10, cached: 0, output: 5 }, finishReason: 'STOP',
      });
    },
  };
}
