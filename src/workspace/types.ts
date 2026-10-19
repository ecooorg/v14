/**
 * Shared workspace types (P26). No Express / browser dependencies.
 */

export type FileClass =
  | 'source'
  | 'config'
  | 'data'
  | 'doc'
  | 'office'
  | 'pdf'
  | 'image'
  | 'archive'
  | 'binary'
  | 'executable';

export type Eol = 'LF' | 'CRLF' | 'mixed';
export type EncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251' | 'binary';

export type EntryFlag = 'secret' | 'generated' | 'lockfile' | 'minified' | 'executable';

export interface Entry {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  class: FileClass;
  lang?: string;
  encoding?: EncodingName;
  eol?: Eol;
  bom?: boolean;
  flags: EntryFlag[];
}

export interface IngestLimits {
  maxArchiveBytes: number;
  maxUnpackedBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxRatioPerEntry: number;
  maxRatioTotal: number;
  timeoutMs: number;
}

export const DEFAULT_BROWSER_LIMITS: IngestLimits = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 30 * 1024 * 1024,
  maxEntries: 1500,
  maxFileBytes: 5 * 1024 * 1024,
  maxRatioPerEntry: 100,
  maxRatioTotal: 50,
  timeoutMs: 30_000,
};

export const DEFAULT_SERVER_LIMITS: IngestLimits = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 60 * 1024 * 1024,
  maxEntries: 2000,
  maxFileBytes: 5 * 1024 * 1024,
  maxRatioPerEntry: 100,
  maxRatioTotal: 50,
  timeoutMs: 20_000,
};

export type SkipReason =
  | 'path_traversal'
  | 'absolute_path'
  | 'invalid_name'
  | 'symlink'
  | 'duplicate_case'
  | 'duplicate_path'
  | 'too_large_file'
  | 'default_skip_rule'
  | 'empty'
  | 'unsupported_entry';

export type RejectReason =
  | 'too_large_archive'
  | 'too_many_entries'
  | 'unpacked_too_large'
  | 'compression_ratio'
  | 'timeout'
  | 'unreadable'
  | 'unsupported_format'
  | 'empty_archive';

export interface IngestSkipped {
  path: string;
  reason: SkipReason;
  detail?: string;
}

export interface IngestReport {
  accepted: number;
  skipped: IngestSkipped[];
  marked: { path: string; flags: EntryFlag[] }[];
  rootPrefix: string;
  limitsHit: string[];
  rejected?: RejectReason;
  rejectDetail?: string;
}

export interface IngestResult {
  entries: Entry[];
  /** path -> raw bytes (only accepted entries) */
  blobs: Map<string, Uint8Array>;
  report: IngestReport;
  manifestHash: string;
}

export interface VersionMeta {
  createdBy: 'import' | 'agent+user' | 'user' | 'rollback' | 'create';
  message?: string;
}

export interface VersionInfo {
  no: number;
  parent: number | null;
  createdAt: string;
  createdBy: VersionMeta['createdBy'];
  message?: string;
  manifestHash: string;
  stats: { files: number; bytes: number };
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  rootPrefix: string;
  head: number;
  createdAt: string;
  privacyAck: boolean;
}

export interface WorkspaceStore {
  createWorkspace(name: string, rootPrefix?: string, privacyAck?: boolean): Promise<string>;
  putBlob(wsId: string, sha256: string, bytes: Uint8Array): Promise<void>;
  commitVersion(
    wsId: string,
    parentNo: number | null,
    manifest: Entry[],
    meta: VersionMeta,
  ): Promise<VersionInfo>;
  getManifest(wsId: string, no: number): Promise<Entry[]>;
  readBlob(wsId: string, sha256: string): Promise<Uint8Array>;
  listVersions(wsId: string): Promise<VersionInfo[]>;
  deleteWorkspace(wsId: string): Promise<void>;
  stats(wsId: string): Promise<{ files: number; bytes: number; versions: number }>;
  getWorkspace?(wsId: string): Promise<WorkspaceInfo | null>;
  setPrivacyAck?(wsId: string, value: boolean): Promise<void>;
}
