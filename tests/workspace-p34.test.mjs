/** P34: universal individual-file ingest and blob persistence contract. */
import assert from 'node:assert/strict';
import { ingestFiles } from '../src/workspace/ingest.ts';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';
import { persistIngestResult } from '../src/workspace/persistIngest.ts';
import { readWorkspaceFile } from '../src/workspace/context.ts';

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
