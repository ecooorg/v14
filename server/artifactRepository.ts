import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getPool } from './database.ts';
import {
  ArtifactFormatError, MAX_ARTIFACT_BYTES, MAX_ARTIFACTS_PER_PROJECT, MAX_VERSIONS_PER_ARTIFACT, checkFilename, sha256Hex, sniffType,
  securityStatusOf, previewOf, lineDiff, listZipEntries, manifestHashOf, storageRefOf, type Manifest,
} from './artifactFormat.ts';

/** Artifact Registry (BX-17.a minimal, BX-17.b full; TZ 10.1-10.4): versions, SHA-256, manifest, binary artifacts, tamper detection, limits. */
export { MAX_ARTIFACT_BYTES, sha256Hex, ArtifactFormatError };
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const artifactInputSchema = z.object({
  projectId: idSchema,
  artifactId: idSchema.optional(),          // omitted: a new artifact; given: a new version of it
  filename: z.string().trim().min(1).max(255).refine((n) => !/[\\/\0]/.test(n), 'filename must not contain path separators'),
  mime: z.string().trim().min(1).max(120).default('text/plain'),
  text: z.string().optional(),
  data: z.instanceof(Uint8Array).optional(), // binary content; exactly one of text and data
  createdBy: z.string().trim().min(1).max(200),
  derivedFrom: z.array(z.string().max(300)).max(50).default([]),
}).strict().refine((v) => (v.text === undefined) !== (v.data === undefined), { message: 'Give exactly one of text and data', path: ['data'] });
export type ArtifactInput = z.input<typeof artifactInputSchema>;

const newId = () => `${Date.now().toString(36).padStart(9, '0')}_${createHash('sha256').update(String(Math.random()) + Date.now()).digest('hex').slice(0, 24)}`;

export type IntegrityProblem = 'object_missing' | 'manifest_missing' | 'size_mismatch' | 'hash_mismatch' | 'metadata_mismatch' | 'manifest_tampered';
export class ArtifactIntegrityError extends Error {
  readonly code = 'INTEGRITY';
  constructor(message: string, readonly problems: IntegrityProblem[] = []) { super(message); }
}

/** Creates the artifact or its next version. Same content as the latest version returns that version (created: false). The version exists only with its manifest (one transaction). */
export async function saveArtifact(input: ArtifactInput) {
  const v = artifactInputSchema.parse(input);
  const bytes = v.data ? Buffer.from(v.data) : Buffer.from(v.text ?? '', 'utf8');
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new ArtifactFormatError('TOO_LARGE', 'Artifact is larger than 5 MB');
  const filename = checkFilename(v.filename);
  const { mime, kind } = sniffType(bytes, v.mime);
  const hash = sha256Hex(bytes);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const artifactId = v.artifactId ?? newId();
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`artifacts:${v.projectId}`]);
    if (v.artifactId) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [artifactId]);
    const known = await client.query(
      `SELECT max(version) AS max_version, max(project_id) AS project_id FROM
         (SELECT version, project_id FROM artifacts WHERE artifact_id=$1 UNION ALL SELECT version, project_id FROM artifact_manifests WHERE artifact_id=$1) t`, [artifactId]);
    const maxVersion = Number(known.rows[0].max_version ?? 0);
    if (maxVersion && known.rows[0].project_id !== v.projectId) throw new Error('Artifact belongs to another project');
    const latest = maxVersion ? await client.query('SELECT version, hash FROM artifacts WHERE artifact_id=$1 AND version=$2', [artifactId, maxVersion]) : { rows: [] as any[] };
    if (latest.rows[0] && latest.rows[0].hash === hash) {
      await client.query('COMMIT');
      return { artifactId, version: maxVersion, hash, size: bytes.length, kind, mime, created: false };
    }
    if (!maxVersion) {
      const n = await client.query('SELECT count(DISTINCT artifact_id) AS n FROM artifact_manifests WHERE project_id=$1', [v.projectId]);
      if (Number(n.rows[0].n) >= MAX_ARTIFACTS_PER_PROJECT) throw new ArtifactFormatError('LIMIT', `A project holds at most ${MAX_ARTIFACTS_PER_PROJECT} artifacts`);
    }
    const version = maxVersion + 1;
    if (version > MAX_VERSIONS_PER_ARTIFACT) throw new ArtifactFormatError('LIMIT', `An artifact has at most ${MAX_VERSIONS_PER_ARTIFACT} versions`);
    const rowId = newId();
    const storageRef = storageRefOf(rowId);
    await client.query(
      `INSERT INTO artifacts(id,artifact_id,version,project_id,filename,mime,size,hash,content,created_by,derived_from,security_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [rowId, artifactId, version, v.projectId, filename, mime, bytes.length, hash, bytes, v.createdBy, JSON.stringify(v.derivedFrom), securityStatusOf(kind)]);
    const manifest: Manifest = {
      schema: 1, artifact_id: artifactId, version, project_id: v.projectId, filename, mime, declared_mime: v.mime, kind, size: bytes.length, hash,
      storage_ref: storageRef, created_by: v.createdBy, derived_from: v.derivedFrom,
    };
    await client.query(
      `INSERT INTO artifact_manifests(artifact_id,version,project_id,hash,size,storage_ref,mime,kind,manifest,manifest_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [artifactId, version, v.projectId, hash, bytes.length, storageRef, mime, kind, JSON.stringify(manifest),
        manifestHashOf({ artifactId, version, projectId: v.projectId, hash, size: bytes.length, storageRef })]);
    await client.query('COMMIT');
    return { artifactId, version, hash, size: bytes.length, kind, mime, created: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

type Loaded = { version: number; row: any | undefined; man: any | undefined };
async function load(artifactId: string, version?: number): Promise<Loaded | null> {
  const id = idSchema.parse(artifactId);
  const pool = await getPool();
  let v = version;
  if (v === undefined) {
    const m = await pool.query('SELECT max(version) AS v FROM (SELECT version FROM artifacts WHERE artifact_id=$1 UNION ALL SELECT version FROM artifact_manifests WHERE artifact_id=$1) t', [id]);
    if (m.rows[0].v === null) return null;
    v = Number(m.rows[0].v);
  }
  const [row, man] = await Promise.all([
    pool.query('SELECT * FROM artifacts WHERE artifact_id=$1 AND version=$2', [id, v]),
    pool.query('SELECT * FROM artifact_manifests WHERE artifact_id=$1 AND version=$2', [id, v]),
  ]);
  if (!row.rows[0] && !man.rows[0]) return null;
  return { version: v, row: row.rows[0], man: man.rows[0] };
}

/** Every way the stored object can disagree with its manifest: a missing or replaced object is an integrity error (TZ 10.2). */
function problemsOf({ row, man }: Loaded): IntegrityProblem[] {
  if (!row) return ['object_missing'];
  if (!man) return ['manifest_missing'];
  const p: IntegrityProblem[] = [];
  const content = Buffer.from(row.content);
  if (content.length !== Number(row.size) || content.length !== Number(man.size)) p.push('size_mismatch');
  const actual = sha256Hex(content);
  if (actual !== row.hash || actual !== man.hash) p.push('hash_mismatch');
  if (row.hash !== man.hash || Number(row.size) !== Number(man.size) || row.project_id !== man.project_id || man.storage_ref !== storageRefOf(row.id)) p.push('metadata_mismatch');
  if (manifestHashOf({ artifactId: man.artifact_id, version: Number(man.version), projectId: man.project_id, hash: man.hash, size: Number(man.size), storageRef: man.storage_ref }) !== man.manifest_hash) p.push('manifest_tampered');
  return p;
}

async function loadVerified(artifactId: string, version?: number) {
  const l = await load(artifactId, version);
  if (!l) return null;
  const problems = problemsOf(l);
  if (problems.length) throw new ArtifactIntegrityError(`Integrity check failed for ${artifactId} v${l.version}: ${problems.join(', ')}`, problems);
  return { ...l, row: l.row, man: l.man };
}

/** Reads a version (latest when omitted) and verifies it against the manifest; a mismatch is an integrity error. */
export async function readArtifact(artifactId: string, version?: number) {
  const l = await loadVerified(artifactId, version);
  if (!l) return null;
  const { content, ...meta } = l.row;
  return { ...meta, kind: l.man.kind as string, text: Buffer.from(content).toString('utf8') };
}

/** Download: the exact bytes, verified. Binary and text alike. */
export async function readArtifactBytes(artifactId: string, version?: number) {
  const l = await loadVerified(artifactId, version);
  if (!l) return null;
  const { content, ...meta } = l.row;
  return { ...meta, kind: l.man.kind as string, data: Buffer.from(content) };
}

/** Check without throwing: result for one version. A deleted row or a replaced content is reported, not hidden. */
export async function verifyArtifact(artifactId: string, version?: number) {
  const l = await load(artifactId, version);
  if (!l) return null;
  const problems = problemsOf(l);
  return { artifactId, version: l.version, ok: problems.length === 0, problems };
}

/** Metadata, verification and a preview (text only; archives list names without unpacking). */
export async function inspectArtifact(artifactId: string, version?: number) {
  const l = await load(artifactId, version);
  if (!l) return null;
  const problems = problemsOf(l);
  const manifest = l.man?.manifest ?? null;
  const out: { version: number; manifest: unknown; ok: boolean; problems: IntegrityProblem[]; preview: string | null; archive: ReturnType<typeof listZipEntries> } =
    { version: l.version, manifest, ok: problems.length === 0, problems, preview: null, archive: null };
  if (out.ok) {
    const data = Buffer.from(l.row.content);
    out.preview = previewOf(data, l.man.kind);
    if (l.man.kind === 'archive') out.archive = listZipEntries(data);
  }
  return out;
}

/** Line diff of two text versions; binary versions only report whether they are the same. */
export async function diffArtifactVersions(artifactId: string, from: number, to: number) {
  const a = await loadVerified(artifactId, from);
  const b = await loadVerified(artifactId, to);
  if (!a || !b) return null;
  if (a.man.kind !== 'text' || b.man.kind !== 'text') return { binary: true as const, same: a.row.hash === b.row.hash };
  return { binary: false as const, same: a.row.hash === b.row.hash, lines: lineDiff(Buffer.from(a.row.content).toString('utf8'), Buffer.from(b.row.content).toString('utf8')) };
}

export async function listArtifactVersions(artifactId: string) {
  const pool = await getPool();
  const r = await pool.query(
    `SELECT m.artifact_id, m.version, a.filename, m.mime, m.kind, m.size, m.hash, a.created_by, m.created_at
       FROM artifact_manifests m LEFT JOIN artifacts a ON a.artifact_id=m.artifact_id AND a.version=m.version
      WHERE m.artifact_id=$1 ORDER BY m.version`, [idSchema.parse(artifactId)]);
  return r.rows;
}

/** Export: the project manifest (all versions, with the verification result of each). Content is not included. */
export async function exportProjectManifest(projectId: string) {
  const pid = idSchema.parse(projectId);
  const pool = await getPool();
  const r = await pool.query('SELECT artifact_id, version, manifest FROM artifact_manifests WHERE project_id=$1 ORDER BY artifact_id, version', [pid]);
  const artifacts = [];
  for (const m of r.rows) artifacts.push({ ...m.manifest, ok: (await verifyArtifact(m.artifact_id, Number(m.version)))?.ok ?? false });
  return { schema: 1 as const, project_id: pid, artifacts };
}
