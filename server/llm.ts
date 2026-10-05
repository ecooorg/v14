/**
 * Gemini transport for v15.
 *
 * The model cascade is discovery-only: it is used until one model successfully
 * answers for an API key. That model is then pinned for subsequent calls.
 * This preserves v15's resilience while keeping the conversation deterministic.
 */
import { GoogleGenAI } from '@google/genai';

export type LlmResult = { text: string; model: string; fallback: boolean; durationMs: number };

const DEFAULT_CASCADE = ['gemini-3.6-flash','gemini-3.5-flash','gemini-3.7-flash','gemini-3.8-flash'].join(',');
const MAX_MODELS = Number(process.env.MAX_MODELS_PER_REQUEST) || 4;
const PER_CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS) || 25_000;
const TOTAL_DEADLINE_MS = Number(process.env.LLM_TOTAL_DEADLINE_MS) || 70_000;
const COOLDOWN_503_MS = 45_000;
const COOLDOWN_BAD_MODEL_MS = 10 * 60_000;
const cooldownUntil = new Map<string, number>();
const pinnedModel = new Map<string, string>();

function modelsFor(kind: 'light'|'strong'): string[] {
  const raw = kind === 'light' ? process.env.MODEL_CASCADE_LIGHT || DEFAULT_CASCADE : process.env.MODEL_CASCADE_STRONG || DEFAULT_CASCADE;
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, MAX_MODELS);
}
function isTransient(msg: string): boolean { return /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand|DEADLINE_EXCEEDED|INTERNAL|timed? ?out|abort|fetch failed|ECONNRESET|ETIMEDOUT|Empty model response/i.test(msg); }
function isBadModel(msg: string): boolean { return /\b(404|403)\b|NOT_FOUND|PERMISSION_DENIED|is not found|not supported|no longer available/i.test(msg); }

async function call(ai: GoogleGenAI, model: string, system: string, user: string, timeoutMs: number, json: boolean): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await ai.models.generateContent({ model, contents: user, config: {
      systemInstruction: system,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      abortSignal: ctrl.signal,
    }});
    const text = (r.text || '').trim();
    if (!text) throw new Error('Empty model response');
    return text;
  } finally { clearTimeout(timer); }
}

export async function generateContent(opts: { system: string; user: string; kind?: 'light'|'strong'; byokKey?: string; json?: boolean }): Promise<LlmResult> {
  const key = opts.byokKey || process.env.GEMINI_API_KEY;
  if (!key) { const e = new Error('No Gemini API key configured') as Error & { code?: string }; e.code = 'NO_API_KEY'; throw e; }
  const ai = new GoogleGenAI({ apiKey: key });
  const models = modelsFor(opts.kind || 'strong');
  const t0 = Date.now();
  const pinned = pinnedModel.get(key);

  if (pinned) {
    const text = await call(ai, pinned, opts.system, opts.user, Math.min(PER_CALL_TIMEOUT_MS, TOTAL_DEADLINE_MS), Boolean(opts.json));
    cooldownUntil.delete(pinned);
    return { text, model: pinned, fallback: pinned !== models[0], durationMs: Date.now() - t0 };
  }

  let lastErr: Error | null = null;
  let sawTransient = false;
  for (const model of models) {
    const elapsed = Date.now() - t0;
    if (elapsed >= TOTAL_DEADLINE_MS) break;
    if ((cooldownUntil.get(model) || 0) > Date.now()) continue;
    try {
      const text = await call(ai, model, opts.system, opts.user, Math.min(PER_CALL_TIMEOUT_MS, TOTAL_DEADLINE_MS - elapsed), Boolean(opts.json));
      pinnedModel.set(key, model);
      cooldownUntil.delete(model);
      return { text, model, fallback: model !== models[0], durationMs: Date.now() - t0 };
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message || '';
      if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) { const q = new Error('Provider quota exceeded') as Error & { code?: string }; q.code = 'PROVIDER_QUOTA'; throw q; }
      if (isBadModel(msg)) cooldownUntil.set(model, Date.now() + COOLDOWN_BAD_MODEL_MS);
      else if (isTransient(msg)) { sawTransient = true; cooldownUntil.set(model, Date.now() + COOLDOWN_503_MS); }
    }
  }
  if (sawTransient) { const e = new Error(lastErr?.message || 'All models overloaded') as Error & { code?: string }; e.code = 'PROVIDER_OVERLOADED'; throw e; }
  throw lastErr || new Error('Model call failed');
}
