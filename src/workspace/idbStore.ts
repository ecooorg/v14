/** IndexedDB WorkspaceStore for Simple/Expert modes (FW-23, FW-24). */
import { manifestHash, sha256Bytes } from './hash.ts';
import type { Entry, VersionInfo, VersionMeta, WorkspaceInfo, WorkspaceStore } from './types.ts';

const DB_NAME = 'bifurcation_workspaces_v1';
const DB_VERSION = 1;
type WorkspaceRecord = WorkspaceInfo;
type VersionRecord = { key: string; workspaceId: string; info: VersionInfo; manifest: Entry[] };
type BlobRecord = { key: string; workspaceId: string; sha256: string; bytes: ArrayBuffer };

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('indexeddb_request_failed')); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error('indexeddb_transaction_failed')); });
}
function id(): string {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `ws_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
function key(wsId: string, value: string | number): string { return `${wsId}:${value}`; }

export class IndexedDbWorkspaceStore implements WorkspaceStore {
  private dbPromise: Promise<IDBDatabase>;
  private constructor(dbPromise: Promise<IDBDatabase>) { this.dbPromise = dbPromise; }

  static open(): IndexedDbWorkspaceStore {
    if (typeof indexedDB === 'undefined') throw new Error('workspace_indexeddb_unavailable');
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('versions')) {
          const store = db.createObjectStore('versions', { keyPath: 'key' });
          store.createIndex('byWorkspace', 'workspaceId', { unique: false });
        }
        if (!db.objectStoreNames.contains('blobs')) {
          const store = db.createObjectStore('blobs', { keyPath: 'key' });
          store.createIndex('byWorkspace', 'workspaceId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('workspace_indexeddb_open_failed'));
      req.onblocked = () => reject(new Error('workspace_indexeddb_blocked'));
    });
    const store = new IndexedDbWorkspaceStore(promise);
    void promise.then(() => store.cleanupOrphanBlobs()).catch(() => undefined);
    return store;
  }

  async quotaStatus(): Promise<{ usage?: number; quota?: number; warning: boolean }> {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage == null || estimate.quota == null) return { warning: false };
    return { usage: estimate.usage, quota: estimate.quota, warning: estimate.quota > 0 && estimate.usage / estimate.quota >= 0.85 };
  }

  async createWorkspace(name: string, rootPrefix = '', privacyAck = false): Promise<string> {
    const db = await this.dbPromise;
    const existing = await request(db.transaction('workspaces', 'readonly').objectStore('workspaces').count());
    if (existing === 0) {
      try { await navigator.storage?.persist?.(); } catch { /* persistence is best effort */ }
    }
    const wsId = id();
    const rec: WorkspaceRecord = { id: wsId, name, rootPrefix, head: 0, createdAt: new Date().toISOString(), privacyAck };
    await request(db.transaction('workspaces', 'readwrite').objectStore('workspaces').add(rec));
    return wsId;
  }

  async setPrivacyAck(wsId: string, value: boolean): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('workspaces', 'readwrite');
    const store = tx.objectStore('workspaces');
    const ws = await request(store.get(wsId)) as WorkspaceRecord | undefined;
    if (!ws) { tx.abort(); throw new Error('workspace_not_found'); }
    store.put({ ...ws, privacyAck: value });
    await done(tx);
  }

  async putBlob(wsId: string, sha256: string, bytes: Uint8Array): Promise<void> {
    const actual = await sha256Bytes(bytes);
    if (actual !== sha256) throw new Error('workspace_blob_hash_mismatch');
    const db = await this.dbPromise;
    const tx = db.transaction(['workspaces', 'blobs'], 'readwrite');
    const ws = await request(tx.objectStore('workspaces').get(wsId));
    if (!ws) { tx.abort(); throw new Error('workspace_not_found'); }
    const store = tx.objectStore('blobs');
    const blobKey = key(wsId, sha256);
    if (!(await request(store.get(blobKey)))) {
      const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
      store.put({ key: blobKey, workspaceId: wsId, sha256, bytes: copy.buffer } satisfies BlobRecord);
    }
    await done(tx);
  }

  async commitVersion(wsId: string, parentNo: number | null, manifest: Entry[], meta: VersionMeta): Promise<VersionInfo> {
    const db = await this.dbPromise;
    // Check every blob before opening the atomic version/head transaction.
    const checkTx = db.transaction(['workspaces', 'blobs'], 'readonly');
    const ws = await request(checkTx.objectStore('workspaces').get(wsId)) as WorkspaceRecord | undefined;
    if (!ws) throw new Error('workspace_not_found');
    if (parentNo === null ? ws.head !== 0 : parentNo !== ws.head) throw new Error('parent_mismatch');
    for (const e of manifest) {
      if (!(await request(checkTx.objectStore('blobs').get(key(wsId, e.sha256))))) throw new Error(`missing_blob:${e.sha256}`);
    }
    const no = ws.head + 1;
    const info: VersionInfo = {
      no, parent: parentNo, createdAt: new Date().toISOString(), createdBy: meta.createdBy,
      message: meta.message, manifestHash: await manifestHash(manifest),
      stats: { files: manifest.length, bytes: manifest.reduce((sum, e) => sum + e.size, 0) },
    };
    const tx = db.transaction(['workspaces', 'versions'], 'readwrite');
    const wsStore = tx.objectStore('workspaces');
    const current = await request(wsStore.get(wsId)) as WorkspaceRecord | undefined;
    if (!current) { tx.abort(); throw new Error('workspace_not_found'); }
    if (current.head !== ws.head) { tx.abort(); throw new Error('parent_mismatch'); }
    tx.objectStore('versions').add({ key: key(wsId, no), workspaceId: wsId, info, manifest: manifest.map((e) => ({ ...e, flags: [...e.flags] })) } satisfies VersionRecord);
    wsStore.put({ ...current, head: no });
    await done(tx);
    return info;
  }

  async getManifest(wsId: string, no: number): Promise<Entry[]> {
    const db = await this.dbPromise;
    const rec = await request(db.transaction('versions', 'readonly').objectStore('versions').get(key(wsId, no))) as VersionRecord | undefined;
    if (!rec) throw new Error('version_not_found');
    return rec.manifest.map((e) => ({ ...e, flags: [...e.flags] }));
  }

  async readBlob(wsId: string, sha256: string): Promise<Uint8Array> {
    const db = await this.dbPromise;
    const rec = await request(db.transaction('blobs', 'readonly').objectStore('blobs').get(key(wsId, sha256))) as BlobRecord | undefined;
    if (!rec) throw new Error('blob_not_found');
    const bytes = new Uint8Array(rec.bytes);
    if (await sha256Bytes(bytes) !== sha256) throw new Error('workspace_blob_integrity_error');
    return bytes;
  }

  async listVersions(wsId: string): Promise<VersionInfo[]> {
    const db = await this.dbPromise;
    const rows = await request(db.transaction('versions', 'readonly').objectStore('versions').index('byWorkspace').getAll(wsId)) as VersionRecord[];
    return rows.map((r) => r.info).sort((a, b) => a.no - b.no);
  }

  async getWorkspace(wsId: string): Promise<WorkspaceInfo | null> {
    const db = await this.dbPromise;
    return (await request(db.transaction('workspaces', 'readonly').objectStore('workspaces').get(wsId)) as WorkspaceInfo | undefined) || null;
  }

  async stats(wsId: string): Promise<{ files: number; bytes: number; versions: number }> {
    const ws = await this.getWorkspace(wsId);
    if (!ws) throw new Error('workspace_not_found');
    const versions = await this.listVersions(wsId);
    const head = versions.find((v) => v.no === ws.head);
    return { files: head?.stats.files || 0, bytes: head?.stats.bytes || 0, versions: versions.length };
  }

  async deleteWorkspace(wsId: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['workspaces', 'versions', 'blobs'], 'readwrite');
    tx.objectStore('workspaces').delete(wsId);
    for (const name of ['versions', 'blobs']) {
      const store = tx.objectStore(name);
      const rows = await request(store.index('byWorkspace').getAllKeys(wsId));
      for (const k of rows) store.delete(k);
    }
    await done(tx);
  }

  private async cleanupOrphanBlobs(): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['workspaces', 'blobs'], 'readwrite');
    const workspaces = await request(tx.objectStore('workspaces').getAll()) as WorkspaceRecord[];
    const live = new Set(workspaces.map((w) => w.id));
    const blobs = await request(tx.objectStore('blobs').getAll()) as BlobRecord[];
    for (const blob of blobs) if (!live.has(blob.workspaceId)) tx.objectStore('blobs').delete(blob.key);
    await done(tx);
  }
}
