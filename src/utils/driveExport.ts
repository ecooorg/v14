/**
 * Save a document to the person's Google Drive as a native Google Doc.
 * Uses its own token with the narrow drive.file scope (files this app creates), requested only when the person
 * clicks the button. The library sync keeps its own appdata-only token and is not affected.
 */
import { DRIVE_FILE_SCOPE, DriveAuthError, driveUploadAsGoogleDoc, requestDriveToken, type DriveToken } from './driveClient';
import { buildDocumentFile, type DocumentSpec } from './attachments';
import type { ErrorLanguage } from '../i18n/errors';

const K_TOKEN = 'be_drive_docs_token', K_EXP = 'be_drive_docs_expires', MARGIN_MS = 30000;
const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* private mode */ } },
};

function cachedToken(): DriveToken | null {
  const token = ss.get(K_TOKEN), exp = Number(ss.get(K_EXP));
  return token && exp - MARGIN_MS > Date.now() ? { token, expiresAt: exp } : null;
}

export interface SavedDoc { id: string; link: string; name: string }

/** Call directly from a click handler: the Google sign-in popup needs the click. */
export async function saveDocumentToGoogleDocs(doc: DocumentSpec, bulk = false, language: ErrorLanguage = 'en'): Promise<SavedDoc> {
  let tok = cachedToken();
  if (!tok) {                                   // first await: keeps the click gesture for the popup
    tok = await requestDriveToken(DRIVE_FILE_SCOPE);
    ss.set(K_TOKEN, tok.token); ss.set(K_EXP, String(tok.expiresAt));
  }
  const { blob, name } = await buildDocumentFile(doc, 'docx', bulk, language);
  const title = name.replace(/\.docx$/i, '');
  try {
    const f = await driveUploadAsGoogleDoc(tok.token, title, blob);
    return { id: f.id, link: f.webViewLink, name: title };
  } catch (e) {
    if (e instanceof DriveAuthError) {
      ss.del(K_TOKEN); ss.del(K_EXP);
      throw new Error('Google Drive access expired or was not granted. Press the button again.');
    }
    throw e;
  }
}
