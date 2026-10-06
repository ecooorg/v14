// QA-02: 10 control situations. Real server.ts + fake Gemini returning a fixed (deliberately messy) model answer.
// Checks server-side processing only; live answer quality is checked in stage 2 (S2-06).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const CASES = JSON.parse(readFileSync(new URL('../fixtures/regression.json', import.meta.url), 'utf8'));
const PASS = 'test-pass-123', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
let answer = {}, hits = 0;
const fake = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { hits++; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] })); }); });
await new Promise((r) => fake.listen(0, r));
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const child = spawn('tsx', ['server.ts'], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_PASSWORD: PASS,
  SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_ROUND_PAUSE_MS: '10' } });
const MARKUP = /\*\*|__|^#{1,6}\s|`|^\s*[*•]\s/m, LABELS = /USER[ _]FACT|GENERAL[ _]KNOWLEDGE|HYPOTHESIS|problemClear|driftDetected|notUnderstoodSignal|\(Source:|USER_DATA|GENERAL_PATTERN/;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(250); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  for (const c of CASES) {
    answer = c.model; hits = 0;
    let history = [{ role: 'user', content: c.first }];
    if (c.second) history = [...history, { role: 'assistant', content: c.previousAssistant || 'ok' }, { role: 'user', content: c.second }];
    const r = await (await fetch(base + '/api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ brief: { decision: c.first }, history, state: c.previousAssistant ? { facts: [], hypotheses: [] } : undefined }) })).json();
    assert.equal(r.success, true, c.id + ': ' + JSON.stringify(r));
    const reply = r.data.reply, e = c.expect;
    const qn = (reply.match(/[?？]/g) || []).length;
    assert.ok(qn <= e.maxQuestions, `${c.id}: ${qn} questions > ${e.maxQuestions}\n${reply}`);
    if (e.noMarkup) assert.ok(!MARKUP.test(reply), `${c.id}: markup in reply\n${reply}`);
    if (e.noLabels) assert.ok(!LABELS.test(JSON.stringify(r.data)), `${c.id}: service label leaked`);
    for (const f of e.factsAbsent) assert.ok(!r.data.state.facts.includes(f), `${c.id}: hypothesis in facts`);
    assert.ok(reply.trim().length > 20, c.id + ': empty reply');
    // v19 (PERF-01): meta.calls counts every model call of the request, including the quality retry
    assert.equal(r.meta.calls, e.calls, `${c.id}: model calls ${r.meta.calls}`);
    assert.equal(hits, r.meta.calls, `${c.id}: meta.calls ${r.meta.calls} != real model hits ${hits}`);
    console.log('ok -', c.id);
  }
  console.log(CASES.length + ' tests passed');
} finally { child.kill(); fake.close(); }
