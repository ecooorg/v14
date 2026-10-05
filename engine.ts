/* Bifurcation Engine v13 decision engine and client core.
 * This file intentionally keeps the v13 methodology intact.
 * Infrastructure additions (auth/Drive) are isolated at the bottom.
 */

/** Bifurcation Engine v11 — domain model */

export type Step =
  | 'TRIAGE'
  | 'BRIEF'
  | 'UNDERSTAND'
  | 'EXPAND'
  | 'ATTACK'
  | 'TEST'
  | 'DECIDE'
  | 'SYNTHESIS'
  | 'LEARN';

export type Source = 'USER_DATA' | 'GENERAL_PATTERN' | 'GUESS';
export type Door = 'ONE_WAY' | 'TWO_WAY';
export type Verifiability = 'TESTABLE' | 'SPECULATION';
export type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export type EpistemicKind =
  | 'FACT'
  | 'ASSUMPTION'
  | 'INTERPRETATION'
  | 'VALUE'
  | 'UNKNOWN'
  | 'EXTERNAL_VERIFY';
export type EpistemicStatus =
  | 'UNRESOLVED'
  | 'USER_CONFIRMED'
  | 'USER_UNKNOWN'
  | 'EXTERNALLY_VERIFIED'
  | 'REJECTED'
  | 'ACCEPTED_UNCERTAINTY';
export type ErrorDiagnosis =
  | 'DATA'
  | 'ASSUMPTION'
  | 'REASONING'
  | 'EXECUTION'
  | 'LUCK';
export type OptionKind =
  | 'HYBRID_OR_PILOT'
  | 'REVERSIBLE_STEP'
  | 'GET_FACT_FIRST'
  | 'OTHER';
export type ExperimentStatus =
  | 'DRAFT'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED';

export interface StepMeta {
  model: string;
  fallback: boolean;
  at: number;
  durationMs: number;
  stage?: Step;
  cycleId?: string;
  schemaVersion?: number;
}

export interface Triage {
  crisis: boolean;
  crisisConfirmed?: boolean;
  onlyValues: boolean;
  q: {
    costly: boolean;
    hardToUndo: boolean;
    resolvableUnknowns: boolean;
    longHorizon: boolean;
  };
  outcome: 'CRISIS_STOP' | 'VALUES_ONLY' | 'METHOD_JUSTIFIED' | 'OVERKILL';
  confirmed?: boolean;
}

export interface DecisionBrief {
  decision: string;
  deadline?: string;
  goal?: string;
  facts: string[];
  unknowns: string[];
  assumptions: string[];
  values: string[];
  constraints: string[];
  myOptions: { id: string; title: string }[];
  leaningOptionId: string | 'NONE';
  errorCost: {
    preliminary?: Level;
    final?: Level;
    note?: string;
  };
  reversibility: {
    preliminary?: Door | 'UNKNOWN';
    final?: Door | 'UNKNOWN';
    exitCost?: string;
    recoveryPath?: string;
  };
  reviewDates: string[];
  minimalMode?: boolean;
}

export interface NeutralItem {
  id: string;
  original: string;
  kind: 'KEEP' | 'NEUTRALIZE' | 'INTERPRETATION';
  neutralQuestion?: string;
  userChoice: 'ACCEPT' | 'EDITED' | 'REVERT';
  edited?: string;
}

export interface Claim {
  id: string;
  kind: EpistemicKind;
  text: string;
  source: Source;
  sourceType: 'USER' | 'MODEL' | 'EXTERNAL' | 'CALCULATION';
  status: EpistemicStatus;
  owner?: string;
  userImportance?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  evidenceIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Unknown extends Claim {
  question: string;
  whyChangesDecision: string;
  howToFindOut: string;
  effort: 'MINUTES' | 'DAYS' | 'WEEKS';
  branchIfA: { answer: string; leadsTo: string };
  branchIfB: { answer: string; leadsTo: string };
  critical: boolean;
  discarded?: boolean;
  answer?: string;
}

export interface Radar {
  facts: Claim[];
  assumptions: Claim[];
  interpretations: Claim[];
  values: Claim[];
  unknowns: Unknown[];
  needsExternalCheck: Claim[];
  meta: StepMeta;
}

export interface KnowledgeMap {
  known: string[];
  unknown: string[];
  critical: string[];
  quickToGet: string[];
  needsIndependentCheck: string[];
  meta: StepMeta;
  confirmed?: boolean;
}

export interface Evidence {
  id: string;
  claim: string;
  sourceType: 'USER_DOCUMENT' | 'EXTERNAL_SOURCE' | 'CALCULATION' | 'MODEL';
  sourceLabel: string;
  sourceLocator?: string;
  verified: boolean;
  verifiedAt?: number;
  notes?: string;
}

export interface Option {
  id: string;
  title: string;
  description: string;
  byUser: boolean;
  kind?: OptionKind;
  keyAssumption: string;
  exitCost: string;
  cheapestTest: string;
  door: Door;
  realistic: 'YES' | 'NO' | 'UNKNOWN';
  linkedUnknownIds: string[];
}

export interface Objection {
  id: string;
  argument: string;
  hiddenAssumption: string;
  failureMode: string;
  whatMustBeTrueForCritiqueToBeWeak: string;
  verifiability: Verifiability;
  response?: { verdict: 'ACCEPTED' | 'REJECTED'; reason: string };
}

export interface RedTeamRound {
  targetOptionId: string;
  role: 'PREFERRED' | 'OPPOSITE';
  objections: Objection[];
  meta: StepMeta;
}

export interface PreMortem {
  horizonMonths: number;
  causes: {
    text: string;
    verifiability: Verifiability;
    verificationAction?: string;
    relatedHypothesisId?: string;
  }[];
  narrative: string;
  whatDistinguishesFromForecast: string;
  meta: StepMeta;
}

export interface Hypothesis {
  id: string;
  text: string;
  verifiability: Verifiability;
  sourceFindingIds?: string[];
  rewrittenByUser?: string;
  priority?: 1 | 2 | 3;
  selectedByUser?: boolean;
}

export interface ChangeRecord {
  at: number;
  field: string;
  from: string;
  to: string;
  reason: string;
}

export interface ExperimentCard {
  id: string;
  hypothesisId: string;
  whyCritical: string;
  test: string;
  metric: string;
  deadline?: string;
  deadlineWords?: string;
  successThreshold?: string;
  stopThreshold?: string;
  intermediateOutcome?: string;
  ifSuccess?: string;
  ifFailure?: string;
  whatToDoAfterStop?: string;
  whatWouldChangeMyMind?: string;
  validityThreats: { threat: string; protection: string; handled: boolean }[];
  thresholdQuestions: string[];
  priorityLabels?: {
    impact: Level;
    accessibility: Level;
    testErrorCost: Level;
  };
  forecast?: {
    wording: string;
    confidence?: number | 'LOW_NO_DATA';
    rationale?: string;
    horizonDays?: 30 | 90 | 180;
    source: 'USER';
  };
  evpi?: {
    p: number;
    gain: number;
    loss: number;
    testCost: number;
    unit: string;
  };
  status: ExperimentStatus;
  lockedAt?: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  resultValue?: string;
  evidenceIds: string[];
  history: ChangeRecord[];
  thresholdShiftedAfterStart: boolean;
}

export interface HumanDecision {
  kind: 'CHOOSE_OPTION' | 'POSTPONE' | 'RUN_TESTS' | 'REFUSE';
  chosenOptionId?: string;
  whatIDecided: string;
  onWhichValues: string;
  underWhichData: string;
  acceptedUncertainties: string[];
  decidedAt: number;
  supersedes?: string;
}

export interface Synthesis {
  paragraphs: [string, string, string, string];
  derivedNumbers: { value: number; formula: string; operands: number[] }[];
  openGaps: string[];
  needsExternalCheck: string[];
  unverifiedNumbers: string[];
  editedByUser?: string;
  meta: StepMeta;
}

export interface JournalEntry {
  id: string;
  createdAt: number;
  hypothesis: string;
  forecastWording: string;
  confidence?: number | 'LOW_NO_DATA';
  rationale?: string;
  reviewDate: string;
  horizonDays: 30 | 90 | 180;
  supersedesId?: string;
  noResultYet?: boolean;
  fact?: string;
  outcome?: boolean;
  discrepancy?: string;
  errorType?: ErrorDiagnosis;
  diagnosisNote?: string;
  whatIUpdated?: string;
  reviewedAt?: number;
}

export type InteractionState =
  | 'NEED_CONTEXT'
  | 'PREVIEW_READY'
  | 'UNDERSTANDING'
  | 'OPTIONS_READY'
  | 'ATTACK_READY'
  | 'TEST_READY'
  | 'SYNTHESIS_READY'
  | 'USER_SATISFIED';

export interface Decision {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  step: Step;
  interactionState?: InteractionState;
  cycleCount: number;
  parentCycleId?: string;
  triage?: Triage;
  brief: DecisionBrief;
  neutralization?: NeutralItem[];
  neutralizationConfirmed?: boolean;
  radar?: Radar;
  knowledgeMap?: KnowledgeMap;
  options: Option[];
  preferredOptionId?: string;
  oppositeOptionId?: string;
  redTeam: RedTeamRound[];
  preMortem?: PreMortem;
  hypotheses: Hypothesis[];
  experiments: ExperimentCard[];
  evidence: Evidence[];
  decision?: HumanDecision;
  synthesis?: Synthesis;
  journal: JournalEntry[];
  modelSuggestions: Record<string, unknown>;
  stepHistory: Record<string, unknown[]>;
  thirdPersonMode?: boolean;
}

export const SCHEMA_VERSION = 11;

export const LOOPS = [
  { id: 1, label: 'UNDERSTAND', steps: ['BRIEF', 'UNDERSTAND'] as Step[] },
  { id: 2, label: 'EXPAND', steps: ['EXPAND'] as Step[] },
  { id: 3, label: 'ATTACK', steps: ['ATTACK'] as Step[] },
  { id: 4, label: 'VERIFY', steps: ['TEST', 'DECIDE', 'SYNTHESIS'] as Step[] },
  { id: 5, label: 'LEARN', steps: ['LEARN'] as Step[] },
] as const;

export const STAGES: {
  id: Step;
  label: string;
  loop: string;
  article: string;
  human: string;
  model: string;
}[] = [
  {
    id: 'TRIAGE',
    label: 'Start',
    loop: 'PREPARE',
    article: 'Quick start step 1',
    human: 'Checks if help is needed and if a careful process is useful',
    model: 'Not used yet',
  },
  {
    id: 'BRIEF',
    label: 'Your story',
    loop: 'UNDERSTAND',
    article: '§6; L1',
    human: 'Describes the situation in their own words',
    model: 'Not used yet',
  },
  {
    id: 'UNDERSTAND',
    label: 'Clarify',
    loop: 'UNDERSTAND',
    article: 'L1; §3.2; §8.2 stages 1–2',
    human: 'Confirms neutralization; answers unknowns; assigns owner',
    model: 'Neutralizes; maps 6 categories; formulates unknowns; knowledge map',
  },
  {
    id: 'EXPAND',
    label: 'Options',
    loop: 'EXPAND',
    article: 'L2; §8.2 stage 3',
    human: 'Marks realistic options; adds own',
    model: '3–5 additional options',
  },
  {
    id: 'ATTACK',
    label: 'Stress-test',
    loop: 'ATTACK',
    article: 'L3; §8.2 stages 4–5',
    human: 'Picks pair; answers objections; selects 1–3 hypotheses',
    model: 'Red team both sides; pre-mortem; hypothesis candidates',
  },
  {
    id: 'TEST',
    label: 'Test ideas',
    loop: 'VERIFY',
    article: 'L4; §7; App.A; §8.2 stages 6–7',
    human: 'Sets thresholds, forecast; locks card',
    model: 'Test draft, metrics, threshold questions',
  },
  {
    id: 'DECIDE',
    label: 'Decide',
    loop: 'LEARN',
    article: 'L5; §9',
    human: 'Records decision, values, and data',
    model: 'On demand: observable success criteria wording',
  },
  {
    id: 'SYNTHESIS',
    label: 'Plan',
    loop: 'LEARN',
    article: 'L5; §8.2 stage 9',
    human: 'Reads, edits, exports',
    model: 'Writes a four-paragraph work plan',
  },
  {
    id: 'LEARN',
    label: 'Learn',
    loop: 'LEARN',
    article: '§10',
    human: 'Enters fact and discrepancy type',
    model: 'Optionally asks review questions',
  },
];

export function emptyBrief(): DecisionBrief {
  return {
    decision: '',
    facts: [],
    unknowns: [],
    assumptions: [],
    values: [],
    constraints: [],
    myOptions: [],
    leaningOptionId: 'NONE',
    errorCost: {},
    reversibility: {},
    reviewDates: [],
    minimalMode: true,
  };
}

export function emptyDecision(): Decision {
  return {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: 'My choice',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    step: 'BRIEF',
    interactionState: 'NEED_CONTEXT',
    cycleCount: 1,
    brief: emptyBrief(),
    options: [],
    redTeam: [],
    hypotheses: [],
    experiments: [],
    evidence: [],
    journal: [],
    modelSuggestions: {},
    stepHistory: {},
  };
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function computeReviewDates(from: Date = new Date()): string[] {
  return [addDays(from, 30), addDays(from, 90), addDays(from, 180)];
}


/** Crisis support contacts and distress markers. */
export const SUPPORT_CONTACTS: { label: string; value: string }[] = [
  { label: 'International Association for Suicide Prevention (IASP)', value: 'https://www.iasp.info/suicidalthoughts/' },
  { label: 'US & Canada: 988 Suicide & Crisis Lifeline', value: '988' },
  { label: 'US: Crisis Text Line', value: 'Text HOME to 741741' },
  { label: 'Emergency services (varies by country)', value: '911 / 112 / local emergency number' },
];
export const DISTRESS_MARKERS: string[] = [
  "don't want to live", 'dont want to live', 'kill myself', 'suicide', 'suicidal', 'harm myself', 'hurt myself',
  'no reason to live', 'end my life', 'want to die', 'no point in living', 'self-harm', 'self harm',
  'не хочу жить', 'хочу умереть', 'покончить с собой', 'покончить с жизнью', 'убить себя', 'нет смысла жить',
  'суицид', 'самоубийств', 'причинить себе вред', 'наложить на себя руки', 'не хочу жити', 'хочу померти',
  'покінчити з собою', 'вбити себе', 'самогубств', 'no quiero vivir', 'quiero morir', 'quitarme la vida',
  'matarme', 'hacerme daño', 'suicid', 'não quero viver', 'quero morrer', 'me matar', 'tirar minha vida',
  'je ne veux plus vivre', 'je veux mourir', 'me tuer', 'en finir avec la vie', 'me faire du mal',
  'non voglio più vivere', 'voglio morire', 'togliermi la vita', 'uccidermi', 'will nicht mehr leben',
  'will sterben', 'suizid', 'selbstmord', 'mich umbringen', 'wil niet meer leven', 'zelfmoord', 'zelfdoding',
  'nie chcę żyć', 'chcę umrzeć', 'samobójst', 'zabić się', 'yaşamak istemiyorum', 'ölmek istiyorum',
  'intihar', 'kendimi öldür', 'أريد أن أموت', 'لا أريد أن أعيش', 'انتحار', 'לא רוצה לחיות', 'להתאבד',
  'आत्महत्या', 'मरना चाहता', '不想活', '想死', '自杀', '自殺', '死にたい', '죽고 싶', '자살',
];
function normalizeSupport(text: string): string { return text.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'"); }
export function hasDistressMarker(text: string): boolean { if (!text) return false; const lower=normalizeSupport(text); return DISTRESS_MARKERS.some(m=>lower.includes(m)); }
export function findDistressInTexts(texts: (string | undefined | null)[]): string | null { for (const t of texts) { if (!t) continue; const lower=normalizeSupport(t); for (const m of DISTRESS_MARKERS) if(lower.includes(m)) return m; } return null; }


/** Feature flags */
export const FEATURES = {
  voice: false,
  pwaInstall: false,
  offlineIndicator: false,
};

export const APP_VERSION = '11.0.0';


/** Plain, friendly UI strings */
export const en = {
  app: 'Bifurcation Engine',
  subtitle: 'A calm way to think through a hard choice · v13',
  formula: 'UNDERSTAND → EXPAND → ATTACK → VERIFY → LEARN',
  human: 'You',
  model: 'AI',
  continue: 'Continue',
  blank: 'blank',
  crisisTitle: 'Do you need urgent personal help right now?',
  crisisYes:
    'Please talk to a real person or a help service first. You can pause this decision. This app is not a replacement for help.',
  privacyTitle: 'Welcome',
  privacyBody:
    'This tool helps you think through a difficult choice step by step. It does not replace professional advice. Do not enter passwords, card numbers, or ID documents. If an API key is set on the server, your answers are sent to Google Gemini to help with the analysis.',
  acceptPrivacy: 'Start',
  decision: 'Your situation',
  deadline: 'Deadline (optional)',
  goal: 'What “good enough” looks like (optional)',
  facts: 'What you already know',
  unknowns: 'What you still need to find out',
  assumptions: 'What you are assuming',
  values: 'What matters to you',
  constraints: 'Limits (money, time, other people)',
  myOptions: 'Options you already see',
  leaning: 'What you lean toward',
  errorCost: 'Cost of a wrong choice',
  reversibility: 'Can you undo it?',
  dontKnow: "I don't know",
  acceptUncertainty: 'I accept uncertainty',
  lockCard: 'Save and lock',
  startTest: 'Start test',
  workPlan: 'Work plan',
  myDecision: 'My decision',
  exportJson: 'Export',
  importJson: 'Import',
  nextCycle: 'Next cycle',
  scenarioNotForecast: 'Scenario, not a prediction',
  noScore: 'This tool does not pick a winner for you.',
  welcomeTitle: 'What are you deciding?',
  welcomeHint:
    'Write a few sentences in your own words. You do not need perfect wording. We will sort it out together.',
  optionalDetails: 'Optional details',
  showOptional: 'Add more detail (optional)',
  hideOptional: 'Hide extra fields',
  fitTitle: 'Optional: is a careful process useful here?',
  fitHint: 'Skip this if you are unsure — you can always continue.',
  startWriting: 'Describe your situation to begin',
};


/** Soft applicability check — internal codes stable; UI uses plain labels */

export interface TriageAnswers {
  crisis: boolean;
  onlyValues: boolean;
  costly: boolean;
  hardToUndo: boolean;
  resolvableUnknowns: boolean;
  longHorizon: boolean;
}

export type TriageOutcome =
  | 'CRISIS_STOP'
  | 'VALUES_ONLY'
  | 'METHOD_JUSTIFIED'
  | 'OVERKILL';

export function triage(answers: TriageAnswers): TriageOutcome {
  if (answers.crisis) return 'CRISIS_STOP';
  if (answers.onlyValues) return 'VALUES_ONLY';
  const yesCount = [
    answers.costly,
    answers.hardToUndo,
    answers.resolvableUnknowns,
    answers.longHorizon,
  ].filter(Boolean).length;
  if (yesCount >= 2) return 'METHOD_JUSTIFIED';
  return 'OVERKILL';
}

export const TRIAGE_OUTCOME_LABEL: Record<TriageOutcome, string> = {
  CRISIS_STOP: 'PAUSE',
  VALUES_ONLY: 'VALUES ONLY',
  METHOD_JUSTIFIED: 'CAREFUL PROCESS HELPS',
  OVERKILL: 'LIGHT TOUCH IS FINE',
};

export const TRIAGE_OUTCOME_TEXT: Record<TriageOutcome, string> = {
  CRISIS_STOP:
    'Please get help from a real person first. Pause this decision if you can.',
  VALUES_ONLY:
    'This is mainly about personal values. A short reflection may be enough.',
  METHOD_JUSTIFIED:
    'A careful step-by-step process is useful: the choice is costly, hard to reverse, or has things you can still check.',
  OVERKILL:
    'You can keep it light — try a small step and learn. You may still use the full process if you want.',
};


/** EVPI calculator — international copy */

export interface EvpiResult {
  evOpen: number;
  bestNoInfo: number;
  evPerfect: number;
  evpi: number;
}

export interface EvpiRange {
  min: number;
  max: number;
}

export function evpi(p: number, G: number, L: number): EvpiResult {
  const evOpen = p * G - (1 - p) * L;
  const bestNoInfo = Math.max(evOpen, 0);
  const evPerfect = p * G;
  return { evOpen, bestNoInfo, evPerfect, evpi: evPerfect - bestNoInfo };
}

export function evpiRange(
  p: number,
  G: number,
  L: number,
  d = 0.1
): EvpiRange {
  const lo = Math.max(0, p - d);
  const hi = Math.min(1, p + d);
  const pts = [lo, hi];
  const pStar = G + L > 0 ? L / (G + L) : 0.5;
  if (pStar > lo && pStar < hi) pts.push(pStar);
  const values = pts.map((x) => evpi(x, G, L).evpi);
  return { min: Math.min(...values), max: Math.max(...values) };
}

export type EvpiVerdict =
  | 'NOT_JUSTIFIED'
  | 'MAY_BE_JUSTIFIED'
  | 'DEPENDS';

export function evpiVerdict(
  testCost: number,
  range: EvpiRange
): { code: EvpiVerdict; text: string } {
  if (testCost > range.max) {
    return {
      code: 'NOT_JUSTIFIED',
      text: 'Test is not justified even with perfect information',
    };
  }
  if (testCost <= range.min) {
    return {
      code: 'MAY_BE_JUSTIFIED',
      text: 'Test may be justified; this is an upper bound — a real test yields less',
    };
  }
  return {
    code: 'DEPENDS',
    text: 'Depends on your probability assessment',
  };
}

export function validateEvpiInput(
  p: number,
  G: number,
  L: number,
  c: number
): string | null {
  if (p < 0 || p > 1) return 'p must be in range 0…1 (or 0…100%)';
  if (G < 0 || L < 0) return 'G and L ≥ 0';
  if (G + L <= 0) return 'G + L > 0';
  if (c < 0) return 'test cost ≥ 0';
  return null;
}


/** Brier score — international copy */

export function brierScore(forecasts: { p: number; outcome: 0 | 1 }[]): {
  score: number;
  n: number;
  warning?: string;
} {
  if (forecasts.length === 0) {
    return { score: NaN, n: 0, warning: 'No forecasts yet' };
  }
  const sum = forecasts.reduce((acc, f) => {
    const err = f.p - f.outcome;
    return acc + err * err;
  }, 0);
  const score = sum / forecasts.length;
  const warning =
    forecasts.length < 10
      ? `Small sample (n=${forecasts.length}); meaningful calibration needs dozens of forecasts`
      : undefined;
  return { score, n: forecasts.length, warning };
}


/** Canonical SHA-256 for experiment card export — TZ B.4 */

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(text: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Node fallback
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function cardChecksum(card: unknown): Promise<string> {
  return sha256Hex(canonicalJson(card));
}


/** .ics calendar file — TZ B.5 */

function escapeIcs(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line: string): string {
  // Fold at 75 octets without splitting UTF-8 multi-byte chars
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + (parts.length === 0 ? 75 : 74), bytes.length);
    // back up if mid multi-byte
    while (end > i && (bytes[end] & 0xc0) === 0x80) end--;
    const chunk = bytes.subarray(i, end).toString('utf8');
    parts.push(parts.length === 0 ? chunk : ' ' + chunk);
    i = end;
  }
  return parts.join('\r\n');
}

export interface IcsEvent {
  uid: string;
  date: string; // YYYY-MM-DD
  summary: string;
}

export function buildIcs(events: IcsEvent[], prodId = '-//Bifurcation Engine//v13//EN'): string {
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
  ];
  for (const e of events) {
    const ymd = e.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART;VALUE=DATE:${ymd}`);
    lines.push(foldLine(`SUMMARY:${escapeIcs(e.summary)}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}


/** localStorage v11 with legacy archive */

const VALID_STEPS: Step[] = [
  'TRIAGE',
  'BRIEF',
  'UNDERSTAND',
  'EXPAND',
  'ATTACK',
  'TEST',
  'DECIDE',
  'SYNTHESIS',
  'LEARN',
];

function mapOldStep(x: any): Step {
  if (VALID_STEPS.includes(x.step)) return x.step;
  if (VALID_STEPS.includes(x.stage)) return x.stage;
  if (x.phase === 'ANALYSIS' || x.phase === 'VERIFY') return 'TEST';
  if (x.phase === 'RADAR') return 'UNDERSTAND';
  if (x.phase === 'DECIDED') return 'DECIDE';
  return 'TRIAGE';
}

/** Read-only archive of pre-v11 data; no auto-conversion of scores/scenarios */
export function migrateFromLegacy(raw: any): {
  decision: Decision | null;
  report: string[];
} {
  const report: string[] = [];
  try {
    const e = emptyDecision();
    const d: Decision = {
      ...e,
      id: raw.id || e.id,
      title: raw.title || 'Archived decision',
      createdAt: raw.createdAt || Date.now(),
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      step: mapOldStep(raw),
      cycleCount: raw.cycleCount || 1,
      brief: {
        ...e.brief,
        decision: raw.brief?.decision || raw.rawInput || '',
        goal: raw.brief?.goal,
        facts: raw.brief?.facts || [],
        unknowns: raw.brief?.unknowns || [],
        assumptions: raw.brief?.assumptions || [],
        values: raw.brief?.values || [],
        constraints: raw.brief?.constraints || [],
        myOptions: (raw.brief?.myOptions || raw.brief?.alternatives || []).map(
          (o: any, i: number) => ({
            id: o.id || `opt_user_${i}`,
            title: o.title || o.tagline || `Option ${i + 1}`,
          })
        ),
        leaningOptionId: raw.brief?.leaningOptionId || 'NONE',
        errorCost: raw.brief?.errorCost || {},
        reversibility: raw.brief?.reversibility || {},
        reviewDates: raw.brief?.reviewDates || raw.reviewDates || [],
      },
      options: [],
      redTeam: [],
      hypotheses: [],
      experiments: [],
      evidence: [],
      journal: [],
      modelSuggestions: {},
      stepHistory: {},
    };

    // Do NOT import scenarios, scores, suggestedCalibration, costOfInaction as user data
    if (raw.scenarios || raw.alternatives?.some((a: any) => a.scenarios)) {
      report.push('Scenarios and probabilities were not migrated (model / disallowed)');
    }
    if (raw.legacySliders || raw.legacyRunway) {
      report.push(
        'Sliders and legacyRunway were not migrated; savings horizon can be entered as text in Constraints'
      );
    }
    if (raw.suggestedCalibration || raw.forecasts?.some((f: any) => f.estimateSource === 'MODEL')) {
      report.push('Model forecasts are not shown as user forecasts');
    }
    if (raw.executiveComment) {
      report.push('executiveComment kept only as archive note (not a verdict)');
      d.modelSuggestions.archivedExecutiveComment = raw.executiveComment;
    }
    if (raw.rawInput) {
      report.push('rawInput available for manual transfer into Brief');
      d.modelSuggestions.archivedRawInput = raw.rawInput;
    }

    return { decision: d, report };
  } catch (err) {
    report.push(`Migration error: ${String(err)}`);
    return { decision: null, report };
  }
}


const KEY = 'bifurcation_decisions_v11';
const ACTIVE = 'bifurcation_active_id_v11';
const PRIVACY = 'bifurcation_privacy_v11';
const ARCHIVE = 'bifurcation_archive_v11';
const MIGRATION_REPORT = 'bifurcation_migration_report_v11';
const DRIVE_MODE = 'bifurcation_drive_mode';
const DRIVE_TOKEN = 'bifurcation_drive_token';
const DRIVE_FILE = 'bifurcation-engine-v13.json';

let driveToken: string | null = null;
let driveConnected = false;
let driveSyncBusy = false;

function googleClientId(): string {
  try { return (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || ''; } catch { return ''; }
}
export function isDriveConfigured(): boolean { return Boolean(googleClientId()); }
export function isGoogleConnected(): boolean { return driveConnected && Boolean(driveToken); }
export function getDriveMode(): boolean { return localStorage.getItem(DRIVE_MODE) === 'google_drive'; }
export function setDriveMode(active: boolean): void {
  if (active) localStorage.setItem(DRIVE_MODE, 'google_drive');
  else localStorage.removeItem(DRIVE_MODE);
}
export function restoreGoogleTokenFromSession(): void {
  try { driveToken = sessionStorage.getItem(DRIVE_TOKEN); driveConnected = Boolean(driveToken); } catch {}
}

let gisLoading: Promise<void> | null = null;
function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as any).google) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google Identity Services could not be loaded'));
    document.head.appendChild(s);
  });
  return gisLoading;
}

export async function connectGoogleDrive(): Promise<{ok:boolean; message:string}> {
  const clientId = googleClientId();
  if (!clientId) return {ok:false, message:'Google Drive is not configured (VITE_GOOGLE_CLIENT_ID is missing).'};
  try {
    await loadGoogleIdentityScript();
    const token = await new Promise<string>((resolve, reject) => {
      const g = (window as any).google;
      if (!g?.accounts?.oauth2) return reject(new Error('Google Identity Services unavailable'));
      const client = g.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/drive.appdata',
        callback: (r:any) => r?.access_token ? resolve(r.access_token) : reject(new Error(r?.error || 'Google authorization failed')),
      });
      client.requestAccessToken();
    });
    driveToken = token;
    driveConnected = true;
    try { sessionStorage.setItem(DRIVE_TOKEN, token); } catch {}
    setDriveMode(true);

    // First connection: remote is primary if a library already exists; otherwise
    // seed Drive from the current local v13 library.
    const remote = await driveRead();
    if (remote) {
      localStorage.setItem(KEY, JSON.stringify(remote));
    } else {
      const local = getStoredDecisions();
      await driveWrite(local);
    }
    return {ok:true, message:'Google Drive connected.'};
  } catch (e:any) {
    driveConnected = false;
    return {ok:false, message:e?.message || 'Google Drive connection failed.'};
  }
}

export function disconnectGoogleDrive(): void {
  driveToken = null; driveConnected = false; setDriveMode(false);
  try { sessionStorage.removeItem(DRIVE_TOKEN); } catch {}
}

async function driveFileId(): Promise<string | null> {
  if (!driveToken) return null;
  const q = encodeURIComponent(`name='${DRIVE_FILE}' and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)`, {
    headers: {Authorization:`Bearer ${driveToken}`},
  });
  if (!r.ok) throw new Error('Google Drive API unavailable');
  const j = await r.json(); return j.files?.[0]?.id || null;
}

async function driveRead(): Promise<Decision[] | null> {
  if (!driveToken) return null;
  const id = await driveFileId(); if (!id) return null;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {headers:{Authorization:`Bearer ${driveToken}`}});
  if (!r.ok) throw new Error('Could not read the Google Drive library');
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('Invalid Google Drive library');
  return j as Decision[];
}

async function driveWrite(ds: Decision[]): Promise<void> {
  if (!driveToken) return;
  const id = await driveFileId();
  const metadata:any = {name:DRIVE_FILE}; if (!id) metadata.parents=['appDataFolder'];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], {type:'application/json'}));
  form.append('file', new Blob([JSON.stringify(ds)], {type:'application/json'}));
  const url = id ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const r = await fetch(url, {method:id?'PATCH':'POST', headers:{Authorization:`Bearer ${driveToken}`}, body:form});
  if (!r.ok) throw new Error('Could not save the library to Google Drive');
}

async function syncToDrive(ds: Decision[]): Promise<void> {
  if (!getDriveMode() || !driveConnected || !driveToken || driveSyncBusy) return;
  driveSyncBusy = true;
  try { await driveWrite(ds); } catch (e) { console.warn('[Drive] sync failed:', e); }
  finally { driveSyncBusy = false; }
}

export async function hydrateFromDrive(): Promise<Decision[] | null> {
  restoreGoogleTokenFromSession();
  if (!getDriveMode() || !driveConnected) return null;
  try {
    const remote = await driveRead();
    if (remote) { localStorage.setItem(KEY, JSON.stringify(remote)); return remote; }
  } catch (e) { console.warn('[Drive] hydrate failed:', e); }
  return null;
}

export function getStoredDecisions(): Decision[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
    const oldKeys=['bifurcation_decisions_v6','bifurcation_decisions_v2','bifurcation_decisions'];
    for (const k of oldKeys) {
      const old=localStorage.getItem(k);
      if(old){
        localStorage.setItem(ARCHIVE,old);
        const parsed=JSON.parse(old); const reports:string[]=[];
        if(Array.isArray(parsed)){
          reports.push(`Archived ${parsed.length} records from ${k}`);
          for(const item of parsed.slice(0,5)){const {report}=migrateFromLegacy(item);reports.push(...report);}
        }
        localStorage.setItem(MIGRATION_REPORT,JSON.stringify(reports)); localStorage.removeItem(k);
      }
    }
    return [];
  } catch { return []; }
}

export function saveDecisions(ds: Decision[]) {
  localStorage.setItem(KEY, JSON.stringify(ds));
  void syncToDrive(ds);
}
export const getActiveDecisionId = () => localStorage.getItem(ACTIVE) || '';
export const setActiveDecisionId = (id: string) => localStorage.setItem(ACTIVE, id);
export const getPrivacyAccepted = () => localStorage.getItem(PRIVACY) === 'true';
export const setPrivacyAccepted = (v: boolean) => localStorage.setItem(PRIVACY, String(v));
export const getArchived = () => localStorage.getItem(ARCHIVE);
export const getMigrationReport = (): string[] => { try { return JSON.parse(localStorage.getItem(MIGRATION_REPORT) || '[]'); } catch { return []; } };


/** JSON export/import — TZ A-06, I-11 (no zip/docx endpoints) */

export function exportDecisionJson(d: Decision): Blob {
  const payload = {
    schemaVersion: d.schemaVersion,
    exportedAt: new Date().toISOString(),
    decision: d,
  };
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
}

export function exportAllJson(decisions: Decision[]): Blob {
  return new Blob(
    [
      JSON.stringify(
        {
          schemaVersion: 8,
          exportedAt: new Date().toISOString(),
          decisions,
        },
        null,
        2
      ),
    ],
    { type: 'application/json' }
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(u);
}

export function parseImportedJson(text: string): Decision[] {
  const data = JSON.parse(text);
  if (Array.isArray(data.decisions)) return data.decisions;
  if (data.decision) return [data.decision];
  if (Array.isArray(data)) return data;
  throw new Error('Unknown import format');
}

