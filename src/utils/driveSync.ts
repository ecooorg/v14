/** Core of one Drive sync (TEST-01, DRV-01). Pure logic: no React, no network; the Drive client is injected. */
import {
  buildLibraryPayload, isSafeToWrite, mergeLibraries, remoteIsNewer, type Mergeable,
} from './driveMerge';
import { DriveNotFoundError, type DriveFileInfo } from './driveClient';

export type SyncMode = 'connect' | 'manual' | 'auto';

export interface DriveOps<T extends Mergeable> {
  find(): Promise<DriveFileInfo | null>;
  read(id: string): Promise<{ decisions: T[] }>;
  write(body: string, id?: string): Promise<DriveFileInfo>;
}

export interface SyncInput<T extends Mergeable> {
  mode: SyncMode;
  local: T[];
  lastSync: number;
  /** DRV-02: local library has records newer than this device last saved. Only used in 'auto' mode. */
  dirty?: boolean;
  appVersion: string;
  schemaVersion: number;
  /** Called before local data is replaced by a merge (rule 2). */
  backup: (local: T[]) => void;
  /** DRV-01: how many times to re-read and re-merge when the file changed before writing. */
  maxRetries?: number;
}

export interface SyncResult<T extends Mergeable> {
  /** 'ok' = finished; 'conflict' = Drive kept changing, nothing was written, local data untouched. */
  status: 'ok' | 'conflict';
  merged: T[];
  remote: T[] | null;
  changedLocal: boolean;
  wrote: boolean;
  file: DriveFileInfo | null;
  /** Value to store as the device's last-sync time. */
  remoteMs: number;
  retries: number;
}

export const MAX_WRITE_RETRIES = 3;

/** Errors from the Drive client (e.g. DriveAuthError) are not caught here: the caller decides. */
export async function syncOnce<T extends Mergeable>(inp: SyncInput<T>, drive: DriveOps<T>): Promise<SyncResult<T>> {
  const { mode, local } = inp;
  const maxRetries = inp.maxRetries ?? MAX_WRITE_RETRIES;
  let file = await drive.find();
  let merged = local, remote: T[] | null = null, changedLocal = false, backedUp = false, retries = 0;

  const readAndMerge = async () => {
    remote = (await drive.read(file!.id)).decisions;
    const m = mergeLibraries(local, remote);
    merged = m.merged; changedLocal = m.changedLocal;
    if (!backedUp && (mode === 'connect' || m.changedLocal)) { inp.backup(local); backedUp = true; }   // rule 2
  };

  // Rule 1/5: merge on connect, and whenever Drive changed after this device last synced.
  if (file && (mode === 'connect' || remoteIsNewer(file.modifiedTime, inp.lastSync))) await readAndMerge();

  let wrote = false;
  for (;;) {
    // Rule 3: never write an empty library over a non-empty one.
    if (!(merged.length > 0 && isSafeToWrite(merged, remote))) break;
    // DRV-02: manual and connect always write; autosave writes only when there is something new to save.
    const needsWrite = mode !== 'auto'
      ? true
      : Boolean(inp.dirty) && (!file || !remote || mergeLibraries(merged, remote).changedRemote);
    if (!needsWrite) break;

    // DRV-01: has the file changed since we read it? If so, read again and merge before writing.
    const cur = await drive.find();
    if ((cur?.id ?? null) !== (file?.id ?? null) || (cur?.modifiedTime ?? 0) !== (file?.modifiedTime ?? 0)) {
      if (retries >= maxRetries) {
        return { status: 'conflict', merged: local, remote, changedLocal: false, wrote: false, file, remoteMs: 0, retries };
      }
      retries++; file = cur;
      if (file) await readAndMerge(); else remote = null;
      continue;
    }

    const body = buildLibraryPayload(merged, inp.appVersion, inp.schemaVersion);
    try { file = await drive.write(body, file?.id); }
    catch (e) { if (e instanceof DriveNotFoundError) file = await drive.write(body); else throw e; }
    wrote = true;
    break;
  }
  return { status: 'ok', merged, remote, changedLocal, wrote, file, remoteMs: file?.modifiedTime || 0, retries };
}
