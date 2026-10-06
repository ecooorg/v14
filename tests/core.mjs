// Core logic tests: real modules, no network. Run: npm run test:core
import assert from 'node:assert/strict';
import { validateNumbers } from '../src/core/numberValidator.ts';
import { triage } from '../src/core/triage.ts';
import { evpi } from '../src/core/evpi.ts';
import { brierScore } from '../src/core/brier.ts';
import { buildIcs } from '../src/core/icsBuilder.ts';
import { canonicalJson, sha256Hex } from '../src/core/sha256Export.ts';
import { APP_VERSION } from '../src/config.ts';
let n = 0; const tests = [];
const add = (name, fn) => tests.push([name, fn]);

add('numbers: JSON operand commas are not parsed as decimal numbers', () => {
  const json = '{"derived_numbers":[{"value":36,"formula":"1800 / 5000 * 100","operands":[1800,5000,100]}]}';
  assert.deepEqual(validateNumbers(json, 'I earn 5000 and pay 1800.', ['36']), []);
});
add('numbers: grounded amounts/counts are allowed, invented numbers are reported', () => {
  assert.deepEqual(validateNumbers('Chance is 40%', 'I think 40% maybe'), []);
  assert.deepEqual(validateNumbers('Chance is 73%', 'I think 40% maybe'), ['73%']);
  assert.deepEqual(validateNumbers('The budget is 2000', 'My budget is 2000'), []);
  assert.deepEqual(validateNumbers('The budget is 3500', 'My budget is 2000'), ['3500']);
  assert.deepEqual(validateNumbers('About 3 options', 'I have 3 options'), []);
});
add('numbers: method scaffolding does not authorize invented user claims', () => {
  assert.deepEqual(validateNumbers('Rent for three months', 'I am considering a move'), ['word:3']);
  assert.deepEqual(validateNumbers('Rent for 3 months', 'I am considering a move'), ['3']);
  assert.deepEqual(validateNumbers('Rent for three months', 'I am considering 3 months'), []);
  assert.deepEqual(validateNumbers('A two-step test', 'I have 2 steps'), []);
});
add('numbers: generic structural counts are allowed, factual units remain strict', () => {
  assert.deepEqual(validateNumbers('Рассмотрите 2–3 фактора и два варианта.', 'Я думаю о переезде.'), []);
  assert.deepEqual(validateNumbers('Вероятность — 70%.', 'Я думаю о переезде.'), ['70%']);
  assert.deepEqual(validateNumbers('Через 3 месяца ситуация изменится.', 'Я думаю о переезде.'), ['3']);
  assert.deepEqual(validateNumbers('Рассмотрите три фактора.', 'Я думаю о переезде.'), []);
});
add('numbers: Russian number words are grounded by user input', () => {
  assert.deepEqual(validateNumbers('Срок — три месяца', 'Я планирую три месяца'), []);
  assert.deepEqual(validateNumbers('Срок — три месяца', 'Я планирую поездку'), ['word:3']);
  assert.deepEqual(validateNumbers('Срок — двадцать три дня', 'У меня 23 дня'), []);
  assert.deepEqual(validateNumbers('Срок — двадцать три дня', 'У меня 22 дня'), ['word:23']);
  assert.deepEqual(validateNumbers('The period is twenty three days', 'I have 23 days'), []);
});
add('numbers: user-supplied percentage may be echoed as a bare derived value, but not as an unrelated fact', () => {
  const input = 'Я думаю, что примерно на 50%.';
  assert.deepEqual(validateNumbers('{\"derived_numbers\":[{\"value\":50,\"formula\":\"user estimate\"}]}', input), []);
  assert.deepEqual(validateNumbers('Ваша оценка составляет 50%.', input), []);
  assert.deepEqual(validateNumbers('Аренда составит 50 евро.', input), ['50']);
});
add('numbers: derived percentage may use the mathematical constant 100', () => {
  assert.deepEqual(validateNumbers(
    '{"paragraph":"Расходы составляют 36% зарплаты.","derived_numbers":[{"value":36,"formula":"1800 / 5000 * 100","operands":[1800,5000,100]}]}',
    'Я зарабатываю 5000 евро и плачу 1800 евро за жильё.',
    ['36']
  ), []);
  assert.deepEqual(validateNumbers(
    '{"paragraph":"Зарплата выше расходов примерно на 177.78%.","derived_numbers":[{"value":177.78,"formula":"(5000 - 1800) / 1800 * 100","operands":[5000,1800,1800,100]}]}',
    'Я зарабатываю 5000 евро и плачу 1800 евро за жильё.',
    ['177.78']
  ), []);
});

add('numbers: derived values remain trusted when operands are listed in a different order', () => {
  const json = '{"paragraph":"Зарплата выше расходов примерно на 177.78%.","derived_numbers":[{"value":177.78,"formula":"(5000 - 1800) / 1800 * 100","operands":[100,1800,5000,1800]}]}';
  assert.deepEqual(validateNumbers(json, 'Я зарабатываю 5000 евро и плачу 1800 евро за жильё.', ['177.78']), []);
});

add('numbers: formula constant 100 is still strict outside derived_numbers', () => {
  assert.deepEqual(validateNumbers('The increase is 100%.', 'I think 50%.'), ['100%']);
  assert.deepEqual(validateNumbers('{"derived_numbers":[{"value":36,"formula":"1800 / 5000 * 100","operands":[1800,5000,100]}]}', 'I earn 5000 and pay 1800.', ['36']), []);
});
add('triage: crisis, values-only, overkill, method', () => {
  const base = { crisis: false, onlyValues: false, costly: false, hardToUndo: false, resolvableUnknowns: false, longHorizon: false };
  assert.equal(triage({ ...base, crisis: true }), 'CRISIS_STOP');
  assert.equal(triage({ ...base, onlyValues: true }), 'VALUES_ONLY');
  assert.equal(triage(base), 'OVERKILL');
  assert.equal(triage({ ...base, costly: true, hardToUndo: true, resolvableUnknowns: true, longHorizon: true }), 'METHOD_JUSTIFIED');
});
add('evpi: known case', () => {
  assert.deepEqual(evpi(0.5, 100, 50), { evOpen: 25, bestNoInfo: 25, evPerfect: 50, evpi: 25 });
});
add('brier: score and small-sample warning', () => {
  const r = brierScore([{ p: 1, outcome: 1 }, { p: 0, outcome: 1 }]);
  assert.equal(r.score, 0.5); assert.equal(r.n, 2); assert.ok(r.warning);
});
add('sha256: canonical JSON is key-order independent; known digest', async () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
add('ics: valid calendar envelope carries the current version', () => {
  const ics = buildIcs([]);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR') && ics.includes('END:VCALENDAR'));
  assert.ok(ics.includes(`//v${APP_VERSION}//`));
});

for (const [name, fn] of tests) { await fn(); n++; console.log('ok -', name); }
console.log(`${n} tests passed`);
