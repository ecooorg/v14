import crypto from 'node:crypto';
import { isProtectedPath } from './codeExecutor.ts';

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  owner: string;
  repository: string;
  apiBaseUrl?: string;
}
export type GitHubCheckResult =
  | { status: 'OK'; permissions: Record<string, string>; repository: string }
  | { status: 'FAIL'; reason: string };

export function createGitHubAppJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!/^\d+$/.test(appId) || !privateKey.trim()) throw new Error('invalid_github_app_config');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat: nowSeconds - 30, exp: nowSeconds + 8 * 60, iss: appId });
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

export function verifyGitHubWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * ADR-06 Amendment 1 (P53): the one GitHub write switch is `GITHUB_DIFF_UPLOAD=true`.
 * `CODE_EXECUTOR=model_patch` means "generate a source ZIP" and implies no GitHub write.
 * Off by default: with the switch off the installation token must stay within the read-only manifest.
 */
export const githubWritesEnabled = (): boolean => process.env.GITHUB_DIFF_UPLOAD === 'true';
export const diffUploadEnabled = (): boolean => process.env.GITHUB_DIFF_UPLOAD === 'true';

const BASE_PERMISSIONS: Record<string, string> = {
  metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read',
};
const WRITE_PERMISSIONS: Record<string, string> = { contents: 'write', pull_requests: 'write' };
const rank: Record<string, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function permissionsWithinMaximum(
  actual: Record<string, string> | undefined,
  writesEnabled: boolean,
): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const maximum = { ...BASE_PERMISSIONS, ...(writesEnabled ? WRITE_PERMISSIONS : {}) };
  for (const [permission, level] of Object.entries(actual)) {
    if (!(permission in maximum) || !(level in rank) || rank[level] > rank[maximum[permission] || 'none']) return false;
  }
  const required = writesEnabled ? { ...BASE_PERMISSIONS, ...WRITE_PERMISSIONS } : BASE_PERMISSIONS;
  return Object.entries(required).every(([key, value]) => (rank[actual[key] || 'none'] || 0) >= rank[value]);
}

export async function verifyGitHubAppConnection(config: GitHubAppConfig, fetcher: typeof fetch = fetch): Promise<GitHubCheckResult> {
  const base = (config.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
  const timeout = AbortSignal.timeout(10_000);
  try {
    const jwt = createGitHubAppJwt(config.appId, config.privateKey);
    const tokenResponse = await fetcher(`${base}/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: '{}', signal: timeout,
    });
    if (!tokenResponse.ok) return { status: 'FAIL', reason: `github_token_http_${tokenResponse.status}` };
    const tokenData = await tokenResponse.json() as { token?: string; permissions?: Record<string, string> };
    if (!tokenData.token || !permissionsWithinMaximum(tokenData.permissions, githubWritesEnabled())) {
      return { status: 'FAIL', reason: 'permissions_too_broad_or_missing' };
    }
    const repositoryResponse = await fetcher(`${base}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`, {
      headers: { Authorization: `Bearer ${tokenData.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: timeout,
    });
    if (!repositoryResponse.ok) return { status: 'FAIL', reason: `github_repository_http_${repositoryResponse.status}` };
    return { status: 'OK', permissions: tokenData.permissions || {}, repository: `${config.owner}/${config.repository}` };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return { status: 'FAIL', reason: name === 'TimeoutError' ? 'timeout' : 'github_connection_error' };
  }
}

// ---- P16 / BX-19 (continued): read PRs and check runs, commit the Task Package to biforge/<task_id> -----------------
// Deliberately no merge, no workflow, no write to any branch outside `biforge/*` (TZ 11.7, E.5).
const GH_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const taskBranchName = (taskId: string): string => {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error('invalid_task_id');
  return `biforge/${taskId}`;
};
/** task id from a head ref, or null for any branch that is not a task branch */
export const taskIdFromBranch = (ref: unknown): string | null => {
  const m = typeof ref === 'string' ? /^biforge\/([A-Za-z0-9_-]{1,128})$/.exec(ref) : null;
  return m ? m[1] : null;
};

type Fetcher = typeof fetch;
const apiBase = (c: GitHubAppConfig) => (c.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
const repoPath = (c: GitHubAppConfig) => `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repository)}`;

/** Installation tokens are issued per call and never stored (E.5). Permissions are checked against the manifest every time. */
async function installationToken(config: GitHubAppConfig, fetcher: Fetcher, writeEnabled: boolean): Promise<string> {
  const jwt = createGitHubAppJwt(config.appId, config.privateKey);
  const res = await fetcher(`${apiBase(config)}/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`, {
    method: 'POST', headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`github_token_http_${res.status}`);
  const data = await res.json() as { token?: string; permissions?: Record<string, string> };
  if (!data.token || !permissionsWithinMaximum(data.permissions, writeEnabled)) throw new Error('permissions_too_broad_or_missing');
  return data.token;
}
async function ghJson(config: GitHubAppConfig, fetcher: Fetcher, token: string, pathAndQuery: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetcher(`${apiBase(config)}${pathAndQuery}`, {
    ...init, headers: { ...GH_HEADERS, Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(10_000),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body };
}
const needOk = (r: { status: number }, what: string) => { if (r.status < 200 || r.status >= 300) throw new Error(`${what}_http_${r.status}`); };

export interface PullRequestInfo { number: number; state: string; merged: boolean; headSha: string; headRef: string; baseRef: string; htmlUrl?: string }
export async function readPullRequest(config: GitHubAppConfig, number: number, fetcher: Fetcher = fetch): Promise<PullRequestInfo> {
  if (!Number.isInteger(number) || number < 1) throw new Error('invalid_pr_number');
  const token = await installationToken(config, fetcher, githubWritesEnabled());
  const r = await ghJson(config, fetcher, token, `${repoPath(config)}/pulls/${number}`);
  needOk(r, 'github_pull');
  const b = r.body;
  if (!b || !/^[0-9a-f]{40}$/i.test(String(b.head?.sha))) throw new Error('github_pull_malformed');
  return { number, state: String(b.state), merged: Boolean(b.merged), headSha: String(b.head.sha), headRef: String(b.head.ref), baseRef: String(b.base?.ref ?? ''), ...(typeof b.html_url === 'string' && b.html_url.startsWith('https://') ? { htmlUrl: b.html_url.slice(0, 500) } : {}) };
}

export interface CheckRunInfo { id: number; name: string; status: string; conclusion: string | null; headSha: string; detailsUrl: string | null }
export async function listCheckRuns(config: GitHubAppConfig, sha: string, fetcher: Fetcher = fetch): Promise<CheckRunInfo[]> {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('invalid_sha');
  const token = await installationToken(config, fetcher, githubWritesEnabled());
  const out: CheckRunInfo[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ghJson(config, fetcher, token, `${repoPath(config)}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    needOk(r, 'github_check_runs');
    const runs: any[] = Array.isArray(r.body?.check_runs) ? r.body.check_runs : [];
    for (const c of runs) out.push({ id: Number(c.id), name: String(c.name).slice(0, 200), status: String(c.status), conclusion: c.conclusion ?? null, headSha: sha, detailsUrl: typeof c.html_url === 'string' && c.html_url.startsWith('https://') ? c.html_url.slice(0, 500) : null });
    if (runs.length < 100) break;
  }
  return out;
}

/** Files changed by a PR. GitHub returns at most 3000; a full 3000 is reported as truncated. */
export async function listPullRequestFiles(config: GitHubAppConfig, number: number, fetcher: Fetcher = fetch): Promise<{ files: Array<{ filename: string; status: string; previous_filename?: string }>; truncated: boolean }> {
  if (!Number.isInteger(number) || number < 1) throw new Error('invalid_pr_number');
  const token = await installationToken(config, fetcher, githubWritesEnabled());
  const files: Array<{ filename: string; status: string; previous_filename?: string }> = [];
  for (let page = 1; page <= 30; page++) {
    const r = await ghJson(config, fetcher, token, `${repoPath(config)}/pulls/${number}/files?per_page=100&page=${page}`);
    needOk(r, 'github_pull_files');
    const rows: any[] = Array.isArray(r.body) ? r.body : [];
    for (const f of rows) files.push({ filename: String(f.filename), status: String(f.status), ...(f.previous_filename ? { previous_filename: String(f.previous_filename) } : {}) });
    if (rows.length < 100) break;
  }
  return { files, truncated: files.length >= 3000 };
}

export interface TaskPackageFile { path: string; content: string }
const MAX_PACKAGE_FILES = 50;
const MAX_PACKAGE_FILE_BYTES = 1_000_000;
/** Allowed Task Package paths (TZ 11.3). Everything else, including workflows and any `..`, is refused. */
export function isAllowedTaskPackagePath(taskId: string, p: string): boolean {
  if (typeof p !== 'string' || p.includes('\\') || p.includes('\0') || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  if (p === 'AGENTS.md') return true;
  const dir = `.biforge/tasks/${taskId}/`;
  if (p.startsWith(dir)) return ['SPEC.md', 'ACCEPTANCE.md', 'EXECUTOR_PROMPT.md'].includes(p.slice(dir.length));
  return p.startsWith('tests/acceptance/') && p.length > 'tests/acceptance/'.length;
}

/**
 * Commit an approved Task Package to `biforge/<task_id>`. Writes are refused unless `writeEnabled` is true
 * (model_patch or diff upload, 11.7). The branch is created from `baseBranch`; `main` is never written.
 */
export async function commitTaskPackage(
  config: GitHubAppConfig,
  input: { taskId: string; baseBranch: string; files: TaskPackageFile[]; message?: string; writeEnabled: boolean },
  fetcher: Fetcher = fetch,
): Promise<{ branch: string; commitShas: string[] }> {
  if (input.writeEnabled !== true) throw new Error('github_write_disabled');
  const branch = taskBranchName(input.taskId);
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(input.baseBranch) || input.baseBranch.startsWith('biforge/') || input.baseBranch.includes('..')) throw new Error('invalid_base_branch');
  if (!input.files.length || input.files.length > MAX_PACKAGE_FILES) throw new Error('invalid_file_count');
  for (const f of input.files) {
    if (!isAllowedTaskPackagePath(input.taskId, f.path)) throw new Error('path_not_allowed');
    if (typeof f.content !== 'string' || Buffer.byteLength(f.content, 'utf8') > MAX_PACKAGE_FILE_BYTES) throw new Error('file_too_large');
  }
  const token = await installationToken(config, fetcher, true);
  const repo = repoPath(config);
  const base = await ghJson(config, fetcher, token, `${repo}/git/ref/heads/${input.baseBranch.split('/').map(encodeURIComponent).join('/')}`);
  needOk(base, 'github_base_ref');
  const baseSha = String(base.body?.object?.sha || '');
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error('github_base_ref_malformed');
  const created = await ghJson(config, fetcher, token, `${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) });
  if (created.status !== 201 && created.status !== 422) needOk(created, 'github_create_branch'); // 422: the branch already exists, continue on it
  const commitShas: string[] = [];
  for (const f of input.files) {
    const url = `${repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    const existing = await ghJson(config, fetcher, token, `${url}?ref=${encodeURIComponent(branch)}`);
    const sha = existing.status === 200 && typeof existing.body?.sha === 'string' ? existing.body.sha : undefined;
    const put = await ghJson(config, fetcher, token, url, { method: 'PUT', body: JSON.stringify({ message: (input.message || `Task Package ${input.taskId}`).slice(0, 200), content: Buffer.from(f.content, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) }) });
    needOk(put, 'github_put_file');
    commitShas.push(String(put.body?.commit?.sha || ''));
  }
  return { branch, commitShas };
}

// ---- P18 / BX-21.a: executor delivery. Reads of branches and diffs; the only writes are a commit and a PR on `biforge/<task_id>` ----
/** Repository settings from the environment (names as in connectors.yaml), or null when GitHub is not configured. */
export function githubConfigFromEnv(): GitHubAppConfig | null {
  const e = process.env;
  if (!e.GITHUB_APP_ID || !e.GITHUB_APP_INSTALLATION_ID || !e.GITHUB_APP_PRIVATE_KEY || !e.GITHUB_REPOSITORY_OWNER || !e.GITHUB_REPOSITORY_NAME) return null;
  return { appId: e.GITHUB_APP_ID, installationId: e.GITHUB_APP_INSTALLATION_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'), owner: e.GITHUB_REPOSITORY_OWNER, repository: e.GITHUB_REPOSITORY_NAME, apiBaseUrl: e.GITHUB_API_BASE_URL };
}
const SHA_RE = /^[0-9a-f]{40}$/i;
const BASE_BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const assertBaseBranch = (b: string) => { if (!BASE_BRANCH_RE.test(b) || b.startsWith('biforge/') || b.includes('..') || b.startsWith('/') || b.endsWith('/')) throw new Error('invalid_base_branch'); };
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');
const httpsOrNull = (u: unknown): string | null => (typeof u === 'string' && u.startsWith('https://') ? u.slice(0, 500) : null);

/** Head SHA of a task branch, or null when the branch does not exist. */
export async function readBranchHead(config: GitHubAppConfig, branch: string, fetcher: Fetcher = fetch): Promise<string | null> {
  const taskId = taskIdFromBranch(branch);
  if (!taskId) throw new Error('invalid_branch');
  const token = await installationToken(config, fetcher, githubWritesEnabled());
  const r = await ghJson(config, fetcher, token, `${repoPath(config)}/git/ref/heads/${refPath(branch)}`);
  if (r.status === 404) return null;
  needOk(r, 'github_branch');
  const sha = String(r.body?.object?.sha || '');
  if (!SHA_RE.test(sha)) throw new Error('github_branch_malformed');
  return sha.toLowerCase();
}

export interface PullRequestByBranch { number: number; state: string; merged: boolean; headSha: string; baseRef: string; htmlUrl: string | null }
/** The newest PR whose head is the task branch (any state), or null. Used when no webhook arrived (polling). */
export async function findPullRequestByBranch(config: GitHubAppConfig, branch: string, fetcher: Fetcher = fetch): Promise<PullRequestByBranch | null> {
  if (!taskIdFromBranch(branch)) throw new Error('invalid_branch');
  const token = await installationToken(config, fetcher, githubWritesEnabled());
  const r = await ghJson(config, fetcher, token, `${repoPath(config)}/pulls?head=${encodeURIComponent(`${config.owner}:${branch}`)}&state=all&sort=created&direction=desc&per_page=5`);
  needOk(r, 'github_pulls');
  const rows: any[] = Array.isArray(r.body) ? r.body : [];
  for (const b of rows) {
    if (b?.head?.ref !== branch || !SHA_RE.test(String(b?.head?.sha)) || !Number.isInteger(b?.number)) continue;
    return { number: b.number, state: String(b.state), merged: Boolean(b.merged_at), headSha: String(b.head.sha).toLowerCase(), baseRef: String(b.base?.ref ?? ''), htmlUrl: httpsOrNull(b.html_url) };
  }
  return null;
}

export interface ComparedFile { filename: string; status: string; additions: number; deletions: number; hasPatch: boolean; previous_filename?: string }
/** Files changed between a base branch and a head (merge-base diff, as a PR shows it). GitHub lists at most 300 files here; that many is reported as truncated. */
export async function compareToBase(config: GitHubAppConfig, baseBranch: string, head: string, fetcher: Fetcher = fetch): Promise<{ files: ComparedFile[]; truncated: boolean; headSha: string }> {
  assertBaseBranch(baseBranch);
  if (!SHA_RE.test(head) && !taskIdFromBranch(head)) throw new Error('invalid_head');
  const token = await installationToken(config, fetcher, githubWritesEnabled());
  const r = await ghJson(config, fetcher, token, `${repoPath(config)}/compare/${refPath(baseBranch)}...${SHA_RE.test(head) ? head : refPath(head)}?per_page=100`);
  needOk(r, 'github_compare');
  const raw: any[] = Array.isArray(r.body?.files) ? r.body.files : [];
  const headSha = String(r.body?.commits?.[r.body.commits.length - 1]?.sha || (SHA_RE.test(head) ? head : ''));
  if (!SHA_RE.test(headSha)) throw new Error('github_compare_malformed');
  const files = raw.map((f) => ({ filename: String(f.filename), status: String(f.status), additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0, hasPatch: typeof f.patch === 'string', ...(f.previous_filename ? { previous_filename: String(f.previous_filename) } : {}) }));
  return { files, truncated: raw.length >= 300, headSha: headSha.toLowerCase() };
}

/** Text of a regular file at a ref, or null when it does not exist. Symlinks, directories, binary and files over 1 MB are refused. */
export async function readTextFile(config: GitHubAppConfig, path: string, ref: string, fetcher: Fetcher = fetch): Promise<string | null> {
  if (!/^[A-Za-z0-9._\-/ ]{1,300}$/.test(path) || path.split('/').some((x) => x === '' || x === '.' || x === '..') || path.startsWith('/')) throw new Error('path_not_allowed');
  if (!SHA_RE.test(ref) && !BASE_BRANCH_RE.test(ref)) throw new Error('invalid_ref');
  const token = await installationToken(config, fetcher, githubWritesEnabled());
  const r = await ghJson(config, fetcher, token, `${repoPath(config)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
  if (r.status === 404) return null;
  needOk(r, 'github_contents');
  const b = r.body;
  if (!b || Array.isArray(b) || b.type !== 'file' || b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error('not_a_regular_file');
  if (Number(b.size) > 1_000_000) throw new Error('file_too_large');
  const bytes = Buffer.from(b.content.replace(/\n/g, ''), 'base64');
  if (bytes.includes(0)) throw new Error('binary_file');
  return bytes.toString('utf8');
}

export interface BranchChange { path: string; /** full new text, or null to delete the file */ content: string | null }
/**
 * One commit on `biforge/<task_id>` made with the Git Data API (blobs, tree, commit, ref). The branch is created from the base branch when it
 * does not exist; an existing branch is advanced without force. Paths in the protected set are refused again here (defence in depth).
 * `main` and workflows are never written; there is no merge in this module.
 */
export async function commitChangesToBranch(
  config: GitHubAppConfig,
  input: { taskId: string; baseBranch: string; changes: BranchChange[]; message: string; writeEnabled: boolean },
  fetcher: Fetcher = fetch,
): Promise<{ branch: string; headSha: string }> {
  if (input.writeEnabled !== true) throw new Error('github_write_disabled');
  const branch = taskBranchName(input.taskId);
  assertBaseBranch(input.baseBranch);
  if (!input.changes.length || input.changes.length > 10) throw new Error('invalid_file_count');
  const seen = new Set<string>();
  for (const c of input.changes) {
    if (typeof c.path !== 'string' || c.path.includes('\\') || c.path.includes('\0') || c.path.startsWith('/') || c.path.split('/').some((x) => x === '' || x === '.' || x === '..')) throw new Error('path_not_allowed');
    if (isProtectedPath(c.path) || seen.has(c.path.toLowerCase())) throw new Error('path_not_allowed');
    seen.add(c.path.toLowerCase());
    if (c.content !== null && (typeof c.content !== 'string' || Buffer.byteLength(c.content, 'utf8') > 1_000_000 || c.content.includes('\0'))) throw new Error('file_too_large');
  }
  const token = await installationToken(config, fetcher, true);
  const repo = repoPath(config);
  const existing = await ghJson(config, fetcher, token, `${repo}/git/ref/heads/${refPath(branch)}`);
  let parent: string;
  const branchExists = existing.status === 200;
  if (branchExists) parent = String(existing.body?.object?.sha || '');
  else {
    if (existing.status !== 404) needOk(existing, 'github_branch');
    const base = await ghJson(config, fetcher, token, `${repo}/git/ref/heads/${refPath(input.baseBranch)}`);
    needOk(base, 'github_base_ref');
    parent = String(base.body?.object?.sha || '');
  }
  if (!SHA_RE.test(parent)) throw new Error('github_ref_malformed');
  const parentCommit = await ghJson(config, fetcher, token, `${repo}/git/commits/${parent}`);
  needOk(parentCommit, 'github_commit');
  const baseTree = String(parentCommit.body?.tree?.sha || '');
  if (!SHA_RE.test(baseTree)) throw new Error('github_commit_malformed');
  const entries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
  for (const c of input.changes) {
    if (c.content === null) { entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null }); continue; }
    const blob = await ghJson(config, fetcher, token, `${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: c.content, encoding: 'utf-8' }) });
    needOk(blob, 'github_blob');
    const sha = String(blob.body?.sha || '');
    if (!SHA_RE.test(sha)) throw new Error('github_blob_malformed');
    entries.push({ path: c.path, mode: '100644', type: 'blob', sha });
  }
  const tree = await ghJson(config, fetcher, token, `${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: entries }) });
  needOk(tree, 'github_tree');
  const treeSha = String(tree.body?.sha || '');
  if (!SHA_RE.test(treeSha)) throw new Error('github_tree_malformed');
  const commit = await ghJson(config, fetcher, token, `${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message: input.message.slice(0, 200) || `Task ${input.taskId}`, tree: treeSha, parents: [parent] }) });
  needOk(commit, 'github_commit_create');
  const headSha = String(commit.body?.sha || '');
  if (!SHA_RE.test(headSha)) throw new Error('github_commit_malformed');
  const moved = branchExists
    ? await ghJson(config, fetcher, token, `${repo}/git/refs/heads/${refPath(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: headSha, force: false }) })
    : await ghJson(config, fetcher, token, `${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }) });
  if (moved.status === 422) throw new Error('github_branch_conflict');
  needOk(moved, 'github_ref_update');
  return { branch, headSha: headSha.toLowerCase() };
}

/** Opens a PR from the task branch into the base branch. An existing open PR for the branch is returned instead. No merge, no auto-merge. */
export async function openPullRequest(
  config: GitHubAppConfig,
  input: { taskId: string; baseBranch: string; title: string; body: string; writeEnabled: boolean },
  fetcher: Fetcher = fetch,
): Promise<{ number: number; htmlUrl: string | null }> {
  if (input.writeEnabled !== true) throw new Error('github_write_disabled');
  const branch = taskBranchName(input.taskId);
  assertBaseBranch(input.baseBranch);
  const token = await installationToken(config, fetcher, true);
  const r = await ghJson(config, fetcher, token, `${repoPath(config)}/pulls`, { method: 'POST', body: JSON.stringify({ title: input.title.slice(0, 200) || `Task ${input.taskId}`, head: branch, base: input.baseBranch, body: input.body.slice(0, 4000), draft: false }) });
  if (r.status === 422) {
    const found = await findPullRequestByBranch(config, branch, fetcher);
    if (found && found.state === 'open') return { number: found.number, htmlUrl: found.htmlUrl };
    throw new Error('github_pull_create_http_422');
  }
  needOk(r, 'github_pull_create');
  if (!Number.isInteger(r.body?.number)) throw new Error('github_pull_malformed');
  return { number: r.body.number, htmlUrl: httpsOrNull(r.body.html_url) };
}
