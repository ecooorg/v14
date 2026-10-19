import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../server/contextBuilder.ts';
import { applyStatePatch } from '../server/statePipeline.ts';

const mk = () => {
  let st = { passport: { goal: 'Ship a tool', projectType: 'software' }, items: {} };
  const ap = (actor, ops) => { const r = applyStatePatch(st, { ops }, { actor, sourceRef: 't' }); assert.ok(r.ok, JSON.stringify(r)); st = r.state; };
  ap('human', [{ op: 'add', section: 'decisions', item: { text: 'Use PostgreSQL', rationale: 'ADR-01' } }, { op: 'add', section: 'requirements', item: { text: 'Must export PDF', acceptance: 'PDF opens' } }]);
  ap('human', [{ op: 'add', section: 'facts', item: { text: 'Budget is fixed at ten units', ref: 'msg:1' } }]);
  ap('agent', [{ op: 'add', section: 'facts', item: { text: 'Unsourced claim about market' } }, { op: 'add', section: 'hypotheses', item: { text: 'Users prefer PDF export' } }, { op: 'add', section: 'hypotheses', item: { text: 'Rejected idea' } }]);
  ap('human', [{ op: 'reject', section: 'hypotheses', id: 'H-2' }]);
  return st;
};

test('P06 context: decisions and requirements always included; unverified and rejected items excluded', () => {
  const c = buildContext({ state: mk(), task: 'Analyse PDF export' });
  assert.match(c.prompt, /Use PostgreSQL/); assert.match(c.prompt, /Must export PDF/); assert.match(c.prompt, /Budget is fixed/);
  assert.doesNotMatch(c.prompt, /Unsourced claim/); assert.doesNotMatch(c.prompt, /Rejected idea/);
  assert.ok(c.excluded.some((x) => x.reason === 'unverified_fact') && c.excluded.some((x) => x.reason === 'rejected'));
  assert.match(c.prompt, /TASK:\nAnalyse PDF export/);
  assert.equal(c.historyReason, undefined);
});

test('P06 context: token limit drops low-relevance items, never decisions or requirements; tokens are measured', () => {
  let st = mk();
  const ops = Array.from({ length: 30 }, (_, i) => ({ op: 'add', section: 'hypotheses', item: { text: `Filler hypothesis number ${i} ` + 'word '.repeat(40) } }));
  ops.push({ op: 'add', section: 'hypotheses', item: { text: 'Pricing strategy hypothesis about subscriptions' } });
  const r = applyStatePatch(st, { ops }, { actor: 'agent', sourceRef: 't' }); st = r.state;
  const big = buildContext({ state: st, task: 'subscriptions pricing', maxTokens: 100000 });
  const small = buildContext({ state: st, task: 'subscriptions pricing', maxTokens: 700 });
  assert.ok(small.tokens.total < big.tokens.total);
  assert.ok(small.excluded.some((x) => x.reason === 'token_limit'));
  assert.match(small.prompt, /Use PostgreSQL/); assert.match(small.prompt, /Must export PDF/);
  assert.match(small.prompt, /Pricing strategy/);   // relevant item survives the cut
  assert.ok(small.tokens.total > 0 && small.tokens.state > 0 && small.tokens.task > 0);
});

test('P06 context: history only with a recorded reason; artifacts are referenced and capped', () => {
  const st = mk();
  assert.doesNotMatch(buildContext({ state: st, task: 't', history: 'old chat' }).prompt, /old chat/);
  const c = buildContext({ state: st, task: 't', history: 'old chat', historyReason: 'user asked to continue', artifacts: [{ id: 'A1', version: 2, filename: 'a.txt', text: 'x'.repeat(40000) }], artifactMaxTokens: 100 });
  assert.match(c.prompt, /old chat/); assert.equal(c.historyReason, 'user asked to continue');
  assert.match(c.prompt, /artifact:A1@2/); assert.match(c.prompt, /\[truncated\]/);
});
