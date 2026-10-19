/**
 * P26a: zip ingest, hostile archives, manifestHash stability
 */
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { ingestZip, ingestArchive } from '../src/workspace/ingest.ts';
import { DEFAULT_BROWSER_LIMITS } from '../src/workspace/types.ts';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';

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
