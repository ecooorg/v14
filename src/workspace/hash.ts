/**
 * SHA-256 helpers and canonical manifestHash (P26 FW-19).
 * Hash uses only path, sha256, mode — derived fields excluded.
 */

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // Prefer Web Crypto when available (browser / modern Node)
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const dig = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return bufferToHex(new Uint8Array(dig));
  }
  // Node fallback
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function bufferToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

export interface HashableEntry {
  path: string;
  sha256: string;
  mode: number;
}

/** Canonical serialisation: sorted by path, fields path|sha256|mode only. */
export function canonicalManifestString(entries: HashableEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted.map((e) => `${e.path}\n${e.sha256}\n${e.mode}`).join('\n');
}

export async function manifestHash(entries: HashableEntry[]): Promise<string> {
  const s = canonicalManifestString(entries);
  const bytes = new TextEncoder().encode(s);
  return sha256Bytes(bytes);
}
