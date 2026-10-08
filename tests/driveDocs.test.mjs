// Save to Google Docs: what is sent to Drive, token handling, errors. No network. Run: npm run test:drivedocs
import assert from 'node:assert/strict';
import { DriveAuthError, driveUploadAsGoogleDoc, isDriveConfigured } from '../src/utils/driveClient.ts';
import { saveDocumentToGoogleDocs } from '../src/utils/driveExport.ts';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const realFetch = globalThis.fetch;
const DOCX = new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])]);
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const DOC = { title: 'План', fileName: 'contract-check-plan', blocks: [{ type: 'paragraph', text: 'x' }] };

await t('driveUploadAsGoogleDoc: asks Drive to convert the .docx into a Google Doc', async () => {
  let call;
  globalThis.fetch = async (url, init) => { call = { url: String(url), init }; return new Response(JSON.stringify({ id: 'abc', webViewLink: 'https://docs.google.com/document/d/abc/edit' }), { status: 200 }); };
  const r = await driveUploadAsGoogleDoc('TOKEN', 'contract-check-plan', DOCX);
  assert.deepEqual(r, { id: 'abc', webViewLink: 'https://docs.google.com/document/d/abc/edit' });
  assert.ok(call.url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'));
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer TOKEN');
  const meta = JSON.parse(await call.init.body.get('metadata').text());
  assert.deepEqual(meta, { name: 'contract-check-plan', mimeType: 'application/vnd.google-apps.document' });
  assert.ok(!('parents' in meta), 'goes to My Drive, not the hidden app data folder');
  const file = call.init.body.get('file');
  assert.equal(file.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(file.size, 7);
});
await t('driveUploadAsGoogleDoc: link falls back to the document address; 401/403 mean sign in again; no id is an error', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'zz' }), { status: 200 });
  assert.equal((await driveUploadAsGoogleDoc('T', 'n', DOCX)).webViewLink, 'https://docs.google.com/document/d/zz/edit');
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response('{}', { status });
    await assert.rejects(driveUploadAsGoogleDoc('T', 'n', DOCX), DriveAuthError);
  }
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  await assert.rejects(driveUploadAsGoogleDoc('T', 'n', DOCX), /did not confirm/);
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  await assert.rejects(driveUploadAsGoogleDoc('T', 'n', DOCX), /Could not save the document/);
});

const calls = [];
function routeFetch(uploadStatus = 200) {
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url) === '/api/export-document') {
      assert.equal(JSON.parse(init.body).format, 'docx');
      return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200, headers: { 'content-disposition': 'attachment; filename="contract-check-plan.docx"' } });
    }
    return new Response(JSON.stringify({ id: 'id1', webViewLink: 'https://docs.google.com/document/d/id1/edit' }), { status: uploadStatus });
  };
}
await t('saveDocumentToGoogleDocs: cached token, Word file built by the server, uploaded under the English name', async () => {
  store.set('be_drive_docs_token', 'CACHED'); store.set('be_drive_docs_expires', String(Date.now() + 3600000));
  routeFetch();
  const r = await saveDocumentToGoogleDocs(DOC);
  assert.deepEqual(r, { id: 'id1', link: 'https://docs.google.com/document/d/id1/edit', name: 'contract-check-plan' });
  assert.deepEqual(calls.map((u) => u.split('?')[0]), ['/api/export-document', 'https://www.googleapis.com/upload/drive/v3/files']);
});
await t('saveDocumentToGoogleDocs: a rejected token is forgotten and the person is told to press again', async () => {
  store.set('be_drive_docs_token', 'REVOKED'); store.set('be_drive_docs_expires', String(Date.now() + 3600000));
  routeFetch(401);
  await assert.rejects(saveDocumentToGoogleDocs(DOC), /Press the button again/);
  assert.equal(store.has('be_drive_docs_token'), false);
});
await t('saveDocumentToGoogleDocs: without a valid token it asks for sign-in first (and says so when Google sign-in is not configured)', async () => {
  store.set('be_drive_docs_token', 'OLD'); store.set('be_drive_docs_expires', String(Date.now() - 1000));
  calls.length = 0; routeFetch();
  assert.equal(isDriveConfigured(), false);
  await assert.rejects(saveDocumentToGoogleDocs(DOC), /not configured/);
  assert.equal(calls.length, 0, 'nothing is built or uploaded before the person signs in');
});
globalThis.fetch = realFetch;
console.log(`\nsave-to-Google-Docs tests passed: ${n}`);
