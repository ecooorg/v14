/**
 * v17 methodology layer (stage 2, step I2).
 * - Normalizes the conversation `state` object (old and new formats) and keeps it small.
 * - Keeps model hypotheses out of facts.
 * - Holds the prompt addition for the v17 layer.
 * - Scrubs leaked internal labels from the visible reply.
 * No extra model calls: every check here is local and deterministic.
 */

export interface ReasoningState {
  coreProblem: string;
  userConcern: string;
  userReasoningState: string;
  facts: string[];
  assumptions: string[];
  unknowns: string[];
  options: string[];
  hypotheses: string[];
  expectations: string[];
}

export const STATE_LIMITS = {
  scalarChars: 300,
  itemChars: 200,
  itemsPerList: 12,
  totalItems: 60,
} as const;

const LISTS = ['facts', 'assumptions', 'unknowns', 'options', 'hypotheses', 'expectations'] as const;
const SCALARS = ['coreProblem', 'userConcern', 'userReasoningState'] as const;

export function emptyReasoningState(): ReasoningState {
  return {
    coreProblem: '', userConcern: '', userReasoningState: '',
    facts: [], assumptions: [], unknowns: [], options: [], hypotheses: [], expectations: [],
  };
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function asText(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    for (const k of ['text', 'title', 'value', 'statement']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return '';
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Crude language-neutral stems (first 5 letters) so inflected forms still match.
function stems(s: string): Set<string> {
  return new Set(normKey(s).split(' ').filter((w) => w.length >= 3).map((w) => w.slice(0, 5)));
}

function overlap(a: string, b: string): number {
  const sa = stems(a), sb = stems(b);
  if (!sa.size || !sb.size) return 0;
  let n = 0;
  for (const w of sa) if (sb.has(w)) n++;
  return n / sa.size;
}

function sameStatement(a: string, b: string): boolean {
  const x = normKey(a), y = normKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x) || overlap(a, b) >= 0.8 && overlap(b, a) >= 0.8;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const t = clip(asText(raw), STATE_LIMITS.itemChars);
    const k = normKey(t);
    if (!t || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= STATE_LIMITS.itemsPerList) break;
  }
  return out;
}

/** Reads any state object (old v16 shape, new shape, junk) into the v17 shape. Never throws. */
export function normalizeState(raw: unknown): ReasoningState {
  const s = emptyReasoningState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  const o = raw as Record<string, unknown>;
  for (const k of SCALARS) s[k] = typeof o[k] === 'string' ? clip(o[k] as string, STATE_LIMITS.scalarChars) : '';
  for (const k of LISTS) s[k] = cleanList(o[k]);
  // A model hypothesis is never a fact: if the same statement is in both, it stays a hypothesis.
  s.facts = s.facts.filter((f) => !s.hypotheses.some((h) => sameStatement(f, h)));
  // Total size cap (trim the tail of the longest lists first).
  let total = LISTS.reduce((n, k) => n + s[k].length, 0);
  while (total > STATE_LIMITS.totalItems) {
    const longest = [...LISTS].sort((a, b) => s[b].length - s[a].length)[0];
    s[longest].pop();
    total--;
  }
  return s;
}

export interface MergeContext {
  previous: ReasoningState;       // state the client sent (already normalized)
  userTexts: string[];            // brief + every user message
  lastAssistantText: string;      // the previous model reply
}

/**
 * Merges the state returned by the model with the previous one.
 * - Missing keys carry over from the previous state.
 * - A NEW fact that echoes the previous model reply but not anything the user wrote
 *   is moved to hypotheses (the model's own words are not information from the user).
 */
export function mergeModelState(modelRaw: unknown, ctx: MergeContext): ReasoningState {
  const prev = ctx.previous;
  const hasModelState = modelRaw && typeof modelRaw === 'object' && !Array.isArray(modelRaw);
  if (!hasModelState) return prev;
  const raw = modelRaw as Record<string, unknown>;
  const incoming = normalizeState(raw);
  const next = emptyReasoningState();
  for (const k of SCALARS) next[k] = typeof raw[k] === 'string' && incoming[k] ? incoming[k] : prev[k];
  for (const k of LISTS) next[k] = Array.isArray(raw[k]) ? incoming[k] : prev[k];

  const userText = ctx.userTexts.join('\n');
  const demoted: string[] = [];
  next.facts = next.facts.filter((f) => {
    if (prev.facts.some((p) => sameStatement(p, f))) return true;      // already known from before
    const fromAssistant = ctx.lastAssistantText ? overlap(f, ctx.lastAssistantText) : 0;
    const fromUser = userText ? overlap(f, userText) : 0;
    if (fromAssistant >= 0.6 && fromUser < 0.4) { demoted.push(f); return false; }
    return true;
  });
  next.hypotheses = cleanList([...next.hypotheses, ...demoted]);
  next.facts = next.facts.filter((f) => !next.hypotheses.some((h) => sameStatement(f, h)));
  return normalizeState(next);
}

/** Internal fields of one model answer. They are read once and never copied to the client. */
export function readInternalFlags(out: any): { problemClear: boolean; driftDetected: boolean; notUnderstood: boolean } {
  return {
    problemClear: out?.problemClear !== false,          // missing = clear (do not block the old behavior)
    driftDetected: out?.driftDetected === true,
    notUnderstood: out?.notUnderstoodSignal === true,
  };
}

/** Keeps the first question only. */
export function firstQuestionOnly(q: string): string {
  const t = String(q || '').trim();
  const i = t.search(/[?？]/);
  return i === -1 ? t : t.slice(0, i + 1).trim();
}

const LABELS = 'USER_DATA|GENERAL_PATTERN|GUESS|USER[ _]FACT|GENERAL[ _]KNOWLEDGE|DERIVED|HYPOTHESIS|UNKNOWN|CORE[ _]PROBLEM|USER[ _]CONCERN|USER[ _]REASONING[ _]STATE|MODEL[ _]HYPOTHESES|KNOWN[ _]FACTS';

/** Safety net: removes service labels and field names if the model leaks them into the reply. */
export function scrubInternalLabels(text: string): string {
  return String(text ?? '')
    .replace(new RegExp(`\\s*[\\(\\[](?:${LABELS})[\\)\\]]`, 'g'), '')
    .replace(new RegExp(`(^|\\n)[ \\t]*(?:-[ \\t]*)?(?:${LABELS})[ \\t]*:[ \\t]*`, 'g'), '$1')
    .replace(/\b(?:problemClear|driftDetected|notUnderstoodSignal|coreProblem|userConcern|userReasoningState)\b\s*[:=]\s*\w*/g, '')
    // S-3: punctuation orphaned by a removed label ("; ." / ".." / "?.") must not stay behind
    .replace(/\s*[;,]+(?:\s*[;,]+)*\s*(?=[.!?])/g, '')
    .replace(/\s+\.(?!\.)/g, '.')
    .replace(/(?<![.])\.\.(?![.])/g, '.')
    .replace(/([!?])\.(?![.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Prompt addition for the v17 layer. Plain additions only; the v16 method below it stays as is. */
export const V17_LAYER_PROMPT = `V17 LAYER (wraps everything below; where it conflicts with the rules below about length, breadth or questions, this layer wins; the steps below are tools to use when they help, not a checklist to fill)
Goal: move the person's thinking forward, not produce the fullest possible answer. Default to a short answer that is enough for their next step of thought. Crisis handling below always wins over this layer.

1. Is the problem clear? (silent, first)
- Ask yourself whether you know what problem the person is trying to solve. If you do not, do no analysis: write one or two plain sentences and ask ONE minimal clarifying question tied to the problem itself. Set problemClear to false and contextSufficiency to LOW.
- Unclear problem and missing data are different. If the problem is clear but data is missing, work on it and look for the decisive unknowns instead of asking for general background.
- If the problem is clear, do not ask for confirmation of it and do not restate it.

2. Hold the core problem
- Keep state.coreProblem (one short sentence in the person's words) and state.userConcern (what worries or matters to them). Update them only when the person says something that changes them.
- What you suggested earlier is a hypothesis, not a fact and not the person's goal. Your previous reply is not new information from the person. Never move your own hypothesis into state.facts, never turn it into the new topic, and do not build the next reply on it as if the person had agreed.

3. "You did not understand me"
- If the person signals, in any language or wording, that you misunderstood them or answered the wrong question: stop the current line, go back to the original statement of the problem, reconsider it, say in one short sentence what you now think the problem is, and ask ONE useful clarifying question. Set notUnderstoodSignal to true and problemClear to false. Do not defend the previous answer and do not apologize at length.

4. Meet the person where their thinking is
- Record in state.userReasoningState, in a few words, how far this particular thought has been worked out (for example: just describing, comparing two options, stuck on one unknown, ready to test). This is about the current thought only, never about the person's intelligence.
- Do not explain what the person has already clearly thought through. Do not repeat their question or their facts back to them.

5. Questions
- At most one question, only if it is tied to the original problem and the next step depends on its answer. If the problem is clear, do not demand confirmation.

6. Keep the kinds of statements apart (silent; never show these labels)
- What the person said (user fact), general knowledge about how such things tend to work, what you derived from their facts, what is your hypothesis, and what is unknown. Put only what the person said into state.facts; put your guesses into state.hypotheses; put gaps into state.unknowns. Present general knowledge as a tendency worth checking.

7. Drift check (silent, before writing the reply, inside this same answer)
- Has my hypothesis become the task? Does this reply move the person's original decision forward? Am I retelling what they already worked out? If any answer is bad, rewrite first. Set driftDetected to true only if your first draft failed this check and you corrected it.

8. Style and format
- Respectful, intellectually honest, no condescension, no mechanical coaching phrases.
- Write the reply as plain text without markdown symbols: no asterisks, no hash headings, no bold. If a list is needed, use lines that start with a dash.
- Never show the person any internal labels, field names or the words problemClear, driftDetected, coreProblem.

`;

const QUESTION_SENTENCE = /[^.!?？\n]*[?？]+[ \t]*/g;
const normQ = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * FIX-02: builds the visible reply with at most one question.
 * - questions not allowed (HIGH context, crisis): no question remains, in reply or in `question`;
 * - `question` given: it is the one kept; other question sentences in the reply are dropped;
 * - no `question`: the first question inside the reply is kept, the others are dropped.
 * A question already present verbatim in the reply is not repeated.
 */
export function buildVisibleReply(reply: string, question: string, allowQuestions: boolean): string {
  const text = String(reply || '').trim();
  const q = allowQuestions ? firstQuestionOnly(question) : '';
  const tidy = (s: string) => s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const inReply: string[] = text.match(QUESTION_SENTENCE) || [];
  if (!inReply.length) return q ? `${text}\n\n${q}` : text;

  const drop = (keep: string | null) => {
    let kept = false;
    const out = text.replace(QUESTION_SENTENCE, (m) => {
      if (keep !== null && !kept && normQ(m) === normQ(keep)) { kept = true; return m; }
      return ' ';   // S-1: never glue the neighbouring sentences together
    });
    return { out: tidy(out), kept };
  };

  if (!allowQuestions) {
    const { out } = drop(null);
    return out || text.replace(/[?？]+/g, '.');
  }
  if (q) {
    const dup = inReply.find((m) => normQ(text).includes(normQ(q)) && (normQ(m).includes(normQ(q)) || normQ(q).includes(normQ(m))));
    if (dup) { const { out } = drop(dup); return out; }
    const { out } = drop(null);
    return out ? `${out}\n\n${q}` : q;
  }
  const { out } = drop(inReply[0]);
  return out;
}
