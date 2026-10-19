/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN connections.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const http = (await import("node:http")).default;
const fs = (await import("node:fs")).default;
const { spawn } = await import("node:child_process");
const { REGISTRY_SEED } = await import("../server/modelRegistry.ts");
const { sha256Hex, artifactInputSchema } = await import("../server/artifactRepository.ts");
const { ledgerEntryFromResponse } = await import("../server/ledger.ts");
const { routeCall, newRouterState } = await import("../server/router.ts");
const { createFakeAdapter } = await import("../server/fakeProvider.ts");

const SECRET = 'sk-test-SECRET-value-123456';
function run(env, ...a) {
  return new Promise((resolve) => {
    const clean = { ...process.env }; delete clean.DATABASE_URL; delete clean.GEMINI_API_KEY;
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/verify-connections.mjs', ...a], { env: { ...clean, ...env } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}
function fakeGemini(mode) {
  const server = http.createServer((req, res) => {
    const ok = req.headers['x-goog-api-key'] === SECRET;
    res.setHeader('content-type', 'application/json');
    if (mode === 'drift') { res.statusCode = 404; return res.end('{}'); }
    if (!ok) { res.statusCode = 400; return res.end('{"error":"API key not valid"}'); }
    if (req.url.includes('generateContent')) return res.end(JSON.stringify({ candidates: [{}], usageMetadata: {} }));
    res.end(JSON.stringify({ models: [{ name: `models/${REGISTRY_SEED[0].modelId}` }] }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('verify:connections OK against a fake Gemini, secret never printed', async () => {
  const s = await fakeGemini('ok');
  const { code, out } = await run({ GEMINI_API_KEY: SECRET, GEMINI_BASE_URL_OVERRIDE: `http://127.0.0.1:${s.address().port}` }, '--only', 'gemini', '--json');
  s.close();
  assert.equal(code, 0);
  const j = JSON.parse(out);
  assert.deepEqual(j.results.map((r) => r.status), ['OK', 'OK']);
  assert.ok(!out.includes(SECRET));
});

test('verify:connections: wrong key is FAIL (exit 2), 404 is DRIFT (exit 2), missing key is BLOCKED (exit 3)', async () => {
  let s = await fakeGemini('ok');
  let r = await run({ GEMINI_API_KEY: 'wrong-key-value', GEMINI_BASE_URL_OVERRIDE: `http://127.0.0.1:${s.address().port}` }, '--only', 'gemini', '--json');
  s.close(); assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).results[0].reason, 'http_400');
  s = await fakeGemini('drift');
  r = await run({ GEMINI_API_KEY: SECRET, GEMINI_BASE_URL_OVERRIDE: `http://127.0.0.1:${s.address().port}` }, '--only', 'gemini', '--json');
  s.close(); assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).results[0].status, 'DRIFT');
  r = await run({}, '--only', 'gemini', '--json');
  assert.equal(r.code, 3); assert.equal(JSON.parse(r.out).results[0].reason, 'missing_secret:GEMINI_API_KEY');
});

test('verify:connections --dry-run makes no network calls', async () => {
  const r = await run({ GEMINI_API_KEY: SECRET, GEMINI_BASE_URL_OVERRIDE: 'http://127.0.0.1:1' }, '--dry-run', '--json');
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.out).results.every((x) => x.status === 'NOT_RUN'));
  assert.ok(!r.out.includes(SECRET));
});

test('connectors.yaml lists connectors with variable names and no secret values', () => {
  const m = JSON.parse(fs.readFileSync('connectors.yaml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
  const example = fs.readFileSync('.env.example', 'utf8');
  for (const [id, c] of Object.entries(m.connectors)) {
    assert.ok(c.env.required.length > 0, `connector ${id} declares required variables`);
  }
  assert.ok(example.includes('GEMINI_API_KEY'), '.env.example mentions GEMINI_API_KEY');
  assert.ok(!JSON.stringify(m).match(/sk-|AIza/), 'no secret-like values in the manifest');
});

test('artifact input: hash and validation (no database needed)', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const base = { projectId: 'p1', filename: 'a.md', text: 'x', createdBy: 'human' };
  assert.equal(artifactInputSchema.safeParse(base).success, true);
  assert.equal(artifactInputSchema.safeParse({ ...base, filename: '../a.md' }).success, false);
  assert.equal(artifactInputSchema.safeParse({ ...base, extra: 1 }).success, false);
});

test('ledger: router reports every call, including failed ones', async () => {
  const rows = [];
  const reg = [{ ...REGISTRY_SEED[0], providerId: 'p1' }];
  const p1 = createFakeAdapter('p1', ['server_error', 'success']);
  const r = await routeCall({ requestId: 'x', prompt: 'p', json: true, metadata: {} }, {
    registry: reg, adapters: { p1 }, state: newRouterState(), required: ['json_output'], sleep: async () => {}, backoffMs: () => 0,
    onCall: (resp, info) => { rows.push(ledgerEntryFromResponse(resp, { runId: 'run1', retries: info.retries })); },
  });
  assert.equal(r.status, 'ok');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.status), ['error', 'ok']);
  assert.equal(rows[0].errorClass, 'PROVIDER_TRANSIENT');
  assert.deepEqual([rows[1].inputTokens, rows[1].outputTokens, rows[1].retries], [10, 5, 1]);
});
}
// ===== END connections.test.mjs =====

// ===== BEGIN driveDocs.test.mjs =====
{
// Save to Google Docs: what is sent to Drive, token handling, errors. No network. Run: npm run test:drivedocs
const assert = (await import("node:assert/strict")).default;
const { DriveAuthError, driveUploadAsGoogleDoc, isDriveConfigured } = await import("../src/driveClient.ts");
const { saveDocumentToGoogleDocs } = await import("../src/driveExport.ts");

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
}
// ===== END driveDocs.test.mjs =====

// ===== BEGIN driveMerge.test.mjs =====
{
const assert = (await import("node:assert/strict")).default;
const { mergeLibraries, isSafeToWrite, remoteIsNewer, parseLibrary, buildLibraryPayload, createBackup, listBackups, DRIVE_FILE_NAME } = await import("../src/driveMerge.ts");

const d = (id, updatedAt, t = '') => ({ id, updatedAt, t });
const mem = () => { const m = new Map(); return { m,
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('merge: union by id', () => {
  const r = mergeLibraries([d('a', 1), d('b', 1)], [d('c', 1)]);
  assert.deepEqual(r.merged.map((x) => x.id).sort(), ['a', 'b', 'c']);
  assert.ok(r.changedLocal && r.changedRemote);
});
t('merge: newer wins (remote newer)', () => {
  const r = mergeLibraries([d('a', 1, 'old')], [d('a', 5, 'new')]);
  assert.equal(r.merged[0].t, 'new'); assert.ok(r.changedLocal); assert.ok(!r.changedRemote);
});
t('merge: newer wins (local newer)', () => {
  const r = mergeLibraries([d('a', 9, 'new')], [d('a', 5, 'old')]);
  assert.equal(r.merged[0].t, 'new'); assert.ok(!r.changedLocal); assert.ok(r.changedRemote);
});
t('merge: tie keeps local, nothing changed', () => {
  const r = mergeLibraries([d('a', 5, 'L')], [d('a', 5, 'R')]);
  assert.equal(r.merged[0].t, 'L'); assert.ok(!r.changedLocal && !r.changedRemote);
});
t('merge: empty local keeps remote, empty remote keeps local', () => {
  assert.equal(mergeLibraries([], [d('a', 1)]).merged.length, 1);
  assert.equal(mergeLibraries([d('a', 1)], []).merged.length, 1);
});
t('merge: does not mutate inputs; ignores rows without id', () => {
  const L = [d('a', 1)], R = [d('b', 1), { updatedAt: 3 }];
  mergeLibraries(L, R); assert.equal(L.length, 1); assert.equal(R.length, 2);
  assert.equal(mergeLibraries(L, R).merged.length, 2);
});
t('empty library never overwrites non-empty remote', () => {
  assert.equal(isSafeToWrite([], [d('a', 1)]), false);
  assert.equal(isSafeToWrite([], []), true);
  assert.equal(isSafeToWrite([], null), true);
  assert.equal(isSafeToWrite([d('a', 1)], [d('b', 1)]), true);
});
t('remoteIsNewer', () => {
  assert.equal(remoteIsNewer(200, 100), true);
  assert.equal(remoteIsNewer(100, 100), false);
  assert.equal(remoteIsNewer(100, null), true);
  assert.equal(remoteIsNewer(null, 100), false);
});
t('parse: old format, new format, bare array, garbage', () => {
  assert.equal(parseLibrary('{"version":13,"updatedAt":7,"decisions":[{"id":"a","updatedAt":1}]}').decisions.length, 1);
  const nw = parseLibrary(buildLibraryPayload([d('a', 1)], '16.5.0', 11, 42));
  assert.equal(nw.appVersion, '16.5.0'); assert.equal(nw.schemaVersion, 11); assert.equal(nw.updatedAt, 42);
  assert.equal(parseLibrary([d('a', 1)]).decisions.length, 1);
  assert.deepEqual(parseLibrary('not json').decisions, []);
  assert.deepEqual(parseLibrary(null).decisions, []);
});
t('payload keeps legacy version field and file name is unchanged', () => {
  assert.equal(JSON.parse(buildLibraryPayload([], '16.5.0', 11)).version, 13);
  assert.equal(DRIVE_FILE_NAME, 'bifurcation-v13-library.json');
});
t('backup: created, dated, keeps last three', () => {
  const s = mem();
  for (let i = 1; i <= 5; i++) assert.ok(createBackup(s, [d('a', i)], 1000 + i));
  const keys = listBackups(s);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, ['bifurcation_library_backup_1003', 'bifurcation_library_backup_1004', 'bifurcation_library_backup_1005']);
  assert.equal(JSON.parse(s.getItem(keys[2])).createdAt, 1005);
  assert.equal(s.m.has('bifurcation_library_backup_1001'), false);
});
t('backup: same millisecond does not overwrite; empty library skipped', () => {
  const s = mem();
  const a = createBackup(s, [d('a', 1)], 5), b = createBackup(s, [d('a', 1)], 5);
  assert.notEqual(a, b); assert.equal(listBackups(s).length, 2);
  assert.equal(createBackup(mem(), [], 5), null);
});
t('backup: quota error does not throw', () => {
  const s = mem(); s.setItem = () => { throw new Error('quota'); };
  assert.equal(createBackup(s, [d('a', 1)], 5), null);
});
console.log(`${n} tests passed`);
}
// ===== END driveMerge.test.mjs =====

// ===== BEGIN driveMirror.test.mjs =====
{
// Drive mirror: manifest + status (no network). Run via node --experimental-strip-types or project test runner.
const assert = (await import("node:assert/strict")).default;

const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => ls.get(k) ?? null,
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};

const mod = await import('../src/driveMirror.ts');

assert.equal(mod.isMirrorConnected(), false);
assert.equal(mod.mirrorStatus('x'), 'not_configured'); // no VITE client id in node

const man = mod.loadMirrorManifest();
assert.equal(man.version, 1);
assert.deepEqual(man.files, []);

console.log('ok - driveMirror basics');
}
// ===== END driveMirror.test.mjs =====

// ===== BEGIN driveSync.test.mjs =====
{
// TEST-01 / DRV-01: sync core against a fake Drive. No network.
const assert = (await import("node:assert/strict")).default;
const { syncOnce } = await import("../src/driveSync.ts");
const { autosaveDelay, hasUnsavedLocal, shouldNotify } = await import("../src/autosave.ts");
const { DriveAuthError, DriveNotFoundError } = await import("../src/driveClient.ts");

const d = (id, updatedAt, t = '') => ({ id, updatedAt, t });
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function fakeDrive(initial, { onWrite, beforeWrite } = {}) {
  const s = { file: initial ? { id: 'f1', mod: 100, decisions: initial } : null, writes: 0, finds: 0 };
  const info = () => (s.file ? { id: s.file.id, modifiedTime: s.file.mod } : null);
  s.concurrent = (decisions) => { s.file = { id: s.file?.id || 'f1', mod: (s.file?.mod || 100) + 10, decisions }; };
  s.ops = {
    find: async () => { s.finds++; return info(); },
    read: async () => ({ decisions: s.file.decisions }),
    write: async (body, id) => {
      if (beforeWrite) beforeWrite(s);
      if (id && !s.file) throw new DriveNotFoundError();
      s.writes++;
      s.file = { id: id || 'f1', mod: (s.file?.mod || 100) + 1, decisions: JSON.parse(body).decisions };
      return info();
    },
  };
  return s;
}
const base = (o) => ({ mode: 'manual', local: [], lastSync: 0, appVersion: 'x', schemaVersion: 11, backup: () => {}, ...o });
const ids = (arr) => arr.map((x) => x.id).sort();

await t('connect with both sides non-empty: merged, backed up, nothing lost', async () => {
  const dr = fakeDrive([d('b', 1), d('c', 1)]); let backed = 0;
  const r = await syncOnce(base({ mode: 'connect', local: [d('a', 1), d('b', 1)], backup: () => backed++ }), dr.ops);
  assert.deepEqual(ids(r.merged), ['a', 'b', 'c']); assert.deepEqual(ids(dr.file.decisions), ['a', 'b', 'c']);
  assert.equal(backed, 1); assert.ok(r.changedLocal && r.wrote);
});
await t('first save creates the file', async () => {
  const dr = fakeDrive(null);
  const r = await syncOnce(base({ local: [d('a', 1)] }), dr.ops);
  assert.ok(r.wrote && dr.file.decisions.length === 1);
});
await t('empty library never overwrites a non-empty Drive file', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'manual', local: [], lastSync: 0 }), dr.ops);
  assert.deepEqual(ids(dr.file.decisions), ['a']);   // Drive content intact
  assert.deepEqual(ids(r.merged), ['a']);            // local gets Drive's dialogs, not wiped
  // Drive unreadable as newer (already synced): empty local, nothing to write
  const r2 = await syncOnce(base({ local: [], lastSync: 999 }), dr.ops);
  assert.ok(!r2.wrote && ids(dr.file.decisions)[0] === 'a');
});
await t('DRV-01: another device writes between read and write -> re-read, merge, nothing lost', async () => {
  const dr = fakeDrive([d('b', 1)]);
  let fired = false;
  const ops = { ...dr.ops, find: async () => { const r = await dr.ops.find(); if (!fired && dr.finds === 1) { fired = true; dr.concurrent([d('b', 1), d('z', 5)]); } return r; } };
  const r = await syncOnce(base({ mode: 'connect', local: [d('a', 1), d('b', 1)] }), ops);
  assert.equal(r.status, 'ok'); assert.equal(r.retries, 1);
  assert.deepEqual(ids(dr.file.decisions), ['a', 'b', 'z']);
});
await t('DRV-01: Drive keeps changing -> stops after max retries, writes nothing, local intact', async () => {
  const dr = fakeDrive([d('b', 1)]); let k = 0;
  const ops = { ...dr.ops, find: async () => { const r = await dr.ops.find(); dr.concurrent([d('b', 1), d('x' + k++, 2)]); return r; } };
  const local = [d('a', 1)];
  const r = await syncOnce(base({ mode: 'connect', local, maxRetries: 3 }), ops);
  assert.equal(r.status, 'conflict'); assert.equal(dr.writes, 0); assert.equal(r.retries, 3);
  assert.deepEqual(r.merged, local);
});
await t('DRV-01: file created by another device while we had none -> merged, not duplicated', async () => {
  const dr = fakeDrive(null); let first = true;
  const ops = { ...dr.ops, find: async () => { const r = await dr.ops.find(); if (first) { first = false; dr.concurrent([d('z', 3)]); } return r; } };
  const r = await syncOnce(base({ local: [d('a', 1)] }), ops);
  assert.deepEqual(ids(dr.file.decisions), ['a', 'z']); assert.equal(r.retries, 1);
});
await t('missing file id (404 on write) falls back to creating the file', async () => {
  const dr = fakeDrive(null); let calls = 0;
  const ops = { ...dr.ops, write: async (b, id) => { calls++; if (calls === 1) throw new DriveNotFoundError(); return dr.ops.write(b); } };
  const r = await syncOnce(base({ local: [d('a', 1)] }), ops);
  assert.ok(r.wrote && calls === 2);
});
await t('expired token (401/403) propagates for the caller to handle; nothing written', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const ops = { ...dr.ops, find: async () => { throw new DriveAuthError(); } };
  await assert.rejects(() => syncOnce(base({ local: [d('a', 2)] }), ops), DriveAuthError);
  assert.equal(dr.writes, 0);
});

await t('DRV-02: autosave with nothing new writes nothing (remote unread)', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'auto', local: [d('a', 1)], lastSync: 100, dirty: false }), dr.ops);
  assert.ok(!r.wrote && dr.writes === 0);
});
await t('DRV-02: autosave with new local data writes', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'auto', local: [d('a', 5)], lastSync: 100, dirty: true }), dr.ops);
  assert.ok(r.wrote && dr.file.decisions[0].updatedAt === 5);
});
await t('DRV-02: autosave, Drive newer and local not dirty -> merges locally, writes nothing', async () => {
  const dr = fakeDrive([d('a', 1), d('z', 9)]);
  const r = await syncOnce(base({ mode: 'auto', local: [d('a', 1)], lastSync: 0, dirty: false }), dr.ops);
  assert.ok(!r.wrote && r.changedLocal && ids(r.merged).join() === 'a,z');
});
await t('DRV-02: manual save always writes, even with nothing new', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'manual', local: [d('a', 1)], lastSync: 100, dirty: false }), dr.ops);
  assert.ok(r.wrote);
});
await t('expired token, then reconnect repeats the failed save (nothing lost)', async () => {
  const dr = fakeDrive([d('b', 1)]);
  const failing = { ...dr.ops, find: async () => { throw new DriveAuthError(); } };
  const local = [d('a', 2), d('b', 1)];
  await assert.rejects(() => syncOnce(base({ mode: 'auto', local, dirty: true }), failing), DriveAuthError);
  const r = await syncOnce(base({ mode: 'connect', local }), dr.ops);   // reconnect = merge + write
  assert.ok(r.wrote); assert.deepEqual(ids(dr.file.decisions), ['a', 'b']);
});
await t('DRV-02: autosave delay keeps the minimum interval between writes', () => {
  const o = { debounceMs: 4000, minIntervalMs: 30000 };
  assert.equal(autosaveDelay({ ...o, now: 1000, lastWriteAt: 0 }), 4000);
  assert.equal(autosaveDelay({ ...o, now: 11000, lastWriteAt: 10000 }), 29000);
  assert.equal(autosaveDelay({ ...o, now: 100000, lastWriteAt: 10000 }), 4000);
});
await t('hasUnsavedLocal', () => {
  assert.ok(hasUnsavedLocal([d('a', 5)], { a: 4 }) && hasUnsavedLocal([d('a', 1)], {}));
  assert.ok(!hasUnsavedLocal([d('a', 5)], { a: 5 }) && !hasUnsavedLocal([], {}));
});
await t('autosave messages are throttled; manual and connect always show', () => {
  assert.ok(shouldNotify('auto', 1000, 0, 30000) && !shouldNotify('auto', 5000, 1000, 30000) && shouldNotify('auto', 31001, 1000, 30000));
  assert.ok(shouldNotify('manual', 5000, 4999, 30000) && shouldNotify('connect', 5000, 4999, 30000));
});
console.log(n + ' tests passed');
}
// ===== END driveSync.test.mjs =====

// ===== BEGIN github-delivery.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const crypto = (await import("node:crypto")).default;
const gh = await import("../server/githubIntegration.ts");

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg = { appId: '1', installationId: '2', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner: 'o', repository: 'r', apiBaseUrl: 'https://gh.test' };
const READ = { metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' };
const WRITE = { metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'write' };
const SHA = 'c'.repeat(40);
function fake(perms, calls) {
  return async (url, o = {}) => {
    const u = new URL(url); const method = o.method || 'GET'; calls.push({ method, path: u.pathname + u.search, body: o.body ? JSON.parse(o.body) : null });
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.pathname.endsWith('/access_tokens')) return json({ token: 'tok-secret', permissions: perms }, 201);
    if (u.pathname.includes('/git/ref/heads/')) return json({ object: { sha: SHA } });
    if (u.pathname.endsWith('/git/refs')) return json({}, 201);
    if (u.pathname.includes('/contents/') && method === 'GET') return json({}, 404);
    if (u.pathname.includes('/contents/') && method === 'PUT') return json({ commit: { sha: 'd'.repeat(40) } }, 201);
    if (u.pathname.endsWith('/pulls/7')) return json({ state: 'open', merged: false, head: { sha: SHA, ref: 'biforge/t1' }, base: { ref: 'main' } });
    if (u.pathname.endsWith('/pulls/7/files')) return json([{ filename: 'a.ts', status: 'modified' }]);
    if (u.pathname.includes('/check-runs')) return json({ check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/runs/1' }] });
    return json({}, 404);
  };
}

test('read PR, files and check runs with read-only permissions', async () => {
  const calls = [];
  const f = fake(READ, calls);
  assert.deepEqual(await gh.readPullRequest(cfg, 7, f), { number: 7, state: 'open', merged: false, headSha: SHA, headRef: 'biforge/t1', baseRef: 'main' });
  assert.equal((await gh.listPullRequestFiles(cfg, 7, f)).files[0].filename, 'a.ts');
  assert.equal((await gh.listCheckRuns(cfg, SHA, f))[0].conclusion, 'success');
  assert.ok(calls.every((c) => c.method === 'GET' || c.path.endsWith('/access_tokens')), 'reads never write');
});

test('reads fail when the installation token is broader than the manifest', async () => {
  await assert.rejects(() => gh.readPullRequest(cfg, 7, fake({ ...READ, administration: 'write' }, [])), /permissions_too_broad_or_missing/);
  await assert.rejects(() => gh.readPullRequest(cfg, 7, fake(WRITE, [])), /permissions_too_broad_or_missing/);
});

test('Task Package commit: refused unless writes are enabled; only biforge/<task_id>; no merge, no main', async () => {
  const files = [{ path: 'AGENTS.md', content: 'x' }, { path: '.biforge/tasks/t1/SPEC.md', content: 'y' }, { path: 'tests/acceptance/a.test.mjs', content: 'z' }];
  await assert.rejects(() => gh.commitTaskPackage(cfg, { taskId: 't1', baseBranch: 'main', files, writeEnabled: false }, fake(WRITE, [])), /github_write_disabled/);
  const calls = [];
  const r = await gh.commitTaskPackage(cfg, { taskId: 't1', baseBranch: 'main', files, writeEnabled: true }, fake(WRITE, calls));
  assert.equal(r.branch, 'biforge/t1');
  const writes = calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/access_tokens'));
  assert.ok(writes.length === 4);
  assert.ok(writes.every((c) => c.method === 'PUT' || c.path.endsWith('/git/refs')));
  assert.ok(writes.filter((c) => c.method === 'PUT').every((c) => c.body.branch === 'biforge/t1'));
  assert.equal(calls.some((c) => /merge|workflows|\/heads\/main/.test(c.path) && c.method !== 'GET'), false);
  assert.equal(JSON.stringify(r).includes('tok-secret'), false);
  assert.equal(Object.keys(gh).some((k) => /merge/i.test(k)), false, 'the module exposes no merge operation');
});

test('Task Package commit: paths, branch and base are validated', async () => {
  const w = (files, extra = {}) => gh.commitTaskPackage(cfg, { taskId: 't1', baseBranch: 'main', files, writeEnabled: true, ...extra }, fake(WRITE, []));
  for (const p of ['.github/workflows/ci.yml', '../x', '/etc/passwd', 'server/a.ts', '.biforge/tasks/other/SPEC.md', '.biforge/tasks/t1/../t2/SPEC.md', 'tests/acceptance/', 'a\\b']) {
    await assert.rejects(() => w([{ path: p, content: 'x' }]), /path_not_allowed/, p);
  }
  await assert.rejects(() => gh.commitTaskPackage(cfg, { taskId: '../main', baseBranch: 'main', files: [{ path: 'AGENTS.md', content: 'x' }], writeEnabled: true }, fake(WRITE, [])), /invalid_task_id/);
  await assert.rejects(() => w([{ path: 'AGENTS.md', content: 'x' }], { baseBranch: 'biforge/other' }), /invalid_base_branch/);
  await assert.rejects(() => w([]), /invalid_file_count/);
  assert.equal(gh.taskIdFromBranch('biforge/abc_1'), 'abc_1');
  assert.equal(gh.taskIdFromBranch('main'), null);
  assert.equal(gh.taskIdFromBranch('biforge/a/b'), null);
});
}
// ===== END github-delivery.test.mjs =====

// ===== BEGIN github-integration.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const crypto = (await import("node:crypto")).default;
const { createGitHubAppJwt, permissionsWithinMaximum, verifyGitHubWebhookSignature, verifyGitHubAppConnection } = await import("../server/githubIntegration.ts");

test('GitHub App JWT is RS256, issuer-bound and expires within ten minutes', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createGitHubAppJwt('12345', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 1_800_000_000);
  const [head, body, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url').toString()).alg, 'RS256');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.equal(payload.iss, '12345');
  assert.ok(payload.exp - payload.iat <= 9 * 60);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url')), true);
});

test('permissions reject excess rights and require the declared minimum', () => {
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' }, false), true);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'read' }, false), false);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read', administration: 'read' }, false), false);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'write' }, true), true);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' }, true), false);
});

test('webhook HMAC is verified against raw bytes in constant-time-safe format', () => {
  const body = Buffer.from('{"action":"opened"}');
  const secret = 'webhook-test-secret';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyGitHubWebhookSignature(body, signature, secret), true);
  assert.equal(verifyGitHubWebhookSignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, undefined, secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, signature, ''), false);
});

test('GitHub connection check uses installation token then repository API without exposing token', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes('/access_tokens')) return new Response(JSON.stringify({ token: 'private-token', permissions: { metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' } }), { status: 201 });
    return new Response(JSON.stringify({ full_name: 'owner/repo' }), { status: 200 });
  };
  const result = await verifyGitHubAppConnection({ appId: '123', installationId: '456', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner: 'owner', repository: 'repo', apiBaseUrl: 'https://github.test' }, fetcher);
  assert.deepEqual(result, { status: 'OK', permissions: { metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' }, repository: 'owner/repo' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-token');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});
}
// ===== END github-integration.test.mjs =====
