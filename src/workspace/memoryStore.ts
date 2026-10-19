/**
 * In-memory WorkspaceStore for contract tests and P26a gate (P26 FW-23).
 */

import { manifestHash } from './hash.ts';
import type {
  Entry,
  VersionInfo,
  VersionMeta,
  WorkspaceInfo,
  WorkspaceStore,
} from './types.ts';

function id(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

interface WsRec {
  info: WorkspaceInfo;
  versions: Map<number, { meta: VersionInfo; manifest: Entry[] }>;
  blobs: Map<string, Uint8Array>;
}

export class MemoryWorkspaceStore implements WorkspaceStore {
  private workspaces = new Map<string, WsRec>();

  async createWorkspace(name: string, rootPrefix = '', privacyAck = false): Promise<string> {
    const wsId = id();
    this.workspaces.set(wsId, {
      info: {
        id: wsId,
        name,
        rootPrefix,
        head: 0,
        createdAt: new Date().toISOString(),
        privacyAck,
      },
      versions: new Map(),
      blobs: new Map(),
    });
    return wsId;
  }

  async putBlob(wsId: string, sha256: string, bytes: Uint8Array): Promise<void> {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error('workspace_not_found');
    if (!ws.blobs.has(sha256)) {
      ws.blobs.set(sha256, bytes);
    }
  }

  async commitVersion(
    wsId: string,
    parentNo: number | null,
    manifest: Entry[],
    meta: VersionMeta,
  ): Promise<VersionInfo> {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error('workspace_not_found');
    if (parentNo === null) {
      if (ws.info.head !== 0) throw new Error('parent_mismatch');
    } else if (parentNo !== ws.info.head) {
      throw new Error('parent_mismatch');
    }
    for (const e of manifest) {
      if (!ws.blobs.has(e.sha256)) throw new Error(`missing_blob:${e.sha256}`);
    }
    const no = ws.info.head + 1;
    const mh = await manifestHash(manifest);
    const stats = {
      files: manifest.length,
      bytes: manifest.reduce((s, e) => s + e.size, 0),
    };
    const info: VersionInfo = {
      no,
      parent: parentNo,
      createdAt: new Date().toISOString(),
      createdBy: meta.createdBy,
      message: meta.message,
      manifestHash: mh,
      stats,
    };
    ws.versions.set(no, { meta: info, manifest: [...manifest] });
    ws.info.head = no;
    return info;
  }

  async getManifest(wsId: string, no: number): Promise<Entry[]> {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error('workspace_not_found');
    const v = ws.versions.get(no);
    if (!v) throw new Error('version_not_found');
    return [...v.manifest];
  }

  async readBlob(wsId: string, sha256: string): Promise<Uint8Array> {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error('workspace_not_found');
    const b = ws.blobs.get(sha256);
    if (!b) throw new Error('blob_not_found');
    return b;
  }

  async listVersions(wsId: string): Promise<VersionInfo[]> {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error('workspace_not_found');
    return [...ws.versions.values()].map((v) => v.meta).sort((a, b) => a.no - b.no);
  }

  async deleteWorkspace(wsId: string): Promise<void> {
    this.workspaces.delete(wsId);
  }

  async stats(wsId: string): Promise<{ files: number; bytes: number; versions: number }> {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error('workspace_not_found');
    const head = ws.versions.get(ws.info.head);
    return {
      files: head?.meta.stats.files ?? 0,
      bytes: head?.meta.stats.bytes ?? 0,
      versions: ws.versions.size,
    };
  }

  async getWorkspace(wsId: string): Promise<WorkspaceInfo | null> {
    return this.workspaces.get(wsId)?.info ?? null;
  }

  async setPrivacyAck(wsId: string, value: boolean): Promise<void> {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error('workspace_not_found');
    ws.info = { ...ws.info, privacyAck: value };
  }
}
