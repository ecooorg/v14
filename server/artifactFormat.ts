import { createHash } from 'node:crypto';

/** Artifact Registry rules without a database (BX-17.b, TZ 10.1-10.4): limits, file names, type by content, preview, diff, archive listing, manifest. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_VERSIONS_PER_ARTIFACT = 200;
export const MAX_ARTIFACTS_PER_PROJECT = 1000;
export const MAX_FILENAME_LENGTH = 255;
export const PREVIEW_CHARS = 2000;
export const MAX_DIFF_LINES = 2000;
export const MAX_ARCHIVE_ENTRIES = 1000;

export type ArtifactKind = 'text' | 'binary' | 'archive' | 'executable';
export class ArtifactFormatError extends Error {
  constructor(readonly code: 'FILENAME' | 'TOO_LARGE' | 'LIMIT' | 'EMPTY_INPUT' | 'NOT_TEXT' | 'TOO_MANY_LINES', message: string) { super(message); }
}

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The file name is a label, never an identifier or a path (TZ 10.1). */
export function checkFilename(name: string): string {
  const n = name.trim();
  if (!n || n.length > MAX_FILENAME_LENGTH) throw new ArtifactFormatError('FILENAME', `File name must be 1-${MAX_FILENAME_LENGTH} characters`);
  if (/[\\/\0-\x1f\x7f]/.test(n) || n === '.' || n === '..') throw new ArtifactFormatError('FILENAME', 'File name must not contain path separators or control characters');
  return n;
}

const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const SIGNATURES: Array<{ sig: number[]; mime: string; kind: ArtifactKind }> = [
  { sig: [0x25, 0x50, 0x44, 0x46, 0x2d], mime: 'application/pdf', kind: 'binary' },
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png', kind: 'binary' },
  { sig: [0xff, 0xd8, 0xff], mime: 'image/jpeg', kind: 'binary' },
  { sig: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif', kind: 'binary' },
  { sig: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip', kind: 'archive' },
  { sig: [0x1f, 0x8b], mime: 'application/gzip', kind: 'archive' },
  { sig: [0x4d, 0x5a], mime: 'application/x-msdownload', kind: 'executable' },
  { sig: [0x7f, 0x45, 0x4c, 0x46], mime: 'application/x-elf', kind: 'executable' },
  { sig: [0xca, 0xfe, 0xba, 0xbe], mime: 'application/x-mach-binary', kind: 'executable' },
  { sig: [0xcf, 0xfa, 0xed, 0xfe], mime: 'application/x-mach-binary', kind: 'executable' },
  { sig: [0x23, 0x21], mime: 'text/x-script', kind: 'executable' },
];

/** Type from content, not from the declared mime (TZ 10.4). Unknown content is a plain binary artifact; executable formats are stored, flagged, never run. */
export function sniffType(data: Uint8Array, declaredMime = 'text/plain'): { mime: string; kind: ArtifactKind } {
  const hit = SIGNATURES.find((s) => startsWith(data, s.sig));
  if (hit) return { mime: hit.mime, kind: hit.kind };
  let isText = !data.includes(0);
  if (isText) { try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { isText = false; } }
  if (!isText) return { mime: 'application/octet-stream', kind: 'binary' };
  const declared = declaredMime.toLowerCase();
  const textual = declared.startsWith('text/') || /^application\/(json|xml|yaml|x-yaml)$/.test(declared) || declared.endsWith('+json');
  return { mime: textual ? declaredMime : 'text/plain', kind: 'text' };
}

export const securityStatusOf = (kind: ArtifactKind) => (kind === 'executable' ? 'flagged_executable' : 'inspected');

/** Preview only for text (a safe format); everything else returns null. */
export function previewOf(data: Uint8Array, kind: ArtifactKind, max = PREVIEW_CHARS): string | null {
  if (kind !== 'text') return null;
  return new TextDecoder().decode(data).slice(0, max);
}

export type DiffLine = { op: '+' | '-' | ' '; line: string };
/** Line diff of two texts (LCS), bounded by MAX_DIFF_LINES per side. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a === '' ? [] : a.split('\n'); const y = b === '' ? [] : b.split('\n');
  if (x.length > MAX_DIFF_LINES || y.length > MAX_DIFF_LINES) throw new ArtifactFormatError('TOO_MANY_LINES', `Diff is limited to ${MAX_DIFF_LINES} lines per version`);
  const t: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: DiffLine[] = []; let i = 0; let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ op: ' ', line: x[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: '-', line: x[i++] });
    else out.push({ op: '+', line: y[j++] });
  }
  while (i < x.length) out.push({ op: '-', line: x[i++] });
  while (j < y.length) out.push({ op: '+', line: y[j++] });
  return out;
}

/** Names from the ZIP central directory. Nothing is extracted (TZ 10.4); a name that could escape a folder is marked unsafe. */
export function listZipEntries(data: Uint8Array): { entries: Array<{ name: string; unsafe: boolean }>; truncated: boolean } | null {
  if (!startsWith(data, [0x50, 0x4b, 0x03, 0x04])) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 22 - 65535); p--) if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) return { entries: [], truncated: false };
  const total = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const entries: Array<{ name: string; unsafe: boolean }> = [];
  for (let n = 0; n < total && entries.length < MAX_ARCHIVE_ENTRIES; n++) {
    if (p + 46 > data.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const len = dv.getUint16(p + 28, true); const extra = dv.getUint16(p + 30, true); const comment = dv.getUint16(p + 32, true);
    if (p + 46 + len > data.length) break;
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + len));
    entries.push({ name, unsafe: /(^|[\\/])\.\.([\\/]|$)/.test(name) || /^([\\/]|[A-Za-z]:)/.test(name) || name.includes('\0') });
    p += 46 + len + extra + comment;
  }
  return { entries, truncated: total > entries.length };
}

export const storageRefOf = (rowId: string) => `pg:${rowId}`;
/** Manifest checksum; the same formula is used in migration 008 for older versions. */
export const manifestHashOf = (m: { artifactId: string; version: number; projectId: string; hash: string; size: number; storageRef: string }) =>
  sha256Hex(`${m.artifactId}|${m.version}|${m.projectId}|${m.hash}|${m.size}|${m.storageRef}`);

export type Manifest = {
  schema: 1; artifact_id: string; version: number; project_id: string; filename: string; mime: string; declared_mime: string;
  kind: ArtifactKind; size: number; hash: string; storage_ref: string; created_by: string; derived_from: string[];
};
