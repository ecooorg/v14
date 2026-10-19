/** Google Drive transport (network only). Merge/safety rules live in driveMerge.ts. */
import { DRIVE_FILE_NAME, parseLibrary, type LibraryFile, type Mergeable } from './driveMerge.ts';

/** 401/403: the token is expired or revoked, so the user must reconnect. */
export class DriveAuthError extends Error { constructor(m = 'Google Drive session expired.') { super(m); this.name = 'DriveAuthError'; } }
/** 404: the remembered file id no longer exists. */
export class DriveNotFoundError extends Error { constructor() { super('Library file not found on Google Drive.'); this.name = 'DriveNotFoundError'; } }

export interface DriveToken { token: string; expiresAt: number; /** Space-separated scopes Google actually granted (the person can untick some). */ scope?: string }
export interface DriveFileInfo { id: string; modifiedTime: number }

const API = 'https://www.googleapis.com';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** 403 with a known cause (P55): the person gets the real reason instead of a silent no-op. */
export type DriveAccessReason = 'no_file_scope' | 'api_disabled' | 'quota';
export class DriveAccessError extends Error {
  reason: DriveAccessReason;
  constructor(reason: DriveAccessReason, m: string) { super(m); this.name = 'DriveAccessError'; this.reason = reason; }
}

/** Reads Google's error body (best effort) and returns its machine reason and text. */
async function errorInfo(r: Response): Promise<{ reason: string; message: string }> {
  try {
    const src: any = typeof (r as any).clone === 'function' ? (r as any).clone() : r;
    const j = await src.json();
    const e = j?.error;
    return { reason: String(e?.errors?.[0]?.reason || e?.status || ''), message: String(e?.message || '') };
  } catch { return { reason: '', message: '' }; }
}

/** 401: expired. 403: a named cause when Google gives one, otherwise treated as expired/revoked. 404: not found. */
async function check(r: Response, what: string): Promise<void> {
  if (r.ok) return;
  if (r.status === 401) throw new DriveAuthError();
  if (r.status === 403) {
    const { reason, message } = await errorInfo(r);
    if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason + ' ' + message)) throw new DriveAccessError('no_file_scope', 'Google Drive did not grant file access.');
    if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(reason + ' ' + message)) throw new DriveAccessError('api_disabled', 'The Google Drive API is switched off for this app.');
    if (/rateLimit|userRateLimit|quota|storageQuota/i.test(reason + ' ' + message)) throw new DriveAccessError('quota', 'Google Drive refused the request (storage full or too many requests).');
    throw new DriveAuthError();
  }
  if (r.status === 404) throw new DriveNotFoundError();
  throw new Error(`Could not ${what} Google Drive.`);
}

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
/** Only files this app creates (or the person opens with it). Used to save documents as Google Docs. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Library (appdata) + user-visible file mirror (drive.file). */
export const DRIVE_FULL_SCOPE = `${DRIVE_APPDATA_SCOPE} ${DRIVE_FILE_SCOPE}`;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const BIFORGE_DRIVE_FOLDER = 'BiForge';

let clientIdOverride = '';
/** Tests only: there is no Vite environment under Node. */
export function _setDriveClientIdForTests(id: string) { clientIdOverride = id; }
const clientIdValue = (): string => (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || clientIdOverride;
export function isDriveConfigured(): boolean { return Boolean(clientIdValue()); }

/** Must be called directly from a click handler (popup blockers). */
export async function requestDriveToken(scope: string = DRIVE_APPDATA_SCOPE): Promise<DriveToken> {
  const clientId = clientIdValue();
  if (!clientId) throw new Error('Google Drive is not configured (VITE_GOOGLE_CLIENT_ID is missing).');
  if (!(window as any).google) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('Google authorization library failed to load.'));
      document.head.appendChild(s);
    });
  }
  return new Promise((resolve, reject) => {
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (r: any) => r?.access_token
        ? resolve({ token: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000, ...(typeof r.scope === 'string' ? { scope: r.scope } : {}) })
        : reject(new Error(r?.error || 'Google authorization was denied.')),
      error_callback: () => reject(new Error('Google authorization was cancelled.')),
    });
    client.requestAccessToken();
  });
}

export async function driveFind(token: string): Promise<DriveFileInfo | null> {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const r = await fetch(`${API}/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`, { headers: auth(token) });
  await check(r, 'read');
  const f = (await r.json()).files?.[0];
  return f ? { id: f.id, modifiedTime: Date.parse(f.modifiedTime) || 0 } : null;
}

export async function driveRead<T extends Mergeable>(token: string, id: string): Promise<LibraryFile<T>> {
  const r = await fetch(`${API}/drive/v3/files/${id}?alt=media`, { headers: auth(token) });
  await check(r, 'read the library from');
  const text = await r.text();
  if (text.trim()) { try { JSON.parse(text); } catch { throw new Error('The library on Google Drive is unreadable; it was not changed.'); } }
  return parseLibrary<T>(text);
}

export async function driveWrite(token: string, body: string, id?: string): Promise<DriveFileInfo> {
  const metadata: any = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };
  if (!id) metadata.parents = ['appDataFolder'];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([body], { type: 'application/json' }));
  const url = `${API}/upload/drive/v3/files${id ? '/' + id : ''}?uploadType=multipart&fields=id,modifiedTime`;
  const r = await fetch(url, { method: id ? 'PATCH' : 'POST', headers: auth(token), body: form });
  await check(r, 'save the library to');
  const j = await r.json();
  return { id: j.id || id!, modifiedTime: Date.parse(j.modifiedTime) || Date.now() };
}

/** Uploads a .docx and lets Drive convert it into a native Google Doc (editable online, shareable by link). */
export async function driveUploadAsGoogleDoc(token: string, name: string, docx: Blob): Promise<{ id: string; webViewLink: string }> {
  const metadata = { name, mimeType: 'application/vnd.google-apps.document' };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([docx], { type: DOCX_MIME }));
  const r = await fetch(`${API}/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`, { method: 'POST', headers: auth(token), body: form });
  await check(r, 'save the document to');
  const j = await r.json().catch(() => ({}));
  if (!j.id) throw new Error('Google Drive did not confirm the save.');
  return { id: j.id, webViewLink: j.webViewLink || `https://docs.google.com/document/d/${j.id}/edit` };
}

/** Find or create a folder (drive.file scope), optionally inside another folder. */
export async function driveFindOrCreateFolder(token: string, name: string = BIFORGE_DRIVE_FOLDER, parentId?: string): Promise<string> {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = encodeURIComponent(`name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${esc(parentId)}' in parents` : ''}`);
  const r = await fetch(`${API}/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`, { headers: auth(token) });
  await check(r, 'list folders on');
  const existing = (await r.json()).files?.[0]?.id;
  if (existing) return String(existing);
  const cr = await fetch(`${API}/drive/v3/files?fields=id`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }),
  });
  await check(cr, 'create folder on');
  const j = await cr.json();
  if (!j.id) throw new Error('Google Drive did not create the folder.');
  return String(j.id);
}

/** True when a remembered folder id still exists and is not in the trash (a deleted folder must be created again). */
export async function driveFolderUsable(token: string, id: string): Promise<boolean> {
  const r = await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed,mimeType`, { headers: auth(token) });
  if (r.status === 404) return false;
  await check(r, 'check a folder on');
  const j = await r.json().catch(() => ({}));
  return Boolean(j.id) && !j.trashed && (!j.mimeType || j.mimeType === 'application/vnd.google-apps.folder');
}

/**
 * Upload a binary (or text) file into My Drive under the BiForge folder.
 * Requires drive.file scope. Returns Drive file id.
 */
export async function driveUploadBinary(
  token: string,
  name: string,
  data: Blob,
  mimeType = 'application/octet-stream',
  parentId?: string,
): Promise<{ id: string; webViewLink?: string }> {
  const parent = parentId || await driveFindOrCreateFolder(token);
  const metadata: Record<string, unknown> = {
    name: String(name || 'file').slice(0, 200),
    mimeType: mimeType || 'application/octet-stream',
    parents: [parent],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([data], { type: mimeType || 'application/octet-stream' }));
  const r = await fetch(
    `${API}/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`,
    { method: 'POST', headers: auth(token), body: form },
  );
  await check(r, 'upload the file to');
  const j = await r.json().catch(() => ({}));
  if (!j.id) throw new Error('Google Drive did not confirm the file upload.');
  return { id: String(j.id), webViewLink: j.webViewLink };
}
