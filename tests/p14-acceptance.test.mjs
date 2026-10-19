// P14 acceptance (no database): artifact rules, boundaries, type by content, safe listing, manifest checksum. Describes ARCHIVE/P14-SPEC.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_ARTIFACT_BYTES, MAX_VERSIONS_PER_ARTIFACT, MAX_ARTIFACTS_PER_PROJECT, MAX_DIFF_LINES, PREVIEW_CHARS, ArtifactFormatError,
  checkFilename, sniffType, securityStatusOf, previewOf, lineDiff, listZipEntries, manifestHashOf, storageRefOf, sha256Hex,
} from '../server/artifactFormat.ts';
import { artifactInputSchema, saveArtifact } from '../server/artifactRepository.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bytes = (...v) => new Uint8Array(v);
const fmt = (fn, code) => assert.throws(fn, (e) => e instanceof ArtifactFormatError && e.code === code, code);

test('limits are the TZ values', () => {
  assert.deepEqual([MAX_ARTIFACT_BYTES, MAX_VERSIONS_PER_ARTIFACT, MAX_ARTIFACTS_PER_PROJECT], [5 * 1024 * 1024, 200, 1000]);
});

test('file name boundaries: 255 characters pass, 256, empty, dots, separators and control characters fail', () => {
  assert.equal(checkFilename('a'.repeat(255)).length, 255);
  assert.equal(checkFilename('  report.md  '), 'report.md');
  assert.equal(checkFilename('..a'), '..a');
  assert.equal(checkFilename('отчёт №1.md'), 'отчёт №1.md');
  for (const bad of ['a'.repeat(256), '', '   ', '.', '..', 'a/b', 'a\\b', '../x', 'a\0b', 'a\nb', 'a\x7fb']) fmt(() => checkFilename(bad), 'FILENAME');
});

test('input schema: exactly one of text and data; unknown keys refused; empty content is allowed', () => {
  const base = { projectId: 'p1', filename: 'a.bin', createdBy: 'human' };
  assert.equal(artifactInputSchema.safeParse({ ...base, text: '' }).success, true);
  assert.equal(artifactInputSchema.safeParse({ ...base, data: bytes(1) }).success, true);
  assert.equal(artifactInputSchema.safeParse({ ...base }).success, false);
  assert.equal(artifactInputSchema.safeParse({ ...base, text: 'x', data: bytes(1) }).success, false);
  assert.equal(artifactInputSchema.safeParse({ ...base, text: 'x', storageRef: 'pg:1' }).success, false);
});

test('size limit: one byte over 5 MB is refused before any database access', async () => {
  await assert.rejects(() => saveArtifact({ projectId: 'p1', filename: 'big.bin', createdBy: 'human', data: new Uint8Array(MAX_ARTIFACT_BYTES + 1) }),
    (e) => e instanceof ArtifactFormatError && e.code === 'TOO_LARGE');
  await assert.rejects(() => saveArtifact({ projectId: 'p1', filename: '../x', createdBy: 'human', text: 'x' }));
});

test('type is taken from content, not from the declared mime (TZ 10.4)', () => {
  assert.deepEqual(sniffType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31), 'text/plain'), { mime: 'application/pdf', kind: 'binary' });
  assert.deepEqual(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'text/markdown'), { mime: 'image/png', kind: 'binary' });
  assert.equal(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0)).mime, 'image/jpeg');
  assert.equal(sniffType(bytes(0x50, 0x4b, 0x03, 0x04, 0)).kind, 'archive');
  for (const exe of [bytes(0x4d, 0x5a, 0x90), bytes(0x7f, 0x45, 0x4c, 0x46), bytes(0xca, 0xfe, 0xba, 0xbe), new TextEncoder().encode('#!/bin/sh\nrm -rf /')]) {
    assert.equal(sniffType(exe, 'text/plain').kind, 'executable');
  }
  assert.equal(securityStatusOf('executable'), 'flagged_executable');
  assert.equal(securityStatusOf('binary'), 'inspected');
  // a declared PDF that is plain text is text; unknown bytes are a plain binary artifact
  assert.deepEqual(sniffType(new TextEncoder().encode('hello'), 'application/pdf'), { mime: 'text/plain', kind: 'text' });
  assert.deepEqual(sniffType(new TextEncoder().encode('{"a":1}'), 'application/json'), { mime: 'application/json', kind: 'text' });
  assert.deepEqual(sniffType(new TextEncoder().encode('# t'), 'text/markdown'), { mime: 'text/markdown', kind: 'text' });
  assert.deepEqual(sniffType(bytes(0xff, 0xfe, 0xfd)), { mime: 'application/octet-stream', kind: 'binary' });
  assert.deepEqual(sniffType(bytes(0x68, 0x00, 0x69)), { mime: 'application/octet-stream', kind: 'binary' });
  assert.deepEqual(sniffType(bytes()), { mime: 'text/plain', kind: 'text' });
});

test('preview exists only for text and is capped', () => {
  assert.equal(previewOf(new TextEncoder().encode('x'.repeat(PREVIEW_CHARS + 50)), 'text').length, PREVIEW_CHARS);
  for (const kind of ['binary', 'archive', 'executable']) assert.equal(previewOf(bytes(65, 66), kind), null);
});

test('line diff: same, added, removed, empty sides, and the line cap', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb').map((d) => d.op), [' ', ' ']);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), [{ op: ' ', line: 'a' }, { op: '-', line: 'b' }, { op: ' ', line: 'c' }, { op: '+', line: 'd' }]);
  assert.deepEqual(lineDiff('', 'x'), [{ op: '+', line: 'x' }]);
  assert.deepEqual(lineDiff('x', ''), [{ op: '-', line: 'x' }]);
  assert.deepEqual(lineDiff('', ''), []);
  const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
  assert.equal(lineDiff(lines(MAX_DIFF_LINES), lines(MAX_DIFF_LINES)).length, MAX_DIFF_LINES);
  fmt(() => lineDiff(lines(MAX_DIFF_LINES + 1), 'x'), 'TOO_MANY_LINES');
});

function zip(names) {
  const enc = new TextEncoder(); const parts = []; const offsets = []; let pos = 0;
  const push = (u8) => { parts.push(u8); pos += u8.length; };
  for (const n of names) { offsets.push(pos); const h = new Uint8Array(30 + enc.encode(n).length); new DataView(h.buffer).setUint32(0, 0x04034b50, true); h.set(enc.encode(n), 30); push(h); }
  const cdStart = pos;
  names.forEach((n, i) => { const nb = enc.encode(n); const c = new Uint8Array(46 + nb.length); const dv = new DataView(c.buffer); dv.setUint32(0, 0x02014b50, true); dv.setUint16(28, nb.length, true); dv.setUint32(42, offsets[i], true); c.set(nb, 46); push(c); });
  const e = new Uint8Array(22); const dv = new DataView(e.buffer); dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, names.length, true); dv.setUint16(10, names.length, true); dv.setUint32(12, pos - cdStart, true); dv.setUint32(16, cdStart, true); push(e);
  const out = new Uint8Array(pos); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

test('archive: names are listed, never extracted; escaping names are marked unsafe; non-ZIP and broken data give no list', () => {
  const r = listZipEntries(zip(['a.txt', 'dir/b.md', '../evil.sh', '/abs', 'C:\\x', 'ok/..bak']));
  assert.deepEqual(r.entries.map((e) => [e.name, e.unsafe]), [['a.txt', false], ['dir/b.md', false], ['../evil.sh', true], ['/abs', true], ['C:\\x', true], ['ok/..bak', false]]);
  assert.equal(r.truncated, false);
  assert.equal(listZipEntries(new TextEncoder().encode('plain')), null);
  assert.deepEqual(listZipEntries(bytes(0x50, 0x4b, 0x03, 0x04, 1, 2, 3)), { entries: [], truncated: false });
});

test('manifest checksum changes with every field; storage reference is a pg reference', () => {
  const m = { artifactId: 'a', version: 1, projectId: 'p', hash: sha256Hex('x'), size: 1, storageRef: storageRefOf('r1') };
  const base = manifestHashOf(m);
  assert.equal(base, manifestHashOf({ ...m }));
  for (const change of [{ artifactId: 'b' }, { version: 2 }, { projectId: 'q' }, { hash: sha256Hex('y') }, { size: 2 }, { storageRef: 'pg:r2' }]) assert.notEqual(manifestHashOf({ ...m, ...change }), base);
  assert.equal(m.storageRef, 'pg:r1');
});

test('migration 008: adds a manifest table only, backfills older versions idempotently, same formula as the code', () => {
  const sql = fs.readFileSync(path.join(root, 'migrations/008_artifact_manifests.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS artifact_manifests/);
  assert.match(sql, /ON CONFLICT \(artifact_id, version\) DO NOTHING/);
  assert.match(sql, /a\.artifact_id \|\| '\|' \|\| a\.version \|\| '\|' \|\| a\.project_id \|\| '\|' \|\| a\.hash \|\| '\|' \|\| a\.size \|\| '\|pg:' \|\| a\.id/);
  assert.doesNotMatch(sql, /DROP |ALTER TABLE artifacts|(?<!ON )DELETE |TRUNCATE/i);
  const names = fs.readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(names.map((n) => n.slice(0, 3)), names.map((_, i) => String(i + 1).padStart(3, '0')));
});
