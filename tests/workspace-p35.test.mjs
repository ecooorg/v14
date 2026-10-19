/** P35: universal file content extraction and extract-aware workspace context. */
import assert from 'node:assert/strict';
import { classifyBytes } from '../src/workspace/classify.ts';
import {
  extractFileContent,
  formatExtractForContext,
  DEFAULT_EXTRACT_LIMITS,
} from '../src/workspace/extract.ts';
import { ingestFiles } from '../src/workspace/ingest.ts';
import { MemoryWorkspaceStore } from '../src/workspace/memoryStore.ts';
import { persistIngestResult } from '../src/workspace/persistIngest.ts';
import { readWorkspaceFile, buildWorkspaceBlock } from '../src/workspace/context.ts';

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
