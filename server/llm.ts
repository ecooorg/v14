/**
 * Gemini proxy.
 *
 * Model selection policy:
 *  - On the first successful request for a given API key, try the connection
 *    cascade in order and pin the first working model.
 *  - After that, use ONLY the pinned model. Do not silently switch models
 *    during a conversation.
 *
 * This keeps connection resilience without making the model used for the
 * conversation unpredictable.
 */
import { GoogleGenAI } from '@google/genai';

export type LlmResult = {
  text: string;
  model: string;
  fallback: boolean;
  durationMs: number;
};

// Connection/discovery order only. The first model that successfully answers
// is pinned for subsequent requests using the same API key.
const DEFAULT_CASCADE = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
].join(',');

const MAX_MODELS = Number(process.env.MAX_MODELS_PER_REQUEST) || 4;
const PER_CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS) || 25_000;
const TOTAL_DEADLINE_MS = Number(process.env.LLM_TOTAL_DEADLINE_MS) || 70_000;
const COOLDOWN_503_MS = 45_000;
const COOLDOWN_BAD_MODEL_MS = 10 * 60_000;

const cooldownUntil = new Map<string, number>();

// First successful model is pinned for the lifetime of this server process.
// The key is the effective Gemini API key (server key or user's BYOK key).
const pinnedModel = new Map<string, string>();

function modelsFor(kind: 'light' | 'strong'): string[] {
  const env =
    kind === 'light'
      ? process.env.MODEL_CASCADE_LIGHT || DEFAULT_CASCADE
      : process.env.MODEL_CASCADE_STRONG || DEFAULT_CASCADE;

  return [...new Set(
    env.split(',').map((s) => s.trim()).filter(Boolean),
  )].slice(0, MAX_MODELS);
}

function isTransient(msg: string): boolean {
  return /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand|DEADLINE_EXCEEDED|INTERNAL|timed? ?out|abort|fetch failed|ECONNRESET|ETIMEDOUT|Empty model response/i.test(msg);
}

function isBadModel(msg: string): boolean {
  return /\b(404|403)\b|NOT_FOUND|PERMISSION_DENIED|is not found|not supported|no longer available/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(
  ai: GoogleGenAI,
  model: string,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await ai.models.generateContent({
      model,
      contents: user,
      config: {
        // Do not send temperature here. Gemini 3.x has stricter generation
        // configuration requirements than the older 2.x setup.
        systemInstruction: system,
        abortSignal: ctrl.signal,
      },
    });

    const text = (r.text || '').trim();
    if (!text) throw new Error('Empty model response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateContent(opts: {
  system: string;
  user: string;
  kind?: 'light' | 'strong';
  byokKey?: string;
}): Promise<LlmResult> {
  const key = opts.byokKey || process.env.GEMINI_API_KEY;

  if (!key) {
    const err = new Error('No Gemini API key configured') as Error & { code?: string };
    err.code = 'NO_API_KEY';
    throw err;
  }

  const ai = new GoogleGenAI({ apiKey: key });
  const kind = opts.kind || 'strong';
  const models = modelsFor(kind);
  const t0 = Date.now();

  // Once a model has been verified, never switch models silently.
  const pinned = pinnedModel.get(key);
  if (pinned) {
    try {
      const text = await callModel(
        ai,
        pinned,
        opts.system,
        opts.user,
        Math.min(PER_CALL_TIMEOUT_MS, TOTAL_DEADLINE_MS),
      );
      cooldownUntil.delete(pinned);
      return {
        text,
        model: pinned,
        fallback: false,
        durationMs: Date.now() - t0,
      };
    } catch (e: unknown) {
      const lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message || '';

      // The pinned model is deliberately NOT replaced here. A later request
      // can retry the same model; changing models mid-session would change
      // the behaviour of the conversation.
      if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
        const err = new Error('Provider quota exceeded') as Error & { code?: string };
        err.code = 'PROVIDER_QUOTA';
        throw err;
      }

      if (isTransient(msg)) {
        cooldownUntil.set(pinned, Date.now() + COOLDOWN_503_MS);
      }

      throw lastErr;
    }
  }

  // No model has been verified for this key yet: use the cascade ONLY here.
  let lastErr: Error | null = null;
  let sawTransient = false;

  for (const model of models) {
    const elapsed = Date.now() - t0;
    if (elapsed >= TOTAL_DEADLINE_MS) break;

    const cooldown = cooldownUntil.get(model) || 0;
    if (cooldown > Date.now()) continue;

    try {
      const text = await callModel(
        ai,
        model,
        opts.system,
        opts.user,
        Math.min(PER_CALL_TIMEOUT_MS, TOTAL_DEADLINE_MS - elapsed),
      );

      pinnedModel.set(key, model);
      cooldownUntil.delete(model);

      return {
        text,
        model,
        fallback: model !== models[0],
        durationMs: Date.now() - t0,
      };
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message || '';

      if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
        const err = new Error('Provider quota exceeded') as Error & { code?: string };
        err.code = 'PROVIDER_QUOTA';
        throw err;
      }

      if (isBadModel(msg)) {
        cooldownUntil.set(model, Date.now() + COOLDOWN_BAD_MODEL_MS);
      } else if (isTransient(msg)) {
        sawTransient = true;
        cooldownUntil.set(model, Date.now() + COOLDOWN_503_MS);
      }
    }
  }

  if (sawTransient) {
    const err = new Error(lastErr?.message || 'All models unavailable') as Error & { code?: string };
    err.code = 'PROVIDER_OVERLOADED';
    throw err;
  }

  throw lastErr || new Error('Model call failed');
}
