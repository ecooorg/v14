/**
 * Program Files archive (Stage 3 / v1.4.3).
 * IndexedDB only — extracted text and agent summaries, never original binaries.
 * Server stores nothing.
 */

import type { Attachment } from './attachments';
import type { DocumentSpec } from './attachments';

const DB_NAME = 'bifurcation_program_files_v1';
const DB_VERSION = 1;
const STORE = 'files';
const MIGRATION_FLAG = 'bifurcation_pf_migrated_v1';
const TEXT_CAP = 30_000;

export type ProgramFileKind =
  | 'pdf' | 'image' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'agent-document';

export interface ProgramFile {
  id: string;
  hash: string;
  name: string;
  kind: ProgramFileKind;
  size: number;
  addedAt: number;
  /** Extracted text or agent-document plain text (capped). */
  text: string;
  /** Image/scan description from the agent, or short structure note for agent docs. */
  summary: string;
  /** Decision ids where this file was used. */
  usedIn: string[];
}

export type ProgramFilesQuota = {
  usage: number;
  quota: number;
  low: boolean;
  message?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('hash', 'hash', { unique: false });
        os.createIndex('addedAt', 'addedAt', { unique: false });
      }
    };
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/** Simple non-crypto hash for dedupe (name + text prefix). */
export async function contentHash(name: string, text: string, size: number): Promise<string> {
  const payload = `${name}|${size}|${text.slice(0, 4000)}`;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    } catch { /* fall through */ }
  }
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777645);
  }
  return (h >>> 0).toString(16) + size.toString(16);
}

function uid(): string {
  return `pf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function capText(s: string): string {
  const t = String(s || '');
  return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t;
}

export async function listProgramFiles(): Promise<ProgramFile[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result || []) as ProgramFile[];
        rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function getProgramFile(id: string): Promise<ProgramFile | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as ProgramFile) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function findByHash(db: IDBDatabase, hash: string): Promise<ProgramFile | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('hash');
    const req = idx.get(hash);
    req.onsuccess = () => resolve((req.result as ProgramFile) || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Upsert by content hash. Merges usedIn. Returns the stored record.
 */
export async function putProgramFile(input: {
  name: string;
  kind: ProgramFileKind;
  size: number;
  text?: string;
  summary?: string;
  usedIn?: string[];
}): Promise<ProgramFile> {
  const text = capText(input.text || '');
  const summary = String(input.summary || '').slice(0, 4000);
  const hash = await contentHash(input.name, text || summary, input.size || 0);
  const db = await openDb();
  const existing = await findByHash(db, hash);
  const now = Date.now();
  const record: ProgramFile = existing
    ? {
        ...existing,
        name: input.name || existing.name,
        kind: input.kind || existing.kind,
        size: input.size || existing.size,
        text: text || existing.text,
        summary: summary || existing.summary,
        usedIn: Array.from(new Set([...(existing.usedIn || []), ...(input.usedIn || [])])),
      }
    : {
        id: uid(),
        hash,
        name: input.name || 'file',
        kind: input.kind,
        size: input.size || text.length,
        addedAt: now,
        text,
        summary,
        usedIn: input.usedIn ? [...input.usedIn] : [],
      };

  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await txDone(tx);
  return record;
}

export async function deleteProgramFile(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

export async function clearProgramFiles(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await txDone(tx);
}

/** Archive an attachment the person just uploaded (text/summary only). */
export async function archiveAttachment(
  a: Attachment,
  decisionId?: string,
): Promise<ProgramFile | null> {
  try {
    return await putProgramFile({
      name: a.name,
      kind: (a.kind as ProgramFileKind) || 'text',
      size: a.size || 0,
      text: a.text || '',
      summary: a.kind === 'image' ? (a.text || '') : '',
      usedIn: decisionId ? [decisionId] : [],
    });
  } catch {
    return null;
  }
}

/** Archive an agent-prepared document. */
export async function archiveAgentDocument(
  doc: DocumentSpec,
  decisionId?: string,
): Promise<ProgramFile | null> {
  try {
    const parts: string[] = [doc.title || ''];
    for (const b of doc.blocks || []) {
      if (b.type === 'heading' || b.type === 'paragraph') parts.push(b.text);
      else if (b.type === 'bullets' || b.type === 'numbered') parts.push(b.items.join('\n'));
      else if (b.type === 'table') {
        parts.push(b.headers.join(' | '));
        for (const row of b.rows) parts.push(row.join(' | '));
      }
    }
    const text = parts.join('\n\n');
    const structure = (doc.blocks || []).map((b) => b.type).join(',');
    return await putProgramFile({
      name: (doc.fileName || doc.title || 'agent-document').slice(0, 120),
      kind: 'agent-document',
      size: text.length,
      text,
      summary: `${doc.title || 'Document'} [${structure}]`.slice(0, 500),
      usedIn: decisionId ? [decisionId] : [],
    });
  } catch {
    return null;
  }
}

/** Convert a program file back into an Attachment for the current message. */
export function programFileToAttachment(pf: ProgramFile): Attachment {
  const kind = pf.kind === 'agent-document' ? 'text' : pf.kind;
  return {
    name: pf.name,
    kind: kind as Attachment['kind'],
    size: pf.size || pf.text.length,
    text: pf.text || pf.summary || '',
  };
}

/**
 * One-shot migration: scan decisions' conversation attachments and agent documents
 * into IndexedDB. Safe to call multiple times; uses a localStorage flag.
 */
export async function migrateAttachmentsFromDecisions(
  decisions: { id?: string; modelSuggestions?: any }[],
): Promise<{ added: number; skipped: boolean }> {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_FLAG) === '1') {
      return { added: 0, skipped: true };
    }
  } catch { /* private mode */ }

  let added = 0;
  for (const d of decisions || []) {
    const hist = d?.modelSuggestions?.conversation;
    if (!Array.isArray(hist)) continue;
    const did = String(d.id || '');
    for (const m of hist) {
      if (Array.isArray(m?.attachments)) {
        for (const a of m.attachments) {
          if (!a?.name) continue;
          await archiveAttachment(a as Attachment, did);
          added++;
        }
      }
      if (m?.document && Array.isArray(m.document.blocks)) {
        await archiveAgentDocument(m.document as DocumentSpec, did);
        added++;
      }
    }
  }

  try {
    localStorage.setItem(MIGRATION_FLAG, '1');
  } catch { /* ignore */ }
  return { added, skipped: false };
}

/** Rough quota check via StorageManager when available. */
export async function getProgramFilesQuota(): Promise<ProgramFilesQuota> {
  const fallback: ProgramFilesQuota = { usage: 0, quota: 0, low: false };
  try {
    if (navigator?.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const usage = Number(est.usage) || 0;
      const quota = Number(est.quota) || 0;
      const ratio = quota > 0 ? usage / quota : 0;
      const low = ratio >= 0.85;
      return {
        usage,
        quota,
        low,
        message: low
          ? 'Storage is almost full. Delete unused program files or export a backup.'
          : undefined,
      };
    }
  } catch { /* ignore */ }
  return fallback;
}

/** Payload fragment for Export all → JSON backup. */
export async function exportProgramFilesPayload(): Promise<ProgramFile[]> {
  return listProgramFiles();
}

/** Restore program files from a backup array (merge by hash). */
export async function importProgramFilesPayload(
  rows: unknown[],
): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  if (!Array.isArray(rows)) return { added, updated };
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = String(r.name || 'file');
    const text = String(r.text || '');
    const summary = String(r.summary || '');
    const size = Number(r.size) || text.length;
    const kind = (String(r.kind || 'text') as ProgramFileKind);
    const usedIn = Array.isArray(r.usedIn) ? r.usedIn.map(String) : [];
    const before = await listProgramFiles();
    const hashes = new Set(before.map((x) => x.hash));
    const saved = await putProgramFile({ name, kind, size, text, summary, usedIn });
    if (hashes.has(saved.hash) && before.some((x) => x.id === saved.id)) updated++;
    else added++;
  }
  return { added, updated };
}
