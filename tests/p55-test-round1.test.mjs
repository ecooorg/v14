import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---- browser shims (Node has no window / storage) ----
const mk = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.sessionStorage = mk();
globalThis.localStorage = mk();
globalThis.window = new EventTarget();

const client = await import('../src/driveClient.ts');
const mirror = await import('../src/driveMirror.ts');
const { briefSections, BRIEF_EMPTY_TEXT } = await import('../src/briefView.ts');
client._setDriveClientIdForTests('test-client-id');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('src/index.css');
const app = read('src/App.tsx');
const pm = read('src/ProjectMode.tsx');
const wp = read('src/WorkspacePanel.tsx');
const cf = read('src/ConversationFiles.tsx');
const ud = read('src/useDrive.ts');

// ---- a fake Google Drive ----
function fakeDrive() {
  const folders = new Map();           // id -> {name, parent, trashed}
  const calls = []; const uploads = [];
  let n = 0; let failWith = null;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); const method = (init.method || 'GET').toUpperCase();
    calls.push(`${method} ${u.pathname}${u.search.slice(0, 60)}`);
    if (failWith) { const f = failWith; return json(f.body, f.status); }
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = decodeURIComponent(u.searchParams.get('q') || '');
      const name = q.match(/name='((?:[^'\\]|\\.)*)'/)?.[1];
      const parent = q.match(/'([^']+)' in parents/)?.[1] || null;
      const hit = [...folders.entries()].find(([, f]) => f.name === name && f.parent === parent && !f.trashed);
      return json({ files: hit ? [{ id: hit[0], name }] : [] });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const b = JSON.parse(init.body); const id = `fold${++n}`;
      folders.set(id, { name: b.name, parent: b.parents?.[0] || null, trashed: false }); return json({ id });
    }
    const one = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one && method === 'GET') { const f = folders.get(one[1]); return f ? json({ id: one[1], trashed: f.trashed, mimeType: 'application/vnd.google-apps.folder' }) : json({ error: { message: 'not found' } }, 404); }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(await init.body.get('metadata').text()); uploads.push(meta); return json({ id: `file${uploads.length}`, webViewLink: `https://drive.test/f${uploads.length}` });
    }
    return json({}, 500);
  };
  return { fetchImpl, folders, calls, uploads, fail: (status, body) => { failWith = { status, body }; }, ok: () => { failWith = null; } };
}
const events = []; window.addEventListener(mirror.DRIVE_STATUS_EVENT, (e) => events.push(e.detail));
const FILE_SCOPE = client.DRIVE_FILE_SCOPE; const APPDATA = client.DRIVE_APPDATA_SCOPE;
const connectToken = (scope = `${APPDATA} ${FILE_SCOPE}`) => mirror.storeMirrorToken({ token: 'tok-abcdefgh', expiresAt: Date.now() + 3_600_000, scope });
const reset = () => { sessionStorage.clear(); localStorage.clear(); mirror._resetMirrorForTests(); events.length = 0; };
const blob = (t = 'hello') => new Blob([t]);

test('P55 a file attached before Drive is connected waits and is saved right after Connect', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl;
  const r = await mirror.mirrorBlobDetailed({ name: 'brief.pdf', data: blob('abc'), localKey: 'k1' });
  assert.equal(r.ok, false); assert.equal(r.reason, 'not_connected'); assert.equal(r.queued, true);
  assert.equal(mirror.pendingMirrorCount(), 1);
  assert.equal(d.calls.length, 0, 'nothing is sent without a token');
  assert.equal(events.at(-1).kind, 'pending'); assert.match(events.at(-1).message, /after you connect/);
  connectToken();
  assert.equal(await mirror.flushMirrorQueue(), 1);
  assert.equal(mirror.pendingMirrorCount(), 0);
  assert.equal(d.uploads.length, 1); assert.equal(d.uploads[0].name, 'brief.pdf');
  assert.equal(events.at(-1).kind, 'saved'); assert.match(events.at(-1).message, /BiForge\/Simple\/brief\.pdf/);
  const names = [...d.folders.values()].map((f) => f.name);
  assert.deepEqual(names, ['BiForge', 'Simple']);
  const [bf, simple] = [...d.folders.entries()];
  assert.equal(bf[1].parent, null); assert.equal(simple[1].parent, bf[0], 'Simple is inside BiForge');
  assert.deepEqual(d.uploads[0].parents, [simple[0]]);
});

test('P55 the folder follows the mode; Project files go into a project subfolder', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  mirror.setMirrorMode('expert');
  const e = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('1'), localKey: 'e1' });
  assert.equal(e.folder, 'BiForge/Expert');
  const p = await mirror.mirrorBlobDetailed({ name: 'spec.md', data: blob('22'), mode: 'project', subfolder: 'My / Plan', localKey: 'p1' });
  assert.equal(p.folder, 'BiForge/Project/My Plan', 'path separators are removed from a project name');
  mirror.setMirrorMode('simple');
  assert.equal((await mirror.mirrorBlobDetailed({ name: 'b.txt', data: blob('333'), localKey: 's1' })).folder, 'BiForge/Simple');
  assert.equal(mirror.folderPathFor('library').join('/'), 'BiForge/Library');
});

test('P55 remembered folders are reused, and a deleted or trashed folder is created again', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  await mirror.mirrorBlobDetailed({ name: 'one.txt', data: blob('1'), localKey: 'a' });
  const created = [...d.folders.keys()].length;
  await mirror.mirrorBlobDetailed({ name: 'two.txt', data: blob('22'), localKey: 'b' });
  assert.equal([...d.folders.keys()].length, created, 'no new folders for the second file');
  // the person trashes the BiForge folder; a new session still remembers its id
  for (const f of d.folders.values()) f.trashed = true;
  mirror._resetMirrorForTests();
  const r = await mirror.mirrorBlobDetailed({ name: 'three.txt', data: blob('333'), localKey: 'c' });
  assert.equal(r.ok, true, 'saved even though the remembered folder was trashed');
  assert.equal([...d.folders.values()].filter((f) => !f.trashed).length, 2, 'BiForge and Simple exist again');
  // and a folder that no longer exists at all
  d.folders.clear(); mirror._resetMirrorForTests();
  assert.equal((await mirror.mirrorBlobDetailed({ name: 'four.txt', data: blob('4444'), localKey: 'd' })).ok, true);
});

test('P55 every failure is announced with its real reason (no silent no-op)', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  d.fail(403, { error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } });
  let r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x1' });
  assert.equal(r.reason, 'no_file_scope'); assert.match(events.at(-1).message, /file access was not granted/); assert.equal(events.at(-1).kind, 'error');
  assert.ok(mirror.getMirrorToken(), 'a scope problem does not throw the session away');
  d.fail(403, { error: { message: 'Google Drive API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } });
  r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x2' });
  assert.equal(r.reason, 'api_disabled'); assert.match(events.at(-1).message, /switched off for this app/);
  d.fail(403, { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } });
  assert.equal((await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x3' })).reason, 'quota');
  d.fail(500, {}); 
  r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x4' });
  assert.equal(r.reason, 'failed'); assert.match(events.at(-1).message, /x\.txt/);
  d.fail(401, { error: { message: 'Invalid Credentials' } });
  r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'x5' });
  assert.equal(r.reason, 'expired'); assert.equal(mirror.getMirrorToken(), null, 'an expired session is dropped');
  assert.match(events.at(-1).message, /reconnect/i);
  for (const m of events.map((e) => e.message)) assert.doesNotMatch(m, /DRIVE_|VITE_|undefined|\[object/);
});

test('P55 a token that lacks the file permission is reported before any request is sent', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken(APPDATA);
  assert.equal(mirror.hasFileScope(mirror.getMirrorToken()), false);
  const r = await mirror.mirrorBlobDetailed({ name: 'x.txt', data: blob('x'), localKey: 'n1' });
  assert.equal(r.reason, 'no_file_scope'); assert.equal(d.calls.length, 0);
  assert.equal(mirror.hasFileScope({ token: 't', expiresAt: 1 }), true, 'an unknown scope is not treated as a refusal');
});

test('P55 the same file is not uploaded twice; the waiting list is bounded', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('same'), localKey: 'dup' });
  const again = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('same'), localKey: 'dup' });
  assert.equal(again.ok, true); assert.equal(again.reused, true); assert.equal(d.uploads.length, 1);
  const changed = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('a longer text'), localKey: 'dup' });
  assert.equal(changed.reused, false); assert.equal(d.uploads.length, 2, 'changed content is saved again');
  reset(); globalThis.fetch = d.fetchImpl;
  for (let i = 0; i < 30; i++) await mirror.mirrorBlobDetailed({ name: `f${i}.txt`, data: blob('x'), localKey: `q${i}` });
  assert.equal(mirror.pendingMirrorCount(), 25);
  assert.match(events.at(-1).message, /Press Drive/, 'a file that cannot wait says so');
});

test('P55 without a Google client id the mirror stays silent and does nothing', async () => {
  reset(); client._setDriveClientIdForTests(''); const d = fakeDrive(); globalThis.fetch = d.fetchImpl;
  const r = await mirror.mirrorBlobDetailed({ name: 'a.txt', data: blob('x'), localKey: 'z' });
  assert.equal(r.reason, 'not_configured'); assert.equal(events.length, 0); assert.equal(d.calls.length, 0);
  client._setDriveClientIdForTests('test-client-id');
});

test('P55 text files keep a sensible name and type; compatible wrappers still work', async () => {
  reset(); const d = fakeDrive(); globalThis.fetch = d.fetchImpl; connectToken();
  const e = await mirror.mirrorTextFile('Spec', 'hello', 'project', 'tk', 'Proj');
  assert.equal(e.name, 'Spec.txt');
  assert.equal((await mirror.mirrorTextFile('notes.md', 'x', 'project', 'tk2', 'Proj')).name, 'notes.md');
  assert.equal(await mirror.mirrorBlob({ name: 'ok.bin', data: blob('1'), localKey: 'w1' }).then((x) => x.name), 'ok.bin');
  d.fail(500, {});
  assert.equal(await mirror.mirrorBlob({ name: 'bad.bin', data: blob('2'), localKey: 'w2' }), null);
});

// ---- Decision brief (item 3) ----
test('P55 decision brief shows plain sections, not stored JSON', () => {
  const brief = { decision: 'Move the team', goal: 'Ship in Q4', facts: ['Two engineers left'], unknowns: ['Budget'], assumptions: [], values: ['Calm'], constraints: ['No new hires'],
    myOptions: [{ id: 'o1', title: 'Hire' }, { id: 'o2', title: 'Wait' }], leaningOptionId: 'o2', errorCost: { final: 'HIGH', note: 'Delays the launch' }, reversibility: { final: 'TWO_WAY', exitCost: 'small' }, reviewDates: ['2026-12-01'], minimalMode: false };
  const s = briefSections(brief);
  assert.deepEqual(s.map((x) => x.title), ['Decision', 'Goal', 'Facts', 'Unknowns', 'What matters to you', 'Limits', 'Your options', 'You lean towards', 'Risk', 'When to look again']);
  assert.deepEqual(s.find((x) => x.title === 'You lean towards').items, ['Wait']);
  assert.ok(s.find((x) => x.title === 'Risk').items.includes('Cost of a mistake: high'));
  assert.ok(s.find((x) => x.title === 'Risk').items.includes('Reversibility: easy to undo'));
  assert.doesNotMatch(JSON.stringify(s), /minimalMode|leaningOptionId|errorCost|"NONE"|ONE_WAY|TWO_WAY/);
});

test('P55 an empty brief says so instead of printing empty fields', () => {
  const empty = { decision: '', facts: [], unknowns: [], assumptions: [], values: [], constraints: [], myOptions: [], leaningOptionId: 'NONE', errorCost: {}, reversibility: {}, reviewDates: [], minimalMode: true };
  assert.deepEqual(briefSections(empty), []);
  assert.deepEqual(briefSections(null), []);
  assert.match(BRIEF_EMPTY_TEXT, /Nothing is recorded/);
  const only = briefSections({ ...empty, decision: 'какая погода прогнозируется в швейцарии' });
  assert.deepEqual(only, [{ title: 'Decision', items: ['какая погода прогнозируется в швейцарии'] }]);
});

test('P55 the brief panel is a real dialog with its own layout and no JSON dump', () => {
  const panel = app.slice(app.indexOf('function BriefPanel('), app.indexOf('function BriefPanel(') + 1800);
  assert.doesNotMatch(panel, /JSON\.stringify/);
  assert.doesNotMatch(panel, /className="privacy"/, 'it no longer reuses the toast layout that squeezed the Close button');
  assert.match(panel, /role="dialog"/); assert.match(panel, /briefSections\(d\.brief\)/);
  assert.match(css, /\.brief-panel\{[^}]*max-height:85vh;overflow:auto/);
  assert.match(css, /\.brief-head \.ghost\{[^}]*white-space:nowrap/);
});

// ---- header menu (item 4) ----
test('P55 More is a closed dropdown at every width', () => {
  assert.match(css, /\.hdr-more-btn\{display:inline-flex/);
  assert.doesNotMatch(css, /@media\(min-width:901px\)\{\s*\.hdr-more-wrap \.hdr-secondary\{display:contents/);
  assert.match(css, /\n\.hdr-more-wrap \.hdr-secondary\{display:none !important;position:absolute;right:0/);
  assert.match(css, /\n\.hdr-more-wrap \.hdr-secondary\.open\{display:flex !important\}/);
  assert.match(app, /document\.addEventListener\('touchstart', onDoc/);
  assert.match(app, /aria-expanded=\{moreOpen\}/);
  assert.match(app, /useState\(false\);\n  const \[sub, setSub\]/, 'the menu starts closed');
});

// ---- wiring (items 1 and 2) ----
test('P55 every upload path reaches Drive: Attach files, conversation files, exports, agent documents', () => {
  assert.match(wp, /import \{ mirrorBlob, mirrorUserFile \} from '\.\/driveMirror\.ts'/);
  assert.match(wp, /void mirrorUserFile\(f\)/);
  assert.match(wp, /webkitRelativePath/, 'a whole folder is not copied file by file');
  assert.match(wp, /void mirrorBlob\(\{ name: result\.filename/);
  assert.match(cf, /void mirrorUserFile\(f\)/);
  assert.doesNotMatch(cf, /mirrorUserFile\(f, 'simple'\)/);
  assert.match(app, /setMirrorMode\(expertMode \? 'expert' : 'simple'\)/);
  assert.doesNotMatch(app, /mirrorUserFile\(file, 'expert'\)/);
  assert.match(read('src/programFiles.ts'), /'unknown',\s*\/\/ the folder follows the mode/);
});

test('P55 connecting Drive saves the waiting files and reports a missing permission', () => {
  assert.match(ud, /storeMirrorToken\(t\)/);
  assert.match(ud, /flushMirrorQueue\(\)/);
  assert.match(ud, /hasFileScope\(t\)/);
  assert.match(ud, /addEventListener\(DRIVE_STATUS_EVENT/);
});

test('P55 Project mode has Drive buttons and nothing uploads silently', () => {
  for (const label of ['Connect Google Drive', 'Save all files to Google Drive', 'Save to Google Drive', 'Save ZIP to Google Drive']) assert.ok(pm.includes(label), label);
  assert.match(pm, /connectDriveFiles\(\)/);
  assert.match(pm, /addEventListener\(DRIVE_STATUS_EVENT/);
  assert.match(pm, /BiForge \/ Project \//);
  assert.match(pm, /Google Drive is not set up on this server/);
  assert.doesNotMatch(pm, /void mirrorTextFile\(meta/, 'opening a file no longer uploads it behind the person\'s back');
  assert.match(pm, /mirrorTextFile\(a\.filename, t\.text \|\| '', 'project'/);
});
