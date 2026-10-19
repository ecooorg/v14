/**
 * Browser-side Google Drive mirror for user uploads and agent files (all modes).
 * Drive is a durable copy; the app keeps working offline / without Drive.
 * Requires a live access token with drive.file (see DRIVE_FULL_SCOPE on connect).
 * No server-side Google credentials.
 *
 * P55: nothing here is silent any more.
 *  - Files go to My Drive → BiForge → Simple | Expert | Project (→ project name).
 *  - Every attempt reports what happened through the `be:drive-status` event (saved / waiting / error with the real reason).
 *  - A file attached before Drive is connected waits in memory and is saved right after Connect.
 *  - A remembered folder id is checked, so a deleted or trashed folder is created again instead of failing forever.
 */
import {
  DRIVE_FILE_SCOPE,
  DRIVE_FULL_SCOPE,
  DriveAccessError,
  DriveAuthError,
  driveFindOrCreateFolder,
  driveFolderUsable,
  driveUploadBinary,
  isDriveConfigured,
  requestDriveToken,
  BIFORGE_DRIVE_FOLDER,
  type DriveToken,
} from './driveClient.ts';

const K_TOKEN = 'be_v13_drive_token';
const K_EXP = 'be_v13_drive_expires';
const K_SCOPE = 'be_v13_drive_scope';
const MANIFEST_KEY = 'be_v13_drive_mirror_manifest';
const FOLDERS_KEY = 'be_v13_drive_folders';
const EXPIRY_MARGIN_MS = 30_000;
const MAX_PENDING_FILES = 25;
const MAX_PENDING_BYTES = 50 * 1024 * 1024;

export const DRIVE_STATUS_EVENT = 'be:drive-status';
export type MirrorMode = 'simple' | 'expert' | 'project' | 'library' | 'unknown';

export interface MirrorEntry {
  localKey: string;
  name: string;
  driveId: string;
  mode: MirrorMode;
  size: number;
  updatedAt: number;
  webViewLink?: string;
}

export interface MirrorManifest {
  version: 1;
  files: MirrorEntry[];
}

export type MirrorFailure = 'not_configured' | 'not_connected' | 'no_file_scope' | 'api_disabled' | 'expired' | 'quota' | 'failed';
export type MirrorResult =
  | { ok: true; entry: MirrorEntry; folder: string; reused: boolean }
  | { ok: false; reason: MirrorFailure; message: string; queued?: boolean };

export interface DriveStatusDetail { kind: 'saved' | 'pending' | 'error'; message: string; name?: string; link?: string }

/** Plain sentences for every failure. No variable names, no codes. */
export const MIRROR_MESSAGES: Record<Exclude<MirrorFailure, 'not_configured'>, string> = {
  not_connected: 'Press Drive to connect Google Drive. Waiting files are saved right after.',
  no_file_scope: 'Google Drive is connected, but file access was not granted. Press Drive again and tick the permission to see, edit, create and delete only the files you use with this app.',
  api_disabled: 'The Google Drive API is switched off for this app in Google Cloud. The owner needs to switch it on.',
  expired: 'The Google Drive session expired. Press Drive to reconnect.',
  quota: 'Google Drive refused the file (storage is full or there were too many requests).',
  failed: 'The file could not be saved to Google Drive.',
};

function ssGet(k: string): string | null {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function ssSet(k: string, v: string) {
  try { sessionStorage.setItem(k, v); } catch { /* private mode */ }
}
function ssDel(k: string) {
  try { sessionStorage.removeItem(k); } catch { /* */ }
}
function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* quota */ }
}

function emit(detail: DriveStatusDetail) {
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(DRIVE_STATUS_EVENT, { detail }));
  } catch { /* no window (tests, SSR) */ }
}

/** Live token from the same sessionStorage keys as useDrive (after Connect). */
export function getMirrorToken(): DriveToken | null {
  const token = ssGet(K_TOKEN);
  const exp = Number(ssGet(K_EXP));
  if (!token || !(exp - EXPIRY_MARGIN_MS > Date.now())) return null;
  const scope = ssGet(K_SCOPE);
  return { token, expiresAt: exp, ...(scope ? { scope } : {}) };
}

export function isMirrorConnected(): boolean {
  return Boolean(getMirrorToken());
}

/** One place that remembers a token (the library hook and the Project page both use it). */
export function storeMirrorToken(t: DriveToken) {
  ssSet(K_TOKEN, t.token);
  ssSet(K_EXP, String(t.expiresAt));
  if (t.scope) ssSet(K_SCOPE, t.scope); else ssDel(K_SCOPE);
}
export function dropMirrorToken() { ssDel(K_TOKEN); ssDel(K_EXP); ssDel(K_SCOPE); }

/** Google lets the person untick permissions. Unknown scope (older response) counts as granted. */
export function hasFileScope(t: DriveToken | null | undefined): boolean {
  if (!t?.scope) return true;
  return t.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE);
}

// ---- which mode the person is in (folder name for files without an explicit mode) ----
let currentMode: MirrorMode = 'simple';
export function setMirrorMode(mode: MirrorMode) { currentMode = mode; }
export function getMirrorMode(): MirrorMode { return currentMode; }
const MODE_FOLDER: Record<MirrorMode, string> = { simple: 'Simple', expert: 'Expert', project: 'Project', library: 'Library', unknown: 'Simple' };
const safeFolderName = (v: string, fallback: string) => String(v || '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;

export function loadMirrorManifest(): MirrorManifest {
  try {
    const raw = lsGet(MANIFEST_KEY);
    if (!raw) return { version: 1, files: [] };
    const j = JSON.parse(raw);
    if (!j || j.version !== 1 || !Array.isArray(j.files)) return { version: 1, files: [] };
    return j as MirrorManifest;
  } catch {
    return { version: 1, files: [] };
  }
}

function saveMirrorManifest(m: MirrorManifest) {
  lsSet(MANIFEST_KEY, JSON.stringify({ version: 1, files: m.files.slice(-200) }));
}

export function getMirrorEntry(localKey: string): MirrorEntry | undefined {
  return loadMirrorManifest().files.find((f) => f.localKey === localKey);
}

export type MirrorStatus = 'saved' | 'not_on_drive' | 'not_connected' | 'not_configured';

export function mirrorStatus(localKey: string): MirrorStatus {
  if (!isDriveConfigured()) return 'not_configured';
  if (!isMirrorConnected()) return 'not_connected';
  return getMirrorEntry(localKey) ? 'saved' : 'not_on_drive';
}

function guessMime(name: string, fallback = 'application/octet-stream'): string {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (n.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.zip')) return 'application/zip';
  if (n.endsWith('.txt') || n.endsWith('.md') || n.endsWith('.csv') || n.endsWith('.log')) return 'text/plain;charset=utf-8';
  if (n.endsWith('.json')) return 'application/json';
  return fallback;
}

// ---- folders: BiForge / <Mode> / <optional project> ----
const verifiedFolders = new Set<string>();
function loadFolders(): Record<string, string> {
  try { const j = JSON.parse(lsGet(FOLDERS_KEY) || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

/** Resolves (and creates when missing) the folder for a path such as ['BiForge','Simple']. Remembered ids are checked once per session. */
async function ensureFolder(token: string, path: string[]): Promise<string> {
  const cache = loadFolders();
  let parent = '';
  for (let i = 0; i < path.length; i++) {
    const key = path.slice(0, i + 1).join('/');
    let id = cache[key] || '';
    if (id && !verifiedFolders.has(`${token.slice(-8)}:${key}:${id}`)) {
      if (await driveFolderUsable(token, id)) verifiedFolders.add(`${token.slice(-8)}:${key}:${id}`);
      else { id = ''; delete cache[key]; }
    }
    if (!id) {
      id = await driveFindOrCreateFolder(token, path[i]!, parent || undefined);
      cache[key] = id;
      verifiedFolders.add(`${token.slice(-8)}:${key}:${id}`);
    }
    parent = id;
  }
  lsSet(FOLDERS_KEY, JSON.stringify(cache));
  return parent;
}

export function folderPathFor(mode: MirrorMode, subfolder?: string): string[] {
  const m: MirrorMode = mode === 'unknown' ? currentMode : mode;
  return [BIFORGE_DRIVE_FOLDER, MODE_FOLDER[m], ...(subfolder ? [safeFolderName(subfolder, 'Project')] : [])];
}

// ---- waiting list (memory only): files attached before Drive was connected ----
interface MirrorOpts { name: string; data: Blob; mimeType?: string; mode?: MirrorMode; localKey?: string; subfolder?: string }
const pending: MirrorOpts[] = [];
export function pendingMirrorCount(): number { return pending.length; }
export function _resetMirrorForTests() { pending.length = 0; verifiedFolders.clear(); currentMode = 'simple'; }

function enqueue(o: MirrorOpts): boolean {
  const key = o.localKey;
  if (key && pending.some((p) => p.localKey === key)) return true;
  const bytes = pending.reduce((n, p) => n + (p.data.size || 0), 0) + (o.data.size || 0);
  if (pending.length >= MAX_PENDING_FILES || bytes > MAX_PENDING_BYTES) return false;
  pending.push(o);
  return true;
}

/** Saves everything that was waiting for a connection. Returns how many files were saved. */
export async function flushMirrorQueue(): Promise<number> {
  if (!getMirrorToken()) return 0;
  const items = pending.splice(0, pending.length);
  let saved = 0;
  for (const it of items) { const r = await mirrorBlobDetailed({ ...it, queue: false }); if (r.ok) saved++; }
  return saved;
}

/**
 * Upload a blob to Drive/BiForge/<Mode> and record it in the local manifest.
 * Never throws. The result says what happened; the same fact is also announced as a `be:drive-status` event.
 * Not connected: the file waits in memory and is saved when Drive is connected (unless `queue: false`).
 */
export async function mirrorBlobDetailed(opts: MirrorOpts & { queue?: boolean }): Promise<MirrorResult> {
  if (!isDriveConfigured()) return { ok: false, reason: 'not_configured', message: '' };
  const name = String(opts.name || 'file').slice(0, 200);
  const mode: MirrorMode = opts.mode || 'unknown';
  const localKey = opts.localKey || `${Date.now()}_${name}`;
  const tok = getMirrorToken();
  if (!tok) {
    const queued = opts.queue !== false && enqueue({ ...opts, name, localKey, mode: mode === 'unknown' ? currentMode : mode });
    const message = queued ? `“${name}” will be saved to Google Drive after you connect it. Press Drive.` : MIRROR_MESSAGES.not_connected;
    emit({ kind: 'pending', message, name });
    return { ok: false, reason: 'not_connected', message, queued };
  }
  if (!hasFileScope(tok)) {
    emit({ kind: 'error', message: MIRROR_MESSAGES.no_file_scope, name });
    return { ok: false, reason: 'no_file_scope', message: MIRROR_MESSAGES.no_file_scope };
  }
  const size = opts.data.size || 0;
  const path = folderPathFor(mode, opts.subfolder);
  const existing = getMirrorEntry(localKey);
  if (existing && existing.size === size) return { ok: true, entry: existing, folder: path.join('/'), reused: true };
  try {
    const parent = await ensureFolder(tok.token, path);
    const mime = opts.mimeType || guessMime(name);
    const up = await driveUploadBinary(tok.token, name, opts.data, mime, parent);
    const entry: MirrorEntry = { localKey, name, driveId: up.id, mode: mode === 'unknown' ? currentMode : mode, size, updatedAt: Date.now(), webViewLink: up.webViewLink };
    const man = loadMirrorManifest();
    saveMirrorManifest({ version: 1, files: [...man.files.filter((f) => f.localKey !== localKey), entry] });
    const folder = path.join('/');
    emit({ kind: 'saved', message: `Saved to Google Drive: ${folder}/${name}`, name, link: up.webViewLink });
    return { ok: true, entry, folder, reused: false };
  } catch (e: any) {
    let reason: MirrorFailure = 'failed';
    if (e instanceof DriveAuthError) { reason = 'expired'; dropMirrorToken(); }
    else if (e instanceof DriveAccessError) reason = e.reason;
    const message = reason === 'failed' ? `“${name}” could not be saved to Google Drive.` : MIRROR_MESSAGES[reason];
    emit({ kind: 'error', message, name });
    return { ok: false, reason, message };
  }
}

/** Compatible wrapper: the entry, or null when the file was not saved. */
export async function mirrorBlob(opts: MirrorOpts): Promise<MirrorEntry | null> {
  const r = await mirrorBlobDetailed(opts);
  return r.ok ? r.entry : null;
}

/** Mirror a browser File (user upload in Simple/Expert/Project). */
export async function mirrorUserFile(file: File, mode: MirrorMode = 'unknown', localKey?: string, subfolder?: string): Promise<MirrorEntry | null> {
  return mirrorBlob({
    name: file.name,
    data: file,
    mimeType: file.type || guessMime(file.name),
    mode,
    subfolder,
    localKey: localKey || `upload_${file.name}_${file.size}_${file.lastModified}`,
  });
}

/** Mirror plain text (e.g. agent document archive, project files). */
export async function mirrorTextFile(
  name: string,
  text: string,
  mode: MirrorMode = 'unknown',
  localKey?: string,
  subfolder?: string,
): Promise<MirrorEntry | null> {
  const body = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const safe = /\.(txt|md|json|csv|log)$/i.test(name) ? name : `${name}.txt`;
  return mirrorBlob({
    name: safe,
    data: body,
    mimeType: guessMime(safe, 'text/plain;charset=utf-8'),
    mode,
    subfolder,
    localKey: localKey || `text_${safe}_${body.size}`,
  });
}

/**
 * Connect Drive for files (used by the Project page; the main page connects through useDrive, same storage).
 * Must be called straight from a click handler (the sign-in popup).
 */
export async function connectDriveFiles(): Promise<{ ok: boolean; message: string }> {
  try {
    const t = await requestDriveToken(DRIVE_FULL_SCOPE);
    storeMirrorToken(t);
    if (!hasFileScope(t)) return { ok: false, message: MIRROR_MESSAGES.no_file_scope };
    const saved = await flushMirrorQueue();
    return { ok: true, message: saved > 0 ? `Google Drive connected. Saved ${saved} waiting file${saved === 1 ? '' : 's'}.` : 'Google Drive connected.' };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'Google Drive connection failed.' };
  }
}
