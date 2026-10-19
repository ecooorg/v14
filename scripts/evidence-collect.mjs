#!/usr/bin/env node
/**
 * PA-01 — Evidence Bot collector. Read-only checks that need no human judgement:
 *   RM-A3 service health (/health commit equals the expected main commit, /ready, one Simple Mode answer),
 *   RM-A4 / RM-B2 / RM-D1 connection checks (verify:connections), reported as PASS only where the check covers the whole PASS criterion.
 * Output: JSON { generated_at, commit, run, checks[], steps{} } where `steps` feeds scripts/gate-eval.mjs.
 * Never prints or stores secret values. Does not write to the service, the database or the repository.
 *
 * Env (names only): SERVICE_URL, EXPECTED_SHA, APP_PASSWORD (optional: enables the one-answer smoke),
 *   GEMINI_API_KEY, GROQ_API_KEY, GITHUB_APP_ID (+ other GITHUB_APP_* for the github check),
 *   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID (record link when run in Actions).
 * Usage: node scripts/evidence-collect.mjs [--out evidence.json] [--summary file.md] [--skip-connections]
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scrub } from './gate-eval.mjs';

const TIMEOUT_MS = 20_000;

function runRecord(env) {
  if (env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY) return `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return null;
}
const sameCommit = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

async function getJson(fetcher, url) {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { http: r.status, body };
  } catch (e) { return { http: 0, body: null, error: String(e?.name || 'error') }; }
}

/** RM-A3 parts: health + ready + optional one answer. */
export async function checkService(env, fetcher = fetch) {
  const base = (env.SERVICE_URL || '').replace(/\/+$/, '');
  if (!base) return { health: { status: 'NOT_RUN', detail: 'no_service_url' }, ready: { status: 'NOT_RUN', detail: 'no_service_url' }, smoke: { status: 'NOT_RUN', detail: 'no_service_url' } };
  const h = await getJson(fetcher, `${base}/health`);
  let health;
  if (h.http !== 200 || h.body?.status !== 'ok') health = { status: 'FAIL', detail: `health http=${h.http}${h.error ? ` ${h.error}` : ''}` };
  else if (!env.EXPECTED_SHA) health = { status: 'NOT_RUN', detail: 'no_expected_sha' };
  else health = sameCommit(h.body.commit, env.EXPECTED_SHA)
    ? { status: 'PASS', detail: `commit ${String(h.body.commit).slice(0, 7)} equals main` }
    : { status: 'FAIL', detail: `commit ${String(h.body.commit).slice(0, 7)} differs from expected ${String(env.EXPECTED_SHA).slice(0, 7)}` };
  const r = await getJson(fetcher, `${base}/ready`);
  const ready = r.http === 200 && r.body?.status === 'ready' ? { status: 'PASS', detail: 'database ready' } : { status: 'FAIL', detail: `ready http=${r.http} ${r.body?.reason || ''}`.trim() };
  let smoke;
  if (!env.APP_PASSWORD) smoke = { status: 'NOT_RUN', detail: 'no_app_password' };
  else {
    try {
      const lr = await fetcher(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.APP_PASSWORD }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
      if (!lr.ok || !cookie) smoke = { status: 'FAIL', detail: `login http=${lr.status}` };
      else {
        const q = 'Выбираю между двумя предложениями о работе. С чего начать?';
        const cr = await fetcher(`${base}/api/conversation`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ brief: { decision: q }, history: [{ role: 'user', content: q }] }), signal: AbortSignal.timeout(70_000) });
        const j = await cr.json().catch(() => null);
        if (j?.success && typeof j.data?.reply === 'string' && j.data.reply.length > 0) smoke = { status: 'PASS', detail: 'one answer received' };
        else smoke = { status: 'FAIL', detail: `conversation http=${cr.status} ${/GEMINI_QUOTA/.test(JSON.stringify(j) || '') ? 'GEMINI_QUOTA' : 'no_reply'}` };
      }
    } catch (e) { smoke = { status: 'FAIL', detail: `smoke ${String(e?.name || 'error')}` }; }
  }
  return { health, ready, smoke };
}

/** Run verify:connections for connectors whose secrets are present. Injectable for tests. */
export function runVerify(only) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'verify:connections', '--', '--json', '--only', only.join(',')], { encoding: 'utf8', timeout: 120_000, env: process.env });
  const line = (r.stdout || '').split('\n').reverse().find((l) => l.trim().startsWith('{'));
  try { return JSON.parse(line); } catch { return null; }
}

const rollup = (results, connector) => {
  const rs = (results || []).filter((x) => x.connector === connector);
  if (!rs.length) return { status: 'NOT_RUN', detail: 'no_result' };
  if (rs.some((x) => x.status === 'FAIL' || x.status === 'DRIFT')) return { status: 'FAIL', detail: rs.filter((x) => x.status === 'FAIL' || x.status === 'DRIFT').map((x) => `${x.check}:${x.status}`).join(',') };
  if (rs.some((x) => x.status === 'BLOCKED')) return { status: 'BLOCKED', detail: 'blocked' };
  if (rs.every((x) => x.status === 'OK')) return { status: 'PASS', detail: 'all checks OK' };
  return { status: 'NOT_RUN', detail: rs.map((x) => x.reason).filter(Boolean).join(',') || 'not_run' };
};

export async function collect({ env = process.env, fetcher = fetch, verify = runVerify, skipConnections = false } = {}) {
  const record = runRecord(env);
  const checks = [];
  const add = (id, step, c, extra = {}) => checks.push({ id, step, status: c.status, detail: c.detail, ...extra });

  const svc = await checkService(env, fetcher);
  add('service_health', 'RM-A3', svc.health);
  add('service_ready', 'RM-A4', svc.ready);
  add('simple_mode_smoke', 'RM-A3', svc.smoke);

  const conn = {};
  if (skipConnections) for (const c of ['gemini', 'groq', 'github']) conn[c] = { status: 'NOT_RUN', detail: 'skipped' };
  else {
    const want = [];
    if (env.GEMINI_API_KEY) want.push('gemini');
    if (env.GROQ_API_KEY) want.push('groq');
    if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_WEBHOOK_SECRET) want.push('github');
    const out = want.length ? verify(want) : null;
    for (const c of ['gemini', 'groq', 'github']) conn[c] = want.includes(c) ? (out ? rollup(out.results, c) : { status: 'BLOCKED', detail: 'verify_failed_to_run' }) : { status: 'NOT_RUN', detail: 'no_secrets' };
  }
  add('connection_gemini', 'RM-A4', conn.gemini);
  add('connection_groq', 'RM-B2', conn.groq);
  add('connection_github', 'RM-D1', conn.github);

  // Step verdicts: PASS only where the collected checks cover the whole PASS criterion of docs/NEXT.md.
  const s = (id) => checks.find((c) => c.id === id)?.status;
  const steps = {};
  const put = (step, status, note) => { steps[step] = { status, record: status === 'PASS' || status === 'PARTIAL' ? record : null, note }; };
  const a3 = [s('service_health'), s('simple_mode_smoke')];
  put('RM-A3', a3.includes('FAIL') ? 'FAIL' : a3.every((x) => x === 'PASS') ? 'PASS' : a3[0] === 'PASS' ? 'PARTIAL' : 'NOT_RUN', 'health commit + one answer; quota lines in Railway logs are not read here');
  const a4 = [s('connection_gemini'), s('connection_groq'), s('service_ready')];
  put('RM-A4', a4.includes('FAIL') ? 'FAIL' : a4.every((x) => x === 'PASS') ? 'PASS' : a4.includes('BLOCKED') ? 'BLOCKED' : 'NOT_RUN', 'gemini + groq connection checks and /ready (database)');
  put('RM-B2', s('connection_groq') === 'FAIL' ? 'FAIL' : s('connection_groq') === 'PASS' ? 'PARTIAL' : s('connection_groq') === 'BLOCKED' ? 'BLOCKED' : 'NOT_RUN', 'connection OK; the real smoke and the registry data_policy record are not covered');
  put('RM-D1', s('connection_github') === 'FAIL' ? 'FAIL' : s('connection_github') === 'PASS' ? 'PARTIAL' : s('connection_github') === 'BLOCKED' ? 'BLOCKED' : 'NOT_RUN', 'App flow OK; the signed webhook 202 is not covered');

  return { version: 1, generated_at: new Date().toISOString(), commit: env.EXPECTED_SHA || null, run: record, checks, steps };
}

export function summaryMarkdown(r) {
  const rows = r.checks.map((c) => `| ${c.step} | ${c.id} | ${c.status} | ${c.detail} |`).join('\n');
  return scrub(`## Evidence run\n\ncommit: ${r.commit || 'unknown'}  run: ${r.run || 'local (no record link)'}\n\n| Step | Check | Status | Detail |\n| --- | --- | --- | --- |\n${rows}\n`);
}

async function main() {
  const a = process.argv.slice(2);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const r = await collect({ skipConnections: a.includes('--skip-connections') });
  const json = scrub(JSON.stringify(r, null, 2));
  if (val('--out')) fs.writeFileSync(val('--out'), json + '\n'); else console.log(json);
  if (val('--summary')) fs.appendFileSync(val('--summary'), summaryMarkdown(r));
  else if (val('--out')) console.log(summaryMarkdown(r));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`evidence-collect failed: ${String(e?.message || e).slice(0, 200)}`); process.exit(1); });
