/** Minimal, non-executing POSIX tar reader with PAX and GNU long-name support (P26a.2). */

export interface TarEntry {
  path: string;
  bytes: Uint8Array;
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'special';
  mode: number;
  linkTarget?: string;
}

const BLOCK = 512;
const decoder = new TextDecoder('utf-8', { fatal: false });

function field(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return decoder.decode(nul < 0 ? slice : slice.subarray(0, nul)).trim();
}

function numberField(bytes: Uint8Array, start: number, length: number): number {
  const raw = field(bytes, start, length).replace(/\0/g, '').trim();
  if (!raw) return 0;
  if (raw[0] === '\u0080') {
    let n = raw.charCodeAt(0) & 0x7f;
    for (let i = 1; i < raw.length; i++) n = n * 256 + raw.charCodeAt(i);
    return n;
  }
  const n = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('tar_invalid_number');
  return n;
}

function zeroBlock(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

function verifyChecksum(header: Uint8Array): boolean {
  const expected = numberField(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  return sum === expected;
}

function parsePax(bytes: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error('tar_invalid_pax');
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length) throw new Error('tar_invalid_pax');
    const record = decoder.decode(bytes.subarray(space + 1, offset + length)).replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0) result[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return result;
}

/** Reads regular file payloads; links/devices are reported as entries and never followed. */
export function readTar(bytes: Uint8Array, limits: { maxEntries: number; maxUnpackedBytes: number; maxFileBytes: number }): TarEntry[] {
  if (bytes.byteLength < BLOCK || bytes.byteLength % BLOCK !== 0) throw new Error('tar_invalid_length');
  const out: TarEntry[] = [];
  let offset = 0;
  let unpacked = 0;
  let pendingPax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  let longName = '';
  let longLink = '';
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (zeroBlock(header)) break;
    if (!verifyChecksum(header)) throw new Error('tar_checksum_mismatch');
    const size = numberField(header, 124, 12);
    const mode = numberField(header, 100, 8) & 0o777;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const baseName = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const rawName = prefix ? `${prefix}/${baseName}` : baseName;
    const linkName = field(header, 157, 100);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > bytes.length) throw new Error('tar_truncated_entry');
    const payload = bytes.slice(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'L' || typeFlag === 'K') {
      if (size > 1024 * 1024) throw new Error('tar_extended_header_too_large');
      if (typeFlag === 'x') pendingPax = { ...pendingPax, ...parsePax(payload) };
      else if (typeFlag === 'g') globalPax = { ...globalPax, ...parsePax(payload) };
      else {
        const text = decoder.decode(payload).replace(/\0.*$/s, '').replace(/\n$/, '');
        if (typeFlag === 'L') longName = text;
        else longLink = text;
      }
      continue;
    }
    const pax = { ...globalPax, ...pendingPax };
    pendingPax = {};
    const name = String(pax.path || longName || rawName).replace(/\0.*$/s, '');
    const linkTarget = String(pax.linkpath || longLink || linkName).replace(/\0.*$/s, '');
    longName = '';
    longLink = '';
    let type: TarEntry['type'];
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') type = 'file';
    else if (typeFlag === '5') type = 'directory';
    else if (typeFlag === '2') type = 'symlink';
    else if (typeFlag === '1') type = 'hardlink';
    else type = 'special';
    out.push({ path: name, bytes: type === 'file' ? payload : new Uint8Array(), type, mode, linkTarget: linkTarget || undefined });
    if (out.length > limits.maxEntries * 2) throw new Error('tar_too_many_entries');
    if (type === 'file') {
      unpacked += payload.byteLength;
      if (unpacked > limits.maxUnpackedBytes) throw new Error('tar_unpacked_too_large');
      if (payload.byteLength > limits.maxFileBytes) { /* caller reports/skips this entry */ }
    }
  }
  return out;
}
