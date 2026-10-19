/**
 * Workspace ChangeSet: validate + apply (P26b FW-38…FW-44).
 * Profile `workspace` (default limits 20 files / 1500 lines) vs `strict` (Task Package 10/400).
 */

import { normalizePath } from './paths.ts';
import { sha256Bytes } from './hash.ts';
import { classifyBytes } from './classify.ts';
import { detectEol, lineDiffStats, restoreEol, splitLines, unifiedDiffForFile } from './diff.ts';
import type { Entry, VersionInfo, WorkspaceStore } from './types.ts';

export type PathPolicyProfile = 'strict' | 'workspace';

export interface EditOp {
  find: string;
  replace: string;
}

export interface ChangeOp {
  path: string;
  action: 'create' | 'modify' | 'delete' | 'rename';
  /** Full content for create / modify (alternative to edits). */
  content?: string;
  /** Exact find/replace pairs (modify only). */
  edits?: EditOp[];
  /** Required for modify: sha256 of the current file in the base version. */
  baseSha256?: string;
  /** rename target */
  newPath?: string;
}

export interface WorkspaceChangeSet {
  baseVersion: number;
  message?: string;
  ops: ChangeOp[];
  /** Explicit confirmation for CI / lockfile paths under profile `workspace`. */
  confirmCiLock?: boolean;
}

export interface ChangeLimits {
  maxFiles: number;
  maxChangedLines: number;
  maxFileBytes: number;
}

export const WORKSPACE_LIMITS: ChangeLimits = {
  maxFiles: 20,
  maxChangedLines: 1500,
  maxFileBytes: 1_000_000,
};

export const STRICT_LIMITS: ChangeLimits = {
  maxFiles: 10,
  maxChangedLines: 400,
  maxFileBytes: 1_000_000,
};

export interface Violation {
  code: string;
  path?: string;
  detail?: string;
}

export interface FilePreview {
  path: string;
  action: 'create' | 'modify' | 'delete' | 'rename';
  added: number;
  removed: number;
  newPath?: string;
  /** Resulting text after apply (null = deleted). */
  afterText: string | null;
  /** Unified diff snippet for the card. */
  diff: string;
  warnings: string[];
}

export interface ValidateResult {
  ok: boolean;
  violations: Violation[];
  previews: FilePreview[];
  totals: { files: number; added: number; removed: number };
  needsCiLockConfirm: boolean;
}

const LOCK_BASE = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
]);

const CI_BASE = new Set([
  'jenkinsfile',
  '.travis.yml',
  'appveyor.yml',
  'azure-pipelines.yml',
  'buildkite.yml',
  'cloudbuild.yaml',
]);

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase();
}

/** Path policy for workspace profile (FW-39). */
export function isWorkspaceBlockedPath(path: string): { blocked: boolean; code?: string; needsConfirm?: boolean } {
  const norm = normalizePath(path);
  if (!norm.ok) return { blocked: true, code: 'unsafe_path' };
  const p = norm.path;
  const l = p.toLowerCase();
  const base = baseName(p);
  if (l.startsWith('.git/') || l === '.git') return { blocked: true, code: 'git_path' };
  if (l.includes('\0')) return { blocked: true, code: 'unsafe_path' };
  if (l.startsWith('tests/acceptance/')) return { blocked: true, code: 'path_protected' };
  if (l.startsWith('.biforge/')) return { blocked: true, code: 'path_protected' };
  if (base === 'agents.md') return { blocked: true, code: 'path_protected' };
  if (l.startsWith('.github/') || l.startsWith('.circleci/') || CI_BASE.has(base) || base.endsWith('.yml') && l.includes('/workflows/')) {
    return { blocked: false, needsConfirm: true, code: 'ci_lock_confirm' };
  }
  if (LOCK_BASE.has(base)) return { blocked: false, needsConfirm: true, code: 'ci_lock_confirm' };
  return { blocked: false };
}

/** Strict profile mirrors Task Package isProtectedPath (without gateEngine). */
export function isStrictProtectedPath(path: string): boolean {
  const norm = normalizePath(path);
  if (!norm.ok) return true;
  const l = norm.path.toLowerCase();
  const base = baseName(norm.path);
  return (
    l.startsWith('tests/acceptance/') ||
    l.startsWith('.github/') ||
    l.startsWith('.biforge/') ||
    l.startsWith('.git/') ||
    l.startsWith('.circleci/') ||
    base === 'agents.md' ||
    LOCK_BASE.has(base) ||
    CI_BASE.has(base)
  );
}

const SECRET_RULES: Array<{ id: string; re: RegExp }> = [
  { id: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: 'provider_secret_key', re: /\b(?:sk|gsk|xai)-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: 'assigned_secret',
    re: /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*["']?[A-Za-z0-9/+_=-]{16,}/,
  },
];

export function findSecretRules(text: string): string[] {
  return SECRET_RULES.filter((r) => r.re.test(text)).map((r) => r.id);
}

function toLf(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Apply exact find/replace edits. Matching is on LF-normalised text; each find must occur exactly once.
 * Returns LF text; caller restores EOL.
 */
export function applyEdits(originalLf: string, edits: EditOp[], eol: 'LF' | 'CRLF' | 'mixed'): { ok: true; text: string } | { ok: false; code: string; detail?: string } {
  if (eol === 'mixed') return { ok: false, code: 'mixed_eol_edits', detail: 'mixed EOL requires full content replace' };
  let cur = originalLf;
  for (let i = 0; i < edits.length; i++) {
    const findLf = toLf(edits[i]!.find);
    const replLf = toLf(edits[i]!.replace);
    if (!findLf.length) return { ok: false, code: 'empty_find', detail: `edit ${i}` };
    const idx = cur.indexOf(findLf);
    if (idx < 0) return { ok: false, code: 'find_not_found', detail: `edit ${i}` };
    const second = cur.indexOf(findLf, idx + findLf.length);
    if (second >= 0) return { ok: false, code: 'find_not_unique', detail: `edit ${i}` };
    cur = cur.slice(0, idx) + replLf + cur.slice(idx + findLf.length);
  }
  return { ok: true, text: cur };
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export interface ValidateOptions {
  profile?: PathPolicyProfile;
  limits?: Partial<ChangeLimits>;
  /** Ceiling that cannot be exceeded even if limits is higher (FW-39). */
  hardMaxFiles?: number;
  hardMaxChangedLines?: number;
}

export async function validateWorkspaceChangeSet(
  store: WorkspaceStore,
  wsId: string,
  cs: WorkspaceChangeSet,
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const profile = opts.profile ?? 'workspace';
  const baseLimits = profile === 'strict' ? STRICT_LIMITS : WORKSPACE_LIMITS;
  const limits: ChangeLimits = {
    maxFiles: Math.min(opts.limits?.maxFiles ?? baseLimits.maxFiles, opts.hardMaxFiles ?? 50),
    maxChangedLines: Math.min(opts.limits?.maxChangedLines ?? baseLimits.maxChangedLines, opts.hardMaxChangedLines ?? 5000),
    maxFileBytes: opts.limits?.maxFileBytes ?? baseLimits.maxFileBytes,
  };

  const violations: Violation[] = [];
  const push = (v: Violation) => {
    if (violations.length < 100) violations.push(v);
  };

  if (!cs || !Array.isArray(cs.ops) || cs.ops.length === 0) push({ code: 'empty_changeset' });

  const ws = store.getWorkspace ? await store.getWorkspace(wsId) : null;
  const head = ws?.head ?? (await store.listVersions(wsId)).reduce((m, v) => Math.max(m, v.no), 0);
  if (cs.baseVersion !== head) {
    push({ code: 'stale_base_version', detail: `base ${cs.baseVersion} head ${head}` });
  }

  let manifest: Entry[] = [];
  try {
    if (head > 0) manifest = await store.getManifest(wsId, head);
  } catch {
    if (cs.baseVersion > 0) push({ code: 'missing_base_version' });
  }
  const byPath = new Map(manifest.map((e) => [e.path, e]));

  if (cs.ops.length > limits.maxFiles) push({ code: 'too_many_files', detail: String(cs.ops.length) });

  const seen = new Set<string>();
  let needsCiLockConfirm = false;
  const previews: FilePreview[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const op of cs.ops || []) {
    const pathNorm = normalizePath(op.path || '');
    if (!pathNorm.ok) {
      push({ code: 'unsafe_path', path: op.path });
      continue;
    }
    const path = pathNorm.path;
    if (seen.has(path.toLowerCase())) {
      push({ code: 'duplicate_path', path });
      continue;
    }
    seen.add(path.toLowerCase());

    if (profile === 'strict') {
      if (isStrictProtectedPath(path)) push({ code: 'path_protected', path });
    } else {
      const pol = isWorkspaceBlockedPath(path);
      if (pol.blocked) push({ code: pol.code || 'path_protected', path });
      if (pol.needsConfirm) needsCiLockConfirm = true;
      if (op.action === 'rename' && op.newPath) {
        const np = normalizePath(op.newPath);
        if (np.ok) {
          const pol2 = isWorkspaceBlockedPath(np.path);
          if (pol2.blocked) push({ code: pol2.code || 'path_protected', path: np.path });
          if (pol2.needsConfirm) needsCiLockConfirm = true;
        }
      }
    }

    const existing = byPath.get(path);
    if (existing?.flags.includes('secret') && op.action !== 'delete') {
      push({ code: 'secret_file', path });
    }

    let beforeText: string | null = null;
    let eol: 'LF' | 'CRLF' | 'mixed' = 'LF';
    if (existing) {
      try {
        const bytes = await store.readBlob(wsId, existing.sha256);
        beforeText = decodeText(bytes);
        eol = existing.eol || detectEol(beforeText);
      } catch {
        push({ code: 'blob_missing', path });
        continue;
      }
    }

    let afterText: string | null = beforeText;
    const warnings: string[] = [];

    if (op.action === 'create') {
      if (existing) push({ code: 'file_exists', path });
      if (op.content === undefined) {
        push({ code: 'missing_content', path });
        continue;
      }
      afterText = op.content;
    } else if (op.action === 'delete') {
      if (!existing) push({ code: 'file_missing', path });
      afterText = null;
    } else if (op.action === 'rename') {
      if (!existing) push({ code: 'file_missing', path });
      const np = normalizePath(op.newPath || '');
      if (!np.ok) {
        push({ code: 'unsafe_path', path: op.newPath });
        continue;
      }
      if (byPath.has(np.path)) push({ code: 'file_exists', path: np.path });
      afterText = beforeText;
    } else if (op.action === 'modify') {
      if (!existing) {
        push({ code: 'file_missing', path });
        continue;
      }
      if (!op.baseSha256) {
        push({ code: 'missing_base_sha', path });
      } else if (op.baseSha256 !== existing.sha256) {
        push({ code: 'stale_base_sha', path, detail: existing.sha256 });
      }
      const beforeLf = toLf(beforeText || '');
      const lineCount = splitLines(beforeLf).length;
      if (op.edits && op.edits.length) {
        if (lineCount > 300 && op.content !== undefined) {
          warnings.push('prefer_edits_for_large_file');
        }
        const applied = applyEdits(beforeLf, op.edits, eol === 'mixed' ? 'mixed' : eol);
        if (applied.ok === false) {
          push({ code: applied.code, path, detail: applied.detail });
          continue;
        }
        afterText = restoreEol(applied.text, eol === 'mixed' ? 'LF' : eol);
      } else if (op.content !== undefined) {
        if (lineCount > 300) {
          // FW-38: agent should use edits for >300 lines — still accept content but flag.
          warnings.push('large_file_full_content');
        }
        afterText = op.content;
      } else {
        push({ code: 'missing_content_or_edits', path });
        continue;
      }
    } else {
      push({ code: 'unknown_action', path, detail: String(op.action) });
      continue;
    }

    if (afterText !== null) {
      const byteLen = encodeUtf8(afterText).byteLength;
      if (byteLen > limits.maxFileBytes) push({ code: 'file_too_large', path, detail: String(byteLen) });
      for (const rule of findSecretRules(afterText)) {
        push({ code: 'secret_in_content', path, detail: rule });
      }
    }

    const beforeLf = toLf(beforeText || '');
    const afterLf = afterText === null ? '' : toLf(afterText);
    const stats =
      op.action === 'delete'
        ? lineDiffStats(beforeLf, '')
        : op.action === 'create'
          ? lineDiffStats('', afterLf)
          : lineDiffStats(beforeLf, afterLf);
    totalAdded += stats.added;
    totalRemoved += stats.removed;

    const newPath = op.action === 'rename' && op.newPath ? normalizePath(op.newPath).ok ? (normalizePath(op.newPath) as { ok: true; path: string }).path : op.newPath : undefined;
    previews.push({
      path,
      action: op.action,
      added: stats.added,
      removed: stats.removed,
      newPath,
      afterText,
      diff: unifiedDiffForFile(newPath || path, beforeText, afterText),
      warnings,
    });
  }

  if (totalAdded + totalRemoved > limits.maxChangedLines) {
    push({ code: 'too_many_lines', detail: String(totalAdded + totalRemoved) });
  }
  if (needsCiLockConfirm && !cs.confirmCiLock) {
    push({ code: 'ci_lock_confirm_required' });
  }

  return {
    ok: violations.length === 0,
    violations,
    previews,
    totals: { files: previews.length, added: totalAdded, removed: totalRemoved },
    needsCiLockConfirm,
  };
}

/**
 * Apply a validated ChangeSet: writes blobs and commits version head+1.
 * Caller must run validate first; this re-validates and aborts on any violation.
 */
export async function applyWorkspaceChangeSet(
  store: WorkspaceStore,
  wsId: string,
  cs: WorkspaceChangeSet,
  opts: ValidateOptions = {},
): Promise<{ ok: true; version: VersionInfo; previews: FilePreview[] } | { ok: false; violations: Violation[] }> {
  const validated = await validateWorkspaceChangeSet(store, wsId, cs, opts);
  if (!validated.ok) return { ok: false, violations: validated.violations };

  const ws = store.getWorkspace ? await store.getWorkspace(wsId) : null;
  const head = ws?.head ?? 0;
  let manifest: Entry[] = head > 0 ? await store.getManifest(wsId, head) : [];
  const byPath = new Map(manifest.map((e) => [e.path, e]));

  for (const prev of validated.previews) {
    if (prev.action === 'delete') {
      byPath.delete(prev.path);
      continue;
    }
    if (prev.action === 'rename' && prev.newPath) {
      const old = byPath.get(prev.path);
      byPath.delete(prev.path);
      if (old) byPath.set(prev.newPath, { ...old, path: prev.newPath });
      continue;
    }
    if (prev.afterText === null) continue;
    const bytes = encodeUtf8(prev.afterText);
    const hash = await sha256Bytes(bytes);
    await store.putBlob(wsId, hash, bytes);
    const classified = classifyBytes(prev.path, bytes);
    const eol = detectEol(prev.afterText);
    const entry: Entry = {
      path: prev.path,
      sha256: hash,
      size: bytes.byteLength,
      mode: 0o100644,
      class: classified.class,
      lang: classified.lang,
      encoding: classified.encoding ?? 'utf-8',
      eol,
      bom: classified.bom,
      flags: classified.flags ?? [],
    };
    byPath.set(prev.path, entry);
  }

  const nextManifest = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const version = await store.commitVersion(wsId, head === 0 ? null : head, nextManifest, {
    createdBy: 'agent+user',
    message: cs.message || 'changeset',
  });
  return { ok: true, version, previews: validated.previews };
}

/** Create an empty workspace and optionally seed version 1 from a map of path→text (AC-15). */
export async function createEmptyWorkspace(
  store: WorkspaceStore,
  name: string,
  files: Record<string, string> = {},
  privacyAck = false,
): Promise<{ wsId: string; version: VersionInfo | null }> {
  const wsId = await store.createWorkspace(name, '', privacyAck);
  const paths = Object.keys(files);
  if (!paths.length) return { wsId, version: null };
  const manifest: Entry[] = [];
  for (const path of paths.sort()) {
    const norm = normalizePath(path);
    if (!norm.ok) continue;
    const text = files[path]!;
    const bytes = encodeUtf8(text);
    const hash = await sha256Bytes(bytes);
    await store.putBlob(wsId, hash, bytes);
    const classified = classifyBytes(norm.path, bytes);
    manifest.push({
      path: norm.path,
      sha256: hash,
      size: bytes.byteLength,
      mode: 0o100644,
      class: classified.class,
      lang: classified.lang,
      encoding: classified.encoding ?? 'utf-8',
      eol: detectEol(text),
      bom: classified.bom,
      flags: classified.flags ?? [],
    });
  }
  const version = await store.commitVersion(wsId, null, manifest, { createdBy: 'create', message: 'initial' });
  return { wsId, version };
}

/** Rollback: new version that is a copy of targetNo (FW-42). */
export async function rollbackWorkspace(
  store: WorkspaceStore,
  wsId: string,
  targetNo: number,
): Promise<VersionInfo> {
  const ws = store.getWorkspace ? await store.getWorkspace(wsId) : null;
  const head = ws?.head ?? 0;
  if (targetNo < 1 || targetNo > head) throw new Error('invalid_rollback_target');
  const manifest = await store.getManifest(wsId, targetNo);
  // Blobs already present; commit as new version.
  return store.commitVersion(wsId, head, manifest, {
    createdBy: 'rollback',
    message: `rollback to v${targetNo}`,
  });
}
