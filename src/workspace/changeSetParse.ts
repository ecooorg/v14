/**
 * Parse agent-proposed ChangeSet from model text or structured JSON (P36).
 * Never applies changes — only normalises shape for validate + human Apply.
 */

import type { ChangeOp, WorkspaceChangeSet } from './changeset.ts';

const ACTIONS = new Set(['create', 'modify', 'delete', 'rename']);

function asString(v: unknown, max = 200_000): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function normalizeOp(raw: unknown): ChangeOp | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const path = asString(o.path, 240);
  const action = asString(o.action, 20);
  if (!path || !action || !ACTIONS.has(action)) return null;
  const op: ChangeOp = {
    path,
    action: action as ChangeOp['action'],
  };
  const content = asString(o.content);
  if (content !== undefined) op.content = content;
  const baseSha256 = asString(o.baseSha256, 64);
  if (baseSha256) op.baseSha256 = baseSha256;
  const newPath = asString(o.newPath, 240);
  if (newPath) op.newPath = newPath;
  if (Array.isArray(o.edits)) {
    const edits: { find: string; replace: string }[] = [];
    for (const e of o.edits.slice(0, 50)) {
      if (!e || typeof e !== 'object') continue;
      const find = asString((e as any).find, 50_000);
      const replace = asString((e as any).replace, 50_000);
      if (find !== undefined && replace !== undefined) edits.push({ find, replace });
    }
    if (edits.length) op.edits = edits;
  }
  return op;
}

/** Accept a plain object that already looks like WorkspaceChangeSet. */
export function normalizeWorkspaceChangeSet(raw: unknown): WorkspaceChangeSet | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // Nested under changeSet / workspaceChangeSet
  if (o.changeSet && typeof o.changeSet === 'object') return normalizeWorkspaceChangeSet(o.changeSet);
  if (o.workspaceChangeSet && typeof o.workspaceChangeSet === 'object')
    return normalizeWorkspaceChangeSet(o.workspaceChangeSet);

  const baseVersion = Number(o.baseVersion);
  if (!Number.isFinite(baseVersion) || baseVersion < 1) return null;
  if (!Array.isArray(o.ops) || o.ops.length === 0 || o.ops.length > 40) return null;
  const ops: ChangeOp[] = [];
  for (const item of o.ops) {
    const op = normalizeOp(item);
    if (op) ops.push(op);
  }
  if (!ops.length) return null;
  const cs: WorkspaceChangeSet = {
    baseVersion: Math.floor(baseVersion),
    ops,
  };
  const message = asString(o.message, 500);
  if (message) cs.message = message;
  if (o.confirmCiLock === true) cs.confirmCiLock = true;
  return cs;
}

/**
 * Extract ChangeSet from assistant reply text.
 * Looks for fenced ```json ... ``` blocks or a top-level JSON object.
 */
export function parseChangeSetFromText(text: string): WorkspaceChangeSet | null {
  if (!text || typeof text !== 'string') return null;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const m of fences) {
    const body = (m[1] || '').trim();
    if (!body || body.length > 400_000) continue;
    try {
      const parsed = JSON.parse(body);
      const cs = normalizeWorkspaceChangeSet(parsed);
      if (cs) return cs;
    } catch {
      /* try next fence */
    }
  }
  // Whole message is JSON
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.length < 400_000) {
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeWorkspaceChangeSet(parsed);
    } catch {
      return null;
    }
  }
  return null;
}
