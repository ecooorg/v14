import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../server/projectRepository.ts';
import { saveArtifact, readArtifact, listArtifactVersions, ArtifactIntegrityError } from '../server/artifactRepository.ts';
import { writeLedgerEntry } from '../server/ledger.ts';
import { getPool, closeDatabase } from '../server/database.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');

test('BX-17.a live: versions, hash, no duplicate content, integrity; ledger row', async () => {
  const project = await createProject({ name: `CI artifacts ${Date.now()}` });
  const pool = await getPool();
  try {
    const a1 = await saveArtifact({ projectId: project.id, filename: 'note.md', text: 'first', createdBy: 'human' });
    assert.deepEqual([a1.version, a1.created], [1, true]);
    const same = await saveArtifact({ projectId: project.id, artifactId: a1.artifactId, filename: 'note.md', text: 'first', createdBy: 'human' });
    assert.deepEqual([same.version, same.created], [1, false]);
    const a2 = await saveArtifact({ projectId: project.id, artifactId: a1.artifactId, filename: 'note.md', text: 'second', createdBy: 'run:1', derivedFrom: [`${a1.artifactId}@1`] });
    assert.deepEqual([a2.version, a2.created], [2, true]);
    assert.equal((await listArtifactVersions(a1.artifactId)).length, 2);
    assert.equal((await readArtifact(a1.artifactId, 1)).text, 'first');
    assert.equal((await readArtifact(a1.artifactId)).text, 'second');
    assert.equal(await readArtifact('missing_id'), null);
    await pool.query('UPDATE artifacts SET content=$1 WHERE artifact_id=$2 AND version=2', [Buffer.from('tampered'), a1.artifactId]);
    await assert.rejects(() => readArtifact(a1.artifactId, 2), ArtifactIntegrityError);
    await writeLedgerEntry({ providerId: 'fake', modelId: 'm', inputTokens: 1, cachedTokens: 0, outputTokens: 2, latencyMs: 3, retries: 0, status: 'ok', runId: `ci-${project.id}` });
    const l = await pool.query('SELECT 1 FROM usage_ledger WHERE run_id=$1', [`ci-${project.id}`]);
    assert.equal(l.rowCount, 1);
    await pool.query('DELETE FROM usage_ledger WHERE run_id=$1', [`ci-${project.id}`]);
  } finally {
    await pool.query('DELETE FROM projects WHERE id=$1', [project.id]);
    await closeDatabase();
  }
});
