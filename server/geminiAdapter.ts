import { providerResponseSchema, errorResponse, ProviderError, type ProviderAdapter, type ProviderErrorClass, type ProviderRequest, type ProviderResponse, type CallOptions } from './adapter.js';

/** Minimal client shape (matches `GoogleGenAI`); injectable so tests need no network. */
export interface GeminiClientLike { models: { generateContent(args: any): Promise<any> } }

/** Same rules as the classifiers in server.ts (`isGeminiQuotaError`, rate-limit, transient), mapped to TZ 7.2 classes. */
export function classifyGeminiError(e: any, aborted = false): ProviderErrorClass {
  const text = String(e?.message || e || '').toLowerCase();
  const status = Number(e?.status || e?.statusCode || e?.response?.status || 0);
  if (/daily quota|per day|daily limit|quota exceeded/.test(text)) return 'PROVIDER_QUOTA';
  if (aborted || /abort|timed? ?out|deadline_exceeded/.test(text)) return 'PROVIDER_TRANSIENT';
  if (status === 401 || status === 403 || /api key|permission_denied|unauthenticated/.test(text)) return 'PROVIDER_AUTH';
  if (status === 429 || /resource_exhausted|rate limit|too many requests/.test(text)) return 'PROVIDER_TRANSIENT';
  if ([500, 502, 503, 504].includes(status) || /unavailable|overloaded|high demand|internal|fetch failed|econnreset|etimedout/.test(text)) return 'PROVIDER_TRANSIENT';
  return 'INVALID_REQUEST';
}

const num = (v: unknown) => (Number.isFinite(v) ? Number(v) : 0);

export function createGeminiAdapter(client: GeminiClientLike, providerId = 'gemini'): ProviderAdapter {
  return {
    id: providerId,
    capabilities: () => ['json_output', 'cached_tokens'],
    async call(req: ProviderRequest, opts: CallOptions): Promise<ProviderResponse> {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : undefined;
      opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      const fail = (cls: ProviderErrorClass, msg: string) =>
        errorResponse(new ProviderError(cls, msg), { providerId, modelId: req.modelId, latencyMs: Date.now() - t0 });
      try {
        const r = await client.models.generateContent({
          model: req.modelId,
          contents: req.prompt,
          config: {
            ...(req.system ? { systemInstruction: req.system } : {}),
            ...(req.json ? { responseMimeType: 'application/json' } : {}),
            ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
            abortSignal: ctrl.signal,
          },
        });
        const latencyMs = Date.now() - t0;
        if (r?.promptFeedback?.blockReason) return fail('POLICY_REJECTED', 'Blocked by provider');
        const text: string = r?.text ?? '';
        if (!text) return fail('PROVIDER_TRANSIENT', 'Empty AI response');   // parity: server.ts treats it as transient
        const finishReason: string | undefined = r?.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') return fail('POLICY_REJECTED', 'Blocked by provider');
        let output: unknown = text;
        if (req.json) {
          if (finishReason === 'MAX_TOKENS') return fail('INVALID_OUTPUT', 'Response truncated');
          try { output = JSON.parse(text); } catch { return fail('INVALID_OUTPUT', 'Invalid JSON'); }
          if (output === null || typeof output !== 'object') return fail('INVALID_OUTPUT', 'JSON is not an object or array');
        }
        const um = r?.usageMetadata;
        return providerResponseSchema.parse({
          status: 'ok', output, latencyMs, providerId, modelId: req.modelId, retryable: false,
          usage: { input: num(um?.promptTokenCount), cached: num(um?.cachedContentTokenCount), output: num(um?.candidatesTokenCount) },
          ...(finishReason ? { finishReason } : {}),
        });
      } catch (e) {
        return fail(classifyGeminiError(e, ctrl.signal.aborted), String((e as any)?.message || e).slice(0, 300));
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
