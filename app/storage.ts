/**
 * Two storage modes (STO-1…5): session (A) or Google Drive (B)
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

export function getStorageMode(): StorageMode {
  const m = localStorage.getItem(MODE_KEY);
  if (m === 'session' || m === 'google_drive') return m;
  return null;
}

export function setStorageMode(mode: StorageMode): void {
  if (!mode) localStorage.removeItem(MODE_KEY);
  else localStorage.setItem(MODE_KEY, mode);
}

export function emptyLibrary(storageMode: StorageMode): Library {
  return {
    version: 14,
    dialogs: [],
    settings: { mode: 'normal', storageMode, privacyAccepted: true },
  };
}

/** Mode A: in-memory / sessionStorage — no guarantee after close */
let memoryLib: Library | null = null;

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
    // Client holds a local cache; Drive sync is best-effort via saveLibrary
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
    // Drive upload when token available
    await pushToGoogleDrive(lib);
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

// --- Google Drive (STO-3) ---
// Uses Google Identity Services + Drive API appDataFolder when configured.
const DRIVE_FILE_NAME = 'bifurcation-v14-library.json';
let accessToken: string | null = null;

export function setGoogleAccessToken(token: string | null): void {
  accessToken = token;
}

export function isGoogleConnected(): boolean {
  return Boolean(accessToken);
}

async function pushToGoogleDrive(lib: Library): Promise<void> {
  if (!accessToken) return;
  try {
    // Find existing file in appDataFolder
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listRes.ok) return;
    const list = (await listRes.json()) as { files?: { id: string }[] };
    const body = JSON.stringify(lib);
    const metadata = {
      name: DRIVE_FILE_NAME,
      parents: list.files?.[0] ? undefined : ['appDataFolder'],
    };
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
    // non-fatal — local cache remains
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
    const fileRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
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
