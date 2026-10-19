import { z } from 'zod';
import { getPool } from './database.ts';
import { stateSchemaWithPassport } from './contracts.ts';

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const nameSchema = z.string().trim().min(1).max(200);
const stateSchema = z.record(z.string(), z.unknown());
const actorSchema = z.enum(['human', 'agent', 'tool', 'system']);
const projectStatusSchema = z.enum(['draft', 'active', 'paused', 'completed', 'archived']);

function sortableId(): string {
  // Timestamp prefix gives chronological sorting; random suffix avoids requiring UUIDv7 support.
  return `${Date.now().toString(36).padStart(9, '0')}_${cryptoRandom()}`;
}
function cryptoRandom(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class StateVersionConflict extends Error {
  readonly code = 'CONFLICT';
  constructor(readonly expectedVersion: number, readonly actualVersion: number) {
    super(`State version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
  }
}

export async function createProject(input: { id?: string; name: string; state?: Record<string, unknown> }) {
  const name = nameSchema.parse(input.name);
  const id = idSchema.parse(input.id ?? sortableId());
  const state = stateSchemaWithPassport.parse(input.state ?? {});
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query(
      `INSERT INTO projects(id,name) VALUES($1,$2) RETURNING id,name,status,created_at,updated_at`, [id, name]);
    await client.query('INSERT INTO project_states(project_id,state_version,state) VALUES($1,1,$2::jsonb)', [id, JSON.stringify(state)]);
    await client.query('INSERT INTO project_state_versions(id,project_id,state_version,state,actor,source_ref) VALUES($1,$2,1,$3::jsonb,$4,$5)', [sortableId(), id, JSON.stringify(state), 'human', 'project:create']);
    await client.query('INSERT INTO project_events(id,project_id,event_type,payload,actor) VALUES($1,$2,$3,$4::jsonb,$5)', [sortableId(), id, 'project.created', JSON.stringify({ name, source_ref: 'project:create' }), 'human']);
    await client.query('INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)', [sortableId(), id, 'project.created', 'human', JSON.stringify({ name })]);
    await client.query('COMMIT');
    return { ...project.rows[0], state, state_version: 1 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function listProjects(limit = 100) {
  const safeLimit = z.number().int().min(1).max(200).parse(limit);
  const pool = await getPool();
  const result = await pool.query(`SELECT p.id,p.name,p.status,p.created_at,p.updated_at,s.state_version
    FROM projects p JOIN project_states s ON s.project_id=p.id
    ORDER BY p.updated_at DESC,p.id LIMIT $1`, [safeLimit]);
  return result.rows;
}

export async function getProject(idInput: string) {
  const id = idSchema.parse(idInput);
  const pool = await getPool();
  const result = await pool.query(`SELECT p.id,p.name,p.status,p.created_at,p.updated_at,s.state,s.state_version
    FROM projects p JOIN project_states s ON s.project_id=p.id WHERE p.id=$1`, [id]);
  return result.rows[0] ?? null;
}

export async function updateProjectState(input: {
  projectId: string; expectedVersion: number; state: Record<string, unknown>;
  actor: 'human'|'agent'|'tool'|'system'; sourceRef: string; // provenance is mandatory (BX-07)
  viaPipeline?: boolean; // set only by server/stateService.ts: model output reaches State only through the patch pipeline (TZ 5.4)
}) {
  if (input.actor === 'agent' && !input.viaPipeline) throw Object.assign(new Error('Model output must go through the State patch pipeline'), { code: 'FORBIDDEN' });
  const projectId = idSchema.parse(input.projectId);
  const expectedVersion = z.number().int().min(1).parse(input.expectedVersion);
  const state = stateSchemaWithPassport.parse(input.state);
  const actor = actorSchema.parse(input.actor);
  const sourceRef = z.string().trim().min(1).max(500).parse(input.sourceRef);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT state_version FROM project_states WHERE project_id=$1 FOR UPDATE', [projectId]);
    if (!current.rowCount) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' });
    const actual = Number(current.rows[0].state_version);
    if (actual !== expectedVersion) throw new StateVersionConflict(expectedVersion, actual);
    const next = actual + 1;
    await client.query('UPDATE project_states SET state_version=$2,state=$3::jsonb,updated_at=now() WHERE project_id=$1', [projectId, next, JSON.stringify(state)]);
    const confirmed = (state.passport as { status?: string } | undefined)?.status === 'confirmed';
    await client.query(confirmed ? `UPDATE projects SET updated_at=now(), status=CASE WHEN status='draft' THEN 'active' ELSE status END WHERE id=$1` : 'UPDATE projects SET updated_at=now() WHERE id=$1', [projectId]);
    await client.query('INSERT INTO project_state_versions(id,project_id,state_version,state,actor,source_ref) VALUES($1,$2,$3,$4::jsonb,$5,$6)', [sortableId(), projectId, next, JSON.stringify(state), actor, sourceRef]);
    await client.query('INSERT INTO project_events(id,project_id,event_type,payload,actor) VALUES($1,$2,$3,$4::jsonb,$5)', [sortableId(), projectId, 'state.updated', JSON.stringify({ state_version: next, source_ref: sourceRef }), actor]);
    await client.query('INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)', [sortableId(), projectId, 'state.updated', actor, JSON.stringify({ state_version: next, source_ref: sourceRef })]);
    await client.query('COMMIT');
    return { project_id: projectId, state_version: next, state };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function listStateVersions(projectIdInput: string, limit = 50) {
  const projectId = idSchema.parse(projectIdInput);
  const safeLimit = z.number().int().min(1).max(200).parse(limit);
  const pool = await getPool();
  const result = await pool.query(`SELECT id,project_id,state_version,state,actor,source_ref,created_at
    FROM project_state_versions WHERE project_id=$1 ORDER BY state_version DESC LIMIT $2`, [projectId, safeLimit]);
  return result.rows;
}


/** Delete a project and cascaded rows. Audit keeps only the fact of deletion (ADR-08). */
export async function deleteProject(input: { projectId: string; actor?: string }) {
  const projectId = idSchema.parse(input.projectId);
  const actor = z.string().min(1).max(120).parse(input.actor ?? 'human');
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id, name FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await client.query(
      'INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)',
      [sortableId(), null, 'project.deleted', actor, JSON.stringify({ project_id: projectId, name: existing.rows[0].name })],
    );
    await client.query('COMMIT');
    return { id: projectId, deleted: true as const };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordAuditEvent(input: { eventType: string; actor: string; projectId?: string; details?: Record<string, unknown> }) {
  const eventType = z.string().min(1).max(120).parse(input.eventType);
  const actor = z.string().min(1).max(120).parse(input.actor);
  const projectId = input.projectId == null ? null : idSchema.parse(input.projectId);
  const details = stateSchema.parse(input.details ?? {});
  const pool = await getPool();
  await pool.query('INSERT INTO audit_events(id,project_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5::jsonb)', [sortableId(), projectId, eventType, actor, JSON.stringify(details)]);
}

export async function consumeRateLimit(input: { key: string; limit: number; windowMs: number; now?: Date }): Promise<{ allowed: boolean; count: number; resetsAt: Date }> {
  const key = z.string().min(1).max(250).parse(input.key);
  const limit = z.number().int().min(1).max(100000).parse(input.limit);
  const windowMs = z.number().int().min(1000).max(31_536_000_000).parse(input.windowMs);
  const now = input.now ?? new Date();
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO rate_limits(bucket_key,window_started_at,request_count,updated_at)
      VALUES($1,$2,1,$2) ON CONFLICT(bucket_key) DO UPDATE SET
      window_started_at=CASE WHEN rate_limits.window_started_at + ($3::bigint * interval '1 millisecond') <= $2 THEN $2 ELSE rate_limits.window_started_at END,
      request_count=CASE WHEN rate_limits.window_started_at + ($3::bigint * interval '1 millisecond') <= $2 THEN 1 ELSE rate_limits.request_count+1 END,
      updated_at=$2 RETURNING window_started_at,request_count`, [key, now, windowMs]);
    const count = Number(result.rows[0].request_count);
    const started = new Date(result.rows[0].window_started_at);
    await client.query('COMMIT');
    return { allowed: count <= limit, count, resetsAt: new Date(started.getTime() + windowMs) };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
