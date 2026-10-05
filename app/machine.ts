/** Canonical v15 Decision Cycle state machine. UI must not own a separate phase. */
export type Phase = 'INTAKE'|'PREVIEW'|'UNDERSTAND'|'EXPAND'|'ATTACK'|'VERIFY'|'DECIDE'|'LEARN'|'CLOSED';
export type Event = 'START'|'CONTINUE'|'EXPAND_DONE'|'ATTACK_DONE'|'HYPOTHESES_CHOSEN'|'CARD_LOCKED'|'RESULT_RECORDED'|'DECISION_REVISED'|'NEW_CYCLE'|'CLOSE'|'BACK';
export type TransitionEvent = { event: Event; timestamp: number; from: Phase; to: Phase; cycleId: string };
export type MachineState = { phase: Phase; cycleId: string; cycleCount: number; parentCycleId?: string; history: Phase[]; transitionHistory: TransitionEvent[] };
const NEXT: Partial<Record<Phase, Partial<Record<Event, Phase>>>> = {
  INTAKE:{START:'UNDERSTAND',CONTINUE:'UNDERSTAND'}, PREVIEW:{CONTINUE:'UNDERSTAND'},
  UNDERSTAND:{CONTINUE:'EXPAND',EXPAND_DONE:'EXPAND'}, EXPAND:{CONTINUE:'ATTACK',ATTACK_DONE:'ATTACK'},
  ATTACK:{CONTINUE:'VERIFY',HYPOTHESES_CHOSEN:'VERIFY'}, VERIFY:{CONTINUE:'DECIDE',CARD_LOCKED:'DECIDE'},
  DECIDE:{CONTINUE:'LEARN',RESULT_RECORDED:'LEARN'}, LEARN:{CLOSE:'CLOSED',NEW_CYCLE:'UNDERSTAND',DECISION_REVISED:'LEARN'}, CLOSED:{NEW_CYCLE:'UNDERSTAND'}
};
export const PHASE_PROGRESS = [
  {id:'Understanding', phases:['INTAKE','PREVIEW','UNDERSTAND'] as Phase[]}, {id:'Options', phases:['EXPAND'] as Phase[]},
  {id:'Stress-test', phases:['ATTACK'] as Phase[]}, {id:'Test', phases:['VERIFY','DECIDE'] as Phase[]}, {id:'Check-in', phases:['LEARN','CLOSED'] as Phase[]}
];
export function createInitialState(): MachineState { const id=crypto.randomUUID(); return {phase:'INTAKE',cycleId:id,cycleCount:1,history:['INTAKE'],transitionHistory:[]}; }
export function canTransition(state: MachineState,event: Event): boolean { return Boolean(NEXT[state.phase]?.[event] || event==='BACK'); }
export function transition(state: MachineState,event: Event): MachineState {
  if(!canTransition(state,event)) throw Object.assign(new Error('Illegal transition'),{code:'ILLEGAL_TRANSITION'});
  const now=Date.now();
  if(event==='BACK'){ const hist=state.history.slice(0,-1); const to=hist.at(-1)||'INTAKE'; return {...state,phase:to,history:hist.length?hist:['INTAKE'],transitionHistory:[...state.transitionHistory,{event,timestamp:now,from:state.phase,to,cycleId:state.cycleId}]}; }
  let cycleId=state.cycleId, parentCycleId=state.parentCycleId, cycleCount=state.cycleCount;
  if(event==='NEW_CYCLE'){ parentCycleId=state.cycleId; cycleId=crypto.randomUUID(); cycleCount+=1; }
  const to=NEXT[state.phase]?.[event] || state.phase;
  return {...state,phase:to,cycleId,parentCycleId,cycleCount,history:[...state.history,to],transitionHistory:[...state.transitionHistory,{event,timestamp:now,from:state.phase,to,cycleId}]};
}
