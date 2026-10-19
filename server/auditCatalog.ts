/**
 * P23 / BX-24 — required audit event types (TZv3.0 §13.5).
 * Catalog is the source of truth for coverage tests; writers use these names.
 */
export const REQUIRED_AUDIT_EVENTS = [
  'auth.login.succeeded',
  'auth.login.failed',
  'project.created',
  'project.deleted',
  'approval.requested',
  'approval.decided',
  'budget.set',
  'gate.waived',
  'project.settings.changed',
  'code_task.started',
  'state.updated',
  'state.patch.applied',
  'state.patch.rejected',
] as const;

export type RequiredAuditEvent = (typeof REQUIRED_AUDIT_EVENTS)[number];

/** Events that MUST be human-only (actor is never a model). */
export const HUMAN_ONLY_AUDIT_EVENTS = [
  'auth.login.succeeded',
  'auth.login.failed',
  'project.created',
  'project.deleted',
  'approval.decided',
  'gate.waived',
  'project.settings.changed',
] as const;

export function isRequiredAuditEvent(t: string): t is RequiredAuditEvent {
  return (REQUIRED_AUDIT_EVENTS as readonly string[]).includes(t);
}
