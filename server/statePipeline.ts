import { z } from 'zod';

/** State patch pipeline (TZ 5.4) and compaction (TZ 5.5). Pure functions: schema -> policy -> apply. A model never writes State directly. */
const text = z.string().trim().min(1).max(2000);
const actorEnum = z.enum(['human', 'agent', 'tool', 'system']);
const review = z.enum(['proposed', 'confirmed', 'rejected']);
const level = z.enum(['high', 'medium', 'low']);
const base = {
  id: z.string().regex(/^[A-Z]{1,2}-\d{1,6}$/), text, author: actorEnum, at: z.string().datetime(), source: z.string().min(1).max(500),
  confirmedBy: z.string().max(100).optional(), updatedBy: actorEnum.optional(), updatedAt: z.string().datetime().optional(), updatedSource: z.string().max(500).optional(),
  rejectedReason: z.string().max(500).optional(), compacted: z.boolean().optional(),
};
const factSchema = z.object({ ...base, status: review, ref: z.string().max(300).optional(), quote: z.string().max(1000).optional(), unverified: z.boolean().optional() }).strict();
const unknownSchema = z.object({ ...base, impact: level, status: z.enum(['open', 'resolved']), review }).strict();
const hypothesisSchema = z.object({ ...base, origin: z.enum(['model', 'human', 'simple_import']), status: review }).strict();
const decisionSchema = z.object({ ...base, decided_by: z.literal('human'), rationale: z.string().max(2000) }).strict();
const riskSchema = z.object({ ...base, severity: level, status: z.enum(['open', 'mitigated']), review }).strict();
const requirementSchema = z.object({ ...base, acceptance: z.string().trim().min(1).max(2000), status: review }).strict();

export const SECTIONS = {
  facts: { prefix: 'F', reviewKey: 'status', schema: factSchema },
  unknowns: { prefix: 'U', reviewKey: 'review', schema: unknownSchema },
  hypotheses: { prefix: 'H', reviewKey: 'status', schema: hypothesisSchema },
  decisions: { prefix: 'D', reviewKey: null, schema: decisionSchema },
  risks: { prefix: 'R', reviewKey: 'review', schema: riskSchema },
  requirements: { prefix: 'RQ', reviewKey: 'status', schema: requirementSchema },
} as const;
export type Section = keyof typeof SECTIONS;
const sectionEnum = z.enum(['facts', 'unknowns', 'hypotheses', 'decisions', 'risks', 'requirements']);

export const stateItemsSchema = z.object({
  facts: z.array(factSchema).default([]), unknowns: z.array(unknownSchema).default([]), hypotheses: z.array(hypothesisSchema).default([]),
  decisions: z.array(decisionSchema).default([]), risks: z.array(riskSchema).default([]), requirements: z.array(requirementSchema).default([]),
}).strict();
export type StateItems = z.infer<typeof stateItemsSchema>;

const itemRecord = z.record(z.string(), z.unknown());
export const statePatchSchema = z.object({
  ops: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('add'), section: sectionEnum, item: itemRecord }).strict(),
    z.object({ op: z.literal('update'), section: sectionEnum, id: z.string().max(20), changes: itemRecord }).strict(),
    z.object({ op: z.literal('reject'), section: sectionEnum, id: z.string().max(20), reason: z.string().max(500).optional() }).strict(),
  ])).min(1).max(100),
}).strict();
export type StatePatch = z.input<typeof statePatchSchema>;

export interface PatchContext { actor: z.infer<typeof actorEnum>; sourceRef: string; now?: Date; policy?: { autoConfirmArtifactQuote?: boolean } }
export interface PatchError { index: number; code: string; message: string }
export type PatchResult = { ok: true; state: Record<string, unknown>; changes: { type: 'added' | 'updated' | 'rejected'; section: Section; id: string }[] } | { ok: false; errors: PatchError[] };

const SYSTEM_FIELDS = ['id', 'author', 'at', 'source', 'confirmedBy', 'unverified', 'compacted', 'decided_by', 'updatedBy', 'updatedAt', 'updatedSource', 'rejectedReason'];

export function applyStatePatch(state: Record<string, unknown>, patchInput: unknown, ctx: PatchContext): PatchResult {
  const p = statePatchSchema.safeParse(patchInput);
  if (!p.success) return { ok: false, errors: [{ index: -1, code: 'SCHEMA', message: p.error.issues[0]?.path.join('.') + ': ' + p.error.issues[0]?.message }] };
  const cur = stateItemsSchema.safeParse(state.items ?? {});
  if (!cur.success) return { ok: false, errors: [{ index: -1, code: 'STATE_INVALID', message: 'Existing items do not match the schema' }] };
  const items = structuredClone(cur.data) as Record<Section, any[]>;
  const human = ctx.actor === 'human';
  const at = (ctx.now ?? new Date()).toISOString();
  const errors: PatchError[] = [];
  const changes: { type: 'added' | 'updated' | 'rejected'; section: Section; id: string }[] = [];
  const err = (index: number, code: string, message: string) => errors.push({ index, code, message });
  const nextId = (s: Section) => `${SECTIONS[s].prefix}-${Math.max(0, ...items[s].map((x) => Number(String(x.id).split('-')[1]) || 0)) + 1}`;

  p.data.ops.forEach((op, index) => {
    const { section } = op;
    const rk = SECTIONS[section].reviewKey;
    if (!human && section === 'decisions') return err(index, 'POLICY_DECISIONS_HUMAN_ONLY', 'Only a human creates or changes decisions');
    if (op.op === 'add') {
      const bad = Object.keys(op.item).find((k) => SYSTEM_FIELDS.includes(k));
      if (bad) return err(index, 'POLICY_SYSTEM_FIELD', `Field "${bad}" is set by the system`);
      if (!human && rk && op.item[rk] !== undefined) return err(index, 'POLICY_STATUS', 'Model items are always created as proposed');
      const item: Record<string, unknown> = { ...op.item, id: nextId(section), author: ctx.actor, at, source: ctx.sourceRef };
      if (rk) item[rk] = human ? (op.item[rk] ?? 'confirmed') : 'proposed';
      if (section === 'unknowns' || section === 'risks') item.status = op.item.status ?? 'open';
      if (section === 'hypotheses') item.origin = human ? (op.item.origin ?? 'human') : 'model';
      if (section === 'decisions') { item.decided_by = 'human'; item.rationale = op.item.rationale ?? ''; }
      if (section === 'facts') {
        if (!item.ref) item.unverified = true;   // rule 5: a fact without a source is never "established"
        else if (!human && ctx.policy?.autoConfirmArtifactQuote !== false && String(item.ref).startsWith('artifact:') && item.quote) {
          item.status = 'confirmed'; item.confirmedBy = 'rule:artifact_quote';   // rule 3: the one deterministic confirmation
        }
      }
      if (human && rk && item[rk] === 'confirmed') item.confirmedBy = 'human';
      const r = SECTIONS[section].schema.safeParse(item);
      if (!r.success) return err(index, 'SCHEMA', `${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message}`);
      items[section].push(r.data); changes.push({ type: 'added', section, id: r.data.id });
      return;
    }
    const idx = items[section].findIndex((x) => x.id === op.id);
    if (idx < 0) return err(index, 'NOT_FOUND', `${op.id} not found in ${section}`);
    const old = items[section][idx];
    if (!human && rk && old[rk] !== 'proposed') return err(index, 'POLICY_CONFIRMED_IMMUTABLE', 'A model may change only proposed items');
    if (op.op === 'reject') {
      if (!rk) return err(index, 'UNSUPPORTED', 'Decisions cannot be rejected');
      items[section][idx] = { ...old, [rk]: 'rejected', rejectedReason: op.reason, updatedBy: ctx.actor, updatedAt: at, updatedSource: ctx.sourceRef };
      changes.push({ type: 'rejected', section, id: old.id });
      return;
    }
    const bad = Object.keys(op.changes).find((k) => SYSTEM_FIELDS.includes(k) || (!human && (k === 'status' || k === 'review') && (k === rk || section === 'unknowns' || section === 'risks')));
    if (bad) return err(index, SYSTEM_FIELDS.includes(bad) ? 'POLICY_SYSTEM_FIELD' : 'POLICY_STATUS', `Field "${bad}" cannot be changed by this actor`);
    const upd: Record<string, any> = { ...old, ...op.changes, updatedBy: ctx.actor, updatedAt: at, updatedSource: ctx.sourceRef };
    if (section === 'facts') { if (upd.ref) delete upd.unverified; else upd.unverified = true; }
    if (human && rk && old[rk] !== 'confirmed' && upd[rk] === 'confirmed') upd.confirmedBy = 'human';
    const r = SECTIONS[section].schema.safeParse(upd);
    if (!r.success) return err(index, 'SCHEMA', `${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message}`);
    items[section][idx] = r.data; changes.push({ type: 'updated', section, id: old.id });
  });
  if (errors.length) return { ok: false, errors };   // atomic: nothing is applied if any operation is refused
  return { ok: true, state: { ...state, items }, changes };
}

/** Rule 5: only a confirmed fact with a source is context-grade. */
export const isEstablishedFact = (f: { status: string; ref?: string; unverified?: boolean }) => f.status === 'confirmed' && Boolean(f.ref) && !f.unverified;

// ---- Compaction (TZ 5.5) ----
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
export const DEFAULT_SECTION_LIMITS: Partial<Record<Section, number>> = { facts: 3000, unknowns: 1500, hypotheses: 1500, risks: 1500 };
const SHORT = 60;
/** Never compressed: all decisions and requirements (incl. acceptance), open risks of level high. */
const isProtected = (section: Section, x: any) => section === 'decisions' || section === 'requirements' || (section === 'risks' && x.severity === 'high' && x.status === 'open' && x.review !== 'rejected');

export function compactState(state: Record<string, unknown>, limits: Partial<Record<Section, number>> = DEFAULT_SECTION_LIMITS) {
  const parsed = stateItemsSchema.safeParse(state.items ?? {});
  if (!parsed.success) return { ok: false as const, error: 'STATE_INVALID' };
  const items = structuredClone(parsed.data) as Record<Section, any[]>;
  const compacted: { section: Section; id: string }[] = [];
  const needsLlm: Section[] = [];
  const rank = (x: any, rk: string | null) => { const v = rk ? x[rk] : 'confirmed'; return v === 'rejected' ? 0 : x.status === 'resolved' || x.status === 'mitigated' ? 0.5 : v === 'proposed' ? 1 : 2; };
  const imp = (x: any) => ({ low: 0, medium: 1, high: 2 } as Record<string, number>)[x.impact ?? x.severity] ?? 1;
  for (const [section, limit] of Object.entries(limits) as [Section, number][]) {
    const rk = SECTIONS[section].reviewKey;
    // deterministic stage: lowest priority first (rejected/closed < proposed < confirmed, then low importance, then older)
    const order = items[section].filter((x) => !isProtected(section, x) && x.text.length > SHORT + 1)
      .sort((a, b) => rank(a, rk) - rank(b, rk) || imp(a) - imp(b) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    for (const x of order) {
      if (estimateTokens(items[section]) <= limit) break;
      x.text = x.text.slice(0, SHORT).trimEnd() + '…'; x.compacted = true; compacted.push({ section, id: x.id });
    }
    if (estimateTokens(items[section]) > limit) needsLlm.push(section);   // LLM compression of low-priority text is a later step
  }
  return { ok: true as const, changed: compacted.length > 0, state: compacted.length ? { ...state, items } : state, compacted, needsLlm };
}
