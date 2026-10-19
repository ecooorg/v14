// Stage 2: state reading, size cap, hypotheses never in facts, label scrubbing.
import assert from 'node:assert/strict';
import { normalizeState, mergeModelState, firstQuestionOnly, buildVisibleReply, scrubInternalLabels, STATE_LIMITS } from '../server/reasoningState.ts';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('old v16 state is read without errors; junk gives an empty state', () => {
  const s = normalizeState({ facts: ['a'], assumptions: [], unknowns: ['x'], options: [{ title: 'opt' }], hypotheses: [], expectations: [] });
  assert.deepEqual([s.facts, s.options, s.coreProblem], [['a'], ['opt'], '']);
  for (const j of ['junk', null, 5, [], undefined]) assert.equal(normalizeState(j).facts.length, 0);
});
t('size is capped (chars, list length, total)', () => {
  const s = normalizeState({ facts: Array.from({ length: 300 }, (_, i) => `fact ${i} ` + 'x'.repeat(900)),
    unknowns: Array.from({ length: 300 }, (_, i) => 'u' + i), coreProblem: 'p'.repeat(2000), extra: 'drop me' });
  assert.ok(s.facts.length <= STATE_LIMITS.itemsPerList && s.facts[0].length <= STATE_LIMITS.itemChars);
  assert.ok(s.coreProblem.length <= STATE_LIMITS.scalarChars);
  assert.equal('extra' in s, false);
  const total = ['facts', 'assumptions', 'unknowns', 'options', 'hypotheses', 'expectations'].reduce((a, k) => a + s[k].length, 0);
  assert.ok(total <= STATE_LIMITS.totalItems);
});
t('a model hypothesis never stays in facts', () => {
  assert.deepEqual(normalizeState({ facts: ['Salary is too low'], hypotheses: ['salary is too low'] }).facts, []);
  const m = mergeModelState({ facts: ['Moving makes the child lose friends', 'I work remotely'], hypotheses: [] },
    { previous: normalizeState({}), userTexts: ['I work remotely and want to move'], lastAssistantText: 'Moving may make the child lose friends at school.' });
  assert.deepEqual(m.facts, ['I work remotely']);
  assert.deepEqual(m.hypotheses, ['Moving makes the child lose friends']);
});
t('missing keys carry over from the previous state', () => {
  const prev = normalizeState({ coreProblem: 'Move or stay', facts: ['f1'] });
  const m = mergeModelState({ unknowns: ['u1'] }, { previous: prev, userTexts: [], lastAssistantText: '' });
  assert.deepEqual([m.coreProblem, m.facts, m.unknowns], ['Move or stay', ['f1'], ['u1']]);
});
t('one question only; service labels are scrubbed', () => {
  assert.equal(firstQuestionOnly('What is the budget? And the deadline?'), 'What is the budget?');
  const c = scrubInternalLabels('Fine (USER FACT)\nHYPOTHESIS: maybe\nproblemClear: true');
  assert.ok(!/USER FACT|HYPOTHESIS|problemClear/.test(c));
});
const qs = (x) => (x.match(/[?？]/g) || []).length;
t('FIX-02: two questions in reply -> one', () => {
  const r = buildVisibleReply('Fact one. What is the budget? And when is the deadline?', '', true);
  assert.equal(qs(r), 1); assert.ok(r.includes('budget'));
});
t('FIX-02: question in reply and another in question field -> only the field one', () => {
  const r = buildVisibleReply('Fact one. What is the budget? Fact two.', 'Who decides?', true);
  assert.equal(qs(r), 1); assert.ok(r.includes('Who decides?') && !r.includes('budget'));
  assert.ok(r.includes('Fact one.') && r.includes('Fact two.'));
});
t('FIX-02: verbatim question already in reply is not repeated', () => {
  const r = buildVisibleReply('Fact one. Who decides?', 'Who decides?', true);
  assert.equal(r, 'Fact one. Who decides?');
});
t('FIX-02: single question in field is appended as before', () => {
  assert.equal(buildVisibleReply('Fact.', 'Who decides?', true), 'Fact.\n\nWho decides?');
  assert.equal(buildVisibleReply('Fact.', '', true), 'Fact.');
});
t('FIX-02: no questions when not allowed (HIGH context / crisis)', () => {
  const r = buildVisibleReply('Fact one. What is the budget? Fact two.', 'Who decides?', false);
  assert.equal(qs(r), 0); assert.ok(r.includes('Fact one.') && r.includes('Fact two.'));
  assert.equal(qs(buildVisibleReply('Is this right?', 'Why?', false)), 0);
});
console.log(n + ' tests passed');

// v19 / S-1: removing a question sentence must not glue the neighbours together
{
  const a = buildVisibleReply('Первая часть. Что вы думаете? Это важно.', '', false);
  assert.ok(!/\.[А-ЯA-Z]/.test(a), `glued sentences: ${a}`);
  assert.ok(a.includes('часть. Это'));
  const b = buildVisibleReply('Esto es una parte. ¿Qué piensas? Esto importa.', '', false);
  assert.ok(!/\.[A-ZÁÉÍÓÚ]/.test(b), `glued sentences: ${b}`);
  console.log('ok v19 S-1 no glued sentences');
}
