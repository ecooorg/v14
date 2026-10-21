import crypto from 'node:crypto';
import { Script } from 'node:vm';
import { z } from 'zod';
import { normalizeRepoPath } from './gateEngine.ts';

// CodeExecutor interface and the `manual` executor (TZ 11.3, 11.4; P18 / BX-21.a).
// This module is pure: no database, no network, no model. It never runs code (D-03): a diff is text that is parsed,
// validated and applied to text. Persistence is behind `ExecutorStore`; GitHub access lives in githubIntegration.ts.

// ---- limits (11.3, 11.4) ----
/** Default for small manual / legacy model_patch tasks. */
export const DEFAULT_MAX_FILES = 10;
export const DEFAULT_MAX_CHANGED_LINES = 400;
/**
 * P58 App Builder ceiling for product-facing /code/build (source ZIP scaffolds).
 * Env override: CODE_APP_BUILDER_MAX_FILES / CODE_APP_BUILDER_MAX_LINES (clamped).
 * Manual delivery packages may still use DEFAULT_* unless the package raises limits.
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
export const APP_BUILDER_MAX_FILES = envInt('CODE_APP_BUILDER_MAX_FILES', 80, 10, 120);
export const APP_BUILDER_MAX_CHANGED_LINES = envInt('CODE_APP_BUILDER_MAX_LINES', 8000, 400, 20000);
/** Absolute schema ceiling (must be >= APP_BUILDER_*). */
export const ABSOLUTE_MAX_FILES = 120;
export const ABSOLUTE_MAX_CHANGED_LINES = 20000;
export const MAX_DIFF_BYTES = 512_000;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_PACKAGE_MD_BYTES = 1_000_000;

// ---- types ----
export const CODE_EXECUTOR_IDS = ['manual', 'model_patch'] as const;
export type CodeExecutorId = (typeof CODE_EXECUTOR_IDS)[number];
/** WAITING_HUMAN | RUNNING | DELIVERED | FAILED | BLOCKED (11.4). RUNNING is reserved for `model_patch` (P19). */
export const EXECUTOR_STATES = ['WAITING_HUMAN', 'RUNNING', 'DELIVERED', 'FAILED', 'BLOCKED'] as const;
export type ExecutorState = (typeof EXECUTOR_STATES)[number];

export interface TaskPackageRef { taskId: string; projectId: string; packageHash: string; baseBranch: string }
export interface RunRef { runId: string | null; attempt: number }
export interface ExecutorHandle { codeTaskId: string; executor: CodeExecutorId }
export interface ExecutorResult {
  executor: CodeExecutorId; branch: string; headSha: string; prUrl?: string; filesChanged: number; linesChanged: number; notes?: string;
}
export interface ExecutorStatus { state: ExecutorState; result?: ExecutorResult; reason?: string }
export interface CodeExecutor {
  id: CodeExecutorId;
  start(pkg: TaskPackageRef, run: RunRef): Promise<ExecutorHandle>;
  poll(h: ExecutorHandle): Promise<ExecutorStatus>;
}

const TRANSITIONS: Record<ExecutorState, readonly ExecutorState[]> = {
  WAITING_HUMAN: ['RUNNING', 'DELIVERED', 'BLOCKED', 'FAILED'],   // RUNNING: a diff is being applied (claimed so that two uploads cannot both write)
  RUNNING: ['DELIVERED', 'BLOCKED', 'FAILED'],
  BLOCKED: ['RUNNING', 'DELIVERED', 'BLOCKED', 'FAILED'],         // a human may deliver again after a refused submission
  DELIVERED: [],
  FAILED: [],
};
export const canExecutorTransition = (from: ExecutorState, to: ExecutorState): boolean => TRANSITIONS[from]?.includes(to) ?? false;
export const isActiveExecutorState = (s: ExecutorState): boolean => s === 'WAITING_HUMAN' || s === 'RUNNING';
export const isOpenExecutorState = (s: ExecutorState): boolean => s === 'WAITING_HUMAN' || s === 'RUNNING' || s === 'BLOCKED';

// ---- paths: protected set and allowed_paths ----
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb', 'bun.lock', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock', 'go.sum', 'uv.lock']);
const CI_FILES = new Set(['.gitlab-ci.yml', '.travis.yml', 'jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'appveyor.yml', '.drone.yml']);
/**
 * Paths no executor may change (11.4 item 3): acceptance tests, CI configuration, AGENTS.md, .biforge, dependency lock files.
 * An unsafe path counts as protected. Comparison is case-insensitive. Extending the set needs an explicit SPEC entry with an approval (not built in P18).
 */
export function isProtectedPath(p: string): boolean {
  const n = normalizeRepoPath(p);
  if (n === null) return true;
  const l = n.toLowerCase();
  const base = l.slice(l.lastIndexOf('/') + 1);
  return l.startsWith('tests/acceptance/') || l.startsWith('.github/') || l.startsWith('.biforge/') || l.startsWith('.git/') || l.startsWith('.circleci/')
    || base === 'agents.md' || LOCKFILES.has(base) || CI_FILES.has(base);
}

const PATTERN_RE = /^[A-Za-z0-9._\-/*]+$/;
/** An allowed_paths entry: a safe relative path or glob (`*` inside a segment, `**` across segments). A bare wildcard is too broad. */
export function isValidAllowedPattern(p: string): boolean {
  if (typeof p !== 'string' || p.length < 1 || p.length > 200 || !PATTERN_RE.test(p)) return false;
  if (p.startsWith('/') || p.endsWith('/') || p.includes('//')) return false;
  if (p.split('/').some((s) => s === '.' || s === '..' || s === '')) return false;
  return /[A-Za-z0-9._-]/.test(p);   // not made of wildcards only
}
const patternCache = new Map<string, RegExp>();
function patternRegex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    let src = '';
    for (let i = 0; i < pattern.length;) {
      if (pattern.startsWith('**/', i)) { src += '(?:.*/)?'; i += 3; }
      else if (pattern.startsWith('**', i)) { src += '.*'; i += 2; }
      else if (pattern[i] === '*') { src += '[^/]*'; i++; }
      else { src += pattern[i].replace(/[.+?^${}()|[\]\\-]/g, '\\$&'); i++; }
    }
    re = new RegExp(`^${src}$`);
    patternCache.set(pattern, re);
  }
  return re;
}
export const matchesAllowedPath = (p: string, patterns: string[]): boolean => patterns.some((pat) => isValidAllowedPattern(pat) && patternRegex(pat).test(p));

// ---- secrets: a Task Package must not carry any (11.3) ----
const SECRET_RULES: Array<{ id: string; re: RegExp }> = [
  { id: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: 'provider_secret_key', re: /\b(?:sk|gsk|xai)-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'assigned_secret', re: /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*["']?[A-Za-z0-9/+_=-]{16,}/ },
];
/** Rule ids that matched. The matched text is never returned or logged. */
export const findSecretRules = (text: string): string[] => SECRET_RULES.filter((r) => r.re.test(text)).map((r) => r.id);

// ---- Task Package (11.3) ----
const safePath = z.string().min(1).max(300).refine((p) => normalizeRepoPath(p) !== null, 'unsafe path');
const fileSchema = z.object({ path: safePath, content: z.string().max(200_000) }).strict();
const allowedPattern = z.string().refine(isValidAllowedPattern, 'invalid allowed_paths entry');
export const taskPackageSchema = z.object({
  agentsMd: z.string().trim().min(1).max(50_000),
  specMd: z.string().trim().min(1).max(100_000),
  acceptanceMd: z.string().trim().min(1).max(50_000),
  executorPromptMd: z.string().trim().min(1).max(20_000),
  allowedPaths: z.array(allowedPattern).min(1).max(100),
  acceptanceTests: z.array(fileSchema.refine((f) => f.path.startsWith('tests/acceptance/') && f.path.length > 'tests/acceptance/'.length, { message: 'acceptance tests live under tests/acceptance/' })).max(50).default([]),
  contextFiles: z.array(fileSchema).max(50).default([]),
  limits: z.object({
    maxFiles: z.number().int().min(1).max(ABSOLUTE_MAX_FILES).default(DEFAULT_MAX_FILES),
    maxChangedLines: z.number().int().min(1).max(ABSOLUTE_MAX_CHANGED_LINES).default(DEFAULT_MAX_CHANGED_LINES),
  }).strict().default({}),
  sensitivity: z.enum(['normal', 'high']).default('normal'),
}).strict().superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const f of [...v.acceptanceTests, ...v.contextFiles]) {
    if (seen.has(f.path.toLowerCase())) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate file ${f.path}` });
    seen.add(f.path.toLowerCase());
  }
});
export type TaskPackage = z.infer<typeof taskPackageSchema>;

/** Stable SHA-256 of the package content (fixed key order). */
export function packageHash(p: TaskPackage): string {
  const c = { agentsMd: p.agentsMd, specMd: p.specMd, acceptanceMd: p.acceptanceMd, executorPromptMd: p.executorPromptMd, allowedPaths: p.allowedPaths,
    acceptanceTests: p.acceptanceTests.map((f) => [f.path, f.content]), contextFiles: p.contextFiles.map((f) => [f.path, f.content]),
    limits: [p.limits.maxFiles, p.limits.maxChangedLines], sensitivity: p.sensitivity };
  return crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

/** Rule ids per place (never the text) for every secret-looking string in the package. */
export function packageSecretFindings(p: TaskPackage): Array<{ where: string; rule: string }> {
  const parts: Array<[string, string]> = [['AGENTS.md', p.agentsMd], ['SPEC.md', p.specMd], ['ACCEPTANCE.md', p.acceptanceMd], ['EXECUTOR_PROMPT.md', p.executorPromptMd],
    ...p.acceptanceTests.map((f): [string, string] => [f.path, f.content]), ...p.contextFiles.map((f): [string, string] => [f.path, f.content])];
  const out: Array<{ where: string; rule: string }> = [];
  for (const [where, text] of parts) for (const rule of findSecretRules(text)) out.push({ where, rule });
  return out;
}

/** SPEC.md as committed or exported: the author's text plus the machine-checked sections the diff validation uses. */
export function renderSpecMd(taskId: string, p: TaskPackage): string {
  return [p.specMd.trim(), '', '## allowed_paths', ...p.allowedPaths.map((a) => `- \`${a}\``), '', '## context_files', ...(p.contextFiles.length ? p.contextFiles.map((f) => `- \`${f.path}\``) : ['- (none)']),
    '', '## limits', `- max files: ${p.limits.maxFiles}`, `- max changed lines: ${p.limits.maxChangedLines}`, '', `Task: \`${taskId}\``, ''].join('\n');
}

const fenceFor = (text: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
};
const block = (path: string, text: string): string => { const f = fenceFor(text); return `### \`${path}\`\n\n${f}\n${text.replace(/\n$/, '')}\n${f}\n`; };

/**
 * PACKAGE.md (11.3): one text file to carry into any tool. Not committed to the repository; handed to the human as an artifact.
 * Deterministic for the same package. Throws on secrets and on a result above MAX_PACKAGE_MD_BYTES.
 */
export function buildPackageMd(taskId: string, p: TaskPackage): string {
  const secrets = packageSecretFindings(p);
  if (secrets.length) throw new CodeExecutorError('PACKAGE_SECRET', 'The package contains secret-looking text', { findings: secrets.slice(0, 20) });
  const md = [
    `# Task Package ${taskId}`, '',
    `Package hash: \`${packageHash(p)}\``, '',
    'Return the result as a pull request from the branch `biforge/' + taskId + '` (or a branch, or a unified diff). Do not merge. Do not touch protected paths.', '',
    '## Instructions (EXECUTOR_PROMPT.md)', '', p.executorPromptMd.trim(), '',
    '## Rules (AGENTS.md)', '', p.agentsMd.trim(), '',
    '## SPEC (SPEC.md)', '', renderSpecMd(taskId, p).trim(), '',
    '## Acceptance criteria (ACCEPTANCE.md)', '', p.acceptanceMd.trim(), '',
    '## Acceptance tests (tests/acceptance/**, read-only for the implementer)', '', ...(p.acceptanceTests.length ? p.acceptanceTests.map((f) => block(f.path, f.content)) : ['(none)', '']),
    '## Context files', '', ...(p.contextFiles.length ? p.contextFiles.map((f) => block(f.path, f.content)) : ['(none)', '']),
  ].join('\n');
  if (Buffer.byteLength(md, 'utf8') > MAX_PACKAGE_MD_BYTES) throw new CodeExecutorError('PACKAGE_TOO_LARGE', 'PACKAGE.md exceeds the size limit; split the task');
  return md;
}

// ---- unified diff: parse, validate, apply (11.4) ----
export class CodeExecutorError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) { super(message); this.name = 'CodeExecutorError'; this.code = code; this.details = details; }
}
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<{ op: ' ' | '+' | '-'; text: string }>; oldNoEol: boolean; newNoEol: boolean }
export interface ParsedFile { path: string; action: 'create' | 'modify' | 'delete'; hunks: Hunk[]; added: number; removed: number }
export interface Violation { code: string; path?: string }
export interface ParsedDiff { files: ParsedFile[]; problems: Violation[] }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const stripCr = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);

/** Parses a unified diff (git or plain). Never throws on content problems: they come back as `problems` (nothing may be applied then). */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const problems: Violation[] = [];
  const files: ParsedFile[] = [];
  const add = (code: string, path?: string) => { if (problems.length < 100 && !problems.some((p) => p.code === code && p.path === path)) problems.push(path === undefined ? { code } : { code, path }); };
  if (typeof text !== 'string' || !text.trim()) { add('empty_diff'); return { files, problems }; }
  if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES) { add('diff_too_large'); return { files, problems }; }
  if (text.includes('\0')) { add('binary_content'); return { files, problems }; }

  const lines = text.split('\n');
  type Cur = { gitPath: string | null; oldPath: string | null; newPath: string | null; create: boolean; del: boolean; binary: boolean; mode: string[]; rename: boolean; hunks: Hunk[]; hasGitHeader: boolean };
  let cur: Cur | null = null;
  const fresh = (hasGitHeader: boolean): Cur => ({ gitPath: null, oldPath: null, newPath: null, create: false, del: false, binary: false, mode: [], rename: false, hunks: [], hasGitHeader });
  const seen = new Set<string>();
  const finish = () => {
    if (!cur) return;
    const c = cur; cur = null;
    let oldP = c.oldPath, newP = c.newPath;
    const dev = '/dev/null';
    if (c.hasGitHeader) {
      if (oldP && oldP !== dev && oldP.startsWith('a/')) oldP = oldP.slice(2);
      if (newP && newP !== dev && newP.startsWith('b/')) newP = newP.slice(2);
    } else {
      const oldOk = oldP === dev || (oldP?.startsWith('a/') ?? false), newOk = newP === dev || (newP?.startsWith('b/') ?? false);
      if (oldOk && newOk) { if (oldP !== dev && oldP) oldP = oldP.slice(2); if (newP !== dev && newP) newP = newP.slice(2); }
    }
    const candidates = [...new Set([c.gitPath, oldP, newP].filter((x): x is string => !!x && x !== dev))];
    if (c.rename) { add('rename_unsupported', (candidates[candidates.length - 1] ?? '').slice(0, 200) || undefined); return; }
    if (candidates.length === 0) { add('path_missing'); return; }
    if (candidates.length > 1) { add('path_mismatch', candidates[0].slice(0, 200)); return; }
    const path = candidates[0];
    if (c.binary) { add('binary_not_allowed', path.slice(0, 200)); return; }
    for (const m of c.mode) add(m, path.slice(0, 200));
    if (path.startsWith('"')) { add('path_unsafe', path.slice(0, 200)); return; }
    const norm = normalizeRepoPath(path);
    if (norm === null) { add('path_unsafe', path.slice(0, 200)); return; }
    if (seen.has(norm.toLowerCase())) { add('duplicate_path', norm); return; }
    seen.add(norm.toLowerCase());
    const create = c.create || oldP === dev, del = c.del || newP === dev;
    if (create && del) { add('empty_change', norm); return; }
    if (!c.hunks.length && !create && !del) { add('empty_change', norm); return; }
    let added = 0, removed = 0;
    for (const h of c.hunks) for (const l of h.lines) { if (l.op === '+') added++; else if (l.op === '-') removed++; }
    files.push({ path: norm, action: create ? 'create' : del ? 'delete' : 'modify', hunks: c.hunks, added, removed });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = stripCr(lines[i]);
    if (line.startsWith('diff --git ')) {
      finish();
      cur = fresh(true);
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) add('header_malformed');
      else if (m[1] !== m[2]) cur.rename = true;   // a path that differs between the sides is a rename or a copy
      else cur.gitPath = m[1];
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!(cur && cur.hunks.length === 0 && cur.oldPath === null)) { finish(); cur = fresh(false); }
      cur!.oldPath = line.slice(4).replace(/\t.*$/, '').trim();
      continue;
    }
    if (!cur) continue;   // text before the first file (mail headers, a commit message) is ignored, never applied
    if (line.startsWith('+++ ') && cur.newPath === null && cur.hunks.length === 0) { cur.newPath = line.slice(4).replace(/\t.*$/, '').trim(); continue; }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      const h: Hunk = { oldStart: Number(hm[1]), oldLines: hm[2] === undefined ? 1 : Number(hm[2]), newStart: Number(hm[3]), newLines: hm[4] === undefined ? 1 : Number(hm[4]), lines: [], oldNoEol: false, newNoEol: false };
      let oldLeft = h.oldLines, newLeft = h.newLines;
      const label = cur.gitPath ?? cur.newPath ?? cur.oldPath ?? undefined;
      if (oldLeft > 100_000 || newLeft > 100_000) { add('malformed_hunk', label); continue; }
      const mark = () => { const last = h.lines[h.lines.length - 1]; if (last) { if (last.op !== '+') h.oldNoEol = true; if (last.op !== '-') h.newNoEol = true; } };
      while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next === '' && i + 1 === lines.length - 1) break;   // the empty piece after the final newline is not a context line
        const op = next === '' ? ' ' : next[0];
        if (op === '\\') { mark(); i++; continue; }
        if (op === ' ') { if (oldLeft <= 0 || newLeft <= 0) break; h.lines.push({ op: ' ', text: next.slice(1) }); oldLeft--; newLeft--; }
        else if (op === '-') { if (oldLeft <= 0) break; h.lines.push({ op: '-', text: next.slice(1) }); oldLeft--; }
        else if (op === '+') { if (newLeft <= 0) break; h.lines.push({ op: '+', text: next.slice(1) }); newLeft--; }
        else break;
        i++;
      }
      while (i + 1 < lines.length && lines[i + 1].startsWith('\\')) { mark(); i++; }   // "\ No newline at end of file" after the last line
      if (oldLeft !== 0 || newLeft !== 0) add('malformed_hunk', label);
      cur.hunks.push(h);
      continue;
    }
    let m: RegExpExecArray | null;
    if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) cur.binary = true;
    else if (cur.hunks.length === 0) {
      if ((m = /^new file mode (\d+)$/.exec(line))) { cur.create = true; if (m[1] === '120000') cur.mode.push('symlink_not_allowed'); else if (m[1] === '160000') cur.mode.push('submodule_not_allowed'); else if (m[1] !== '100644') cur.mode.push('mode_not_allowed'); }
      else if ((m = /^deleted file mode (\d+)$/.exec(line))) { cur.del = true; if (m[1] === '120000') cur.mode.push('symlink_not_allowed'); else if (m[1] === '160000') cur.mode.push('submodule_not_allowed'); }
      else if (/^(old|new) mode /.test(line)) cur.mode.push('mode_change_not_allowed');
      else if (/^(rename|copy) (from|to) /.test(line) || /^(dis)?similarity index /.test(line)) cur.rename = true;
    }
  }
  finish();
  if (!files.length && !problems.length) add('empty_diff');
  return { files, problems };
}

export interface ChangeFile { path: string; action: string; added: number; removed: number }
/** Validation by deterministic code (11.4 items 1 to 4). Returns every violation; an empty list means the change set may be applied. */
export function validateChangeSet(files: ChangeFile[], o: { allowedPaths: string[]; limits?: { maxFiles?: number; maxChangedLines?: number } }): Violation[] {
  // Package may request up to APP_BUILDER / absolute ceiling; do not clamp back to DEFAULT_*.
  const maxFiles = Math.min(o.limits?.maxFiles ?? DEFAULT_MAX_FILES, ABSOLUTE_MAX_FILES);
  const maxLines = Math.min(o.limits?.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES, ABSOLUTE_MAX_CHANGED_LINES);
  const out: Violation[] = [];
  const push = (v: Violation) => { if (out.length < 100) out.push(v); };
  if (files.length === 0) push({ code: 'empty_diff' });
  if (files.length > maxFiles) push({ code: 'too_many_files' });
  if (files.reduce((s, f) => s + f.added + f.removed, 0) > maxLines) push({ code: 'too_many_lines' });
  for (const f of files) {
    if (normalizeRepoPath(f.path) === null) { push({ code: 'path_unsafe', path: f.path.slice(0, 200) }); continue; }
    if (isProtectedPath(f.path)) { push({ code: 'path_protected', path: f.path }); continue; }
    if (!matchesAllowedPath(f.path, o.allowedPaths)) push({ code: 'path_not_allowed', path: f.path });
  }
  return out;
}

const splitText = (text: string): { lines: string[]; eol: boolean } => {
  if (text === '') return { lines: [], eol: true };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') { lines.pop(); return { lines, eol: true }; }
  return { lines, eol: false };
};

/**
 * Applies the hunks of one file to its current text. Strict: every context and removed line must match exactly at the stated position.
 * `original` is null when the file does not exist. Returns the new text, or null for a deletion.
 */
export function applyFileDiff(original: string | null, f: ParsedFile): string | null {
  if (f.action === 'create') {
    if (original !== null) throw new CodeExecutorError('file_exists', 'A file to create already exists', { path: f.path });
  } else if (original === null) throw new CodeExecutorError('file_missing', 'A file to change does not exist', { path: f.path });
  const src = splitText(original ?? '');
  const out: string[] = [];
  let idx = 0;
  let eol = f.action === 'create' ? true : src.eol;
  let reachedEnd = false;
  let lastNewNoEol = false;
  for (const h of f.hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < idx || start > src.lines.length) throw new CodeExecutorError('hunk_failed', 'Hunk position does not match the file', { path: f.path });
    while (idx < start) out.push(src.lines[idx++]);
    for (const l of h.lines) {
      if (l.op === '+') { out.push(l.text); continue; }
      if (src.lines[idx] === undefined || src.lines[idx] !== l.text) throw new CodeExecutorError('hunk_failed', 'Hunk context does not match the file', { path: f.path, line: idx + 1 });
      if (l.op === ' ') out.push(l.text);
      idx++;
    }
    reachedEnd = idx === src.lines.length;
    lastNewNoEol = h.newNoEol;
  }
  while (idx < src.lines.length) out.push(src.lines[idx++]);
  if (f.hunks.length && reachedEnd) eol = !lastNewNoEol;
  if (f.action === 'delete') {
    if (out.length) throw new CodeExecutorError('hunk_failed', 'A deletion must remove the whole file', { path: f.path });
    return null;
  }
  const text = out.length ? out.join('\n') + (eol ? '\n' : '') : '';
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new CodeExecutorError('file_too_large', 'Resulting file is too large', { path: f.path });
  return text;
}

export const countChanges = (files: ChangeFile[]) => ({ filesChanged: files.length, linesChanged: files.reduce((s, f) => s + f.added + f.removed, 0) });

// ---- the `manual` executor (11.4) ----
/** Persistence used by the executor; the service implements it on PostgreSQL, tests on memory. */
export interface ExecutorStore {
  createWaiting(pkg: TaskPackageRef, run: RunRef, executor: CodeExecutorId): Promise<{ codeTaskId: string }>;
  read(codeTaskId: string): Promise<{ state: ExecutorState; result?: ExecutorResult; reason?: string } | null>;
}
/**
 * `manual`: BiForge prepares the package and waits. The human carries PACKAGE.md to any tool and returns a PR, a branch or a diff
 * (submitted through the service). Nothing here starts a model or runs code.
 */
export function createManualExecutor(store: ExecutorStore): CodeExecutor {
  return {
    id: 'manual',
    async start(pkg, run) { const { codeTaskId } = await store.createWaiting(pkg, run, 'manual'); return { codeTaskId, executor: 'manual' }; },
    async poll(h) {
      const row = await store.read(h.codeTaskId);
      if (!row) throw new CodeExecutorError('NOT_FOUND', 'Code task not found');
      return { state: row.state, ...(row.result ? { result: row.result } : {}), ...(row.reason ? { reason: row.reason } : {}) };
    },
  };
}

// ---- structured model_patch (TZ 11.4, P19 / BX-21.b) ----
/** JSON shape returned by the code_author profile: full-file contents, not a unified diff. */
export const modelPatchFileSchema = z.object({
  path: z.string().min(1).max(300),
  action: z.enum(['create', 'modify', 'delete']),
  content: z.string().max(MAX_FILE_BYTES).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.action !== 'delete' && (v.content === undefined || v.content === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content required for create/modify' });
  }
  if (v.action === 'delete' && v.content !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content must be absent for delete' });
  }
});
export const modelPatchSchema = z.object({
  files: z.array(modelPatchFileSchema).min(1).max(ABSOLUTE_MAX_FILES),
  notes: z.string().max(10_000).optional(),
}).strict();
export type ModelPatch = z.infer<typeof modelPatchSchema>;

/** Convert a validated model patch into ChangeFile[] (added/removed estimated by line count of content). */
export function modelPatchToChangeFiles(patch: ModelPatch): ChangeFile[] {
  return patch.files.map((f) => {
    const lines = f.content ? f.content.split('\n').length : 0;
    return {
      path: f.path,
      action: f.action,
      hunks: [],
      added: f.action === 'delete' ? 0 : lines,
      removed: f.action === 'create' ? 0 : lines,
    };
  });
}

/** Full-file payloads for Git Data API: create/modify → text, delete → null. */
export function modelPatchToBranchChanges(patch: ModelPatch): Array<{ path: string; content: string | null }> {
  return patch.files.map((f) => ({
    path: f.path,
    content: f.action === 'delete' ? null : (f.content ?? ''),
  }));
}

/**
 * Validate a model_patch payload against package limits and protected paths (TZ 11.4 points 1–5).
 * Returns violations; empty array means the patch is acceptable for application.
 */
export function validateModelPatch(raw: unknown, o: { allowedPaths: string[]; limits?: { maxFiles?: number; maxChangedLines?: number } }): { ok: true; patch: ModelPatch; files: ChangeFile[] } | { ok: false; violations: Violation[] } {
  const parsed = modelPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [{ code: 'schema_invalid', path: parsed.error.issues[0]?.path?.join('.') }] };
  }
  const patch = parsed.data;
  const files = modelPatchToChangeFiles(patch);
  const viol = validateChangeSet(files, o);
  for (const f of patch.files) {
    if (normalizeRepoPath(f.path) === null) viol.push({ code: 'path_unsafe', path: f.path.slice(0, 200) });
    if (f.content !== undefined && Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) viol.push({ code: 'file_too_large', path: f.path });
  }
  if (viol.length) return { ok: false, violations: viol };
  return { ok: true, patch, files };
}

/**
 * Static checks for generated source. This parses JavaScript but NEVER evaluates it.
 * Browser/game intents must include a basic index.html shell; remote script sources are refused.
 */
export function validateGeneratedSource(patch: ModelPatch, goal: string): Violation[] {
  const violations: Violation[] = [];
  const browserIntent = /\btetris\b|\bbrowser\b|\bweb app\b|\bwebsite\b|\bhtml\b|\bgame\b|тетрис|игр[а-я]*/i.test(goal);
  const liveFiles = patch.files.filter((f) => f.action !== 'delete' && f.content !== undefined);
  const html = liveFiles.find((f) => /(?:^|\/)index\.html$/i.test(f.path));
  const pkgJson = liveFiles.find((f) => /(?:^|\/)package\.json$/i.test(f.path));
  // Browser-style goals need a local entrypoint (static index.html or a package.json-based app).
  if (browserIntent && !html && !pkgJson) violations.push({ code: 'browser_entrypoint_missing' });
  if (html) {
    if (!/<html\b/i.test(html.content ?? '') || !/<body\b/i.test(html.content ?? '')) violations.push({ code: 'html_shell_invalid', path: html.path });
    if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(html.content ?? '')) violations.push({ code: 'remote_script_disallowed', path: html.path });
    const scripts = html.content ?? '';
    for (const match of scripts.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/i.test(match[1]) || /\btype\s*=\s*["']module["']/i.test(match[1])) continue;
      try { new Script(match[2], { filename: html.path }); }
      catch { violations.push({ code: 'javascript_syntax_invalid', path: html.path }); }
    }
  }
  for (const file of liveFiles.filter((f) => /\.js$/i.test(f.path))) {
    const content = file.content ?? '';
    // ESM files need a module parser; this conservative MVP reports no claim about their syntax.
    if (/^\s*(?:import\s|export\s)/m.test(content)) continue;
    try { new Script(content, { filename: file.path }); }
    catch { violations.push({ code: 'javascript_syntax_invalid', path: file.path }); }
  }
  return violations;
}

/**
 * `model_patch`: product calls code_author via Router, validates the structured patch, writes via Git Data API.
 * The actual model call and GitHub write live in the service (they need adapters and config). This factory only
 * manages the WAITING/RUNNING lifecycle; the service drives the work after start returns RUNNING.
 */
export function createModelPatchExecutor(store: ExecutorStore): CodeExecutor {
  return {
    id: 'model_patch',
    async start(pkg, run) {
      const { codeTaskId } = await store.createWaiting(pkg, run, 'model_patch');
      return { codeTaskId, executor: 'model_patch' };
    },
    async poll(h) {
      const row = await store.read(h.codeTaskId);
      if (!row) throw new CodeExecutorError('NOT_FOUND', 'Code task not found');
      return { state: row.state, ...(row.result ? { result: row.result } : {}), ...(row.reason ? { reason: row.reason } : {}) };
    },
  };
}
