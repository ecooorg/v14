// P14 live expectations (PostgreSQL). Every test works in its own project and never counts rows of other projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProject } from '../server/projectRepository.ts';
import { getPool } from '../server/database.ts';
import {
  saveArtifact, readArtifact, readArtifactBytes, verifyArtifact, inspectArtifact, diffArtifactVersions, listArtifactVersions, exportProjectManifest,
  ArtifactIntegrityError, ArtifactFormatError, MAX_ARTIFACT_BYTES,
} from '../server/artifactRepository.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const project = () => createProject({ name: `P14 ${uid()}` });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0, 255]);
const save = (p, extra) => saveArtifact({ projectId: p.id, filename: 'f.txt', createdBy: 'human', ...extra });
const problems = async (id, v) => (await verifyArtifact(id, v)).problems;

test('migration 008 created artifact_manifests', async () => {
  const r = await (await getPool()).query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'artifact_manifests'");
  assert.equal(r.rowCount, 1);
});

test('a binary artifact is stored and downloaded byte for byte; its type comes from content; a manifest exists', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const a = await save(p, { filename: 'logo.png', mime: 'text/plain', data: PNG });
    assert.deepEqual([a.kind, a.mime, a.created, a.version], ['binary', 'image/png', true, 1]);
    const got = await readArtifactBytes(a.artifactId);
    assert.deepEqual(new Uint8Array(got.data), PNG);
    assert.equal(got.hash, a.hash);
    const m = (await pool.query('SELECT * FROM artifact_manifests WHERE artifact_id=$1', [a.artifactId])).rows[0];
    assert.equal(m.manifest.declared_mime, 'text/plain'); assert.equal(m.manifest.mime, 'image/png'); assert.equal(m.storage_ref.startsWith('pg:'), true);
    assert.deepEqual(await problems(a.artifactId), []);
    const again = await save(p, { artifactId: a.artifactId, filename: 'logo.png', data: PNG });
    assert.deepEqual([again.created, again.version], [false, 1]);
    const unknown = await save(p, { filename: 'blob.xyz', data: Uint8Array.from([0xff, 0xfe, 0, 7]) });
    assert.deepEqual([unknown.kind, unknown.mime], ['binary', 'application/octet-stream']);
    assert.equal((await inspectArtifact(a.artifactId)).preview, null);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('an executable is stored, flagged and never run; text keeps working through readArtifact', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const e = await save(p, { filename: 'run.sh', data: new TextEncoder().encode('#!/bin/sh\necho hi') });
    assert.equal(e.kind, 'executable');
    assert.equal((await pool.query('SELECT security_status FROM artifacts WHERE artifact_id=$1', [e.artifactId])).rows[0].security_status, 'flagged_executable');
    const t = await save(p, { text: 'hello' });
    assert.equal((await readArtifact(t.artifactId)).text, 'hello');
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('tampering and a missing object are detected (TZ 10.2)', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const a = await save(p, { text: 'one' });
    const v2 = await save(p, { artifactId: a.artifactId, text: 'two' });
    const v3 = await save(p, { artifactId: a.artifactId, text: 'three' });
    // 1. content replaced, hash left alone
    await pool.query('UPDATE artifacts SET content=$1 WHERE artifact_id=$2 AND version=1', [Buffer.from('evil'), a.artifactId]);
    assert.ok((await problems(a.artifactId, 1)).includes('hash_mismatch'));
    await assert.rejects(() => readArtifact(a.artifactId, 1), ArtifactIntegrityError);
    // 2. content and hash replaced together: the manifest still disagrees
    const evil = Buffer.from('evil2'); const { createHash } = await import('node:crypto');
    await pool.query('UPDATE artifacts SET content=$1, hash=$2, size=$3 WHERE artifact_id=$4 AND version=2', [evil, createHash('sha256').update(evil).digest('hex'), evil.length, a.artifactId]);
    assert.ok((await problems(a.artifactId, 2)).includes('metadata_mismatch'));
    // 3. the object is gone: the latest version is reported missing, not silently replaced by v2
    await pool.query('DELETE FROM artifacts WHERE artifact_id=$1 AND version=3', [a.artifactId]);
    assert.deepEqual(await problems(a.artifactId, 3), ['object_missing']);
    await assert.rejects(() => readArtifact(a.artifactId), (e) => e instanceof ArtifactIntegrityError && e.problems.includes('object_missing'));
    assert.equal((await inspectArtifact(a.artifactId, 3)).ok, false);
    assert.equal(v3.version, 3);
    // 4. a version is never reused after its object was lost
    const v4 = await save(p, { artifactId: a.artifactId, text: 'four' });
    assert.equal(v4.version, 4);
    // 5. the manifest itself was edited
    await pool.query("UPDATE artifact_manifests SET storage_ref='pg:other' WHERE artifact_id=$1 AND version=4", [a.artifactId]);
    assert.ok((await problems(a.artifactId, 4)).includes('manifest_tampered'));
    // 6. a row without a manifest
    await pool.query('DELETE FROM artifact_manifests WHERE artifact_id=$1 AND version=4', [a.artifactId]);
    assert.deepEqual(await problems(a.artifactId, 4), ['manifest_missing']);
    assert.equal(v2.version, 2);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('limits: exactly 5 MB passes, one byte more fails; 200 versions pass, the 201st fails; 1000 artifacts per project', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const big = await save(p, { filename: 'big.bin', data: new Uint8Array(MAX_ARTIFACT_BYTES).fill(7) });
    assert.equal(big.size, MAX_ARTIFACT_BYTES);
    assert.equal((await readArtifactBytes(big.artifactId)).data.length, MAX_ARTIFACT_BYTES);
    await assert.rejects(() => save(p, { data: new Uint8Array(MAX_ARTIFACT_BYTES + 1) }), (e) => e instanceof ArtifactFormatError && e.code === 'TOO_LARGE');
    const first = await save(p, { text: 'v1' });
    for (let i = 2; i <= 200; i++) await save(p, { artifactId: first.artifactId, text: `v${i}` });
    assert.equal((await listArtifactVersions(first.artifactId)).length, 200);
    await assert.rejects(() => save(p, { artifactId: first.artifactId, text: 'v201' }), (e) => e instanceof ArtifactFormatError && e.code === 'LIMIT');
    const q = await project();
    try {
      await pool.query(
        `INSERT INTO artifact_manifests(artifact_id,version,project_id,hash,size,storage_ref,mime,kind,manifest,manifest_hash)
         SELECT 'fill-' || $2 || '-' || g, 1, $1, repeat('a',64), 0, 'pg:x', 'text/plain', 'text', '{}'::jsonb, repeat('b',64) FROM generate_series(1,999) g`, [q.id, uid().replace(/[^A-Za-z0-9]/g, '')]);
      assert.equal((await save(q, { text: 'the 1000th' })).created, true);
      await assert.rejects(() => save(q, { text: 'the 1001st' }), (e) => e instanceof ArtifactFormatError && e.code === 'LIMIT');
      const newVersion = await save(q, { artifactId: (await pool.query("SELECT artifact_id FROM artifact_manifests WHERE project_id=$1 AND manifest->>'filename'='f.txt'", [q.id])).rows[0].artifact_id, text: 'second version is not a new artifact' });
      assert.equal(newVersion.version, 2);
    } finally { await pool.query('DELETE FROM projects WHERE id=$1', [q.id]); }
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('inspect, diff, archive listing and project manifest export', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const a = await save(p, { text: 'a\nb\nc' });
    await save(p, { artifactId: a.artifactId, text: 'a\nc\nd' });
    const d = await diffArtifactVersions(a.artifactId, 1, 2);
    assert.deepEqual(d.lines.filter((l) => l.op !== ' ').map((l) => l.op + l.line), ['-b', '+d']);
    const i = await inspectArtifact(a.artifactId);
    assert.equal(i.version, 2); assert.equal(i.preview, 'a\nc\nd'); assert.equal(i.ok, true);
    const bin = await save(p, { filename: 'x.png', data: PNG }); await save(p, { artifactId: bin.artifactId, filename: 'x.png', data: Uint8Array.from([...PNG, 9]) });
    assert.deepEqual(await diffArtifactVersions(bin.artifactId, 1, 2), { binary: true, same: false });
    const zipBytes = Uint8Array.from(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]));
    const z = await save(p, { filename: 'a.zip', data: zipBytes });
    assert.equal(z.kind, 'archive');
    assert.deepEqual((await inspectArtifact(z.artifactId)).archive, { entries: [], truncated: false });
    const m = await exportProjectManifest(p.id);
    assert.equal(m.artifacts.length, 5); assert.ok(m.artifacts.every((x) => x.ok === true && x.project_id === p.id && !('content' in x)));
    assert.equal(await diffArtifactVersions('missing_id', 1, 2), null);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('upgrade: versions stored before migration 008 get a manifest; a second run changes nothing', async () => {
  const p = await project(); const pool = await getPool();
  try {
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('legacy text'); const hash = createHash('sha256').update(body).digest('hex'); const artifactId = `legacy_${uid().replace(/[^A-Za-z0-9]/g, '')}`;
    await pool.query("INSERT INTO artifacts(id,artifact_id,version,project_id,filename,mime,size,hash,content,created_by) VALUES($1,$2,1,$3,'old.md','text/markdown',$4,$5,$6,'run:old')", [`row_${artifactId}`, artifactId, p.id, body.length, hash, body]);
    assert.deepEqual(await problems(artifactId, 1), ['manifest_missing']);
    const sql = fs.readFileSync(new URL('../migrations/008_artifact_manifests.sql', import.meta.url), 'utf8');
    const backfill = sql.slice(sql.indexOf('INSERT INTO artifact_manifests'), sql.indexOf('COMMIT;'));
    await pool.query(backfill); await pool.query(backfill);
    assert.equal((await pool.query('SELECT 1 FROM artifact_manifests WHERE artifact_id=$1', [artifactId])).rowCount, 1);
    assert.deepEqual(await problems(artifactId, 1), []);
    assert.equal((await readArtifact(artifactId)).text, 'legacy text');
    const next = await save(p, { artifactId, filename: 'old.md', text: 'new text' });
    assert.equal(next.version, 2);
  } finally { await pool.query('DELETE FROM projects WHERE id=$1', [p.id]); }
});

test('concurrency: parallel saves of the same content create one version; deleting a project removes artifacts and manifests', async () => {
  const p = await project(); const pool = await getPool();
  const a = await save(p, { text: 'seed' });
  const results = await Promise.all(Array.from({ length: 5 }, () => save(p, { artifactId: a.artifactId, text: 'same new content' })));
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.deepEqual([...new Set(results.map((r) => r.version))], [2]);
  assert.equal((await listArtifactVersions(a.artifactId)).length, 2);
  await pool.query('DELETE FROM projects WHERE id=$1', [p.id]);
  assert.equal((await pool.query('SELECT 1 FROM artifacts WHERE project_id=$1', [p.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM artifact_manifests WHERE project_id=$1', [p.id])).rowCount, 0);
  assert.equal(await readArtifact(a.artifactId), null);
});
