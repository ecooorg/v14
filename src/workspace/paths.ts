/**
 * Path normalisation and safety checks (P26 FW-05…FW-07).
 */

export type PathReject =
  | 'empty'
  | 'absolute'
  | 'traversal'
  | 'windows_drive'
  | 'unc'
  | 'control_char'
  | 'rtl_override'
  | 'too_long'
  | 'segment_too_long'
  | 'nul';

const RTL = /[\u202A-\u202E\u2066-\u2069]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** NFC + / separators; empty segments collapsed. Does not reject. */
export function normalizePathRaw(input: string): string {
  let s = String(input ?? '').normalize('NFC').replace(/\\/g, '/');
  // strip leading ./
  while (s.startsWith('./')) s = s.slice(2);
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  return parts.join('/');
}

/**
 * Validate and normalise a single archive entry path.
 * Returns { ok, path } or { ok: false, reason }.
 * Name `a..b.txt` is valid (only path segments equal to `..` are forbidden).
 */
export function normalizePath(input: string):
  | { ok: true; path: string }
  | { ok: false; reason: PathReject; detail?: string } {
  if (input == null || String(input).length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const raw = String(input);
  if (raw.includes('\0') || CONTROL.test(raw)) {
    return { ok: false, reason: raw.includes('\0') ? 'nul' : 'control_char' };
  }
  if (RTL.test(raw)) {
    return { ok: false, reason: 'rtl_override' };
  }
  // absolute / UNC / Windows drive before normalisation
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    return { ok: false, reason: 'absolute' };
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^[a-zA-Z]:$/.test(raw.trim())) {
    return { ok: false, reason: 'windows_drive' };
  }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { ok: false, reason: 'unc' };
  }

  const nfc = raw.normalize('NFC').replace(/\\/g, '/');
  const segments = nfc.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      return { ok: false, reason: 'traversal' };
    }
    if (seg.length > 120) {
      return { ok: false, reason: 'segment_too_long', detail: seg.slice(0, 40) };
    }
    out.push(seg);
  }
  if (out.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const path = out.join('/');
  if (path.length > 240) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, path };
}

/** Case-insensitive key for collision detection (NFC + lower). */
export function caseKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** Default skip rules (FW-09). path is already normalised. */
export function matchesDefaultSkip(path: string): string | null {
  const lower = path.toLowerCase();
  const rules: [RegExp | string, string][] = [
    [/^(\.git)(\/|$)/i, '.git/'],
    [/(^|\/)node_modules(\/|$)/i, 'node_modules/'],
    [/(^|\/)dist(\/|$)/i, 'dist/'],
    [/(^|\/)build(\/|$)/i, 'build/'],
    [/(^|\/)\.next(\/|$)/i, '.next/'],
    [/(^|\/)target(\/|$)/i, 'target/'],
    [/(^|\/)__pycache__(\/|$)/i, '__pycache__/'],
    [/(^|\/)venv(\/|$)/i, 'venv/'],
    [/(^|\/)\.venv(\/|$)/i, '.venv/'],
    [/(^|\/)\.idea(\/|$)/i, '.idea/'],
    [/(^|\/)\.DS_Store$/i, '.DS_Store'],
    [/\.pyc$/i, '*.pyc'],
  ];
  for (const [re, label] of rules) {
    if (typeof re === 'string') {
      if (lower === re || lower.endsWith('/' + re)) return label;
    } else if (re.test(path)) {
      return label;
    }
  }
  return null;
}

/**
 * If every path shares a single top-level directory, return that prefix
 * (without trailing slash). Otherwise ''.
 */
export function detectRootPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  if (tops.size !== 1) return '';
  const top = [...tops][0];
  // only strip if every path has at least one segment under top
  if (paths.every((p) => p === top || p.startsWith(top + '/'))) {
    // require at least one file under the prefix (not only the dir itself)
    if (paths.some((p) => p.startsWith(top + '/'))) return top;
  }
  return '';
}

export function stripRootPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path === prefix) return '';
  if (path.startsWith(prefix + '/')) return path.slice(prefix.length + 1);
  return path;
}
