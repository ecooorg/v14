/**
 * Deterministic workspace export (P26b FW-45…FW-49).
 * Uses JSZip when available; pure byte builder fallback for tests without DOM.
 */

import type { Entry, WorkspaceStore } from './types.ts';
import { unifiedDiffForFile } from './diff.ts';

const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export type ExportMode = 'full' | 'changed' | 'diff';

export interface ExportResult {
  filename: string;
  /** Zip or plain text for mode=diff */
  bytes: Uint8Array;
  sha256: string;
  mode: ExportMode;
  files: number;
  warnings: string[];
}

function safeFileName(raw: string): string {
  let s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 80) s = s.slice(0, 80);
  return s || 'workspace';
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const dig = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** Build a deterministic zip of the given path→bytes map (lexicographic paths, fixed DOS time). */
export async function buildDeterministicZip(files: Map<string, Uint8Array>): Promise<Uint8Array> {
  let JSZip: any;
  try {
    JSZip = (await import('jszip')).default;
  } catch {
    // Minimal uncompressed ZIP writer for environments without jszip in tests.
    return buildRawZip(files);
  }
  const zip = new JSZip();
  const paths = [...files.keys()].sort();
  for (const p of paths) {
    zip.file(p, files.get(p)!, {
      date: FIXED_DATE,
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }
  const out = await zip.generateAsync({
    type: 'uint8array',
    compression: 'STORE',
    streamFiles: false,
  });
  return out as Uint8Array;
}

/** Minimal ZIP STORE writer (no compression) with fixed timestamps. */
function buildRawZip(files: Map<string, Uint8Array>): Uint8Array {
  const paths = [...files.keys()].sort();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const dosTime = 0; // 00:00:00
  const dosDate = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01

  for (const name of paths) {
    const data = files.get(name)!;
    const nameBytes = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, dosTime, true);
    lv.setUint16(10, dosDate, true);
    // CRC32 skipped (0) for simplicity in fallback — real JSZip path is preferred
    lv.setUint32(14, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralParts) centralSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, paths.length, true);
  ev.setUint16(10, paths.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of localParts) {
    out.set(p, o);
    o += p.length;
  }
  for (const c of centralParts) {
    out.set(c, o);
    o += c.length;
  }
  out.set(end, o);
  return out;
}

export async function exportWorkspace(
  store: WorkspaceStore,
  wsId: string,
  opts: {
    version?: number;
    mode?: ExportMode;
    /** For mode=changed|diff: compare against this version (default 1 or first). */
    baseVersion?: number;
    name?: string;
    skipRulesNote?: string[];
  } = {},
): Promise<ExportResult> {
  const mode = opts.mode ?? 'full';
  const ws = store.getWorkspace ? await store.getWorkspace(wsId) : null;
  const head = ws?.head ?? 0;
  const version = opts.version ?? head;
  if (version < 1) throw new Error('no_version');
  const manifest = await store.getManifest(wsId, version);
  const name = safeFileName(opts.name || ws?.name || 'workspace');
  const warnings = opts.skipRulesNote?.length
    ? [`Skipped at ingest: ${opts.skipRulesNote.join(', ')}`]
    : [];

  if (mode === 'full') {
    const files = new Map<string, Uint8Array>();
    for (const e of manifest) {
      const bytes = await store.readBlob(wsId, e.sha256);
      // Preserve original bytes exactly (FW-47).
      files.set(e.path, bytes);
    }
    const zip = await buildDeterministicZip(files);
    const hash = await sha256Hex(zip);
    return {
      filename: `${name}-v${version}.zip`,
      bytes: zip,
      sha256: hash,
      mode,
      files: manifest.length,
      warnings,
    };
  }

  const baseNo = opts.baseVersion ?? 1;
  let baseManifest: Entry[] = [];
  try {
    if (baseNo >= 1 && baseNo < version) baseManifest = await store.getManifest(wsId, baseNo);
  } catch {
    baseManifest = [];
  }
  const baseMap = new Map(baseManifest.map((e) => [e.path, e]));
  const headMap = new Map(manifest.map((e) => [e.path, e]));

  const changedPaths = new Set<string>();
  for (const [p, e] of headMap) {
    const b = baseMap.get(p);
    if (!b || b.sha256 !== e.sha256) changedPaths.add(p);
  }
  for (const p of baseMap.keys()) {
    if (!headMap.has(p)) changedPaths.add(p);
  }

  if (mode === 'diff') {
    const parts: string[] = [];
    for (const p of [...changedPaths].sort()) {
      const before = baseMap.has(p) ? decodeText(await store.readBlob(wsId, baseMap.get(p)!.sha256)) : null;
      const after = headMap.has(p) ? decodeText(await store.readBlob(wsId, headMap.get(p)!.sha256)) : null;
      parts.push(unifiedDiffForFile(p, before, after));
    }
    const text = parts.join('\n');
    const bytes = new TextEncoder().encode(text);
    const hash = await sha256Hex(bytes);
    return {
      filename: `${name}-v${baseNo}-v${version}.diff`,
      bytes,
      sha256: hash,
      mode,
      files: changedPaths.size,
      warnings,
    };
  }

  // changed zip + BIFORGE-CHANGES.md
  const files = new Map<string, Uint8Array>();
  const changeLines = [`# BiForge changes v${baseNo} → v${version}`, '', '## Files', ''];
  for (const p of [...changedPaths].sort()) {
    if (headMap.has(p)) {
      files.set(p, await store.readBlob(wsId, headMap.get(p)!.sha256));
      changeLines.push(`- modified/added: \`${p}\``);
    } else {
      changeLines.push(`- deleted: \`${p}\``);
    }
  }
  files.set('BIFORGE-CHANGES.md', new TextEncoder().encode(changeLines.join('\n') + '\n'));
  const zip = await buildDeterministicZip(files);
  const hash = await sha256Hex(zip);
  return {
    filename: `${name}-v${version}-changed.zip`,
    bytes: zip,
    sha256: hash,
    mode: 'changed',
    files: files.size,
    warnings,
  };
}
