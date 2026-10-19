import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, getProject, listStateVersions, updateProjectState, StateVersionConflict } from '../server/projectRepository.ts';
import { applyPatchToProject, compactProjectState, PatchRejectedError } from '../server/stateService.ts';
import { getPool, closeDatabase } from '../server/database.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');

test('P05 live: patch pipeline writes a version, refuses bad patches, blocks direct model writes, compacts', async () => {
  const project = await createProject({ name: `CI state pipeline ${Date.now()}` });
  const pool = await getPool();
  try {
    const r = await applyPatchToProject({ projectId: project.id, expectedVersion: 1, actor: 'agent', sourceRef: 'run:ci-1', patch: { ops: [{ op: 'add', section: 'facts', item: { text: 'A fact' } }] } });
    assert.equal(r.state_version, 2);
    assert.equal((await getProject(project.id)).state.items.facts[0].status, 'proposed');
    await assert.rejects(() => applyPatchToProject({ projectId: project.id, expectedVersion: 2, actor: 'agent', sourceRef: 'run:ci-2', patch: { ops: [{ op: 'add', section: 'decisions', item: { text: 'no' } }] } }), PatchRejectedError);
    assert.equal(Number((await getProject(project.id)).state_version), 2);   // nothing written
    await assert.rejects(() => applyPatchToProject({ projectId: project.id, expectedVersion: 1, actor: 'agent', sourceRef: 'run:ci-3', patch: { ops: [{ op: 'add', section: 'facts', item: { text: 'stale' } }] } }), StateVersionConflict);
    await assert.rejects(() => updateProjectState({ projectId: project.id, expectedVersion: 2, state: { items: {} }, actor: 'agent', sourceRef: 'run:direct' }), /patch pipeline/);
    const long = 'x'.repeat(1200);
    await applyPatchToProject({ projectId: project.id, expectedVersion: 2, actor: 'human', sourceRef: 'ui:ci', patch: { ops: [1, 2, 3].map((n) => ({ op: 'add', section: 'hypotheses', item: { text: `${n} ${long}` } })) } });
    const c = await compactProjectState({ projectId: project.id, expectedVersion: 3, limits: { hypotheses: 400 } });
    assert.equal(c.state_version, 4);
    assert.ok(c.compacted.length > 0);
    const versions = await listStateVersions(project.id, 10);
    assert.deepEqual(versions.map((v) => Number(v.state_version)).sort(), [1, 2, 3, 4]);
    const full = versions.find((v) => Number(v.state_version) === 3);
    assert.ok(full.state.items.hypotheses[0].text.length > 1000);   // the full version stays available
    const audit = await pool.query("SELECT 1 FROM audit_events WHERE project_id=$1 AND event_type IN ('state.patch.applied','state.patch.rejected')", [project.id]);
    assert.ok(audit.rowCount >= 3);
  } finally {
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await closeDatabase();
  }
});
