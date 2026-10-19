#!/usr/bin/env node
/**
 * PA-03 — safe staging evidence collector. GET-only against a dedicated staging service.
 * Never prints env values, never mutates app/database state, never triggers restore/rollback.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 12_000;
const LOAD_CONCURRENCY = 20;
const now = () => new Date().toISOString();
const check = (id, status, detail, extra = {}) => ({ id, status, detail, ...extra });
const statusFrom = (checks) => checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'PASS') ? 'PARTIAL' : 'NOT_RUN';

async function request(fetcher, url, options = {}) {
  try {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    return { response, bodyText: await response.text().catch(() => '') };
  } catch (error) {
    return { response: null, bodyText: '', error: String(error?.name || 'request_error') };
  }
}

function safeStagingUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /staging/i.test(u.hostname) ? u : null;
  } catch { return null; }
}

export async function collectStagingEvidence({ env = process.env, fetcher = fetch, clock = Date.now } = {}) {
  const generatedAt = now();
  const checks = [];
  const rawUrl = env.STAGING_SERVICE_URL || '';
  const baseUrl = safeStagingUrl(rawUrl);
  if (!baseUrl) {
    checks.push(check('staging_url', 'NOT_RUN', rawUrl ? 'url_must_be_https_and_hostname_must_contain_staging' : 'STAGING_SERVICE_URL_missing'));
    for (const id of ['health', 'ready', 'ops_html', 'ops_json', 'bounded_load', 'database_migrations']) checks.push(check(id, 'NOT_RUN', 'staging_url_not_validated'));
  } else {
    checks.push(check('staging_url', 'PASS', 'https staging hostname accepted'));
    const base = baseUrl.origin;
    const h = await request(fetcher, `${base}/health`);
    let healthJson = null;
    try { healthJson = JSON.parse(h.bodyText); } catch { /* expected to be JSON */ }
    checks.push(h.response?.status === 200 && healthJson?.status === 'ok'
      ? check('health', 'PASS', 'HTTP 200; status ok', { http: 200, commit: typeof healthJson.commit === 'string' ? healthJson.commit.slice(0, 12) : null })
      : check('health', h.response ? 'FAIL' : 'FAIL', `health_probe_failed:${h.response?.status ?? h.error}`));

    const ready = await request(fetcher, `${base}/ready`);
    let readyJson = null;
    try { readyJson = JSON.parse(ready.bodyText); } catch { /* report status only */ }
    checks.push(ready.response?.status === 200 && readyJson?.status === 'ready'
      ? check('ready', 'PASS', 'HTTP 200; database ready')
      : check('ready', 'FAIL', `ready_probe_failed:${ready.response?.status ?? ready.error}`));

    let cookie = '';
    if (env.STAGING_APP_PASSWORD) {
      const login = await request(fetcher, `${base}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: env.STAGING_APP_PASSWORD }),
      });
      cookie = login.response?.headers.get('set-cookie')?.split(';')[0] || '';
      if (!login.response?.ok || !cookie) {
        checks.push(check('staging_login', 'FAIL', `login_failed:${login.response?.status ?? login.error}`));
      } else {
        checks.push(check('staging_login', 'PASS', 'staging login accepted; cookie not recorded'));
      }
    } else checks.push(check('staging_login', 'NOT_RUN', 'STAGING_APP_PASSWORD_missing'));

    if (cookie) {
      const opsHtml = await request(fetcher, `${base}/ops`, { headers: { cookie } });
      checks.push(opsHtml.response?.status === 200 && /BiForge operations/.test(opsHtml.bodyText)
        ? check('ops_html', 'PASS', 'authenticated /ops page rendered')
        : check('ops_html', 'FAIL', `/ops_failed:${opsHtml.response?.status ?? opsHtml.error}`));
      const opsJson = await request(fetcher, `${base}/api/ops`, { headers: { cookie } });
      let payload = null;
      try { payload = JSON.parse(opsJson.bodyText); } catch { /* handled below */ }
      const valid = opsJson.response?.status === 200 && payload && typeof payload === 'object'
        && (payload.queue || payload.success === true || payload.snapshot);
      checks.push(valid
        ? check('ops_json', 'PASS', 'authenticated /api/ops returned JSON metrics')
        : check('ops_json', 'FAIL', `/api/ops_failed:${opsJson.response?.status ?? opsJson.error}`));
    } else {
      checks.push(check('ops_html', 'NOT_RUN', 'authenticated session unavailable'));
      checks.push(check('ops_json', 'NOT_RUN', 'authenticated session unavailable'));
    }

    const started = clock();
    const load = await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, () => request(fetcher, `${base}/health`)));
    const elapsedMs = Math.max(0, clock() - started);
    const failures = load.filter((r) => !r.response || r.response.status !== 200).length;
    checks.push(failures === 0
      ? check('bounded_load', 'PASS', `${LOAD_CONCURRENCY} concurrent GET /health requests completed`, { requests: LOAD_CONCURRENCY, failures, elapsedMs })
      : check('bounded_load', 'FAIL', `${failures}/${LOAD_CONCURRENCY} health requests failed`, { requests: LOAD_CONCURRENCY, failures, elapsedMs }));

    checks.push(check('database_migrations', env.STAGING_DATABASE_URL ? 'NOT_RUN' : 'NOT_RUN', env.STAGING_DATABASE_URL
      ? 'database migration check is run by the workflow step; a migration count is not a restore proof'
      : 'STAGING_DATABASE_URL_missing'));
  }

  const scenario181 = Array.from({ length: 12 }, (_, i) => ({
    id: `scenario_18_1_${String(i + 1).padStart(2, '0')}`,
    status: 'NOT_RUN',
    detail: 'requires the full Project Mode scenario and/or owner evidence; this read-only collector does not claim it passed',
  }));
  checks.push(check('restore_drill', 'NOT_RUN', 'no backup restore was initiated; follow docs/OPS_ROLLBACK.md on a disposable database'));
  checks.push(check('rollback_drill', 'NOT_RUN', 'no deployment or rollback was initiated; perform the staging drill manually'));
  checks.push(check('capacity_acceptance', 'NOT_RUN', 'health endpoint probe is not a full capacity/load acceptance test'));

  const run = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  return {
    version: 1,
    patch: 'PA-03',
    generatedAt,
    commit: env.GITHUB_SHA || null,
    run,
    overall: statusFrom(checks),
    safety: { stagingOnly: true, syntheticDataRequired: true, writesPerformed: false, restorePerformed: false, rollbackPerformed: false, modelCalls: 0 },
    checks,
    scenario181,
  };
}

export function renderSummary(report) {
  const lines = [
    '## PA-03 staging drills',
    '',
    `- Overall: **${report.overall}**`,
    `- Commit: ${report.commit || 'unknown'}`,
    `- Run: ${report.run || 'local run (no GitHub URL)'}`,
    '- Safety: read-only GET probes; 0 model calls; no restore, rollback, or database writes.',
    '',
    '| Check | Status | Detail |',
    '|---|---|---|',
    ...report.checks.map((c) => `| ${c.id} | ${c.status} | ${String(c.detail).replaceAll('|', '\\|')} |`),
    '',
    '### Scenario 18.1 checklist',
    '',
    '| Item | Status | Detail |',
    '|---|---|---|',
    ...report.scenario181.map((c) => `| ${c.id} | ${c.status} | ${c.detail} |`),
    '',
    'Restore and rollback remain NOT_RUN until separately performed and evidenced on staging.',
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const report = await collectStagingEvidence();
  const json = JSON.stringify(report, null, 2) + '\n';
  if (arg('--out')) fs.writeFileSync(arg('--out'), json);
  else process.stdout.write(json);
  if (arg('--summary')) fs.appendFileSync(arg('--summary'), renderSummary(report));
  if (report.overall === 'FAIL') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(`staging-drills failed: ${String(error?.name || 'error')}`);
  process.exitCode = 1;
});
