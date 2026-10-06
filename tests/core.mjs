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

add('numbers: percent from the input is allowed, an invented percent is reported', () => {
  assert.deepEqual(validateNumbers('Chance is 40%', 'I think 40% maybe'), []);
  assert.deepEqual(validateNumbers('Chance is 73%', 'I think 40% maybe'), ['73%']);
  assert.deepEqual(validateNumbers('About 3 options', 'I have 3 options'), []);
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
