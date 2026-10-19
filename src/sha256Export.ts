/** Canonical SHA-256 for experiment card export — TZ B.4 */

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(text: string): Promise<string> {
  // This module is part of the browser bundle. Web Crypto is available in
  // secure contexts (HTTPS and localhost); do not import node:crypto here,
  // because Vite externalizes Node built-ins and the browser cannot execute them.
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    throw new Error('SHA-256 is unavailable: use HTTPS or localhost with Web Crypto enabled.');
  }
  const buf = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function cardChecksum(card: unknown): Promise<string> {
  return sha256Hex(canonicalJson(card));
}
