// PERF-01: prompt size and token counts are reported in meta; nothing of it reaches the reply text.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let withUsage = true; let calls = 0; let requestBodies = [];
const answer = { reply: 'Plain text reply.', question: 'Which city?', contextSufficiency: 'MEDIUM', triage: 'PROCEED', problemClear: true,
  gain: ['HIDDEN_ASSUMPTION'], newOptions: [], state: { coreProblem: 'Move or stay' } };
const fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  calls++; requestBodies.push(b); res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
    ...(withUsage ? { usageMetadata: { promptTokenCount: 4321, candidatesTokenCount: 210, cachedContentTokenCount: 123, totalTokenCount: 4531 } } : {}) })); }); });
await new Promise((r) => fake.listen(0, r));
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS,
  SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_ROUND_PAUSE_MS: '10' } });
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(250); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const ask = async () => (await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ brief: { decision: 'Should I move?' }, history: [{ role: 'user', content: 'Should I move?' }] }) })).json();

  let r = await ask();
  assert.equal(r.success, true);
  assert.ok(r.meta.promptChars > 3000, 'promptChars should include the system instruction and prompt, got ' + r.meta.promptChars);
  assert.ok(r.meta.inputTokens > 0 && r.meta.outputTokens > 0, 'token counts expected when the API returns them');
  assert.equal(r.meta.inputTokens, 4321 * r.meta.calls, 'tokens are summed over all model responses of the request');
  assert.equal(r.meta.cachedTokens, 123 * r.meta.calls, 'cached tokens are reported in meta');
  assert.ok(!/promptChars|inputTokens|outputTokens|cachedTokens/.test(JSON.stringify(r.data)), 'size data must not be in the answer data');
  assert.ok(!/promptChars|inputTokens|outputTokens|cachedTokens/.test(r.data.reply), 'size data must not be in the reply text');
  console.log('ok - promptChars, token counts and cached tokens are in meta, not in the reply');

  // Token Economy v1.6: the server keeps the full dialogue locally but sends only the last 8 raw turns to Gemini.
  withUsage = true; requestBodies.length = 0; calls = 0;
  const longHistory = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `TURN-${i}-${'x'.repeat(200)}` }));
  r = await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ brief: { decision: 'Should I move?' }, history: longHistory }) }).then(x => x.json());
  assert.equal(r.success, true);
  const sentText = requestBodies.at(-1)?.contents?.[0]?.parts?.[0]?.text || '';
  const turns = sentText.match(/TURN-\d+/g) || [];
  assert.deepEqual(turns, ['TURN-12','TURN-13','TURN-14','TURN-15','TURN-16','TURN-17','TURN-18','TURN-19'], 'only the last 8 turns should reach Gemini');
  assert.equal(r.meta.cachedTokens, 123, 'cached tokens remain visible after compaction');
  console.log('ok - Token Economy compacts the raw transcript to the last 8 turns');

  withUsage = false;
  r = await ask();
  assert.equal(r.success, true);
  assert.ok(r.meta.promptChars > 3000);
  assert.equal('inputTokens' in r.meta, false);
  assert.equal('outputTokens' in r.meta, false);
  console.log('ok - without usageMetadata only promptChars is reported');
  console.log('2 tests passed');
} finally { child.kill(); fake.close(); }
