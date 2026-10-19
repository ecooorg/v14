// npm run verify:connections [-- --only gemini,postgres --json --dry-run]  (TZ E.6). No LLM; never prints secret values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY_ALL } from '../server/modelRegistry.ts';
import { verifyGitHubAppConnection } from '../server/githubIntegration.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const only = args.includes('--only') ? String(args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean) : null;
const dryRun = flag('--dry-run');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'connectors.yaml'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
const TIMEOUT_MS = 10_000;

const results = [];
const add = (connector, check, status, extra = {}) => results.push({ connector, check, status, ...extra });
const present = (n) => Boolean(process.env[n]);

async function httpCheck(id, c, url, body) {
  const t0 = Date.now();
  const override = process.env[`${id.toUpperCase()}_BASE_URL_OVERRIDE`];
  const target = override ? override.replace(/\/$/, '') + new URL(url).pathname + new URL(url).search : url;
  let res;
  try {
    res = await fetch(target, {
      method: c.method,
      headers: { [c.auth.header]: (c.auth.scheme ? `${c.auth.scheme} ` : '') + process.env[c.auth.env], ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { status: 'FAIL', reason: e?.name === 'TimeoutError' ? 'timeout' : 'network_error', latency_ms: Date.now() - t0 };
  }
  const latency_ms = Date.now() - t0;
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 404) return { status: 'DRIFT', reason: 'http_404', http: 404, latency_ms };
  if (res.status !== c.expect.status) return { status: 'FAIL', reason: `http_${res.status}`, http: res.status, latency_ms };
  if (c.expect.content_is_json) {
    try { JSON.parse(json?.choices?.[0]?.message?.content); } catch { return { status: 'DRIFT', reason: 'content_not_json', http: res.status, latency_ms }; }
  }
  const missing = (c.expect.json_has || []).filter((k) => !json || json[k] === undefined);
  if (missing.length) return { status: 'DRIFT', reason: `missing_field:${missing.join(',')}`, http: res.status, latency_ms };
  return { status: 'OK', http: res.status, latency_ms, json };
}

async function sqlCheck(c) {
  const t0 = Date.now();
  let pool;
  try {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: TIMEOUT_MS, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
    const r = await pool.query(c.query);
    return r.rowCount === c.expect.rows ? { status: 'OK', latency_ms: Date.now() - t0 } : { status: 'FAIL', reason: 'unexpected_rows', latency_ms: Date.now() - t0 };
  } catch { return { status: 'FAIL', reason: 'db_unreachable', latency_ms: Date.now() - t0 }; }
  finally { await pool?.end().catch(() => undefined); }
}

for (const [id, conn] of Object.entries(manifest.connectors)) {
  if (only && !only.includes(id)) continue;
  const required = id === 'github' && process.env.CODE_EXECUTOR === 'model_patch'
    ? [...(conn.env.required || []), 'GITHUB_REPOSITORY_OWNER', 'GITHUB_REPOSITORY_NAME']
    : id === 'github' ? [...(conn.env.required || []), 'GITHUB_REPOSITORY_OWNER', 'GITHUB_REPOSITORY_NAME'] : (conn.env.required || []);
  const missing = required.filter((n) => !present(n));
  if (dryRun) {
    for (const c of conn.checks) add(id, c.id, 'NOT_RUN', { reason: 'dry_run', env_present: Object.fromEntries((conn.env.required || []).map((n) => [n, present(n)])) });
    continue;
  }
  if (missing.length) { add(id, 'env', 'BLOCKED', { reason: `missing_secret:${missing[0]}` }); continue; }
  let listed = null;
  for (const c of conn.checks) {
    let r;
    if (c.kind === 'github_app_flow') {
      const result = await verifyGitHubAppConnection({
        appId: process.env.GITHUB_APP_ID || '',
        installationId: process.env.GITHUB_APP_INSTALLATION_ID || '',
        privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        owner: process.env.GITHUB_REPOSITORY_OWNER || '',
        repository: process.env.GITHUB_REPOSITORY_NAME || '',
        apiBaseUrl: process.env.GITHUB_API_BASE_URL,
      });
      add(id, c.id, result.status, result.status === 'OK' ? { repository: result.repository } : { reason: result.reason });
      continue;
    }
    if (c.kind === 'sql') r = await sqlCheck(c);
    else if (c.id === 'tiny_json_call') {
      if (!listed) { add(id, c.id, 'NOT_RUN', { reason: 'depends_on:list_models' }); continue; }
      const names = new Set((listed.data || []).map((m) => String(m.id || '')));
      const model = REGISTRY_ALL.find((e) => e.providerId === id && names.has(e.modelId));
      if (!model) { add(id, c.id, 'DRIFT', { reason: 'no_registry_model_in_list' }); continue; }
      r = await httpCheck(id, c, c.url, { model: model.modelId, messages: [{ role: 'user', content: 'Reply with a JSON object: {"ok":true}' }], response_format: { type: 'json_object' }, max_tokens: 300 });
    } else if (c.id === 'tiny_call') {
      if (!listed) { add(id, c.id, 'NOT_RUN', { reason: 'depends_on:list_models' }); continue; }
      const names = new Set((listed.models || []).map((m) => String(m.name || '').replace(/^models\//, '')));
      const model = REGISTRY_ALL.find((e) => e.providerId === id && names.has(e.modelId));
      if (!model) { add(id, c.id, 'DRIFT', { reason: 'no_registry_model_in_list' }); continue; }
      r = await httpCheck(id, c, c.url.replace('{MODEL_ID}', model.modelId), { contents: [{ parts: [{ text: 'Reply with one word: ok' }] }], generationConfig: { maxOutputTokens: 10 } });
    } else r = await httpCheck(id, c, c.url);
    if (c.id === 'list_models' && r.status === 'OK') listed = r.json;
    const { json: _j, ...clean } = r;
    add(id, c.id, clean.status, clean);
  }
}

const summary = { OK: 0, FAIL: 0, DRIFT: 0, BLOCKED: 0, NOT_RUN: 0 };
for (const r of results) summary[r.status]++;
let out = JSON.stringify({ version: 1, checked_at: new Date().toISOString(), results, summary });
for (const n of Object.keys(process.env)) {   // defence in depth: a secret value must never reach the output
  const v = process.env[n];
  if (/KEY|SECRET|PASSWORD|DATABASE_URL|TOKEN/.test(n) && v && v.length >= 6) out = out.split(v).join('[redacted]');
}
if (flag('--json')) console.log(out);
else for (const r of results) console.log(`${r.connector}/${r.check}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.http ? ` http=${r.http}` : ''}`);

if (!dryRun && process.env.DATABASE_URL && results.length) {   // record the run; a failure here never changes the verdict
  try {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: TIMEOUT_MS, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
    for (const r of results) await pool.query('INSERT INTO connection_checks(id,connector,check_id,status,reason,http_status,latency_ms) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [`${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`, r.connector, r.check, r.status, r.reason ?? null, r.http ?? null, r.latency_ms ?? null]);
    await pool.end();
  } catch { if (!flag('--json')) console.log('connection_checks: not recorded (table or database unavailable)'); }
}
process.exitCode = summary.FAIL || summary.DRIFT ? 2 : summary.BLOCKED ? 3 : 0;
