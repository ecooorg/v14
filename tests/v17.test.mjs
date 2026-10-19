// Stage 2: real server.ts + fake Gemini. Service fields must not reach the user.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let answer = {}; let lastPrompt = '';
const fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  lastPrompt = b; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] })); }); });
await new Promise((r) => fake.listen(0, r));
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS,
  SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_ROUND_PAUSE_MS: '10' } });
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(250); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const ask = async (state) => (await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ brief: { decision: 'Should I move?' }, history: [{ role: 'user', content: 'Should I move?' }], state }) })).json();

  answer = { reply: '**Hello** (USER FACT) problemClear: false', question: 'Which city? And when?', contextSufficiency: 'HIGH', triage: 'PROCEED',
    problemClear: false, driftDetected: true, notUnderstoodSignal: true, gain: [], newOptions: [],
    state: { coreProblem: 'Move or stay', facts: ['f'], hypotheses: ['h'], driftDetected: true, secret: 'x' } };
  let r = await ask({ facts: ['old'], unknowns: ['u'] });   // old-format state
  assert.equal(r.success, true);
  const out = JSON.stringify(r.data);
  assert.ok(!/problemClear|driftDetected|notUnderstoodSignal|USER FACT|\*\*/.test(out), 'service data leaked: ' + out);
  assert.equal(r.data.question, 'Which city?', 'one question, allowed although context was HIGH');
  assert.equal(r.data.state.coreProblem, 'Move or stay');
  assert.equal('secret' in r.data.state, false);
  assert.ok(lastPrompt.includes('V17 LAYER'));
  console.log('ok - service fields and labels do not reach the user; old state accepted; one question');

  answer = { ...answer, state: { facts: ['a hypothesis'], hypotheses: ['a hypothesis'] }, problemClear: true, notUnderstoodSignal: false, contextSufficiency: 'MEDIUM' };
  r = await ask({});
  assert.deepEqual(r.data.state.facts, []);
  console.log('ok - hypothesis from the model does not reach facts in the response');
  console.log('2 tests passed');
} finally { child.kill(); fake.close(); }
