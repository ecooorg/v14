/**
 * Gemini proxy (INF-5, INF-6, INF-8). Key on server or BYOK header.
 * Never log prompts or responses.
 */
import { GoogleGenAI } from '@google/genai';

export type LlmResult = {
  text: string;
  model: string;
  fallback: boolean;
  durationMs: number;
};

function modelsFor(kind: 'light' | 'strong'): string[] {
  const env =
    kind === 'light'
      ? process.env.MODEL_CASCADE_LIGHT || 'gemini-3.5-flash'
      : process.env.MODEL_CASCADE_STRONG || 'gemini-3.5-flash';
  return env.split(',').map((s) => s.trim()).filter(Boolean);
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
  const models = modelsFor(opts.kind || 'strong');
  const t0 = Date.now();
  let lastErr: Error | null = null;

  // At most one fallback attempt (INF-8)
  for (let i = 0; i < Math.min(models.length, 2); i++) {
    const model = models[i];
    try {
      const r = await ai.models.generateContent({
        model,
        contents: opts.user,
        config: {
          systemInstruction: opts.system,
          temperature: 0.4,
        },
      });
      const text = (r.text || '').trim();
      if (!text) throw new Error('Empty model response');
      return { text, model, fallback: i > 0, durationMs: Date.now() - t0 };
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message || '';
      // Provider daily quota → do not cascade models (INF-5)
      if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
        const err = new Error('Provider quota exceeded') as Error & { code?: string };
        err.code = 'PROVIDER_QUOTA';
        throw err;
      }
      if (i === 0 && models.length > 1) continue;
      break;
    }
  }
  throw lastErr || new Error('Model call failed');
}
