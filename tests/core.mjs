import assert from 'node:assert/strict';
import { createInitialState, transition, canTransition } from '../app/machine.ts';
import { migrateV14ToV15 } from '../app/migration.ts';

const s=createInitialState();
assert.equal(s.phase,'INTAKE');
assert.equal(canTransition(s,'START'),true);
const u=transition(s,'START');
assert.equal(u.phase,'UNDERSTAND');
assert.equal(u.transitionHistory.at(-1).event,'START');
assert.equal(canTransition(u,'CARD_LOCKED'),false);
assert.throws(()=>transition(u,'CARD_LOCKED'),/Illegal transition/);
const b=transition(u,'BACK');
assert.equal(b.phase,'INTAKE');
assert.equal(b.transitionHistory.at(-1).event,'BACK');
const l={version:14,dialogs:[{id:'d1',title:'x',createdAt:1,updatedAt:2,phase:'UNDERSTAND',messages:[{id:'m',role:'user',text:'hello',at:1}],state:{phase:'UNDERSTAND',cycleCount:1,history:['INTAKE','UNDERSTAND']},cycleCount:1}],settings:{mode:'normal',storageMode:'session'}};
const m=migrateV14ToV15(l);
assert.equal(m.version,15); assert.equal(m.schemaVersion,15); assert.equal(m.dialogs[0].messages[0].text,'hello'); assert.equal(m.dialogs[0].state.phase,'UNDERSTAND');
console.log('v15 core + migration tests ok');
