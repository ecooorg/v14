/**
 * Google Drive library safety (UI-05, rules 1-3, 5, 7).
 * Pure functions: no network, no React, no direct browser access, so they are fully testable.
 * The Drive file name and the old format stay readable as before.
 */

export interface Mergeable { id: string; updatedAt: number }

export interface MergeResult<T extends Mergeable> {
  merged: T[];
  /** true if the merged list differs from the local list (local needs updating) */
  changedLocal: boolean;
  /** true if the merged list differs from the remote list (remote needs updating) */
  changedRemote: boolean;
}

const ts = (x: Mergeable) => (Number.isFinite(x?.updatedAt) ? x.updatedAt : 0);

/** One entry per id; the one with the latest updatedAt wins (first one wins a tie). */
function dedupe<T extends Mergeable>(list: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const d of list) {
    if (!d || typeof d.id !== 'string' || !d.id) continue;
    const prev = m.get(d.id);
    if (!prev || ts(d) > ts(prev)) m.set(d.id, d);
  }
  return m;
}

/**
 * Rule 1: merge by dialog id. For the same id the later updatedAt wins (local wins a tie);
 * dialogs present on only one side are added. Inputs are never mutated.
 */
export function mergeLibraries<T extends Mergeable>(local: T[], remote: T[]): MergeResult<T> {
  const L = dedupe(local), R = dedupe(remote);
  const merged: T[] = [];
  let changedLocal = false, changedRemote = false;
  for (const [id, l] of L) {
    const r = R.get(id);
    if (r && ts(r) > ts(l)) { merged.push(r); changedLocal = true; }
    else { merged.push(l); if (!r || ts(l) > ts(r)) changedRemote = true; }
  }
  for (const [id, r] of R) if (!L.has(id)) { merged.push(r); changedLocal = true; }
  if (L.size !== local.length) changedLocal = true;   // duplicates/invalid rows were cleaned
  if (R.size !== remote.length) changedRemote = true;
  return { merged, changedLocal, changedRemote };
}

/** Rule 3: an empty library is never written over a non-empty one on Drive. */
export function isSafeToWrite(next: Mergeable[], remote: Mergeable[] | null): boolean {
  return !(next.length === 0 && remote !== null && remote.length > 0);
}

/** Rule 5: if Drive changed after this device last synced, merge first, then write. */
export function remoteIsNewer(remoteModifiedMs: number | null | undefined, lastSyncMs: number | null | undefined): boolean {
  if (!remoteModifiedMs) return false;
  return remoteModifiedMs > (lastSyncMs || 0);
}

/* ---------- Rule 7: file content (name bifurcation-v13-library.json is unchanged) ---------- */

export const DRIVE_FILE_NAME = 'bifurcation-v13-library.json';

export interface LibraryFile<T> {
  decisions: T[];
  updatedAt: number;
  appVersion?: string;
  schemaVersion?: number;
}

/** Reads the old format ({version, updatedAt, decisions}), the new one, or a bare array. Never throws. */
export function parseLibrary<T extends Mergeable>(raw: unknown): LibraryFile<T> {
  const empty: LibraryFile<T> = { decisions: [], updatedAt: 0 };
  try {
    const obj: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(obj)) return { decisions: obj, updatedAt: 0 };
    if (obj && Array.isArray(obj.decisions)) {
      return {
        decisions: obj.decisions,
        updatedAt: Number(obj.updatedAt) || 0,
        appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : undefined,
        schemaVersion: Number.isFinite(obj.schemaVersion) ? obj.schemaVersion : undefined,
      };
    }
  } catch { /* fall through */ }
  return empty;
}

/** Keeps the legacy `version: 13` field so older clients can still read the file. */
export function buildLibraryPayload<T>(decisions: T[], appVersion: string, schemaVersion: number, now = Date.now()): string {
  return JSON.stringify({ version: 13, appVersion, schemaVersion, updatedAt: now, decisions });
}

/* ---------- Rule 2: local backups (last three, separate browser keys) ---------- */

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const BACKUP_INDEX_KEY = 'bifurcation_library_backups_index';
const BACKUP_PREFIX = 'bifurcation_library_backup_';

function readIndex(store: KeyValueStore): string[] {
  try {
    const a = JSON.parse(store.getItem(BACKUP_INDEX_KEY) || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

export function listBackups(store: KeyValueStore): string[] { return readIndex(store); }

/**
 * Saves a dated copy of the local library before it may be changed.
 * Keeps the newest `keep` copies. An empty library is not backed up (nothing to lose).
 * Returns the backup key, or null if nothing was saved (including storage quota errors).
 * Never throws.
 */
export function createBackup(store: KeyValueStore, local: unknown[], now = Date.now(), keep = 3): string | null {
  if (!local.length) return null;
  const index = readIndex(store);
  let key = `${BACKUP_PREFIX}${now}`;
  for (let n = 1; index.includes(key); n++) key = `${BACKUP_PREFIX}${now}_${n}`;
  const data = JSON.stringify({ createdAt: now, decisions: local });
  const write = () => store.setItem(key, data);
  try {
    try { write(); }
    catch {
      // quota: free the oldest copy once and retry
      const oldest = index.shift();
      if (!oldest) return null;
      store.removeItem(oldest);
      write();
    }
  } catch { return null; }
  index.push(key);
  while (index.length > keep) { const old = index.shift()!; try { store.removeItem(old); } catch { /* ignore */ } }
  try { store.setItem(BACKUP_INDEX_KEY, JSON.stringify(index)); } catch { /* ignore */ }
  return key;
}
