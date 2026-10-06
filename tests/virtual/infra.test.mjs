// INFRA-01: real server.ts + fake Gemini. Format failures, overload fallback, user key vs daily cap.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const PASS = 'test-pass-123', SECRET = 'x'.repeat(40), USER_KEY = 'USER-OWN-KEY-555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// Fake Gemini: records each call (model + key); `behave(model, n)` decides the answer.
const calls = []; let behave = () => ({ status: 200, text: '{}' });
const fake = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    const model = (req.url.match(/models\/([^:/?]+)/) || [])[1] || '?';
    calls.push({ model, key: req.headers['x-goog-api-key'] || '' });
    const r = behave(model, calls.length);
    res.statusCode = r.status; res.setHeader('Content-Type', 'application/json');
    res.end(r.status === 200
      ? JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: r.text }] }, finishReason: 'STOP' }] })
      : JSON.stringify({ error: { code: r.status, status: 'UNAVAILABLE', message: 'The model is overloaded' } }));
  });
});
await new Promise((r) => fake.listen(0, r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
const GOOD = JSON.stringify({ items: [], thirdPersonText: 'A person is choosing.' });

async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn('tsx', ['server.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', PORT: String(port),
    APP_PASSWORD: PASS, SESSION_SECRET: SECRET, GEMINI_API_KEY: 'server-key', GEMINI_BASE_URL: FAKE, TRUST_PROXY_HOPS: '1',
    MODEL_CASCADE_LIGHT: 'm-a,m-b,m-c', LLM_ROUND_PAUSE_MS: '10', ...env } });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('server exited:\n' + log);
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    await sleep(250);
  }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const neutralize = (headers = {}) => fetch(base + '/api/neutralize', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, ...headers },
    body: JSON.stringify({ brief: { decision: 'Should I move to another city?' } }) });
  return { neutralize, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}
let n = 0; const t = async (name, fn) => { calls.length = 0; await fn(); n++; console.log('ok -', name); };

try {
  let s = await startServer({ DAILY_CALL_CAP: '1000' });

  await t('format failure: one retry on another model, not the whole chain', async () => {
    behave = () => ({ status: 200, text: 'this is not json' });
    const r = await s.neutralize();
    assert.ok(r.status >= 400, 'request should fail cleanly');
    assert.equal(calls.length, 2, 'expected 1 call + 1 retry, got ' + calls.length);
    assert.notEqual(calls[0].model, calls[1].model, 'retry must use a different model');
  });

  await t('format failure then success on the retry', async () => {
    behave = (m, i) => (i === 1 ? { status: 200, text: 'oops' } : { status: 200, text: GOOD });
    const r = await s.neutralize();
    assert.equal(r.status, 200); assert.equal(calls.length, 2);
    assert.ok((await r.json()).meta.calls === 2);
  });

  await t('overloaded main model: moves on to the next model', async () => {
    behave = (m) => (m === 'm-a' ? { status: 503, text: '' } : { status: 200, text: GOOD });
    const r = await s.neutralize();
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.meta.model, 'm-b'); assert.equal(j.meta.fallback, true);
    assert.deepEqual(calls.map((c) => c.model), ['m-a', 'm-b']);
  });
  await s.stop();

  s = await startServer({ DAILY_CALL_CAP: '2' });
  await t("user's own key is not counted in the server's daily limit", async () => {
    behave = () => ({ status: 200, text: GOOD });
    assert.equal((await s.neutralize()).status, 200);
    assert.equal((await s.neutralize()).status, 200);
    const blocked = await s.neutralize();
    assert.equal(blocked.status, 429); assert.equal((await blocked.json()).code, 'DAILY_CAP');
    calls.length = 0;
    for (let i = 0; i < 3; i++) assert.equal((await s.neutralize({ 'x-byok-key': USER_KEY })).status, 200);
    assert.ok(calls.length >= 3 && calls.every((c) => c.key === USER_KEY), 'user key must be the one sent to Google');
  });
  await s.stop();
} finally { fake.close(); }
console.log(`${n} tests passed`);
process.exit(0);
