/** P26a.2: tar/gzip, folder ingest, IndexedDB contract availability and WORKSPACE protocol. */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { ingestArchive, ingestFiles } from '../src/workspace/ingest.ts';
import { DEFAULT_BROWSER_LIMITS } from '../src/workspace/types.ts';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';
import { buildWorkspaceBlock, parseWorkspaceModelResponse, readWorkspaceFile, resolveWorkspaceRequests, searchWorkspace } from '../src/workspace/context.ts';
import { IndexedDbWorkspaceStore } from '../src/workspace/idbStore.ts';

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
