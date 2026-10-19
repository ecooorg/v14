/**
 * Content-based classification (P26 FW-12…FW-16).
 */

import type { EncodingName, EntryFlag, Eol, FileClass } from './types.ts';

export interface ClassifyResult {
  class: FileClass;
  lang?: string;
  encoding: EncodingName;
  eol?: Eol;
  bom: boolean;
  flags: EntryFlag[];
  /** true if text may be edited (round-trip ok for non-utf8) */
  editable: boolean;
  text?: string;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

function sniffBinary(bytes: Uint8Array): FileClass | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image'; // PNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image'; // JPEG
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    // zip-like — office vs archive decided by caller if needed; default archive
    return 'archive';
  }
  if (startsWith(bytes, [0x1f, 0x8b])) return 'archive'; // gzip
  if (startsWith(bytes, [0x4d, 0x5a])) return 'executable'; // MZ
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return 'executable'; // ELF
  if (startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe])) {
    return 'executable'; // Mach-O
  }
  // NUL in first 8 KB → binary
  const head = bytes.subarray(0, Math.min(8192, bytes.length));
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return 'binary';
  }
  return null;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  xml: 'xml',
  svg: 'svg',
  csv: 'csv',
  tsv: 'tsv',
  txt: 'text',
  log: 'text',
  dockerfile: 'dockerfile',
};

const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  gnumakefile: 'make',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitattributes',
  license: 'text',
  licence: 'text',
  readme: 'markdown',
  'readme.md': 'markdown',
  'cmakelists.txt': 'cmake',
};

const CONFIG_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'cargo.toml',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'gemfile',
  '.env',
  '.env.example',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
]);

const LOCK_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'bun.lockb',
]);

const SECRET_NAME_RE =
  /(^|\/)(\.env($|\.)|.*\.pem$|.*\.key$|id_rsa|.*\.p12$|credentials\.json$|.*secret.*|.*credential.*)/i;

function detectEol(s: string): Eol {
  const hasCRLF = /\r\n/.test(s);
  const hasLF = /(?:^|[^\r])\n/.test(s) || s.endsWith('\n');
  const hasCR = /\r(?!\n)/.test(s);
  if (hasCRLF && !hasLF && !hasCR) return 'CRLF';
  if (hasLF && !hasCRLF && !hasCR) return 'LF';
  if ((hasCRLF && hasLF) || (hasCRLF && hasCR) || (hasLF && hasCR)) return 'mixed';
  if (hasCRLF) return 'CRLF';
  return 'LF';
}

function tryDecode(bytes: Uint8Array): {
  encoding: EncodingName;
  text: string;
  bom: boolean;
  editable: boolean;
} {
  // BOM UTF-8
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    return { encoding: 'utf-8', text, bom: true, editable: true };
  }
  // UTF-16 LE/BE BOM
  if (startsWith(bytes, [0xff, 0xfe])) {
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    return { encoding: 'utf-16le', text, bom: true, editable: roundTrip(bytes, 'utf-16le', text, true) };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    const text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
    return { encoding: 'utf-16be', text, bom: true, editable: false };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { encoding: 'utf-8', text, bom: false, editable: true };
  } catch {
    /* fall through */
  }
  // windows-1251 fallback with round-trip check
  try {
    const text = new TextDecoder('windows-1251').decode(bytes);
    const editable = roundTrip(bytes, 'windows-1251', text, false);
    return { encoding: 'windows-1251', text, bom: false, editable };
  } catch {
    return { encoding: 'binary', text: '', bom: false, editable: false };
  }
}

function roundTrip(
  original: Uint8Array,
  encoding: string,
  text: string,
  _bom: boolean,
): boolean {
  try {
    // Browser/Node TextEncoder is UTF-8 only; for 1251 we approximate via checking
    // that decoding is stable (re-decode same). Full encode for 1251 needs iconv;
    // we mark editable only for utf-8 in P26a. Non-utf8 → read-only unless utf-8 round-trips.
    if (encoding === 'utf-8' || encoding === 'utf-16le') {
      const enc = new TextEncoder().encode(text);
      // for utf-8 without bom, lengths should match closely
      if (encoding === 'utf-8') {
        return enc.length === original.length || Math.abs(enc.length - original.length) <= 3;
      }
    }
    if (encoding === 'windows-1251') {
      // Without a 1251 encoder in core, treat as read-only for edits (FW-16).
      return false;
    }
    return false;
  } catch {
    return false;
  }
}

function languageOf(path: string): string | undefined {
  const base = path.split('/').pop() || path;
  const lower = base.toLowerCase();
  if (NAME_LANG[lower]) return NAME_LANG[lower];
  const ext = lower.includes('.') ? lower.split('.').pop()! : lower;
  return EXT_LANG[ext];
}

function isGenerated(text: string): boolean {
  const lines = text.split('\n');
  if (lines.some((l) => l.length > 5000)) return true;
  if (lines.length > 5) {
    const avg = text.length / lines.length;
    if (avg > 300) return true;
  }
  return false;
}

function isMinified(text: string, path: string): boolean {
  const lower = path.toLowerCase();
  if (/\.min\.(js|css)$/.test(lower)) return true;
  const lines = text.split('\n');
  if (lines.length <= 3 && text.length > 2000) return true;
  return false;
}

/**
 * Classify bytes of a single file.
 */
export function classifyBytes(path: string, bytes: Uint8Array): ClassifyResult {
  const bin = sniffBinary(bytes);
  const base = (path.split('/').pop() || path).toLowerCase();
  const flags: EntryFlag[] = [];

  if (bin === 'executable') {
    flags.push('executable');
    return { class: 'executable', encoding: 'binary', bom: false, flags, editable: false };
  }
  if (bin === 'pdf') {
    return { class: 'pdf', encoding: 'binary', bom: false, flags, editable: false };
  }
  if (bin === 'image') {
    return { class: 'image', encoding: 'binary', bom: false, flags, editable: false };
  }
  if (bin === 'archive') {
    // OOXML packages are zip-based; classify as office when the path says so (P35).
    const officeExt = /\.(docx|xlsx|pptx)$/i.test(base);
    if (officeExt) {
      return { class: 'office', encoding: 'binary', bom: false, flags, editable: false };
    }
    return { class: 'archive', encoding: 'binary', bom: false, flags, editable: false };
  }
  if (bin === 'binary') {
    return { class: 'binary', encoding: 'binary', bom: false, flags, editable: false };
  }

  const dec = tryDecode(bytes);
  if (dec.encoding === 'binary' || !dec.text) {
    return { class: 'binary', encoding: 'binary', bom: false, flags, editable: false };
  }

  const eol = detectEol(dec.text);
  const lang = languageOf(path);

  if (SECRET_NAME_RE.test(path) || SECRET_NAME_RE.test(base)) {
    flags.push('secret');
  }
  if (LOCK_NAMES.has(base)) flags.push('lockfile');
  if (isGenerated(dec.text)) flags.push('generated');
  if (isMinified(dec.text, path)) flags.push('minified');

  // shebang scripts stay source (editable text)
  let cls: FileClass = 'source';
  if (CONFIG_NAMES.has(base) || base.startsWith('.env')) cls = 'config';
  else if (lang === 'markdown' || lang === 'text') cls = 'doc';
  else if (lang === 'json' && base.includes('lock')) cls = 'config';
  else if (!lang && !dec.text.trim()) cls = 'data';

  // mode bit executable for shebang is set by ingest, not here

  return {
    class: cls,
    lang,
    encoding: dec.encoding,
    eol,
    bom: dec.bom,
    flags,
    editable: dec.editable,
    text: dec.text,
  };
}

/** Expand TEXT attachment acceptance: content looks like text (no NUL). */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (sniffBinary(bytes)) return false;
  return true;
}
