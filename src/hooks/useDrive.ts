import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION, SCHEMA_VERSION, AUTOSAVE_MIN_INTERVAL_MS } from '../config';
import { autosaveDelay, hasUnsavedLocal, shouldNotify } from '../utils/autosave';
import { createBackup, mergeLibraries, type Mergeable } from '../utils/driveMerge';
import { syncOnce } from '../utils/driveSync';
import {
  DriveAuthError, driveFind, driveRead, driveWrite, requestDriveToken,
  type DriveToken,
} from '../utils/driveClient';

const K_TOKEN = 'be_v13_drive_token', K_EXP = 'be_v13_drive_expires', K_FILE = 'be_v13_drive_file';
const K_SYNC = 'be_v13_drive_last_sync', K_SAVED = 'be_v13_drive_saved';
const AUTOSAVE_MS = 4000, EXPIRY_MARGIN_MS = 30000;

const ss = { get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch {} } };
const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };

function loadToken(): DriveToken | null {
  const token = ss.get(K_TOKEN), exp = Number(ss.get(K_EXP));
  return token && exp - EXPIRY_MARGIN_MS > Date.now() ? { token, expiresAt: exp } : null;
}
function loadSaved(): Record<string, number> { try { return JSON.parse(ls.get(K_SAVED) || '{}') || {}; } catch { return {}; } }

/**
 * One Drive connection for the whole library (UI-02, UI-05).
 * connect(): merge local + Drive (never replace), back up first, then write the merged result to both sides.
 * save(): manual save. Autosave runs after connection, debounced.
 */
export function useDrive<T extends Mergeable>(decisions: T[], setDecisions: (f: (cur: T[]) => T[]) => void) {
  const [tok, setTok] = useState<DriveToken | null>(loadToken);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState<Record<string, number>>(loadSaved);
  const decRef = useRef(decisions); decRef.current = decisions;
  const busyRef = useRef(false);
  const savedRef = useRef(saved); savedRef.current = saved;
  const lastWriteRef = useRef(0), lastNotifyRef = useRef(0);
  const connected = Boolean(tok);

  const notify = useCallback((m: string) => { setMessage(m); }, []);
  useEffect(() => { if (!message) return; const t = setTimeout(() => setMessage(''), 5000); return () => clearTimeout(t); }, [message]);

  // Expiry: switch the button back to "Connect" when the token runs out.
  useEffect(() => {
    if (!tok) return;
    const ms = tok.expiresAt - EXPIRY_MARGIN_MS - Date.now();
    const t = setTimeout(() => { setTok(null); notify('Google Drive session expired. Reconnect to keep saving.'); }, Math.max(ms, 0));
    return () => clearTimeout(t);
  }, [tok, notify]);

  function dropToken() { ss.del(K_TOKEN); ss.del(K_EXP); setTok(null); }

  const run = useCallback(async (t: DriveToken, mode: 'connect' | 'manual' | 'auto') => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const local = decRef.current;
      const r = await syncOnce<T>({
        mode, local, dirty: hasUnsavedLocal(local, savedRef.current), lastSync: Number(ls.get(K_SYNC)) || 0, appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION,
        backup: (l) => createBackup(localStorage, l),
      }, {
        find: () => driveFind(t.token),
        read: (id) => driveRead<T>(t.token, id),
        write: (body, id) => driveWrite(t.token, body, id),
      });
      if (r.changedLocal && r.remote) { const rem = r.remote; setDecisions((cur) => mergeLibraries(cur, rem).merged); }
      if (r.status === 'conflict') {
        // DRV-01: Drive kept changing; nothing was written and nothing was lost. Edits stay on this device.
        if (shouldNotify(mode, Date.now(), lastNotifyRef.current, AUTOSAVE_MIN_INTERVAL_MS)) {
          lastNotifyRef.current = Date.now();
          notify('Google Drive was changed from another device. Your dialogs are kept here; saving will be retried.');
        }
        return;
      }
      const merged = r.merged;
      if (r.wrote) lastWriteRef.current = Date.now();
      ss.set(K_FILE, r.file?.id || '');
      ls.set(K_SYNC, String(r.remoteMs));
      const map: Record<string, number> = {}; merged.forEach((d) => { map[d.id] = d.updatedAt; });
      setSaved((prev) => { const n = { ...prev, ...map }; ls.set(K_SAVED, JSON.stringify(n)); return n; });
      notify(mode === 'connect' ? 'Google Drive connected.' : mode === 'manual' ? 'Saved to Google Drive.' : '');
    } catch (e: any) {
      if (e instanceof DriveAuthError) {
        dropToken();
        notify('Google Drive session expired. Reconnect to save.');
      } else if (shouldNotify(mode, Date.now(), lastNotifyRef.current, AUTOSAVE_MIN_INTERVAL_MS)) {
        lastNotifyRef.current = Date.now();
        notify(e?.message || 'Google Drive save failed.');
      }
    } finally { busyRef.current = false; setBusy(false); }
  }, [setDecisions, notify]);

  const connect = useCallback(async () => {
    try {
      const t = await requestDriveToken();       // first await keeps the click gesture
      ss.set(K_TOKEN, t.token); ss.set(K_EXP, String(t.expiresAt)); setTok(t);
      await run(t, 'connect');                   // also repeats a failed save (merge + write)
    } catch (e: any) { notify(e?.message || 'Google Drive connection failed.'); }
  }, [run, notify]);

  const save = useCallback(() => { if (tok) void run(tok, 'manual'); }, [tok, run]);

  // Autosave (enabled by default after connection): debounce after the last edit.
  const dirty = hasUnsavedLocal(decisions, saved);
  useEffect(() => {
    if (!tok || !dirty) return;
    const delay = autosaveDelay({ now: Date.now(), debounceMs: AUTOSAVE_MS, minIntervalMs: AUTOSAVE_MIN_INTERVAL_MS, lastWriteAt: lastWriteRef.current });
    const t = setTimeout(() => void run(tok, 'auto'), delay);
    return () => clearTimeout(t);
  }, [tok, dirty, decisions, run]);

  return {
    connected, busy, message,
    /** the single button: Save when connected, Connect otherwise */
    onButton: connected ? save : connect,
    /** for the history list: is this dialog's latest version on Drive? */
    isOnDrive: (d: T) => (saved[d.id] ?? -1) >= d.updatedAt,
  };
}
