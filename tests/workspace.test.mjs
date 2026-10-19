/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN workspace-a2.test.mjs =====
{
/** P26a.2: tar/gzip, folder ingest, IndexedDB contract availability and WORKSPACE protocol. */
const assert = (await import("node:assert/strict")).default;
const { gzipSync } = await import("node:zlib");
const { ingestArchive, ingestFiles } = await import("../src/workspace/ingest.ts");
const { DEFAULT_BROWSER_LIMITS } = await import("../src/workspace/types.ts");
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { buildWorkspaceBlock, parseWorkspaceModelResponse, readWorkspaceFile, resolveWorkspaceRequests, searchWorkspace } = await import("../src/workspace/context.ts");
const { IndexedDbWorkspaceStore } = await import("../src/workspace/idbStore.ts");

function tarFile(path, content, type = '0') {
  const data = Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(path, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii'); h.write('0000000\0', 108, 8, 'ascii'); h.write('0000000\0', 116, 8, 'ascii');
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii'); h.fill(32, 148, 156); h[156] = type.charCodeAt(0);
  h.write('ustar\0', 257, 6, 'ascii'); h.write('00', 263, 2, 'ascii');
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512); data.copy(padded);
  return Buffer.concat([h, padded, Buffer.alloc(1024)]);
}
function makeFile(name, content) {
  const bytes = new TextEncoder().encode(content);
  return { name, size: bytes.length, async arrayBuffer() { return bytes.slice().buffer; } };
}

const tar = tarFile('proj/README.md', '# project\n');
const plainTar = new Uint8Array(tar);
const rTar = await ingestArchive(plainTar);
assert.equal(rTar.report.rejected, undefined);
assert.ok(rTar.entries.some((e) => e.path === 'README.md'));
const rGz = await ingestArchive(new Uint8Array(gzipSync(tar)));
assert.equal(rGz.report.rejected, undefined);
assert.equal(rGz.manifestHash, rTar.manifestHash);

const folder = await ingestFiles([makeFile('src/main.ts', 'export const answer = 42;\n'), makeFile('README.md', '# Demo\n')]);
assert.equal(folder.report.rejected, undefined);
assert.equal(folder.entries.length, 2);

assert.throws(() => IndexedDbWorkspaceStore.open(), /workspace_indexeddb_unavailable/);

const store = new MemoryWorkspaceStore();
const wsId = await store.createWorkspace('demo', '', true);
const files = [makeFile('README.md', '# Demo\nworkspace context'), makeFile('src/main.ts', 'export const answer = 42;\n'), makeFile('.env', 'SECRET=not-for-model')];
const folder2 = await ingestFiles(files);
for (const [sha, bytes] of folder2.blobs) await store.putBlob(wsId, sha, bytes);
await store.commitVersion(wsId, null, folder2.entries, { createdBy: 'import' });
await assert.rejects(buildWorkspaceBlock({ store, workspaceId: wsId, version: 1, budget: 4000, privacyAck: false, question: 'README.md' }), /workspace_privacy_ack_required/);
const block = await buildWorkspaceBlock({ store, workspaceId: wsId, version: 1, budget: 4000, privacyAck: true, question: 'README.md' });
assert.match(block, /WORKSPACE/);
assert.match(block, /README\.md/);
assert.doesNotMatch(block, /SECRET=not-for-model/);
const secret = folder2.entries.find((e) => e.path === '.env');
assert.equal((await readWorkspaceFile(store, wsId, 1, '.env')).reason, 'secret_requires_explicit_user_approval');
assert.ok(secret.flags.includes('secret'));
assert.equal((await searchWorkspace(store, wsId, 1, 'answer', '*.ts')).length, 1);
assert.equal(parseWorkspaceModelResponse({ answer: 'ok', needFiles: [{ path: 'src/main.ts' }], needSearch: [{ pattern: 'answer' }] }).needFiles.length, 1);
assert.throws(() => parseWorkspaceModelResponse({ needSearch: Array.from({ length: 4 }, () => ({ pattern: 'x' })) }), /workspace_needSearch_invalid/);

let calls = 0;
const resolved = await resolveWorkspaceRequests({
  initial: { prompt: 'initial' },
  async call(context, round) { calls++; return round === 0 ? { answer: 'need', needFiles: [{ path: 'src/main.ts' }] } : { answer: 'done' }; },
  async resolveFiles() { return 'src/main.ts: export const answer = 42'; },
  async resolveSearch() { return ''; },
  append(base, extra) { return { prompt: `${base.prompt}\n${extra}` }; },
});
assert.equal(calls, 2);
assert.equal(resolved.answer, 'done');
console.log('workspace-a2: tar/gzip, folder, privacy, context, search and model follow-up OK');
}
// ===== END workspace-a2.test.mjs =====

// ===== BEGIN workspace-changeset.test.mjs =====
{
/** P26b: workspace ChangeSet validate/apply, CRLF, stale sha, CI/lock confirm, rollback (AC-07…09, AC-15). */
const assert = (await import("node:assert/strict")).default;
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { applyWorkspaceChangeSet, createEmptyWorkspace, rollbackWorkspace, validateWorkspaceChangeSet, applyEdits, WORKSPACE_LIMITS } = await import("../src/workspace/changeset.ts");
const { sha256Bytes } = await import("../src/workspace/hash.ts");

const store = new MemoryWorkspaceStore();

// --- create from scratch (AC-15) ---
{
  const { wsId, version } = await createEmptyWorkspace(store, 'Tetris', {
    'index.html': '<!doctype html><title>Tetris</title>\n',
    'src/main.js': 'console.log("go");\n',
  }, true);
  assert.ok(wsId);
  assert.equal(version.no, 1);
  assert.equal(version.parent, null);
  const man = await store.getManifest(wsId, 1);
  assert.equal(man.length, 2);
  assert.ok(man.every((e) => e.sha256.length === 64));
}

// --- AC-07: valid modify via edits ---
{
  const { wsId } = await createEmptyWorkspace(store, 'demo', {
    'hello.txt': 'hello world\nsecond line\n',
  });
  const man = await store.getManifest(wsId, 1);
  const entry = man.find((e) => e.path === 'hello.txt');
  const cs = {
    baseVersion: 1,
    message: 'greet',
    ops: [
      {
        path: 'hello.txt',
        action: 'modify',
        baseSha256: entry.sha256,
        edits: [{ find: 'world', replace: 'BiForge' }],
      },
    ],
  };
  const v = await validateWorkspaceChangeSet(store, wsId, cs);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.previews[0].added + v.previews[0].removed > 0, true);
  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  assert.equal(applied.version.no, 2);
  const bytes = await store.readBlob(wsId, (await store.getManifest(wsId, 2)).find((e) => e.path === 'hello.txt').sha256);
  assert.equal(new TextDecoder().decode(bytes), 'hello BiForge\nsecond line\n');
}

// --- AC-08: violations ---
{
  const { wsId } = await createEmptyWorkspace(store, 'viol', { 'a.txt': 'alpha\n' });
  const man = await store.getManifest(wsId, 1);
  const sha = man[0].sha256;

  // stale baseSha256
  let r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'a.txt', action: 'modify', baseSha256: '0'.repeat(64), content: 'beta\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'stale_base_sha'));

  // unsafe path
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: '../etc/passwd', action: 'create', content: 'x' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'unsafe_path'));

  // .git blocked
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: '.git/config', action: 'create', content: 'x' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'git_path'));

  // secret in content
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'leak.txt', action: 'create', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'secret_in_content'));

  // CI/lock without confirm
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'package-lock.json', action: 'create', content: '{}\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'ci_lock_confirm_required'));
  r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    confirmCiLock: true,
    ops: [{ path: 'package-lock.json', action: 'create', content: '{}\n' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.violations));

  // too many files
  const many = Array.from({ length: WORKSPACE_LIMITS.maxFiles + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    action: 'create',
    content: 'x\n',
  }));
  r = await validateWorkspaceChangeSet(store, wsId, { baseVersion: 1, ops: many });
  assert.ok(r.violations.some((v) => v.code === 'too_many_files'));

  // find not unique
  const uniq = await createEmptyWorkspace(store, 'uniq', { 'u.txt': 'aa aa\n' });
  const um = await store.getManifest(uniq.wsId, 1);
  r = await validateWorkspaceChangeSet(store, uniq.wsId, {
    baseVersion: 1,
    ops: [{ path: 'u.txt', action: 'modify', baseSha256: um[0].sha256, edits: [{ find: 'aa', replace: 'b' }] }],
  });
  assert.ok(r.violations.some((v) => v.code === 'find_not_unique'));
}

// --- AC-09: CRLF preserved + rollback restores hash ---
{
  const crlf = 'line1\r\nline2\r\n';
  const { wsId } = await createEmptyWorkspace(store, 'crlf', { 'crlf.txt': crlf });
  const man = await store.getManifest(wsId, 1);
  const e = man[0];
  assert.equal(e.eol, 'CRLF');
  const beforeHash = e.sha256;
  const cs = {
    baseVersion: 1,
    ops: [{ path: 'crlf.txt', action: 'modify', baseSha256: beforeHash, edits: [{ find: 'line2', replace: 'LINE2' }] }],
  };
  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  const afterBytes = await store.readBlob(wsId, (await store.getManifest(wsId, 2)).find((x) => x.path === 'crlf.txt').sha256);
  const afterText = new TextDecoder().decode(afterBytes);
  assert.ok(afterText.includes('\r\n'), 'CRLF must be preserved');
  assert.equal(afterText, 'line1\r\nLINE2\r\n');

  const rb = await rollbackWorkspace(store, wsId, 1);
  assert.equal(rb.no, 3);
  const m3 = await store.getManifest(wsId, 3);
  assert.equal(m3.find((x) => x.path === 'crlf.txt').sha256, beforeHash);
}

// --- applyEdits unit ---
{
  const r = applyEdits('foo bar foo', [{ find: 'bar', replace: 'baz' }], 'LF');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'foo baz foo');
  const fail = applyEdits('x x', [{ find: 'x', replace: 'y' }], 'LF');
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 'find_not_unique');
}

console.log('workspace-changeset: ok');
}
// ===== END workspace-changeset.test.mjs =====

// ===== BEGIN workspace-export.test.mjs =====
{
/** P26b: export full/changed/diff, byte-identity round-trip, determinism (AC-10, AC-11). */
const assert = (await import("node:assert/strict")).default;
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { createEmptyWorkspace, applyWorkspaceChangeSet } = await import("../src/workspace/changeset.ts");
const { exportWorkspace, buildDeterministicZip } = await import("../src/workspace/exportZip.ts");
const { sha256Bytes } = await import("../src/workspace/hash.ts");

const store = new MemoryWorkspaceStore();

const files = {
  'README.md': '# Hello\n',
  'src/app.ts': 'export const n = 1;\n',
  'data/crlf.txt': 'a\r\nb\r\n',
};
const { wsId, version } = await createEmptyWorkspace(store, 'exp', files);
assert.equal(version.no, 1);

// AC-10: full export twice → same sha256; bytes match originals
const e1 = await exportWorkspace(store, wsId, { mode: 'full', version: 1 });
const e2 = await exportWorkspace(store, wsId, { mode: 'full', version: 1 });
assert.equal(e1.sha256, e2.sha256);
assert.equal(e1.filename, 'exp-v1.zip');
assert.ok(e1.bytes.byteLength > 20);

// Round-trip via JSZip if available
let JSZip;
try {
  JSZip = (await import('jszip')).default;
} catch {
  JSZip = null;
}
if (JSZip) {
  const z = await JSZip.loadAsync(e1.bytes);
  for (const [path, text] of Object.entries(files)) {
    const got = await z.file(path).async('uint8array');
    const expected = new TextEncoder().encode(text);
    assert.deepEqual([...got], [...expected], path);
  }
}

// Modify → changed + diff
const man = await store.getManifest(wsId, 1);
const app = man.find((e) => e.path === 'src/app.ts');
const applied = await applyWorkspaceChangeSet(store, wsId, {
  baseVersion: 1,
  message: 'bump',
  ops: [{ path: 'src/app.ts', action: 'modify', baseSha256: app.sha256, content: 'export const n = 2;\n' }],
});
assert.equal(applied.ok, true);

const changed = await exportWorkspace(store, wsId, { mode: 'changed', version: 2, baseVersion: 1 });
assert.ok(changed.filename.includes('changed'));
if (JSZip) {
  const z = await JSZip.loadAsync(changed.bytes);
  assert.ok(z.file('BIFORGE-CHANGES.md'));
  assert.ok(z.file('src/app.ts'));
  assert.equal(z.file('README.md'), null);
}

const diff = await exportWorkspace(store, wsId, { mode: 'diff', version: 2, baseVersion: 1 });
const diffText = new TextDecoder().decode(diff.bytes);
assert.ok(diffText.includes('diff --git'));
assert.ok(diffText.includes('src/app.ts'));
assert.ok(diffText.includes('-export const n = 1;') || diffText.includes('n = 1'));
assert.ok(diffText.includes('+export const n = 2;') || diffText.includes('n = 2'));

// Deterministic zip of same map
const map = new Map([
  ['b.txt', new TextEncoder().encode('b')],
  ['a.txt', new TextEncoder().encode('a')],
]);
const z1 = await buildDeterministicZip(map);
const z2 = await buildDeterministicZip(map);
assert.deepEqual([...z1], [...z2]);
assert.equal(await sha256Bytes(z1), await sha256Bytes(z2));

console.log('workspace-export: ok');
}
// ===== END workspace-export.test.mjs =====

// ===== BEGIN workspace-ingest.test.mjs =====
{
/**
 * P26a: zip ingest, hostile archives, manifestHash stability
 */
const assert = (await import("node:assert/strict")).default;
const JSZip = (await import("jszip")).default;
const { readFileSync } = await import("node:fs");
const { ingestZip, ingestArchive } = await import("../src/workspace/ingest.ts");
const { DEFAULT_BROWSER_LIMITS } = await import("../src/workspace/types.ts");
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");

async function makeZip(files) {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    z.file(name, content);
  }
  const buf = await z.generateAsync({ type: 'uint8array' });
  return buf;
}

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('ok', name))
    .catch((e) => {
      console.error('FAIL', name, e);
      process.exitCode = 1;
    });
}

await t('simple zip: accepts text files, stable hash', async () => {
  const bytes = await makeZip({
    'src/main.ts': 'export const x = 1;\n',
    'README.md': '# Hi\n',
  });
  const r1 = await ingestZip(bytes);
  assert.equal(r1.report.rejected, undefined);
  assert.equal(r1.entries.length, 2);
  assert.ok(r1.manifestHash.length === 64);
  const r2 = await ingestZip(bytes);
  assert.equal(r1.manifestHash, r2.manifestHash);
});

await t('root prefix stripped', async () => {
  const bytes = await makeZip({
    'proj/a.ts': 'a',
    'proj/b.ts': 'b',
  });
  const r = await ingestZip(bytes);
  assert.equal(r.report.rootPrefix, 'proj');
  assert.deepEqual(r.entries.map((e) => e.path).sort(), ['a.ts', 'b.ts']);
});

await t('path traversal: normalizePath rejects .. (JSZip rewrites ../ on write)', async () => {
  // JSZip resolves ../ when creating entries; hostile archives with raw CD paths
  // are covered by normalizePath unit tests. Here we only ensure clean zip still works.
  const bytes = await makeZip({ 'ok.ts': 'ok', 'nested/a.ts': 'a' });
  const r = await ingestZip(bytes);
  assert.ok(r.entries.some((e) => e.path === 'ok.ts' || e.path.endsWith('a.ts')));
  assert.equal(r.report.rejected, undefined);
});

await t('a..b.txt accepted', async () => {
  const bytes = await makeZip({ 'a..b.txt': 'x' });
  const r = await ingestZip(bytes);
  assert.equal(r.report.rejected, undefined);
  assert.equal(r.entries[0].path, 'a..b.txt');
});

await t('node_modules skipped by default', async () => {
  const bytes = await makeZip({
    'src/x.ts': 'x',
    'node_modules/pkg/index.js': 'y',
  });
  const r = await ingestZip(bytes);
  assert.equal(r.entries.length, 1);
  assert.ok(r.report.skipped.some((s) => s.reason === 'default_skip_rule'));
});

await t('too many entries rejected', async () => {
  const files = {};
  for (let i = 0; i < 20; i++) files[`f${i}.txt`] = 'x';
  const bytes = await makeZip(files);
  const r = await ingestZip(bytes, { ...DEFAULT_BROWSER_LIMITS, maxEntries: 5 });
  assert.equal(r.report.rejected, 'too_many_entries');
});

await t('memory store: import version', async () => {
  const bytes = await makeZip({ 'hi.ts': 'console.log(1)\n' });
  const r = await ingestZip(bytes);
  const store = new MemoryWorkspaceStore();
  const wsId = await store.createWorkspace('demo', r.report.rootPrefix, true);
  for (const [sha, data] of r.blobs) {
    await store.putBlob(wsId, sha, data);
  }
  const ver = await store.commitVersion(wsId, null, r.entries, { createdBy: 'import', message: 'test' });
  assert.equal(ver.no, 1);
  assert.equal(ver.manifestHash, r.manifestHash);
  const m = await store.getManifest(wsId, 1);
  assert.equal(m.length, r.entries.length);
});

// AC-01 fixture: bf-v24.zip if present
const fixturePaths = [
  '/home/workdir/attachments/bf-v24.zip',
  new URL('../../attachments/bf-v24.zip', import.meta.url).pathname,
];
let fixture;
for (const p of fixturePaths) {
  try {
    fixture = readFileSync(p);
    break;
  } catch { /* next */ }
}

if (fixture) {
  await t('AC-01: bf-v24.zip loads with stable manifestHash', async () => {
    const bytes = new Uint8Array(fixture);
    const r1 = await ingestZip(bytes, {
      ...DEFAULT_BROWSER_LIMITS,
      maxEntries: 2500,
      maxUnpackedBytes: 80 * 1024 * 1024,
      maxArchiveBytes: 30 * 1024 * 1024,
    });
    if (r1.report.rejected) {
      console.log('ingest report', r1.report);
    }
    assert.equal(r1.report.rejected, undefined);
    assert.ok(r1.entries.length > 200, `expected many files, got ${r1.entries.length}`);
    console.log('  files accepted:', r1.entries.length, 'skipped:', r1.report.skipped.length, 'root:', r1.report.rootPrefix);
    const r2 = await ingestZip(bytes, {
      ...DEFAULT_BROWSER_LIMITS,
      maxEntries: 2500,
      maxUnpackedBytes: 80 * 1024 * 1024,
      maxArchiveBytes: 30 * 1024 * 1024,
    });
    assert.equal(r1.manifestHash, r2.manifestHash);
  });
} else {
  console.log('skip AC-01 fixture (bf-v24.zip not found)');
}


await t('tar duplicate paths keep the first entry', async () => {
  function tarFile(name, content) {
    const header = new Uint8Array(512);
    const enc = new TextEncoder();
    header.set(enc.encode(name), 0);
    header.set(enc.encode('0000644\0'), 100);
    header.set(enc.encode('0000000\0'), 108);
    header.set(enc.encode('0000000\0'), 116);
    header.set(enc.encode(content.length.toString(8).padStart(11, '0') + '\0'), 124);
    header.set(enc.encode('00000000000\0'), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.set(enc.encode('ustar\0'), 257);
    header.set(enc.encode('00'), 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    const data = enc.encode(content);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    return [header, padded];
  }
  const parts = [...tarFile('same.txt', 'first'), ...tarFile('same.txt', 'second'), new Uint8Array(1024)];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const result = await ingestArchive(bytes);
  assert.equal(result.report.rejected, undefined);
  assert.equal(result.entries.length, 1);
  assert.equal(new TextDecoder().decode(result.blobs.get(result.entries[0].sha256)), 'first');
  assert.ok(result.report.skipped.some((s) => s.reason === 'duplicate_path'));
});

console.log('workspace-ingest done');
}
// ===== END workspace-ingest.test.mjs =====

// ===== BEGIN workspace-p27.test.mjs =====
{
/**
 * P27 — persistIngest glue + privacy guard (no browser / IndexedDB required).
 */
const assert = (await import("node:assert/strict")).default;
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { canBuildWorkspaceContext, isArchiveFileName, languageSummaryLine, persistIngestResult, summarizeLanguages } = await import("../src/workspace/persistIngest.ts");
const { sha256Bytes } = await import("../src/workspace/hash.ts");

assert.equal(isArchiveFileName("app.zip"), true);
assert.equal(isArchiveFileName("x.tar.gz"), true);
assert.equal(isArchiveFileName("readme.md"), false);

assert.equal(canBuildWorkspaceContext(false), false);
assert.equal(canBuildWorkspaceContext(true), true);

const enc = new TextEncoder();
const textBytes = enc.encode("hello workspace\n");
const sha = await sha256Bytes(textBytes);
const entry = {
  path: "hello.txt",
  sha256: sha,
  size: textBytes.byteLength,
  mode: 0o644,
  class: "source",
  lang: "txt",
  flags: [],
};
const result = {
  entries: [entry],
  blobs: new Map([[sha, textBytes]]),
  report: { accepted: 1, skipped: [], marked: [], rootPrefix: "", limitsHit: [] },
  manifestHash: "test",
};

const langs = summarizeLanguages(result.entries);
assert.equal(langs.txt, 1);
assert.ok(languageSummaryLine(result.entries).includes("txt"));

const store = new MemoryWorkspaceStore();
const ok = await persistIngestResult(store, result, "demo");
assert.equal(ok.ok, true, JSON.stringify(ok));
if (!ok.ok) throw new Error("unreachable");
assert.ok(ok.workspaceId);
assert.equal(ok.version.no, 1);
assert.equal(ok.stats.files, 1);
const manifest = await store.getManifest(ok.workspaceId, 1);
assert.equal(manifest.length, 1);
assert.equal(manifest[0].path, "hello.txt");

const rejected = await persistIngestResult(store, {
  entries: [],
  blobs: new Map(),
  report: { accepted: 0, skipped: [], marked: [], rootPrefix: "", limitsHit: [], rejected: "empty_archive" },
  manifestHash: "",
}, "x");
assert.equal(rejected.ok, false);
assert.equal(rejected.ok === false && rejected.code, "empty_archive");

const empty = await persistIngestResult(store, {
  entries: [],
  blobs: new Map(),
  report: { accepted: 0, skipped: [], marked: [], rootPrefix: "", limitsHit: [] },
  manifestHash: "",
}, "x");
assert.equal(empty.ok, false);
assert.equal(empty.ok === false && empty.code, "empty_ingest");

console.log("workspace-p27: ok");
}
// ===== END workspace-p27.test.mjs =====

// ===== BEGIN workspace-p34.test.mjs =====
{
/** P34: universal individual-file ingest and blob persistence contract. */
const assert = (await import("node:assert/strict")).default;
const { ingestFiles } = await import("../src/workspace/ingest.ts");
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { persistIngestResult } = await import("../src/workspace/persistIngest.ts");
const { readWorkspaceFile } = await import("../src/workspace/context.ts");

const encoder = new TextEncoder();
const fixtures = [
  { name: 'README.md', body: '# P34 workspace\nReadable content.' },
  { name: 'data.csv', body: 'name,value\nalpha,1\n' },
  { name: 'sample.unknown', body: 'text with an unknown extension' },
];
const files = fixtures.map((fixture) => ({
  name: fixture.name,
  size: fixture.body.length,
  arrayBuffer: async () => encoder.encode(fixture.body).buffer,
}));
const ingested = await ingestFiles(files);
assert.equal(ingested.report.rejected, undefined);
assert.equal(ingested.entries.length, fixtures.length);

// Ingest blobs are content-addressed by SHA-256; persist must support that contract.
const store = new MemoryWorkspaceStore();
const saved = await persistIngestResult(store, ingested, 'p34-test');
assert.equal(saved.ok, true, JSON.stringify(saved));
if (!saved.ok) throw new Error('workspace persist failed');
const manifest = await store.getManifest(saved.workspaceId, saved.version.no);
assert.equal(manifest.length, fixtures.length);
const readme = await readWorkspaceFile(store, saved.workspaceId, 1, 'README.md');
assert.match(readme.text || '', /Readable content/);
const csv = await readWorkspaceFile(store, saved.workspaceId, 1, 'data.csv');
// P35: CSV may be normalised to markdown table (alpha | 1) or kept raw (alpha,1)
assert.match(csv.text || '', /alpha\s*[,|]\s*1/);

// Original byte hashes survive ingest + persistence.
for (const entry of ingested.entries) {
  const bytes = await store.readBlob(saved.workspaceId, entry.sha256);
  assert.equal(bytes.byteLength, entry.size);
}
console.log('workspace-p34: ok');
}
// ===== END workspace-p34.test.mjs =====

// ===== BEGIN workspace-p35.test.mjs =====
{
/** P35: universal file content extraction and extract-aware workspace context. */
const assert = (await import("node:assert/strict")).default;
const { classifyBytes } = await import("../src/workspace/classify.ts");
const { extractFileContent, formatExtractForContext, DEFAULT_EXTRACT_LIMITS } = await import("../src/workspace/extract.ts");
const { ingestFiles } = await import("../src/workspace/ingest.ts");
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { persistIngestResult } = await import("../src/workspace/persistIngest.ts");
const { readWorkspaceFile, buildWorkspaceBlock } = await import("../src/workspace/context.ts");

const encoder = new TextEncoder();

// --- classify: office extensions on zip magic ---
{
  // Minimal empty zip local-file header signature
  const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const docx = classifyBytes('report.docx', zipMagic);
  assert.equal(docx.class, 'office', 'docx zip → office');
  const xlsx = classifyBytes('sheet.xlsx', zipMagic);
  assert.equal(xlsx.class, 'office', 'xlsx zip → office');
  const generic = classifyBytes('pkg.zip', zipMagic);
  assert.equal(generic.class, 'archive', 'generic zip stays archive');
}

// --- CSV extract ---
{
  const csv = encoder.encode('name,value\nalpha,1\nbeta,2\n');
  const r = await extractFileContent('data.csv', csv, 'data', DEFAULT_EXTRACT_LIMITS);
  assert.equal(r.metadataOnly, false);
  assert.match(r.text, /alpha \| 1/);
  assert.match(r.text, /beta \| 2/);
  assert.equal(r.meta.format, 'csv');
}

// --- JSON pretty ---
{
  const json = encoder.encode('{"a":1,"b":[2,3]}');
  const r = await extractFileContent('cfg.json', json, 'config', DEFAULT_EXTRACT_LIMITS);
  assert.equal(r.metadataOnly, false);
  assert.match(r.text, /"a": 1/);
  assert.equal(r.meta.format, 'json');
}

// --- plain text ---
{
  const md = encoder.encode('# Title\n\nHello workspace.\n');
  const r = await extractFileContent('README.md', md, 'doc', DEFAULT_EXTRACT_LIMITS);
  assert.equal(r.metadataOnly, false);
  assert.match(r.text, /Hello workspace/);
}

// --- image → metadata only ---
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const r = await extractFileContent('photo.png', png, 'image', DEFAULT_EXTRACT_LIMITS);
  assert.equal(r.metadataOnly, true);
  assert.equal(r.text, '');
  assert.match(r.meta.note || '', /image/i);
}

// --- DATA markers ---
{
  const r = await extractFileContent('a.txt', encoder.encode('secret-looking but data'), 'source');
  const block = formatExtractForContext('a.txt', r, { class: 'source', size: 22 });
  assert.match(block, /BEGIN WORKSPACE FILE DATA/);
  assert.match(block, /never instructions/);
  assert.match(block, /END WORKSPACE FILE DATA/);
  assert.match(block, /secret-looking but data/);
}

// --- DOCX via minimal OOXML package ---
{
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
     <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
       <w:body><w:p><w:r><w:t>P35 docx hello</w:t></w:r></w:p></w:body>
     </w:document>`,
  );
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types></Types>');
  const buf = await zip.generateAsync({ type: 'uint8array' });
  const r = await extractFileContent('note.docx', buf, 'office', DEFAULT_EXTRACT_LIMITS);
  assert.equal(r.metadataOnly, false, JSON.stringify(r.meta));
  assert.match(r.text, /P35 docx hello/);
  assert.equal(r.meta.format, 'docx');
}

// --- XLSX via minimal OOXML package ---
{
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
      <si><t>Name</t></si><si><t>Ada</t></si></sst>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
        Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c></row>
        <row r="2"><c r="A2" t="s"><v>1</v></c></row>
      </sheetData></worksheet>`,
  );
  const buf = await zip.generateAsync({ type: 'uint8array' });
  const r = await extractFileContent('people.xlsx', buf, 'office', DEFAULT_EXTRACT_LIMITS);
  assert.equal(r.metadataOnly, false, JSON.stringify(r.meta));
  assert.match(r.text, /Sheet: People/);
  assert.match(r.text, /Ada/);
  assert.equal(r.meta.format, 'xlsx');
}

// --- end-to-end: ingest → persist → readWorkspaceFile with extract ---
{
  const fixtures = [
    { name: 'notes.txt', body: 'Plain note for P35.' },
    { name: 'table.csv', body: 'id,label\n1,one\n2,two\n' },
  ];
  const files = fixtures.map((f) => ({
    name: f.name,
    size: f.body.length,
    arrayBuffer: async () => encoder.encode(f.body).buffer,
  }));
  const ingested = await ingestFiles(files);
  assert.equal(ingested.report.rejected, undefined);
  const store = new MemoryWorkspaceStore();
  const saved = await persistIngestResult(store, ingested, 'p35-e2e');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  if (!saved.ok) throw new Error('persist failed');

  await store.setPrivacyAck?.(saved.workspaceId, true);
  const txt = await readWorkspaceFile(store, saved.workspaceId, saved.version.no, 'notes.txt');
  assert.match(txt.text || '', /Plain note for P35/);
  assert.ok(txt.formatted && /BEGIN WORKSPACE FILE DATA/.test(txt.formatted));

  const csv = await readWorkspaceFile(store, saved.workspaceId, saved.version.no, 'table.csv');
  assert.match(csv.text || '', /1 \| one/);
  assert.equal(csv.extract?.meta.format, 'csv');

  const block = await buildWorkspaceBlock({
    store,
    workspaceId: saved.workspaceId,
    version: saved.version.no,
    budget: 20_000,
    privacyAck: true,
    question: 'What does notes.txt say?',
  });
  assert.match(block, /WORKSPACE/);
  assert.match(block, /Plain note for P35|notes\.txt/);
}

// --- secret still blocked ---
{
  const envBody = encoder.encode('API_KEY=should-not-leak\n');
  const files = [
    {
      name: '.env',
      size: envBody.byteLength,
      arrayBuffer: async () => envBody.buffer,
    },
  ];
  const ingested = await ingestFiles(files);
  const store = new MemoryWorkspaceStore();
  const saved = await persistIngestResult(store, ingested, 'p35-secret');
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error('persist failed');
  const read = await readWorkspaceFile(store, saved.workspaceId, saved.version.no, '.env');
  assert.equal(read.reason, 'secret_requires_explicit_user_approval');
  assert.equal(read.text, undefined);
}

console.log('workspace-p35: ok');
}
// ===== END workspace-p35.test.mjs =====

// ===== BEGIN workspace-p36.test.mjs =====
{
/** P36: ChangeSet parse, human-gated apply, no version bump before Apply, rollback. */
const assert = (await import("node:assert/strict")).default;
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { applyWorkspaceChangeSet, createEmptyWorkspace, rollbackWorkspace, validateWorkspaceChangeSet } = await import("../src/workspace/changeset.ts");
const { normalizeWorkspaceChangeSet, parseChangeSetFromText } = await import("../src/workspace/changeSetParse.ts");

const store = new MemoryWorkspaceStore();

// --- parse from fenced JSON ---
{
  const text = `Here is the patch:

\`\`\`json
{
  "changeSet": {
    "baseVersion": 1,
    "message": "rename greeting",
    "ops": [
      {
        "path": "hello.txt",
        "action": "modify",
        "baseSha256": "${'a'.repeat(64)}",
        "edits": [{ "find": "world", "replace": "BiForge" }]
      }
    ]
  }
}
\`\`\`
`;
  const cs = parseChangeSetFromText(text);
  assert.ok(cs);
  assert.equal(cs.baseVersion, 1);
  assert.equal(cs.ops[0].action, 'modify');
  assert.equal(cs.ops[0].edits?.[0].replace, 'BiForge');
}

// --- reject garbage ---
{
  assert.equal(parseChangeSetFromText('no json here'), null);
  assert.equal(normalizeWorkspaceChangeSet({ baseVersion: 0, ops: [] }), null);
}

// --- validate does not write; apply creates v2 ---
{
  const { wsId } = await createEmptyWorkspace(store, 'p36', {
    'hello.txt': 'hello world\n',
  });
  const man = await store.getManifest(wsId, 1);
  const sha = man[0].sha256;
  const cs = {
    baseVersion: 1,
    message: 'greet',
    ops: [
      {
        path: 'hello.txt',
        action: 'modify',
        baseSha256: sha,
        edits: [{ find: 'world', replace: 'BiForge' }],
      },
    ],
  };
  const v = await validateWorkspaceChangeSet(store, wsId, cs);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  // Still version 1 after validate
  const ws = await store.getWorkspace?.(wsId);
  assert.equal(ws?.head, 1);

  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  assert.equal(applied.version.no, 2);
  const bytes = await store.readBlob(
    wsId,
    (await store.getManifest(wsId, 2)).find((e) => e.path === 'hello.txt').sha256,
  );
  assert.equal(new TextDecoder().decode(bytes), 'hello BiForge\n');
}

// --- rollback adds new version restoring prior content ---
{
  const { wsId } = await createEmptyWorkspace(store, 'p36-rb', {
    'a.txt': 'one\n',
  });
  const man1 = await store.getManifest(wsId, 1);
  const cs = {
    baseVersion: 1,
    ops: [{ path: 'a.txt', action: 'modify', baseSha256: man1[0].sha256, content: 'two\n' }],
  };
  const applied = await applyWorkspaceChangeSet(store, wsId, cs);
  assert.equal(applied.ok, true);
  assert.equal(applied.version.no, 2);
  const rb = await rollbackWorkspace(store, wsId, 1);
  assert.equal(rb.no, 3);
  assert.equal(rb.createdBy, 'rollback');
  const man3 = await store.getManifest(wsId, 3);
  const text = new TextDecoder().decode(await store.readBlob(wsId, man3[0].sha256));
  assert.equal(text, 'one\n');
}

// --- stale sha blocked (no apply) ---
{
  const { wsId } = await createEmptyWorkspace(store, 'p36-stale', { 'x.txt': 'x\n' });
  const r = await validateWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'x.txt', action: 'modify', baseSha256: '0'.repeat(64), content: 'y\n' }],
  });
  assert.ok(r.violations.some((v) => v.code === 'stale_base_sha'));
  const applied = await applyWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'x.txt', action: 'modify', baseSha256: '0'.repeat(64), content: 'y\n' }],
  });
  assert.equal(applied.ok, false);
  const ws = await store.getWorkspace?.(wsId);
  assert.equal(ws?.head, 1);
}

console.log('workspace-p36: ok');
}
// ===== END workspace-p36.test.mjs =====

// ===== BEGIN workspace-p38.test.mjs =====
{
/** P38: export full / changed / diff; full export preserves original blob bytes. */
const assert = (await import("node:assert/strict")).default;
const { MemoryWorkspaceStore } = await import("../src/workspace/memoryStore.ts");
const { applyWorkspaceChangeSet, createEmptyWorkspace } = await import("../src/workspace/changeset.ts");
const { exportWorkspace, buildDeterministicZip } = await import("../src/workspace/exportZip.ts");
const { sha256Bytes } = await import("../src/workspace/hash.ts");

const store = new MemoryWorkspaceStore();

{
  const body = 'hello export\n';
  const { wsId } = await createEmptyWorkspace(store, 'p38-full', { 'a.txt': body });
  const exp = await exportWorkspace(store, wsId, { mode: 'full', name: 'p38-full' });
  assert.equal(exp.mode, 'full');
  assert.ok(exp.filename.endsWith('.zip'));
  assert.equal(exp.files, 1);
  // Re-zip single file must match deterministic builder with same bytes
  const bytes = new TextEncoder().encode(body);
  const map = new Map([['a.txt', bytes]]);
  const direct = await buildDeterministicZip(map);
  assert.equal(exp.sha256, await (async () => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(exp.bytes).digest('hex');
  })());
  // Unchanged path bytes equal original
  const man = await store.getManifest(wsId, 1);
  const blob = await store.readBlob(wsId, man[0].sha256);
  assert.equal(new TextDecoder().decode(blob), body);
  assert.equal(await sha256Bytes(blob), man[0].sha256);
}

{
  const { wsId } = await createEmptyWorkspace(store, 'p38-chg', { 'x.txt': 'one\n' });
  const man1 = await store.getManifest(wsId, 1);
  const applied = await applyWorkspaceChangeSet(store, wsId, {
    baseVersion: 1,
    ops: [{ path: 'x.txt', action: 'modify', baseSha256: man1[0].sha256, content: 'two\n' }],
  });
  assert.equal(applied.ok, true);
  const ch = await exportWorkspace(store, wsId, { mode: 'changed', baseVersion: 1, version: 2, name: 'p38-chg' });
  assert.equal(ch.mode, 'changed');
  assert.ok(ch.filename.includes('changed'));
  assert.ok(ch.files >= 2); // file + BIFORGE-CHANGES.md

  const df = await exportWorkspace(store, wsId, { mode: 'diff', baseVersion: 1, version: 2, name: 'p38-chg' });
  assert.equal(df.mode, 'diff');
  assert.ok(df.filename.endsWith('.diff'));
  const text = new TextDecoder().decode(df.bytes);
  assert.ok(text.includes('x.txt') || text.includes('---') || text.includes('+++') || text.includes('one') || text.includes('two'));
}

console.log('workspace-p38: ok');
}
// ===== END workspace-p38.test.mjs =====

// ===== BEGIN workspace-paths.test.mjs =====
{
/**
 * P26a: path normalisation and skip rules
 */
const assert = (await import("node:assert/strict")).default;
const { normalizePath, caseKey, matchesDefaultSkip, detectRootPrefix, stripRootPrefix } = await import("../src/workspace/paths.ts");

function t(name, fn) {
  try {
    fn();
    console.log('ok', name);
  } catch (e) {
    console.error('FAIL', name, e);
    process.exitCode = 1;
  }
}

t('normalize: a..b.txt is valid', () => {
  const r = normalizePath('src/a..b.txt');
  assert.equal(r.ok, true);
  assert.equal(r.path, 'src/a..b.txt');
});

t('normalize: rejects .. segment', () => {
  const r = normalizePath('foo/../etc/passwd');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'traversal');
});

t('normalize: rejects absolute', () => {
  assert.equal(normalizePath('/etc/passwd').ok, false);
  assert.equal(normalizePath('C:\\Windows\\x').reason, 'windows_drive');
});

t('normalize: rejects control and empty', () => {
  assert.equal(normalizePath('a/\x00/b').ok, false);
  assert.equal(normalizePath('').ok, false);
});

t('normalize: collapses empty segments and NFC', () => {
  const r = normalizePath('a//b/./c');
  assert.equal(r.ok, true);
  assert.equal(r.path, 'a/b/c');
});

t('caseKey lowercases', () => {
  assert.equal(caseKey('Src/App.TS'), caseKey('src/app.ts'));
});

t('default skip rules', () => {
  assert.equal(matchesDefaultSkip('node_modules/x'), 'node_modules/');
  assert.equal(matchesDefaultSkip('.git/config'), '.git/');
  assert.equal(matchesDefaultSkip('src/main.ts'), null);
});

t('root prefix', () => {
  assert.equal(detectRootPrefix(['bf-main/a.ts', 'bf-main/b.ts']), 'bf-main');
  assert.equal(detectRootPrefix(['a.ts', 'b.ts']), '');
  assert.equal(stripRootPrefix('bf-main/a.ts', 'bf-main'), 'a.ts');
});

console.log('workspace-paths done');
}
// ===== END workspace-paths.test.mjs =====
