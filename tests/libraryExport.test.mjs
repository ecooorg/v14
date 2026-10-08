// B2-B4: whole-library export and import merge. No server, no network. Run: npm run test:library
import assert from 'node:assert/strict';
import { emptyDecision } from '../src/types/decision.ts';
import { documentToMarkdown, libraryToDocument, planImport, importReport } from '../src/utils/libraryExport.ts';
import { exportAllJson, parseImportedBackup } from '../src/utils/exportZip.ts';
import { sanitizeDocument } from '../server/documents.ts';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const mk = (title, updatedAt, conv = []) => {
  const d = emptyDecision();
  d.title = title; d.updatedAt = updatedAt; d.createdAt = 1700000000000;
  d.modelSuggestions = { ...d.modelSuggestions, conversation: conv };
  return d;
};
const a = mk('Alpha', 100, [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there' }]);
const b = mk('Beta', 200, [{ role: 'user', content: 'Second' }]);

await t('library document has every dialogue as a chapter', () => {
  const doc = libraryToDocument([a, b]);
  const heads = doc.blocks.filter((x) => x.type === 'heading').map((x) => x.text);
  assert.ok(heads.some((h) => h.startsWith('1. Alpha')));
  assert.ok(heads.some((h) => h.startsWith('2. Beta')));
  const md = documentToMarkdown(doc);
  assert.ok(md.includes('Hi there') && md.includes('Second'));
});
await t('markdown: tables and lists', () => {
  const md = documentToMarkdown({ title: 'T', blocks: [{ type: 'bullets', items: ['x'] }, { type: 'table', headers: ['h|1', 'h2'], rows: [['a', 'b']] }] });
  assert.ok(md.startsWith('# T') && md.includes('- x') && md.includes('h\\|1') && md.includes('| --- | --- |'));
});
await t('server accepts a long library document only in bulk mode', () => {
  const many = Array.from({ length: 60 }, (_, i) => mk('D' + i, i, [{ role: 'user', content: 'm' + i }, { role: 'assistant', content: 'r' + i }]));
  const doc = libraryToDocument(many);
  assert.ok(doc.blocks.length > 150);
  assert.ok(sanitizeDocument(doc).blocks.length <= 150);
  assert.equal(sanitizeDocument(doc, undefined, true).blocks.length, doc.blocks.length);
});
await t('import into an empty library adds everything', () => {
  const p = planImport([], [a, b]);
  assert.deepEqual([p.added, p.updated, p.skipped], [2, 0, 0]);
  assert.equal(p.merged.length, 2);
});
await t('re-import creates no duplicates and reports skipped', () => {
  const p = planImport([a, b], [a, b]);
  assert.deepEqual([p.added, p.updated, p.skipped], [0, 0, 2]);
  assert.equal(p.merged.length, 2);
  assert.equal(importReport(p, true), 'Добавлено 0, обновлено 0, пропущено 2.');
});
await t('newer incoming updates; newer local is kept and flagged as a conflict', () => {
  const aNew = { ...a, updatedAt: 500, title: 'Alpha v2' };
  const bOld = { ...b, updatedAt: 50, title: 'Beta old' };
  const p = planImport([a, b], [aNew, bOld]);
  assert.deepEqual([p.added, p.updated, p.skipped], [0, 1, 1]);
  assert.deepEqual(p.conflicts, ['Beta']);
  assert.equal(p.merged.find((d) => d.id === a.id).title, 'Alpha v2');
  assert.equal(p.merged.find((d) => d.id === b.id).title, 'Beta');
});
await t('nothing local is removed', () => {
  const c = mk('Local only', 10);
  assert.equal(planImport([c, a], [b]).merged.length, 3);
});
await t('round trip: export all to .json, parse, import into a clean library', async () => {
  const blob = exportAllJson([a, b], [{ name: 'f.txt', text: 'x' }]);
  const text = await blob.text();
  const back = parseImportedBackup(text);
  assert.equal(back.programFiles.length, 1);
  const p = planImport([], back.decisions);
  assert.deepEqual(p.merged.map((d) => d.id).sort(), [a.id, b.id].sort());
});
console.log(`\n${n} checks passed`);
