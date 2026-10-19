import { SECTIONS, estimateTokens, isEstablishedFact, stateItemsSchema, type Section } from './statePipeline.ts';

/** Context Builder (TZ 7.5): profile instruction + State slice (by relevance, within the token limit) + decisions + artifacts the task refers to + the task.
 *  Chat history is never added unless a reason is given (it is then recorded in `historyReason`). Pure function. */
export const ANALYST_INSTRUCTION = `You are BiForge in Project Mode (project analyst). Work only from the project context below. Prefer operational precision: facts, gaps, risks and requirements tied to this project. Do not invent facts, numbers or sources. Do not chat or coach — return structured analysis only.
Return ONE JSON object: {"summary": "<short analysis in plain text>", "patch": {"ops": [ ... ]}}.
Allowed ops: {"op":"add","section":"facts|unknowns|hypotheses|risks|requirements","item":{...}}, {"op":"update","section":...,"id":"X-1","changes":{...}}, {"op":"reject","section":...,"id":"X-1","reason":"..."}.
Item fields: facts {text, ref?, quote?}; unknowns {text, impact:"high|medium|low"}; hypotheses {text}; risks {text, severity:"high|medium|low"}; requirements {text, acceptance}.
Never set id, status, author or source. Never touch "decisions": only a human makes decisions. A fact needs "ref" ("msg:..." or "artifact:...") or it stays unverified.`;

export interface ContextArtifact { id: string; version: number; filename: string; text: string }
export interface ContextInput {
  instruction?: string; state: Record<string, unknown>; task: string; artifacts?: ContextArtifact[];
  history?: string; historyReason?: string; maxTokens?: number; artifactMaxTokens?: number;
}
export interface ContextResult {
  system: string; prompt: string;
  tokens: { total: number; instruction: number; state: number; artifacts: number; task: number; limit: number };
  included: Record<string, number>; excluded: { section: string; id: string; reason: string }[]; historyReason?: string;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
const PROTECTED: Section[] = ['decisions', 'requirements'];

export function buildContext(input: ContextInput): ContextResult {
  const limit = input.maxTokens ?? 6000;
  const system = input.instruction ?? ANALYST_INSTRUCTION;
  const parsed = stateItemsSchema.safeParse(input.state.items ?? {});
  const items = (parsed.success ? parsed.data : stateItemsSchema.parse({})) as Record<Section, any[]>;
  const excluded: ContextResult['excluded'] = [];
  const taskWords = words(input.task);
  const passport = input.state.passport as Record<string, unknown> | undefined;
  const head = { goal: input.state.goal ?? passport?.goal, phase: input.state.phase, type: input.state.type ?? passport?.projectType, next_action: input.state.next_action };

  const artifacts = (input.artifacts ?? []).map((a) => {
    const cap = (input.artifactMaxTokens ?? 3000) * 4;
    const text = a.text.length > cap ? a.text.slice(0, cap) + '\n[truncated]' : a.text;
    return { ref: `artifact:${a.id}@${a.version}`, filename: a.filename, text };
  });
  const taskBlock = `TASK:\n${input.task}`;
  const hist = input.history && input.historyReason ? `CHAT HISTORY (reason: ${input.historyReason}):\n${input.history}` : '';
  const fixed = estimateTokens(system) + estimateTokens(artifacts) + estimateTokens(taskBlock) + estimateTokens(hist) + estimateTokens(head);

  // candidates: rejected / resolved / closed items are not context; a fact without a confirmed source is not "established" (TZ 5.4 rule 5)
  type Cand = { section: Section; item: any; score: number; protected: boolean };
  const cands: Cand[] = [];
  for (const section of Object.keys(SECTIONS) as Section[]) {
    for (const x of items[section]) {
      const rk = SECTIONS[section].reviewKey;
      const review = rk ? x[rk] : 'confirmed';
      if (review === 'rejected') { excluded.push({ section, id: x.id, reason: 'rejected' }); continue; }
      if (section === 'facts' && !isEstablishedFact(x)) { excluded.push({ section, id: x.id, reason: 'unverified_fact' }); continue; }
      if (x.status === 'resolved' || x.status === 'mitigated') { excluded.push({ section, id: x.id, reason: 'closed' }); continue; }
      const overlap = [...words(x.text)].filter((w) => taskWords.has(w)).length;
      const importance = ({ high: 2, medium: 1, low: 0 } as Record<string, number>)[x.impact ?? x.severity] ?? 0;
      cands.push({ section, item: x, protected: PROTECTED.includes(section), score: (review === 'confirmed' ? 10 : 0) + importance * 3 + overlap * 5 });
    }
  }
  const slim = (c: Cand) => ({ id: c.item.id, text: c.item.text, ...(c.item.acceptance ? { acceptance: c.item.acceptance } : {}), ...(c.item.rationale ? { rationale: c.item.rationale } : {}), ...(c.item.impact ? { impact: c.item.impact } : {}), ...(c.item.severity ? { severity: c.item.severity } : {}), ...((SECTIONS[c.section].reviewKey && c.item[SECTIONS[c.section].reviewKey!] === 'proposed') ? { proposed: true } : {}) });
  const pick = (list: Cand[]) => { const out: Record<string, any[]> = {}; for (const c of list) (out[c.section] ??= []).push(slim(c)); return out; };

  const kept = cands.filter((c) => c.protected);   // decisions and requirements are never dropped
  let used = fixed + estimateTokens(pick(kept));
  for (const c of cands.filter((x) => !x.protected).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))) {
    const cost = estimateTokens(slim(c));
    if (used + cost > limit) { excluded.push({ section: c.section, id: c.item.id, reason: 'token_limit' }); continue; }
    kept.push(c); used += cost;
  }
  const slice = pick(kept.sort((a, b) => a.item.id.localeCompare(b.item.id, undefined, { numeric: true })));
  const prompt = [
    `PROJECT:\n${JSON.stringify(head)}`, `STATE:\n${JSON.stringify(slice)}`,
    ...artifacts.map((a) => `ARTIFACT ${a.ref} (${a.filename}):\n${a.text}`), ...(hist ? [hist] : []), taskBlock,
  ].join('\n\n');
  const stateTokens = estimateTokens(slice);
  return {
    system, prompt, historyReason: hist ? input.historyReason : undefined, excluded,
    included: Object.fromEntries(Object.entries(slice).map(([k, v]) => [k, v.length])),
    tokens: { total: estimateTokens(system) + estimateTokens(prompt), instruction: estimateTokens(system), state: stateTokens, artifacts: estimateTokens(artifacts), task: estimateTokens(taskBlock), limit },
  };
}
