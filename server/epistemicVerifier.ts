/**
 * P48 — optional independent claim verifier (Groq small when available).
 * Never blocks the primary reply: on any failure return verifier: skipped|error.
 * Pure helpers are safe for offline tests (no zod / registry import at module top for pure path).
 */
import type { UserIntentFlags } from './intentFlags.ts';
import type { ConversationMode } from './conversationMode.ts';
import type { ProviderAdapter } from './adapter.ts';

export type ClaimKind = 'fact' | 'hypothesis' | 'unknown';

export type EpistemicClaim = { text: string; kind: ClaimKind };

export type EpistemicResult = {
  claims: EpistemicClaim[];
  issues: string[];
  check_suggestions: string[];
  verifier: 'groq' | 'skipped' | 'error';
};

const KIND_SET = new Set<string>(['fact', 'hypothesis', 'unknown']);
const DEFAULT_GROQ_BASE = 'https://api.groq.com/openai/v1';

/** Heuristic: primary text looks fact-like (numbers, %, years, URLs). */
export function hasFactualSurface(text: string): boolean {
  const t = String(text || '');
  if (/\bhttps?:\/\//i.test(t)) return true;
  if (/\b\d{4}\b/.test(t) && /\b(19|20)\d{2}\b/.test(t)) return true;
  if (/\d+\s*%/.test(t)) return true;
  if (/\b\d+[.,]\d+\b/.test(t) && t.length > 40) return true;
  if (/\b\d{2,}\b/.test(t) && /(million|billion|км|km|°C|°F|meter|metre)/i.test(t)) return true;
  return false;
}

export function shouldRunVerifier(opts: {
  hasGroqKey: boolean;
  triage: string;
  hasDocument: boolean;
  conversationMode: ConversationMode | string;
  flags: UserIntentFlags;
  replyText: string;
}): boolean {
  if (!opts.hasGroqKey) return false;
  const triage = String(opts.triage || '').toUpperCase();
  if (triage === 'CRISIS') return false;
  if (opts.hasDocument) return false;
  const mode = String(opts.conversationMode || '');
  if (mode === 'research' || mode === 'decision') return true;
  const f = opts.flags;
  if (f.userAskedSearch || f.userAskedApproximate || f.userCriticizedEvasion || f.userDemandedDirectAnswer) return true;
  if (hasFactualSurface(opts.replyText)) return true;
  return false;
}

/** Parse and clamp verifier JSON; returns null if unusable. */
export function parseVerifierPayload(raw: unknown): Omit<EpistemicResult, 'verifier'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const claimsIn = Array.isArray(o.claims) ? o.claims : [];
  const claims: EpistemicClaim[] = [];
  for (const c of claimsIn.slice(0, 8)) {
    if (!c || typeof c !== 'object') continue;
    const text = String((c as any).text || '').trim().slice(0, 400);
    const kind = String((c as any).kind || '').toLowerCase();
    if (!text || !KIND_SET.has(kind)) continue;
    claims.push({ text, kind: kind as ClaimKind });
  }
  const issues = (Array.isArray(o.issues) ? o.issues : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => String(x).trim().slice(0, 300))
    .slice(0, 5);
  const check_suggestions = (Array.isArray(o.check_suggestions) ? o.check_suggestions : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => String(x).trim().slice(0, 300))
    .slice(0, 5);
  if (!claims.length && !issues.length && !check_suggestions.length) return null;
  return { claims, issues, check_suggestions };
}

export function skippedEpistemic(reason: 'skipped' | 'error' = 'skipped'): EpistemicResult {
  return { claims: [], issues: [], check_suggestions: [], verifier: reason };
}

const VERIFIER_SYSTEM = `You are a claim classifier, not an answer rewriter.
Given the user message and the assistant draft, list concrete claims and mark each as fact (supported by the draft's own grounding), hypothesis (assumption or uncertain), or unknown.
Return JSON only: {"claims":[{"text":"...","kind":"fact"|"hypothesis"|"unknown"}],"issues":["..."],"check_suggestions":["..."]}
Max 8 claims, max 5 issues, max 5 check_suggestions. Do not rewrite the assistant answer. Do not invent new facts.`;

/** Prefer small Groq model; override via EPISTEMIC_VERIFIER_MODEL. */
export function pickVerifierModelId(): string {
  return process.env.EPISTEMIC_VERIFIER_MODEL || 'openai/gpt-oss-120b';
}

/**
 * One-shot verifier. Never throws to caller for provider errors — returns error/skipped.
 */
export async function runEpistemicVerifier(opts: {
  userText: string;
  replyText: string;
  requestId?: string;
  adapter?: ProviderAdapter;
  modelId?: string;
  timeoutMs?: number;
}): Promise<EpistemicResult> {
  const key = process.env.GROQ_API_KEY;
  if (!key && !opts.adapter) return skippedEpistemic('skipped');

  let adapter = opts.adapter;
  if (!adapter) {
    try {
      const { createOpenAICompatibleAdapter } = await import('./openaiCompatAdapter.ts');
      adapter = createOpenAICompatibleAdapter({
        providerId: 'groq',
        baseUrl: process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE,
        apiKey: key!,
      });
    } catch {
      return skippedEpistemic('error');
    }
  }

  const modelId = opts.modelId || pickVerifierModelId();
  const prompt = `USER:\n${String(opts.userText || '').slice(0, 4000)}\n\nASSISTANT_DRAFT:\n${String(opts.replyText || '').slice(0, 6000)}`;

  try {
    const res = await adapter.call({
      requestId: opts.requestId || `epistemic-${Date.now()}`,
      modelId,
      system: VERIFIER_SYSTEM,
      prompt,
      json: true,
      maxOutputTokens: 800,
      metadata: {},
    }, { timeoutMs: opts.timeoutMs ?? 12_000 });
    if (res.status !== 'ok') {
      console.info(JSON.stringify({ type: 'epistemic_verifier', status: res.status, errorClass: (res as any).errorClass }));
      return skippedEpistemic('error');
    }
    const parsed = parseVerifierPayload(res.output);
    if (!parsed) {
      console.info(JSON.stringify({ type: 'epistemic_verifier', status: 'invalid_output' }));
      return skippedEpistemic('error');
    }
    return { ...parsed, verifier: 'groq' };
  } catch (e: any) {
    console.info(JSON.stringify({ type: 'epistemic_verifier', status: 'exception', message: String(e?.message || e).slice(0, 200) }));
    return skippedEpistemic('error');
  }
}
