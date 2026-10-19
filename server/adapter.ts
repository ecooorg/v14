import { z } from 'zod';

/** Provider error classes (TZ 7.2, 7.4). Distinct from task errors (TASK_FAILED). */
export const PROVIDER_ERROR_CLASSES = [
  'PROVIDER_TRANSIENT', 'PROVIDER_QUOTA', 'PROVIDER_AUTH', 'INVALID_REQUEST', 'INVALID_OUTPUT', 'POLICY_REJECTED',
] as const;
export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

export type FallbackAction = 'retry_same_then_next' | 'cooldown_next' | 'disable_provider' | 'fail' | 'retry_hint_then_next' | 'escalate_human';
/** Fallback matrix (TZ 7.4) as data; consumed by Router in a later patch. */
export const FALLBACK_MATRIX: Record<ProviderErrorClass, { action: FallbackAction; retries: number; retryable: boolean }> = {
  PROVIDER_TRANSIENT: { action: 'retry_same_then_next', retries: 1, retryable: true },
  PROVIDER_QUOTA: { action: 'cooldown_next', retries: 0, retryable: false },
  PROVIDER_AUTH: { action: 'disable_provider', retries: 0, retryable: false },
  INVALID_REQUEST: { action: 'fail', retries: 0, retryable: false },
  INVALID_OUTPUT: { action: 'retry_hint_then_next', retries: 1, retryable: true },
  POLICY_REJECTED: { action: 'escalate_human', retries: 0, retryable: false },
};

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(readonly errorClass: ProviderErrorClass, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderError';
    this.retryable = FALLBACK_MATRIX[errorClass].retryable;
  }
}

/** Generic classification by HTTP status; quota exhaustion must be flagged by the caller. */
export function classifyHttpStatus(status: number, opts: { quotaExhausted?: boolean; blocked?: boolean } = {}): ProviderErrorClass {
  if (opts.blocked) return 'POLICY_REJECTED';
  if (status === 429) return opts.quotaExhausted ? 'PROVIDER_QUOTA' : 'PROVIDER_TRANSIENT';
  if (status === 401 || status === 403) return 'PROVIDER_AUTH';
  if (status === 408 || status >= 500) return 'PROVIDER_TRANSIENT';
  return 'INVALID_REQUEST';
}

export const CAPABILITIES = ['json_output', 'long_context', 'vision', 'tool_use', 'code_patch', 'cached_tokens'] as const;
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const providerRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(200),
  system: z.string().optional(),
  prompt: z.string(),
  json: z.boolean().default(false),
  maxOutputTokens: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type ProviderRequest = z.infer<typeof providerRequestSchema>;

export interface CallOptions { timeoutMs?: number; signal?: AbortSignal }

/** Normalized provider response (TZ 7.2). */
export const providerResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  output: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  usage: z.object({
    input: z.number().int().min(0), cached: z.number().int().min(0), output: z.number().int().min(0),
  }).strict(),
  latencyMs: z.number().min(0),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  finishReason: z.string().optional(),
  retryable: z.boolean(),
  errorClass: z.enum(PROVIDER_ERROR_CLASSES).optional(),
  rawRef: z.string().optional(),
  retryAfterMs: z.number().int().min(0).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.status === 'ok' && v.errorClass) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ok response must not carry errorClass' });
  if (v.status === 'ok' && v.output === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ok response requires output' });
  if (v.status === 'error' && !v.errorClass) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'error response requires errorClass' });
});
export type ProviderResponse = z.infer<typeof providerResponseSchema>;

export interface ProviderAdapter {
  id: string;
  capabilities(): Capability[];
  call(req: ProviderRequest, opts: CallOptions): Promise<ProviderResponse>;
}

/** Builds an error response from a ProviderError. */
export function errorResponse(e: ProviderError, ctx: { providerId: string; modelId: string; latencyMs: number; retryAfterMs?: number }): ProviderResponse {
  return providerResponseSchema.parse({
    status: 'error', usage: { input: 0, cached: 0, output: 0 }, latencyMs: ctx.latencyMs,
    providerId: ctx.providerId, modelId: ctx.modelId, retryable: e.retryable, errorClass: e.errorClass,
    ...(ctx.retryAfterMs !== undefined ? { retryAfterMs: ctx.retryAfterMs } : {}),
  });
}
