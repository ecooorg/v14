import { providerResponseSchema, errorResponse, ProviderError, type ProviderAdapter, type ProviderErrorClass, type ProviderRequest, type ProviderResponse, type CallOptions } from './adapter.js';

export interface OpenAICompatConfig {
  providerId: string;
  baseUrl: string;                 // e.g. https://api.groq.com/openai/v1 (no trailing slash needed)
  apiKey: string;
  fetchImpl?: typeof fetch;        // injectable: tests need no network
  jsonMode?: boolean;              // send response_format=json_object when req.json (default true)
}

/** HTTP status + provider message -> TZ 7.2 class. Daily/quota exhaustion is PROVIDER_QUOTA; per-minute limits are transient. */
export function classifyOpenAICompatError(status: number, message: string, aborted = false): ProviderErrorClass {
  const text = message.toLowerCase();
  if (aborted || /abort|timed? ?out|fetch failed|econnreset|etimedout|network/.test(text) && !status) return 'PROVIDER_TRANSIENT';
  if (status === 429) return /per day|\(tpd\)|\(rpd\)|insufficient_quota|exceeded your current quota|billing|quota/.test(text) ? 'PROVIDER_QUOTA' : 'PROVIDER_TRANSIENT';
  if (status === 401 || status === 403) return 'PROVIDER_AUTH';
  if (status === 408 || status >= 500) return 'PROVIDER_TRANSIENT';
  return 'INVALID_REQUEST';
}

const num = (v: unknown) => (Number.isFinite(v) ? Number(v) : 0);

export function createOpenAICompatibleAdapter(cfg: OpenAICompatConfig): ProviderAdapter {
  const providerId = cfg.providerId;
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    id: providerId,
    capabilities: () => (cfg.jsonMode === false ? [] : ['json_output']),
    async call(req: ProviderRequest, opts: CallOptions): Promise<ProviderResponse> {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : undefined;
      opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      const fail = (cls: ProviderErrorClass, msg: string, retryAfterMs?: number) =>
        errorResponse(new ProviderError(cls, msg), { providerId, modelId: req.modelId, latencyMs: Date.now() - t0, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      try {
        const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }];
        const res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: req.modelId, messages,
            ...(req.json && cfg.jsonMode !== false ? { response_format: { type: 'json_object' } } : {}),
            ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
          }),
          signal: ctrl.signal,
        });
        let body: any = null;
        try { body = await res.json(); } catch { /* not JSON */ }
        if (!res.ok) {
          const msg = String(body?.error?.message || body?.error?.code || `HTTP ${res.status}`);
          const ra = res.status === 429 ? Number(res.headers.get('retry-after')) : NaN;   // seconds -> ms
          return fail(classifyOpenAICompatError(res.status, msg), msg.slice(0, 300), res.headers.get('retry-after') !== null && Number.isFinite(ra) && ra >= 0 ? Math.round(ra * 1000) : undefined);
        }
        const choice = body?.choices?.[0];
        const finishReason: string | undefined = choice?.finish_reason ?? undefined;
        if (finishReason === 'content_filter') return fail('POLICY_REJECTED', 'Blocked by provider');
        const text: string = typeof choice?.message?.content === 'string' ? choice.message.content : '';
        if (!text) return fail('PROVIDER_TRANSIENT', 'Empty AI response');
        let output: unknown = text;
        if (req.json) {
          if (finishReason === 'length') return fail('INVALID_OUTPUT', 'Response truncated');
          try { output = JSON.parse(text); } catch { return fail('INVALID_OUTPUT', 'Invalid JSON'); }
          if (output === null || typeof output !== 'object') return fail('INVALID_OUTPUT', 'JSON is not an object or array');
        }
        const u = body?.usage;
        return providerResponseSchema.parse({
          status: 'ok', output, latencyMs: Date.now() - t0, providerId, modelId: req.modelId, retryable: false,
          usage: { input: num(u?.prompt_tokens), cached: num(u?.prompt_tokens_details?.cached_tokens), output: num(u?.completion_tokens) },
          ...(finishReason ? { finishReason } : {}),
        });
      } catch (e) {
        return fail(classifyOpenAICompatError(0, String((e as any)?.message || e), ctrl.signal.aborted), String((e as any)?.message || e).slice(0, 300));
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
