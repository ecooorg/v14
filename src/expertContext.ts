/**
 * P52: what the Expert open dialogue tells the server.
 * The chat under every Expert stage uses /api/conversation. Without these fields the server could not tell
 * Expert from Simple and could not know what the method had already produced. Plain text only, bounded.
 */
import type { Decision } from './decision.ts';

export const EXPERT_CONTEXT_MAX_CHARS = 3000;

const clip = (v: unknown, n: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (title: string, items: unknown[], each = 160, max = 6): string => {
  const rows = items.map((x) => clip(x, each)).filter(Boolean).slice(0, max);
  return rows.length ? `${title}: ${rows.join(' | ')}` : '';
};

/** Compact summary of what the Expert method has produced so far. Empty string when nothing yet. */
export function buildExpertStageContext(d: Decision): string {
  const parts: string[] = [];
  const b = d.brief;
  if (b) {
    if (b.goal) parts.push(`Goal: ${clip(b.goal, 200)}`);
    parts.push(list('Facts', b.facts || []));
    parts.push(list('Unknowns', b.unknowns || []));
    parts.push(list('Assumptions', b.assumptions || []));
    parts.push(list('Constraints', b.constraints || [], 120, 4));
  }
  parts.push(list('Options', (d.options || []).map((o) => `${o.title}${o.keyAssumption ? ` (assumes: ${o.keyAssumption})` : ''}`), 200, 6));
  const objections = (d.redTeam || []).flatMap((r) => (r.objections || []).map((o: any) => o?.text ?? o?.claim ?? o?.title ?? ''));
  parts.push(list('Objections raised', objections, 140, 5));
  parts.push(list('Hypotheses', (d.hypotheses || []).map((h) => h.rewrittenByUser || h.text), 160, 5));
  if (d.decision?.whatIDecided) parts.push(`Person's decision: ${clip(d.decision.whatIDecided, 240)}`);
  if (d.synthesis) parts.push(list('Open gaps', d.synthesis.openGaps || [], 140, 4));
  return parts.filter(Boolean).join('\n').slice(0, EXPERT_CONTEXT_MAX_CHARS);
}

/** Extra body fields for /api/conversation. Empty object outside Expert, so Simple requests are unchanged. */
export function expertConversationFields(d: Decision, expert: boolean | undefined): Record<string, string> {
  if (!expert) return {};
  const ctx = buildExpertStageContext(d);
  return { productMode: 'Expert', expertStage: String(d.step || ''), ...(ctx ? { expertContext: ctx } : {}) };
}
