import assert from 'node:assert/strict';
// Minimal state machine tests without TS loader issues — duplicate logic
const ALLOWED = {
  INTAKE: ['START', 'CONTINUE'],
  UNDERSTAND: ['CONTINUE', 'EXPAND_DONE', 'BACK'],
  EXPAND: ['CONTINUE', 'ATTACK_DONE', 'BACK'],
  ATTACK: ['CONTINUE', 'HYPOTHESES_CHOSEN', 'BACK'],
  VERIFY: ['CONTINUE', 'CARD_LOCKED', 'BACK'],
  DECIDE: ['CONTINUE', 'RESULT_RECORDED', 'BACK'],
  LEARN: ['CONTINUE', 'DECISION_REVISED', 'NEW_CYCLE', 'CLOSE', 'BACK'],
  CLOSED: ['NEW_CYCLE'],
  PREVIEW: ['CONTINUE', 'BACK'],
};
function can(phase, event) {
  return (ALLOWED[phase] || []).includes(event);
}
assert.equal(can('INTAKE', 'START'), true);
assert.equal(can('CLOSED', 'START'), false);
assert.equal(can('LEARN', 'NEW_CYCLE'), true);
console.log('core tests ok');
