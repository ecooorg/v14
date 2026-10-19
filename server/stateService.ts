import { applyStatePatch, compactState, type PatchContext, type Section } from './statePipeline.ts';
import { getProject, updateProjectState, recordAuditEvent, StateVersionConflict } from './projectRepository.ts';

export class PatchRejectedError extends Error {
  readonly code = 'VALIDATION';
  constructor(readonly errors: { index: number; code: string; message: string }[]) { super(`State patch rejected: ${errors[0]?.code}`); }
}

/** Domain service: schema -> policy -> apply -> new version + event. The only way a model's patch reaches State. */
export async function applyPatchToProject(input: { projectId: string; expectedVersion: number; patch: unknown; actor: PatchContext['actor']; sourceRef: string }) {
  const project = await getProject(input.projectId);
  if (!project) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' });
  if (Number(project.state_version) !== input.expectedVersion) throw new StateVersionConflict(input.expectedVersion, Number(project.state_version));
  const r = applyStatePatch(project.state, input.patch, { actor: input.actor, sourceRef: input.sourceRef });
  if (r.ok === false) {
    await recordAuditEvent({ eventType: 'state.patch.rejected', actor: input.actor, projectId: input.projectId, details: { source_ref: input.sourceRef, codes: r.errors.map((e) => e.code) } });
    throw new PatchRejectedError(r.errors);
  }
  const saved = await updateProjectState({ projectId: input.projectId, expectedVersion: input.expectedVersion, state: r.state, actor: input.actor, sourceRef: input.sourceRef, viaPipeline: true });
  await recordAuditEvent({ eventType: 'state.patch.applied', actor: input.actor, projectId: input.projectId, details: { source_ref: input.sourceRef, state_version: saved.state_version, changes: r.changes } });
  return { ...saved, changes: r.changes };
}

/** Compaction saves a new State version; the full previous version stays in project_state_versions. */
export async function compactProjectState(input: { projectId: string; expectedVersion: number; limits?: Partial<Record<Section, number>> }) {
  const project = await getProject(input.projectId);
  if (!project) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' });
  if (Number(project.state_version) !== input.expectedVersion) throw new StateVersionConflict(input.expectedVersion, Number(project.state_version));
  const c = compactState(project.state, input.limits);
  if (c.ok === false) throw new PatchRejectedError([{ index: -1, code: c.error, message: 'Existing items do not match the schema' }]);
  if (!c.changed) return { state_version: input.expectedVersion, compacted: [], needsLlm: c.needsLlm };
  const saved = await updateProjectState({ projectId: input.projectId, expectedVersion: input.expectedVersion, state: c.state, actor: 'system', sourceRef: 'compaction' });
  return { state_version: saved.state_version, compacted: c.compacted, needsLlm: c.needsLlm };
}
