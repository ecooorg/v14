/**
 * P55: the «Decision brief» panel shows the person's own words in plain sections, never the stored JSON.
 * Pure: no React. Only sections that have content are returned.
 */
import type { DecisionBrief } from './decision.ts';

export interface BriefSection { title: string; items: string[] }

const LEVEL: Record<string, string> = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };
const DOOR: Record<string, string> = { ONE_WAY: 'hard to undo', TWO_WAY: 'easy to undo', UNKNOWN: 'not clear yet' };
const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
const word = (map: Record<string, string>, v: unknown) => map[String(v)] || text(v).toLowerCase();

export function briefSections(b: DecisionBrief | null | undefined): BriefSection[] {
  if (!b) return [];
  const out: BriefSection[] = [];
  const add = (title: string, items: unknown[]) => { const rows = items.map(text).filter(Boolean); if (rows.length) out.push({ title, items: rows }); };
  add('Decision', [b.decision]);
  add('Goal', [b.goal]);
  add('Deadline', [b.deadline]);
  add('Facts', b.facts || []);
  add('Unknowns', b.unknowns || []);
  add('Assumptions', b.assumptions || []);
  add('What matters to you', b.values || []);
  add('Limits', b.constraints || []);
  const options = (b.myOptions || []).map((o) => text(o?.title));
  add('Your options', options);
  const lean = (b.myOptions || []).find((o) => o?.id === b.leaningOptionId);
  if (lean) add('You lean towards', [lean.title]);
  const cost: string[] = [];
  if (b.errorCost?.final || b.errorCost?.preliminary) cost.push(`Cost of a mistake: ${word(LEVEL, b.errorCost.final || b.errorCost.preliminary)}`);
  if (b.errorCost?.note) cost.push(b.errorCost.note);
  if (b.reversibility?.final || b.reversibility?.preliminary) cost.push(`Reversibility: ${word(DOOR, b.reversibility.final || b.reversibility.preliminary)}`);
  if (b.reversibility?.exitCost) cost.push(`Cost of backing out: ${b.reversibility.exitCost}`);
  if (b.reversibility?.recoveryPath) cost.push(`Way back: ${b.reversibility.recoveryPath}`);
  add('Risk', cost);
  add('When to look again', b.reviewDates || []);
  return out;
}

export const BRIEF_EMPTY_TEXT = 'Nothing is recorded in the brief yet. It fills in as you go through the steps.';
