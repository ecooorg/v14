/**
 * Two storage modes (STO-1…5): session (A) or Google Drive (B)
 * Mode B is only "active" after a real Google token is present.
 */
export type StorageMode = 'session' | 'google_drive' | null;

export type DialogMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  phase: string;
  lastSnippet?: string;
  overdueCheckIn?: boolean;
};

export type DialogRecord = DialogMeta & {
  messages: { id: string; role: 'user' | 'agent'; text: string; at: number }[];
  state: unknown;
  cycleCount?: number;
};

export type Library = {
  version: 14;
  dialogs: DialogRecord[];
  settings: {
    mode: 'normal' | 'expert';
    storageMode: StorageMode;
    userGeminiKey?: string;
    privacyAccepted?: boolean;
    googleConnected?: boolean;
  };
};

const SESSION_KEY = 'be_v14_session_library';
const MODE_KEY = 'be_v14_storage_mode';
const PRIVACY_KEY = 'be_v14_privacy';
const DRIVE_TOKEN_KEY = 'be_v14_drive_token';
const DRIVE_FILE_NAME = 'bifurcation-v14-library.json';

let memoryLib: Library | null = null;
let accessToken: string | null = null;

export function getGoogleClientId(): string {
  try {
    return (
      (import.meta as unknown as { env?: { VITE_GOOGLE_CLIENT_ID?: string } }).env?.VITE_GOOGLE_CLIENT_ID ||
      ''
    );
  } catch {
    return '';
  }
}

export function isDriveConfigured(): boolean {
  return Boolean(getGoogleClientId());
}

export function getStorageMode(): StorageMode {
  const m = localStorage.getItem(MODE_KEY);
  if (m === 'session' || m === 'google_drive') return m;
  return null;
}

export function setStorageMode(mode: StorageMode): void {
  if (!mode) localStorage.removeItem(MODE_KEY);
  else localStorage.setItem(MODE_KEY, mode);
}

/** True only when mode is Drive AND we have a token */
export function isGoogleDriveActive(): boolean {
  return getStorageMode() === 'google_drive' && isGoogleConnected();
}

export function setGoogleAccessToken(token: string | null): void {
  accessToken = token;
  if (token) {
    try {
      sessionStorage.setItem(DRIVE_TOKEN_KEY, token);
    } catch { /* ignore */ }
  } else {
    try {
      sessionStorage.removeItem(DRIVE_TOKEN_KEY);
    } catch { /* ignore */ }
  }
}

export function restoreGoogleTokenFromSession(): void {
  try {
    const t = sessionStorage.getItem(DRIVE_TOKEN_KEY);
    if (t) accessToken = t;
  } catch { /* ignore */ }
}

export function isGoogleConnected(): boolean {
  if (accessToken) return true;
  restoreGoogleTokenFromSession();
  return Boolean(accessToken);
}

export function emptyLibrary(storageMode: StorageMode): Library {
  return {
    version: 14,
    dialogs: [],
    settings: {
      mode: 'normal',
      storageMode,
      privacyAccepted: true,
      googleConnected: isGoogleConnected(),
    },
  };
}

export async function loadLibrary(): Promise<Library> {
  const mode = getStorageMode();
  if (mode === 'session') {
    if (memoryLib) return memoryLib;
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        memoryLib = JSON.parse(raw) as Library;
        return memoryLib;
      }
    } catch { /* ignore */ }
    memoryLib = emptyLibrary('session');
    return memoryLib;
  }
  if (mode === 'google_drive') {
    if (isGoogleConnected()) {
      const fromDrive = await pullFromGoogleDrive();
      if (fromDrive) {
        try {
          localStorage.setItem('be_v14_drive_cache', JSON.stringify(fromDrive));
        } catch { /* ignore */ }
        return fromDrive;
      }
    }
    try {
      const raw = localStorage.getItem('be_v14_drive_cache');
      if (raw) return JSON.parse(raw) as Library;
    } catch { /* ignore */ }
    return emptyLibrary('google_drive');
  }
  return emptyLibrary(null);
}

export async function saveLibrary(lib: Library): Promise<void> {
  const mode = getStorageMode();
  if (mode === 'session') {
    memoryLib = lib;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(lib));
    } catch { /* quota */ }
    return;
  }
  if (mode === 'google_drive') {
    try {
      localStorage.setItem('be_v14_drive_cache', JSON.stringify(lib));
    } catch { /* quota */ }
    if (isGoogleConnected()) await pushToGoogleDrive(lib);
  }
}

export function exportLibraryJson(lib: Library): string {
  return JSON.stringify(lib, null, 2);
}

export function importLibraryJson(raw: string, existing: Library): Library {
  const incoming = JSON.parse(raw) as Library;
  if (!incoming || incoming.version !== 14 || !Array.isArray(incoming.dialogs)) {
    throw new Error('Invalid library file');
  }
  const byId = new Map(existing.dialogs.map((d) => [d.id, d]));
  for (const d of incoming.dialogs) {
    const prev = byId.get(d.id);
    if (!prev || d.updatedAt >= prev.updatedAt) byId.set(d.id, d);
  }
  return {
    ...existing,
    dialogs: Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

async function pushToGoogleDrive(lib: Library): Promise<void> {
  if (!accessToken) return;
  try {
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listRes.ok) return;
    const list = (await listRes.json()) as { files?: { id: string }[] };
    const body = JSON.stringify(lib);
    const metadata: Record<string, unknown> = { name: DRIVE_FILE_NAME };
    if (!list.files?.[0]) metadata.parents = ['appDataFolder'];
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([body], { type: 'application/json' }));
    const fileId = list.files?.[0]?.id;
    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    await fetch(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
  } catch {
    /* non-fatal */
  }
}

export async function pullFromGoogleDrive(): Promise<Library | null> {
  if (!accessToken) return null;
  try {
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listRes.ok) return null;
    const list = (await listRes.json()) as { files?: { id: string }[] };
    const id = list.files?.[0]?.id;
    if (!id) return null;
    const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fileRes.ok) return null;
    return (await fileRes.json()) as Library;
  } catch {
    return null;
  }
}

export function privacyAccepted(): boolean {
  return localStorage.getItem(PRIVACY_KEY) === '1';
}
export function setPrivacyAccepted(): void {
  localStorage.setItem(PRIVACY_KEY, '1');
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Load GIS script once */
let gisLoading: Promise<void> | null = null;
export function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as unknown as { google?: unknown }).google) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Google Identity'));
    document.head.appendChild(s);
  });
  return gisLoading;
}

export function requestGoogleDriveToken(): Promise<string> {
  const clientId = getGoogleClientId();
  if (!clientId) return Promise.reject(new Error('NO_CLIENT_ID'));
  return loadGoogleIdentityScript().then(
    () =>
      new Promise((resolve, reject) => {
        const google = (window as unknown as {
          google?: {
            accounts: {
              oauth2: {
                initTokenClient: (cfg: Record<string, unknown>) => { requestAccessToken: () => void };
              };
            };
          };
        }).google;
        if (!google) {
          reject(new Error('GIS_MISSING'));
          return;
        }
        const client = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.appdata',
          callback: (resp: { access_token?: string; error?: string }) => {
            if (resp.error || !resp.access_token) {
              reject(new Error(resp.error || 'TOKEN_ERROR'));
              return;
            }
            setGoogleAccessToken(resp.access_token);
            resolve(resp.access_token);
          },
        });
        client.requestAccessToken();
      }),
  );
}
