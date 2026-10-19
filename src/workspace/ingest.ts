/**
 * Safe archive ingest (P26). Zip only in P26a; tar follows in a.2.
 * Uses actual-byte counters; does not trust header sizes alone.
 */

import JSZip from 'jszip';
import { classifyBytes } from './classify.ts';
import { manifestHash, sha256Bytes } from './hash.ts';
import {
  caseKey,
  detectRootPrefix,
  matchesDefaultSkip,
  normalizePath,
  stripRootPrefix,
} from './paths.ts';
import type {
  Entry,
  IngestLimits,
  IngestReport,
  IngestResult,
  IngestSkipped,
  RejectReason,
} from './types.ts';
import { DEFAULT_BROWSER_LIMITS } from './types.ts';
import { readTar } from './tar.ts';

function isZip(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) ||
    (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b)
  );
}

function reject(reason: RejectReason, detail?: string): IngestResult {
  return {
    entries: [],
    blobs: new Map(),
    report: {
      accepted: 0,
      skipped: [],
      marked: [],
      rootPrefix: '',
      limitsHit: [reason],
      rejected: reason,
      rejectDetail: detail,
    },
    manifestHash: '',
  };
}

/**
 * Ingest a zip archive into entries + blobs + report.
 * Does not execute any payload. Skips or rejects per FW-04…FW-11 table.
 */
export async function ingestZip(
  archiveBytes: Uint8Array,
  limits: IngestLimits = DEFAULT_BROWSER_LIMITS,
): Promise<IngestResult> {
  if (archiveBytes.byteLength === 0) {
    return reject('empty_archive');
  }
  if (archiveBytes.byteLength > limits.maxArchiveBytes) {
    return reject('too_large_archive', `archive ${archiveBytes.byteLength} > ${limits.maxArchiveBytes}`);
  }
  if (!isZip(archiveBytes)) {
    return reject('unsupported_format', 'not a zip signature');
  }

  let zip: JSZip;
  try {
    // JSZip still loads fully; actual-byte counter below is the safety net.
    // Pass a plain Uint8Array copy so the buffer is ArrayBuffer (not SharedArrayBuffer).
    const copy = new Uint8Array(archiveBytes.byteLength);
    copy.set(archiveBytes);
    zip = await JSZip.loadAsync(copy);
  } catch (e) {
    return reject('unreadable', e instanceof Error ? e.message : 'load failed');
  }

  const names = Object.keys(zip.files);
  if (names.length > limits.maxEntries * 2) {
    // pre-check: directories inflate count; hard stop on extreme
    return reject('too_many_entries', `entries ${names.length}`);
  }

  const skipped: IngestSkipped[] = [];
  const caseSeen = new Map<string, string>();
  const rawByPath = new Map<string, Uint8Array>();
  let unpacked = 0;
  let fileCount = 0;

  for (const name of names) {
    const zf = zip.files[name];
    if (!zf || zf.dir) continue;

    // Symlink / unix mode: JSZip exposes unixPermissions sometimes
    const unix = (zf as { unixPermissions?: number }).unixPermissions;
    if (unix != null && (unix & 0o170000) === 0o120000) {
      skipped.push({ path: name, reason: 'symlink', detail: 'symlink not created' });
      continue;
    }

    const norm = normalizePath(name);
    if (norm.ok === false) {
      const r = norm.reason;
      const reason =
        r === 'traversal' || r === 'absolute' || r === 'windows_drive' || r === 'unc'
          ? ('path_traversal' as const)
          : r === 'empty'
            ? ('empty' as const)
            : ('invalid_name' as const);
      skipped.push({ path: name, reason, detail: r });
      continue;
    }

    const skipRule = matchesDefaultSkip(norm.path);
    if (skipRule) {
      skipped.push({ path: norm.path, reason: 'default_skip_rule', detail: skipRule });
      continue;
    }

    const ck = caseKey(norm.path);
    if (caseSeen.has(ck) && caseSeen.get(ck) !== norm.path) {
      skipped.push({ path: norm.path, reason: 'duplicate_case', detail: caseSeen.get(ck) });
      continue;
    }

    let data: Uint8Array;
    try {
      const ab = await zf.async('uint8array');
      data = ab;
    } catch {
      skipped.push({ path: norm.path, reason: 'unsupported_entry', detail: 'read failed' });
      continue;
    }

    // Actual bytes
    unpacked += data.byteLength;
    if (unpacked > limits.maxUnpackedBytes) {
      return reject('unpacked_too_large', `unpacked ${unpacked}`);
    }
    // Compression ratio (entry): compressed size unknown precisely with JSZip; use archive size vs unpacked as total check later
    if (data.byteLength > limits.maxFileBytes) {
      skipped.push({ path: norm.path, reason: 'too_large_file', detail: String(data.byteLength) });
      continue;
    }

    // Last-wins for identical path
    caseSeen.set(ck, norm.path);
    rawByPath.set(norm.path, data);
    fileCount++;
    if (fileCount > limits.maxEntries) {
      return reject('too_many_entries', `files ${fileCount}`);
    }
  }

  if (rawByPath.size === 0) {
    return reject('empty_archive', skipped.length ? 'all skipped' : 'no files');
  }

  // Total compression ratio
  if (archiveBytes.byteLength > 0 && unpacked / archiveBytes.byteLength > limits.maxRatioTotal) {
    return reject('compression_ratio', `ratio ${(unpacked / archiveBytes.byteLength).toFixed(1)}`);
  }

  const allPaths = [...rawByPath.keys()];
  const rootPrefix = detectRootPrefix(allPaths);

  const entries: Entry[] = [];
  const blobs = new Map<string, Uint8Array>();
  const marked: IngestReport['marked'] = [];

  for (const [fullPath, data] of rawByPath) {
    const path = stripRootPrefix(fullPath, rootPrefix);
    if (!path) continue; // was the root dir marker only

    const sha = await sha256Bytes(data);
    const cls = classifyBytes(path, data);
    // executable bit: keep only from unix mode if present; default 0o644
    let mode = 0o644;
    // JSZip doesn't always expose mode; leave 644

    const entry: Entry = {
      path,
      sha256: sha,
      size: data.byteLength,
      mode,
      class: cls.class,
      lang: cls.lang,
      encoding: cls.encoding,
      eol: cls.eol,
      bom: cls.bom,
      flags: cls.flags,
    };
    entries.push(entry);
    blobs.set(sha, data);
    if (cls.flags.length) {
      marked.push({ path, flags: cls.flags });
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const mh = await manifestHash(entries);

  return {
    entries,
    blobs,
    report: {
      accepted: entries.length,
      skipped,
      marked,
      rootPrefix,
      limitsHit: [],
    },
    manifestHash: mh,
  };
}

/** Inflate gzip using the platform stream API; no shell or archive utility is invoked. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('gzip_unsupported_in_this_browser');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isTar(bytes: Uint8Array): boolean {
  return bytes.length >= 262 && decoderAscii(bytes.subarray(257, 262)) === 'ustar';
}
function decoderAscii(bytes: Uint8Array): string { return String.fromCharCode(...bytes); }

async function ingestTar(bytes: Uint8Array, limits: IngestLimits): Promise<IngestResult> {
  let tarEntries;
  try { tarEntries = readTar(bytes, limits); }
  catch (e) {
    const message = e instanceof Error ? e.message : 'tar_read_failed';
    const reason: RejectReason = message.includes('too_many') ? 'too_many_entries' : message.includes('unpacked_too_large') ? 'unpacked_too_large' : 'unreadable';
    return reject(reason, message);
  }
  const z = new JSZip();
  const skipped: IngestSkipped[] = [];
  const seen = new Map<string, string>();
  let files = 0;
  for (const item of tarEntries) {
    if (item.type === 'directory') continue;
    if (item.type !== 'file') {
      skipped.push({ path: item.path, reason: item.type === 'symlink' || item.type === 'hardlink' ? 'symlink' : 'unsupported_entry', detail: item.linkTarget ? `link target: ${item.linkTarget}` : item.type });
      continue;
    }
    const norm = normalizePath(item.path);
    if (norm.ok === false) {
      const r = norm.reason;
      skipped.push({ path: item.path, reason: r === 'traversal' || r === 'absolute' || r === 'windows_drive' || r === 'unc' ? 'path_traversal' : r === 'empty' ? 'empty' : 'invalid_name', detail: r });
      continue;
    }
    const rule = matchesDefaultSkip(norm.path);
    if (rule) { skipped.push({ path: norm.path, reason: 'default_skip_rule', detail: rule }); continue; }
    const key = caseKey(norm.path);
    if (seen.has(key)) {
      const previous = seen.get(key)!;
      if (previous !== norm.path) {
        skipped.push({ path: norm.path, reason: 'duplicate_case', detail: previous });
      } else {
        // Deterministic first-wins policy: never let a later duplicate silently
        // replace an earlier file in an archive.
        skipped.push({ path: norm.path, reason: 'duplicate_path', detail: 'duplicate path; first entry kept' });
      }
      continue;
    }
    if (item.bytes.byteLength > limits.maxFileBytes) { skipped.push({ path: norm.path, reason: 'too_large_file', detail: String(item.bytes.byteLength) }); continue; }
    if (seen.has(key)) skipped.push({ path: norm.path, reason: 'unsupported_entry', detail: 'duplicate path; last entry kept' });
    seen.set(key, norm.path);
    z.file(norm.path, item.bytes);
    files++;
    if (files > limits.maxEntries) return reject('too_many_entries', `files ${files}`);
  }
  if (!files) {
    const empty = reject('empty_archive', 'no regular files accepted');
    empty.report.skipped = skipped;
    return empty;
  }
  const packed = await z.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await ingestZip(packed, { ...limits, maxArchiveBytes: Math.max(limits.maxArchiveBytes, packed.byteLength), maxRatioTotal: Math.max(limits.maxRatioTotal, 1000) });
  result.report.skipped = [...skipped, ...result.report.skipped];
  return result;
}

/** Ingest ZIP, POSIX tar, or gzip-compressed tar by signature, not filename. */
export async function ingestArchive(bytes: Uint8Array, limits: IngestLimits = DEFAULT_BROWSER_LIMITS): Promise<IngestResult> {
  if (!bytes.byteLength) return reject('empty_archive');
  if (bytes.byteLength > limits.maxArchiveBytes) return reject('too_large_archive', `archive ${bytes.byteLength} > ${limits.maxArchiveBytes}`);
  if (isZip(bytes)) return ingestZip(bytes, limits);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      const expanded = await gunzip(bytes);
      if (expanded.byteLength > limits.maxUnpackedBytes) return reject('unpacked_too_large', `gzip payload ${expanded.byteLength}`);
      return ingestTar(expanded, limits);
    } catch (e) { return reject('unreadable', e instanceof Error ? e.message : 'gzip_read_failed'); }
  }
  if (isTar(bytes)) return ingestTar(bytes, limits);
  return reject('unsupported_format', 'expected ZIP, tar, or gzip-compressed tar signature');
}

/** Ingest a folder picker / dropped file list without uploading its contents to a server. */
export async function ingestFiles(files: Iterable<{ name: string; size?: number; webkitRelativePath?: string; arrayBuffer(): Promise<ArrayBuffer> }>, limits: IngestLimits = DEFAULT_BROWSER_LIMITS): Promise<IngestResult> {
  const z = new JSZip();
  const skipped: IngestSkipped[] = [];
  const seen = new Map<string, string>();
  let count = 0;
  let total = 0;
  for (const file of files) {
    const rawPath = file.webkitRelativePath || file.name;
    const norm = normalizePath(rawPath);
    if (norm.ok === false) { skipped.push({ path: rawPath, reason: norm.reason === 'traversal' || norm.reason === 'absolute' || norm.reason === 'windows_drive' || norm.reason === 'unc' ? 'path_traversal' : 'invalid_name', detail: norm.reason }); continue; }
    const rule = matchesDefaultSkip(norm.path);
    if (rule) { skipped.push({ path: norm.path, reason: 'default_skip_rule', detail: rule }); continue; }
    const key = caseKey(norm.path);
    if (seen.has(key) && seen.get(key) !== norm.path) { skipped.push({ path: norm.path, reason: 'duplicate_case', detail: seen.get(key) }); continue; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > limits.maxFileBytes) { skipped.push({ path: norm.path, reason: 'too_large_file', detail: String(bytes.byteLength) }); continue; }
    total += bytes.byteLength;
    if (total > limits.maxUnpackedBytes) return reject('unpacked_too_large', `folder bytes ${total}`);
    if (seen.has(key)) skipped.push({ path: norm.path, reason: 'unsupported_entry', detail: 'duplicate path; last entry kept' });
    seen.set(key, norm.path);
    z.file(norm.path, bytes);
    if (++count > limits.maxEntries) return reject('too_many_entries', `files ${count}`);
  }
  if (!count) { const empty = reject('empty_archive', 'no files accepted'); empty.report.skipped = skipped; return empty; }
  const packed = await z.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const result = await ingestZip(packed, { ...limits, maxArchiveBytes: Math.max(limits.maxArchiveBytes, packed.byteLength), maxRatioTotal: Math.max(limits.maxRatioTotal, 1000) });
  result.report.skipped = [...skipped, ...result.report.skipped];
  return result;
}
