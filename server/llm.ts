/**
 * Gemini proxy (INF-5, INF-6, INF-8). Key on server or BYOK header.
 * Never log prompts or responses.
 *
 * Resilience strategy against 503 "high demand":
 *  1. Walk a cascade of DIFFERENT models (each has its own capacity pool).
 *  2. A model that returned 503/timeout goes on a short cooldown, so the
 *     next requests skip it instead of waiting for it to fail again.
 *  3. If the whole chain failed, pause briefly and do one more round.
 *  4. Hard total deadline, so the user is never left waiting forever.
 */
import { GoogleGenAI } from '@google/genai';

export type LlmResult = {
  text: string;
  model: string;
  fallback: boolean;
  durationMs: number;
};

// Order matters: best/most capable first, then other generations/sizes.
// Verified against Google's model list + deprecations page (Oct 2026).
// gemini-2.0-* is shut down; gemini-2.5-* is restricted for new keys → not used.
const DEFAULT_CASCADE = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
].join(',');

const MAX_MODELS = Number(process.env.MAX_MODELS_PER_REQUEST) || 7;
const ROUNDS = 2;                                   // passes over the whole chain
const ROUND_PAUSE_MS = 1500;
const PER_CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS) || 25_000;
const TOTAL_DEADLINE_MS = Number(process.env.LLM_TOTAL_DEADLINE_MS) || 70_000;
const COOLDOWN_503_MS = 45_000;                     // overloaded model: skip for a while
const COOLDOWN_BAD_MODEL_MS = 10 * 60_000;          // 404 / no access: skip for long

const cooldownUntil = new Map<string, number>();

function modelsFor(kind: 'light' | 'strong'): string[] {
  const env =
    kind === 'light'
      ? process.env.MODEL_CASCADE_LIGHT || DEFAULT_CASCADE
      : process.env.MODEL_CASCADE_STRONG || DEFAULT_CASCADE;
  const list = env.split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)].slice(0, MAX_MODELS);
}

// Temporary provider overload / server errors: try another model
function isTransient(msg: string): boolean {
  return /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand|DEADLINE_EXCEEDED|INTERNAL|timed? ?out|abort|fetch failed|ECONNRESET|ETIMEDOUT|Empty model response/i.test(msg);
}

// Model doesn't exist / no access for this key: skip it for a long time
function isBadModel(msg: string): boolean {
  return /\b(404|403)\b|NOT_FOUND|PERMISSION_DENIED|is not found|not supported|no longer available/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const models = modelsFor(opts.kind || 'strong');
  const t0 = Date.now();
  let lastErr: Error | null = null;
  let sawTransient = false;

  for (let round = 0; round < ROUNDS; round++) {
    // In round 2 ignore cooldowns: everything may have recovered, or all are cooling down
    const now = Date.now();
    const candidates = round === 0
      ? models.filter((m) => (cooldownUntil.get(m) || 0) <= now)
      : models.filter((m) => (cooldownUntil.get(m) || 0) - now < COOLDOWN_BAD_MODEL_MS / 2);
    const chain = candidates.length ? candidates : models;

    for (let i = 0; i < chain.length; i++) {
      const elapsed = Date.now() - t0;
      if (elapsed > TOTAL_DEADLINE_MS) break;
      const model = chain[i];
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        Math.min(PER_CALL_TIMEOUT_MS, TOTAL_DEADLINE_MS - elapsed),
      );
      try {
        const r = await ai.models.generateContent({
          model,
          contents: opts.user,
          config: {
            systemInstruction: opts.system,
            temperature: 0.4,
            abortSignal: ctrl.signal,
          },
        });
        const text = (r.text || '').trim();
        if (!text) throw new Error('Empty model response');
        cooldownUntil.delete(model);
        return { text, model, fallback: model !== models[0], durationMs: Date.now() - t0 };
      } catch (e: unknown) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const msg = lastErr.message || '';
        // Provider daily quota → do not cascade models (INF-5)
        if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
          const err = new Error('Provider quota exceeded') as Error & { code?: string };
          err.code = 'PROVIDER_QUOTA';
          throw err;
        }
        if (isBadModel(msg)) {
          cooldownUntil.set(model, Date.now() + COOLDOWN_BAD_MODEL_MS);
          console.warn(JSON.stringify({ type: 'llm_skip', model, reason: 'unavailable_for_key' }));
        } else if (isTransient(msg)) {
          sawTransient = true;
          cooldownUntil.set(model, Date.now() + COOLDOWN_503_MS);
          console.warn(JSON.stringify({ type: 'llm_retry', model, round, reason: msg.slice(0, 120) }));
        } else {
          // Unknown error (e.g. safety block, bad request): still try next model
          console.warn(JSON.stringify({ type: 'llm_error', model, reason: msg.slice(0, 120) }));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (Date.now() - t0 > TOTAL_DEADLINE_MS) break;
    if (round < ROUNDS - 1) await sleep(ROUND_PAUSE_MS);
  }

  if (sawTransient) {
    const err = new Error(lastErr?.message || 'All models overloaded') as Error & { code?: string };
    err.code = 'PROVIDER_OVERLOADED';
    throw err;
  }
  throw lastErr || new Error('Model call failed');
}
