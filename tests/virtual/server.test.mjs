// Real server.ts (production mode) + fake Gemini on localhost. Run: npm run test:virtual
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const PASS = 'test-pass-123', SECRET = 'x'.repeat(40), BYOK = 'SECRET-USER-KEY-987';
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Gemini: any generateContent call returns a markdown-laden JSON reply ----
let fakeHits = 0;
const fake = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    fakeHits++;
    const reply = '**Key point** here.\n* first item\n+ second item\n## Heading\nPlain text.';
    const text = JSON.stringify({ reply, contextSufficiency: 'HIGH', question: '', options: [], newOptions: [], nextStep: '' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }));
  });
});
await new Promise((r) => fake.listen(0, r));
const FAKE_URL = `http://127.0.0.1:${fake.address().port}`;

// ---- server process helper ----
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS, SESSION_SECRET: SECRET,
    GEMINI_API_KEY: 'fake-key', GOOGLE_GEMINI_BASE_URL: FAKE_URL, GEMINI_BASE_URL: FAKE_URL, TRUST_PROXY_HOPS: '1', ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn('tsx', ['server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const srv = { port, child, base: `http://127.0.0.1:${port}`, getLog: () => log,
    stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill(); }) };
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('server exited early:\n' + log);
    try { const r = await fetch(srv.base + '/api/health'); if (r.ok) return srv; } catch {}
    await sleep(250);
  }
  throw new Error('server did not start:\n' + log);
}
const post = (srv, path, body, headers = {}) => fetch(srv.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

let n = 0, skipped = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

try {
  // 1. Sign-in basics, flags, health, 401
  let srv = await startServer();
  let cookie = '';
  await t('health without sign-in: only status and version', async () => {
    const j = await (await fetch(srv.base + '/api/health')).json();
    assert.deepEqual(Object.keys(j).sort(), ['status', 'version']);
  });
  await t('AI endpoint without sign-in: 401', async () => {
    const r = await post(srv, '/api/conversation', { brief: { decision: 'x' } });
    assert.equal(r.status, 401);
  });
  await t('wrong password: 401', async () => { assert.equal((await post(srv, '/api/login', { password: 'nope' })).status, 401); });
  await t('right password: 200 and cookie flags', async () => {
    const r = await post(srv, '/api/login', { password: PASS });
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie') || '';
    for (const f of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=']) assert.ok(sc.includes(f), 'cookie lacks ' + f);
    cookie = cookieOf(r);
  });
  await t('signed in: full health with models, session authenticated', async () => {
    const j = await (await fetch(srv.base + '/api/health', { headers: { cookie } })).json();
    assert.ok('lightModels' in j && 'hasKey' in j);
    assert.equal((await (await fetch(srv.base + '/api/session', { headers: { cookie } })).json()).authenticated, true);
  });

  // 1b. File attachments: raw body + X-File-Name (same contract as the browser client).
  const attachRaw = (bytes, name, extraHeaders = {}) =>
    fetch(srv.base + '/api/attach', {
      method: 'POST',
      headers: {
        cookie,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name),
        ...extraHeaders,
      },
      body: bytes,
    });

  await t('attachment validation accepts text files (raw upload)', async () => {
    const body = new TextEncoder().encode('alpha\n42');
    const r = await attachRaw(body, 'notes.txt');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.success, true);
    assert.equal(j.data.name, 'notes.txt');
    assert.equal(j.data.size, 8);
    assert.equal(j.data.kind, 'text');
    assert.ok(typeof j.data.text === 'string' && j.data.text.includes('alpha'));
    assert.equal('inlineData' in j.data, false);
    assert.equal(j.meta.stage, 'attach');
  });

  await t('conversation accepts prior attachment text via JSON (not multipart)', async () => {
    const before = fakeHits;
    const up = await attachRaw(new TextEncoder().encode('USER DATA\n42'), 'context.txt');
    assert.equal(up.status, 200);
    const att = (await up.json()).data;
    const r = await post(srv, '/api/conversation', {
      brief: { decision: 'Should I move?' },
      history: [{ role: 'user', content: 'Should I move?' }],
      attachments: [{ name: att.name, kind: att.kind, text: att.text }],
    }, { cookie });
    assert.equal(r.status, 200);
    assert.ok(fakeHits > before, 'fake Gemini was not reached');
    const j = await r.json();
    assert.equal(j.success, true);
  });

  await t('large attachment text is accepted when sent as JSON field (trimmed by client budget)', async () => {
    const big = 'x'.repeat(50_000);
    const up = await attachRaw(new TextEncoder().encode(big), 'large.txt');
    assert.equal(up.status, 200);
    const att = (await up.json()).data;
    const r = await post(srv, '/api/conversation', {
      brief: { decision: 'Should I move?' },
      history: [{ role: 'user', content: 'Should I move?' }],
      attachments: [{ name: att.name, kind: att.kind, text: String(att.text || '').slice(0, 30_000) }],
    }, { cookie });
    assert.equal(r.status, 200);
  });

  await t('attachment rejects mismatched binary signature', async () => {
    const r = await attachRaw(new TextEncoder().encode('not a pdf'), 'fake.pdf');
    assert.equal(r.status, 415);
    const j = await r.json();
    assert.equal(j.code, 'UNSUPPORTED_TYPE');
  });

  await t('document endpoint generates DOCX', async () => {
    const r = await fetch(srv.base + '/api/export-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        format: 'docx',
        document: {
          title: 'Test note',
          blocks: [
            { type: 'paragraph', text: 'Hello' },
            { type: 'bullets', items: ['One'] },
          ],
        },
      }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /wordprocessingml/);
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert.ok(bytes[0] === 0x50 && bytes[1] === 0x4b, 'DOCX should be a ZIP container');
  });

  await t('document download uses English ASCII file name even for Cyrillic titles', async () => {
    const r = await fetch(srv.base + '/api/export-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        format: 'pdf',
        document: {
          title: 'Тестовый документ',
          blocks: [{ type: 'paragraph', text: 'Проверка' }],
        },
      }),
    });
    assert.equal(r.status, 200);
    const cd = r.headers.get('content-disposition') || '';
    // Product rule: downloaded names are always English ASCII (transliterated title).
    assert.match(cd, /filename="[a-z0-9-]+\.pdf"/i);
    assert.equal(/filename\*=/.test(cd), false);
  });

  await t('document endpoint generates PDF with the bundled Unicode font', async () => {
    const r = await fetch(srv.base + '/api/export-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        format: 'pdf',
        document: {
          title: 'Тестовый документ',
          blocks: [{ type: 'paragraph', text: 'Проверка кириллицы' }],
        },
      }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /application\/pdf/);
    const text = Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString('ascii');
    assert.equal(text, '%PDF-');
  });
  await t('tampered cookie is rejected', async () => {
    const bad = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    assert.equal((await (await fetch(srv.base + '/api/session', { headers: { cookie: bad } })).json()).authenticated, false);
  });

  // 2. Chat answer without markdown + user key never logged (needs the SDK to honour GOOGLE_GEMINI_BASE_URL)
  await t('chat reply has no markdown symbols; user key not logged', async () => {
    const before = fakeHits;
    const r = await post(srv, '/api/conversation', { brief: { decision: 'Should I move to a cooler city?' }, history: [{ role: 'user', content: 'Should I move to a cooler city?' }] },
      { cookie, 'x-byok-key': BYOK });
    if (fakeHits === before) { skipped++; console.log('   SKIPPED: fake Gemini was not reached (SDK ignored GOOGLE_GEMINI_BASE_URL); status', r.status); return; }
    const j = await r.json();
    const reply = j?.data?.reply ?? j?.reply ?? '';
    assert.ok(reply.length > 0, 'empty reply: ' + JSON.stringify(j).slice(0, 200));
    assert.ok(!/[*#]/.test(reply), 'markdown left in reply: ' + reply);
    assert.ok(reply.includes('- first item') && reply.includes('- second item'));
    assert.ok(!srv.getLog().includes(BYOK), 'user key found in server log');
  });

  // 3. Session survives a restart (same SESSION_SECRET)
  await srv.stop(); srv = await startServer();
  await t('session survives server restart', async () => {
    assert.equal((await (await fetch(srv.base + '/api/session', { headers: { cookie } })).json()).authenticated, true);
  });
  await srv.stop();

  // 4. Brute force limit; spoofed X-Forwarded-For does not help; window expires
  srv = await startServer({ LOGIN_MAX_FAILS: '5', LOGIN_WINDOW_MIN: '0.05' });   // 3-second window
  await t('brute force: blocked with 429 after the limit, even with a spoofed forwarded address', async () => {
    let status = 0, retry = null;
    for (let i = 0; i < 8 && status !== 429; i++) {
      const r = await post(srv, '/api/login', { password: 'bad' + i }, { 'X-Forwarded-For': `1.1.1.${i}, 9.9.9.9` });
      status = r.status; retry = r.headers.get('retry-after');
    }
    assert.equal(status, 429); assert.ok(retry && Number(retry) >= 1);
    const ok = await post(srv, '/api/login', { password: PASS }, { 'X-Forwarded-For': '2.2.2.2, 9.9.9.9' });
    assert.equal(ok.status, 429, 'correct password must wait while blocked');
  });
  await t('after the pause the correct password is accepted', async () => {
    await sleep(3300);
    assert.equal((await post(srv, '/api/login', { password: PASS }, { 'X-Forwarded-For': '9.9.9.9' })).status, 200);
  });
  await srv.stop();

  // 5. Startup rules
  await t('auth enabled without SESSION_SECRET: server refuses to start', async () => {
    let failed = false;
    try { await startServer({ SESSION_SECRET: undefined }); } catch (e) { failed = /SESSION_SECRET/.test(String(e.message)); }
    assert.ok(failed);
  });
  await t('empty password in production: loud warning, site stays open', async () => {
    const s = await startServer({ APP_PASSWORD: '', SESSION_SECRET: undefined });
    assert.ok(/WARNING/.test(s.getLog()) && /DISABLED/.test(s.getLog()));
    assert.equal((await (await fetch(s.base + '/api/session')).json()).required, false);
    await s.stop();
  });
} finally { fake.close(); }

console.log(`${n} tests passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(0);
