import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStatePatch, compactState, isEstablishedFact, estimateTokens, stateItemsSchema } from '../server/statePipeline.ts';
import { stateSchemaWithPassport } from '../server/contracts.ts';

const agent = { actor: 'agent', sourceRef: 'run:1', now: new Date('2026-10-10T10:00:00Z') };
const human = { actor: 'human', sourceRef: 'ui:1', now: new Date('2026-10-10T11:00:00Z') };
const add = (section, item) => ({ ops: [{ op: 'add', section, item }] });
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.state; };

test('model items are always proposed, ids and provenance are assigned by the system', () => {
  const s = ok(applyStatePatch({}, { ops: [
    { op: 'add', section: 'facts', item: { text: 'Budget is 10k' } },
    { op: 'add', section: 'hypotheses', item: { text: 'Users prefer mobile' } },
    { op: 'add', section: 'risks', item: { text: 'Vendor lock-in', severity: 'high' } },
  ] }, agent));
  assert.deepEqual([s.items.facts[0].id, s.items.facts[0].status, s.items.facts[0].author, s.items.facts[0].source], ['F-1', 'proposed', 'agent', 'run:1']);
  assert.equal(s.items.hypotheses[0].origin, 'model');
  assert.equal(s.items.risks[0].review, 'proposed');
  assert.equal(s.items.facts[0].at, '2026-10-10T10:00:00.000Z');
});

test('policy: a model cannot confirm, cannot touch decisions, cannot set system fields', () => {
  for (const patch of [
    add('facts', { text: 'x', status: 'confirmed' }),
    add('decisions', { text: 'We use X' }),
    add('facts', { text: 'x', author: 'human' }),
    add('facts', { text: 'x', id: 'F-99' }),
  ]) assert.equal(applyStatePatch({}, patch, agent).ok, false);
  const withFact = ok(applyStatePatch({}, add('facts', { text: 'x' }), agent));
  const r = applyStatePatch(withFact, { ops: [{ op: 'update', section: 'facts', id: 'F-1', changes: { status: 'confirmed' } }] }, agent);
  assert.equal(r.errors[0].code, 'POLICY_STATUS');
});

test('decisions: only a human; a hypothesis never becomes a decision by itself', () => {
  const s = ok(applyStatePatch({}, add('decisions', { text: 'Use PostgreSQL', rationale: 'ADR-01' }), human));
  assert.deepEqual([s.items.decisions[0].id, s.items.decisions[0].decided_by], ['D-1', 'human']);
  const r = applyStatePatch(s, { ops: [{ op: 'update', section: 'decisions', id: 'D-1', changes: { text: 'Use MySQL' } }] }, agent);
  assert.equal(r.errors[0].code, 'POLICY_DECISIONS_HUMAN_ONLY');
  assert.equal(applyStatePatch(s, { ops: [{ op: 'reject', section: 'decisions', id: 'D-1' }] }, human).errors[0].code, 'UNSUPPORTED');
});

test('human confirms a proposed item; a model cannot change a confirmed one', () => {
  let s = ok(applyStatePatch({}, add('hypotheses', { text: 'H' }), agent));
  s = ok(applyStatePatch(s, { ops: [{ op: 'update', section: 'hypotheses', id: 'H-1', changes: { status: 'confirmed' } }] }, human));
  assert.deepEqual([s.items.hypotheses[0].status, s.items.hypotheses[0].confirmedBy, s.items.hypotheses[0].updatedBy], ['confirmed', 'human', 'human']);
  const r = applyStatePatch(s, { ops: [{ op: 'reject', section: 'hypotheses', id: 'H-1' }] }, agent);
  assert.equal(r.errors[0].code, 'POLICY_CONFIRMED_IMMUTABLE');
});

test('fact without ref is unverified and not established; artifact+quote is the one rule-based confirmation', () => {
  let s = ok(applyStatePatch({}, add('facts', { text: 'No source' }), human));
  assert.equal(s.items.facts[0].unverified, true);
  assert.equal(isEstablishedFact(s.items.facts[0]), false);   // confirmed by a human, but no source
  s = ok(applyStatePatch(s, { ops: [{ op: 'update', section: 'facts', id: 'F-1', changes: { ref: 'msg:42' } }] }, human));
  assert.equal(isEstablishedFact(s.items.facts[0]), true);
  const a = ok(applyStatePatch({}, add('facts', { text: 'Limit 5 MB', ref: 'artifact:A1@1', quote: 'max 5 MB' }), agent));
  assert.deepEqual([a.items.facts[0].status, a.items.facts[0].confirmedBy], ['confirmed', 'rule:artifact_quote']);
  const b = ok(applyStatePatch({}, add('facts', { text: 'Limit', ref: 'msg:1' }), agent));
  assert.equal(b.items.facts[0].status, 'proposed');
  const c = ok(applyStatePatch({}, add('facts', { text: 'Limit', ref: 'artifact:A1@1', quote: 'q' }), { ...agent, policy: { autoConfirmArtifactQuote: false } }));
  assert.equal(c.items.facts[0].status, 'proposed');
});

test('patch is atomic: one refused operation applies nothing; input state is not mutated', () => {
  const start = { goal: 'g' };
  const r = applyStatePatch(start, { ops: [{ op: 'add', section: 'facts', item: { text: 'ok' } }, { op: 'add', section: 'decisions', item: { text: 'no' } }] }, agent);
  assert.equal(r.ok, false);
  assert.deepEqual(start, { goal: 'g' });
  assert.equal(applyStatePatch({}, { ops: [] }, agent).errors[0].code, 'SCHEMA');
  assert.equal(applyStatePatch({}, { ops: [{ op: 'update', section: 'facts', id: 'F-9', changes: {} }] }, agent).errors[0].code, 'NOT_FOUND');
});

test('model rejects only its own proposed items; ids keep growing', () => {
  let s = ok(applyStatePatch({}, add('unknowns', { text: 'Who pays?', impact: 'high' }), agent));
  s = ok(applyStatePatch(s, { ops: [{ op: 'reject', section: 'unknowns', id: 'U-1', reason: 'duplicate' }, { op: 'add', section: 'unknowns', item: { text: 'Next', impact: 'low' } }] }, agent));
  assert.deepEqual([s.items.unknowns[0].review, s.items.unknowns[1].id], ['rejected', 'U-2']);
});

test('State schema: invalid items are refused wherever State is written', () => {
  assert.equal(stateSchemaWithPassport.safeParse({ items: { facts: [{ id: 'bad' }] } }).success, false);
  assert.equal(stateSchemaWithPassport.safeParse({ goal: 'x' }).success, true);
});

test('compaction: protected classes keep IDs and full text; low priority is shortened first', () => {
  const long = (t) => `${t} ` + 'x'.repeat(900);
  const mk = (n, extra) => Array.from({ length: n }, (_, i) => ({ text: long(`f${i}`), ...extra }));
  let s = {};
  s = ok(applyStatePatch(s, { ops: [
    ...mk(6, {}).map((item) => ({ op: 'add', section: 'facts', item: { ...item, ref: 'msg:1' } })),
    { op: 'add', section: 'decisions', item: { text: long('decision'), rationale: long('why') } },
    { op: 'add', section: 'requirements', item: { text: long('req'), acceptance: long('accept') } },
    { op: 'add', section: 'risks', item: { text: long('high risk'), severity: 'high' } },
    { op: 'add', section: 'risks', item: { text: long('low risk'), severity: 'low' } },
  ] }, human));
  // make one fact rejected and one proposed: they must be shortened before confirmed ones
  s = ok(applyStatePatch(s, { ops: [{ op: 'reject', section: 'facts', id: 'F-1' }, { op: 'update', section: 'facts', id: 'F-2', changes: { status: 'proposed' } }] }, human));
  const before = structuredClone(s.items);
  const limits = { facts: 900, risks: 300, decisions: 1, requirements: 1 };
  const c = compactState(s, limits);
  assert.equal(c.ok, true); assert.equal(c.changed, true);
  const after = c.state.items;
  for (const sec of ['decisions', 'requirements']) assert.deepEqual(after[sec], before[sec]);   // never compressed
  assert.deepEqual(after.risks.find((r) => r.severity === 'high'), before.risks.find((r) => r.severity === 'high'));
  for (const sec of Object.keys(before)) assert.deepEqual(after[sec].map((x) => x.id), before[sec].map((x) => x.id));   // no ID lost
  assert.equal(after.risks.find((r) => r.severity === 'low').compacted, true);
  const firstTwo = c.compacted.filter((x) => x.section === 'facts').slice(0, 2).map((x) => x.id);
  assert.deepEqual(firstTwo, ['F-1', 'F-2']);   // rejected, then proposed, before confirmed
  assert.ok(estimateTokens(after.facts) < estimateTokens(before.facts));
  assert.equal(stateItemsSchema.safeParse(after).success, true);
  assert.deepEqual(before, structuredClone(s.items));   // input untouched
  assert.equal(compactState({}, limits).changed, false);
});
