/**
 * Unified state machine (SM-1…SM-5)
 */
export type Phase =
  | 'INTAKE'
  | 'PREVIEW'
  | 'UNDERSTAND'
  | 'EXPAND'
  | 'ATTACK'
  | 'VERIFY'
  | 'DECIDE'
  | 'LEARN'
  | 'CLOSED';

export type Event =
  | 'START'
  | 'CONTINUE'
  | 'EXPAND_DONE'
  | 'ATTACK_DONE'
  | 'HYPOTHESES_CHOSEN'
  | 'CARD_LOCKED'
  | 'RESULT_RECORDED'
  | 'DECISION_REVISED'
  | 'NEW_CYCLE'
  | 'CLOSE'
  | 'BACK';

const ALLOWED: Record<Phase, Event[]> = {
  INTAKE: ['START', 'CONTINUE'],
  PREVIEW: ['CONTINUE', 'BACK'],
  UNDERSTAND: ['CONTINUE', 'EXPAND_DONE', 'BACK'],
  EXPAND: ['CONTINUE', 'ATTACK_DONE', 'BACK'],
  ATTACK: ['CONTINUE', 'HYPOTHESES_CHOSEN', 'BACK'],
  VERIFY: ['CONTINUE', 'CARD_LOCKED', 'BACK'],
  DECIDE: ['CONTINUE', 'RESULT_RECORDED', 'BACK'],
  LEARN: ['CONTINUE', 'DECISION_REVISED', 'NEW_CYCLE', 'CLOSE', 'BACK'],
  CLOSED: ['NEW_CYCLE'],
};

const NEXT: Partial<Record<Phase, Partial<Record<Event, Phase>>>> = {
  INTAKE: { START: 'UNDERSTAND', CONTINUE: 'UNDERSTAND' },
  PREVIEW: { CONTINUE: 'UNDERSTAND' },
  UNDERSTAND: { CONTINUE: 'EXPAND', EXPAND_DONE: 'EXPAND' },
  EXPAND: { CONTINUE: 'ATTACK', ATTACK_DONE: 'ATTACK' },
  ATTACK: { CONTINUE: 'VERIFY', HYPOTHESES_CHOSEN: 'VERIFY' },
  VERIFY: { CONTINUE: 'DECIDE', CARD_LOCKED: 'DECIDE' },
  DECIDE: { CONTINUE: 'LEARN', RESULT_RECORDED: 'LEARN' },
  LEARN: { CLOSE: 'CLOSED', NEW_CYCLE: 'UNDERSTAND', DECISION_REVISED: 'LEARN' },
  CLOSED: { NEW_CYCLE: 'UNDERSTAND' },
};

export type MachineState = {
  phase: Phase;
  cycleCount: number;
  parentCycleId?: string;
  history: Phase[];
};

export function createInitialState(): MachineState {
  return { phase: 'INTAKE', cycleCount: 1, history: ['INTAKE'] };
}

export function canTransition(state: MachineState, event: Event): boolean {
  return (ALLOWED[state.phase] || []).includes(event);
}

export function transition(state: MachineState, event: Event): MachineState {
  if (!canTransition(state, event)) {
    throw Object.assign(new Error('Illegal transition'), { code: 'ILLEGAL_TRANSITION' });
  }
  if (event === 'BACK') {
    const hist = state.history.slice(0, -1);
    const phase = hist[hist.length - 1] || 'INTAKE';
    return { ...state, phase, history: hist.length ? hist : ['INTAKE'] };
  }
  const phase = NEXT[state.phase]?.[event] || state.phase;
  let cycleCount = state.cycleCount;
  let parentCycleId = state.parentCycleId;
  if (event === 'NEW_CYCLE') {
    parentCycleId = `cycle-${state.cycleCount}`;
    cycleCount = state.cycleCount + 1;
  }
  return {
    ...state,
    phase,
    cycleCount,
    parentCycleId,
    history: [...state.history, phase],
  };
}

export const PHASE_PROGRESS: { id: string; phases: Phase[] }[] = [
  { id: 'Understanding', phases: ['INTAKE', 'PREVIEW', 'UNDERSTAND'] },
  { id: 'Options', phases: ['EXPAND'] },
  { id: 'Stress-test', phases: ['ATTACK'] },
  { id: 'Test', phases: ['VERIFY', 'DECIDE'] },
  { id: 'Check-in', phases: ['LEARN', 'CLOSED'] },
];
