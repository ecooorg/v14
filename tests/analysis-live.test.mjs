import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, getProject, updateProjectState, StateVersionConflict } from '../server/projectRepository.ts';
import { runAnalysis, reviewItem, addDecision, listProjectLedger, listProjectArtifacts, AnalysisError } from '../server/analysisService.ts';
import { readArtifact } from '../server/artifactRepository.ts';
import { createFakeAdapter } from '../server/fakeProvider.ts';
import { newRouterState } from '../server/router.ts';
import { closeDatabase } from '../server/database.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const out = { summary: 'Two risks found.', patch: { ops: [
  { op: 'add', section: 'facts', item: { text: 'Fact from the model', ref: 'msg:1' } },
  { op: 'add', section: 'risks', item: { text: 'Schedule risk', severity: 'high' } } ] } };

test('P06 live: slice S1 - passport gate, model patch is proposed, human review, artifact, ledger, 409', async () => {
  const p = await createProject({ name: `CI S1 ${Date.now()}` });
  const deps = { adapters: { gemini: createFakeAdapter('gemini', ['success'], out) }, router: newRouterState() };
  try {
    await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 1, task: 'x' }, deps), (e) => e instanceof AnalysisError && e.code === 'PASSPORT_NOT_CONFIRMED');
    const cur = await getProject(p.id);
    await updateProjectState({ projectId: p.id, expectedVersion: 1, actor: 'human', sourceRef: 'ci', state: { ...cur.state, passport: { ...cur.state.passport, projectType: 'software', goal: 'CI goal', users: 'owner', inputsOutputs: 'text', constraints: 'none', securityData: 'synthetic', successCriteria: 'works', budget: { calls: 10, tokens: 100000, executorRuns: 1 }, executor: 'manual', humanLevel: 'supervised', status: 'confirmed' } } });
    const r = await runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'Analyse the schedule' }, deps);
    assert.equal(r.state_version, 3); assert.equal(r.changes.length, 2);
    const after = await getProject(p.id);
    assert.ok(after.state.items.facts.concat(after.state.items.risks).every((x) => (x.status === 'proposed' || x.review === 'proposed') || x.status === 'confirmed'));
    assert.equal(after.state.items.risks[0].review, 'proposed');
    const art = await readArtifact(r.artifact.artifactId);   // hash verified inside
    assert.match(art.text, /Two risks found/);
    const ledger = await listProjectLedger(p.id);
    assert.equal(ledger.length, 1); assert.equal(ledger[0].input_tokens, 10);
    const { getPool } = await import('../server/database.ts');
    const dec = await (await getPool()).query('SELECT policy_version, status, units_spent FROM route_decisions WHERE run_id=$1', [r.run_id]);   // P08: every decision is stored
    assert.equal(dec.rowCount, 1); assert.equal(dec.rows[0].policy_version, 'router-v1/units-v1'); assert.equal(dec.rows[0].status, 'ok');
    assert.ok(r.tokens.estimated.total > 0);
    await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'stale' }, deps), (e) => e instanceof StateVersionConflict);
    const rv = await reviewItem({ projectId: p.id, expectedVersion: 3, section: 'risks', id: 'R-1', action: 'confirm' });
    assert.equal((await getProject(p.id)).state.items.risks[0].review, 'confirmed'); assert.equal(rv.state_version, 4);
    const d = await addDecision({ projectId: p.id, expectedVersion: 4, text: 'Go ahead', rationale: 'ok' });
    assert.equal(d.state_version, 5);
    assert.equal((await listProjectArtifacts(p.id)).length, 1);
    // the model may not create decisions: the whole patch is refused, nothing is written
    const bad = { adapters: { gemini: createFakeAdapter('gemini', ['success'], { summary: '', patch: { ops: [{ op: 'add', section: 'decisions', item: { text: 'x' } }] } }) }, router: newRouterState() };
    await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 5, task: 'y' }, bad), /rejected/);
    assert.equal(Number((await getProject(p.id)).state_version), 5);
  } finally { await closeDatabase(); }
});
