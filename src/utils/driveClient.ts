/** Google Drive transport (network only). Merge/safety rules live in driveMerge.ts. */
import { DRIVE_FILE_NAME, parseLibrary, type LibraryFile, type Mergeable } from './driveMerge';

/** 401/403: the token is expired or revoked, so the user must reconnect. */
export class DriveAuthError extends Error { constructor(m = 'Google Drive session expired.') { super(m); this.name = 'DriveAuthError'; } }
/** 404: the remembered file id no longer exists. */
export class DriveNotFoundError extends Error { constructor() { super('Library file not found on Google Drive.'); this.name = 'DriveNotFoundError'; } }

export interface DriveToken { token: string; expiresAt: number }
export interface DriveFileInfo { id: string; modifiedTime: number }

const API = 'https://www.googleapis.com';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function check(r: Response, what: string) {
  if (r.ok) return;
  if (r.status === 401 || r.status === 403) throw new DriveAuthError();
  if (r.status === 404) throw new DriveNotFoundError();
  throw new Error(`Could not ${what} Google Drive.`);
}

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
/** Only files this app creates (or the person opens with it). Used to save documents as Google Docs. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function isDriveConfigured(): boolean { return Boolean((import.meta as any).env?.VITE_GOOGLE_CLIENT_ID); }

/** Must be called directly from a click handler (popup blockers). */
export async function requestDriveToken(scope: string = DRIVE_APPDATA_SCOPE): Promise<DriveToken> {
  const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
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
        ? resolve({ token: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000 })
        : reject(new Error(r?.error || 'Google authorization was denied.')),
      error_callback: () => reject(new Error('Google authorization was cancelled.')),
    });
    client.requestAccessToken();
  });
}

export async function driveFind(token: string): Promise<DriveFileInfo | null> {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const r = await fetch(`${API}/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`, { headers: auth(token) });
  check(r, 'read');
  const f = (await r.json()).files?.[0];
  return f ? { id: f.id, modifiedTime: Date.parse(f.modifiedTime) || 0 } : null;
}

export async function driveRead<T extends Mergeable>(token: string, id: string): Promise<LibraryFile<T>> {
  const r = await fetch(`${API}/drive/v3/files/${id}?alt=media`, { headers: auth(token) });
  check(r, 'read the library from');
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
  check(r, 'save the library to');
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
  check(r, 'save the document to');
  const j = await r.json().catch(() => ({}));
  if (!j.id) throw new Error('Google Drive did not confirm the save.');
  return { id: j.id, webViewLink: j.webViewLink || `https://docs.google.com/document/d/${j.id}/edit` };
}
