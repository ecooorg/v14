import { createInitialState, type MachineState } from './machine';
import type { DialogRecord, Library } from './storage';

export function migrateV14ToV15(input: unknown): Library {
  const src = input as { version?: number; dialogs?: any[]; settings?: any };
  if (!src || src.version !== 14 || !Array.isArray(src.dialogs)) throw new Error('INVALID_V14_LIBRARY');
  const dialogs: DialogRecord[] = src.dialogs.map((d:any) => {
    const old = d.state;
    const state: MachineState = old && typeof old === 'object' && 'phase' in old && 'history' in old
      ? { ...createInitialState(), ...old, cycleId: old.cycleId || crypto.randomUUID(), transitionHistory: old.transitionHistory || [] }
      : createInitialState();
    return {...d, state, cycleCount: d.cycleCount || state.cycleCount, phase: state.phase};
  });
  return {version:15, schemaVersion:15, dialogs, settings:{mode:src.settings?.mode==='expert'?'expert':'normal',storageMode:src.settings?.storageMode||null,userGeminiKey:src.settings?.userGeminiKey,privacyAccepted:Boolean(src.settings?.privacyAccepted)}};
}
