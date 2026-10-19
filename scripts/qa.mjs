#!/usr/bin/env node
// Run checks independently, retain per-check logs, and produce a complete report.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'artifacts', 'qa');
fs.mkdirSync(outDir, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;
const tasks = [
  ['version-consistency', node, ['scripts/check-version.mjs']],
  ['docs-links', node, ['scripts/check-docs.mjs']],
  ['version-test', node, ['tests/version-check.test.mjs']],
  ['copy-lint', node, ['scripts/lint-copy.mjs']],
  ['typecheck', npm, ['run', 'typecheck']],
  ['merge', npm, ['run', 'test:merge']],
  ['security', npm, ['run', 'test:security']],
  ['core', npm, ['run', 'test:core']],
  ['reasoning', npm, ['run', 'test:reasoning']],
  ['export', npm, ['run', 'test:export']],
  ['sync', npm, ['run', 'test:sync']],
  ['files', npm, ['run', 'test:files']],
  ['drive-docs', npm, ['run', 'test:drivedocs']],
  ['library', npm, ['run', 'test:library']],
  ['package-c', npm, ['run', 'test:package-c']],
  ['virtual-server', npm, ['exec', '--', 'tsx', 'tests/virtual/server.test.mjs']],
  ['virtual-infra', npm, ['exec', '--', 'tsx', 'tests/virtual/infra.test.mjs']],
  ['virtual-v17', npm, ['exec', '--', 'tsx', 'tests/virtual/v17.test.mjs']],
  ['virtual-regression', npm, ['exec', '--', 'tsx', 'tests/virtual/regression.test.mjs']],
  ['virtual-perf', npm, ['exec', '--', 'tsx', 'tests/virtual/perf.test.mjs']],
  ['virtual-files', npm, ['exec', '--', 'tsx', 'tests/virtual/files.test.mjs']],
  ['virtual-expert-files', npm, ['exec', '--', 'tsx', 'tests/virtual/expert-files.test.mjs']],
  ['virtual-stage2', npm, ['exec', '--', 'tsx', 'tests/virtual/stage2.test.mjs']],
];
const results = [];
const hasTsx = fs.existsSync(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'));
const hasViteClient = fs.existsSync(path.join(root, 'node_modules', 'vite', 'client.d.ts'));
const startedAt = new Date().toISOString();
console.log(`BiForge QA — ${startedAt}\nRunning ${tasks.length} independent checks.`);
for (const [id, command, args] of tasks) {
  const t0 = Date.now();
  console.log(`\n[RUN] ${id}`);
  let stdout = '', stderr = '', exitCode = null, signal = null, status = 'FAIL';
  try {
    const needsDeps = command === npm;
    const requiresTsx = args.includes('tsx') || args.some(arg => /^test:(merge|security|core|reasoning|export|sync|files|drivedocs|library)$/.test(arg));
    const missing = [];
    if (needsDeps && !fs.existsSync(path.join(root, 'node_modules'))) missing.push('node_modules is missing');
    if (requiresTsx && !hasTsx) missing.push('local tsx executable is missing');
    if (id === 'typecheck' && !hasViteClient) missing.push('vite/client type definitions are missing');
    if (missing.length) {
      status = 'BLOCKED';
      stderr = `${missing.join('; ')}. Install the locked dependencies with npm ci and rerun QA.`;
    } else {
      const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1' } });
      stdout = r.stdout || ''; stderr = r.stderr || ''; exitCode = r.status; signal = r.signal || null;
      if (r.error) stderr += `\nRunner error: ${r.error.stack || r.error.message}\n`;
      status = r.error?.code === 'ETIMEDOUT' ? 'BLOCKED' : exitCode === 0 ? 'PASS' : 'FAIL';
    }
  } catch (e) { stderr = e?.stack || String(e); status = 'BLOCKED'; }
  const durationMs = Date.now() - t0;
  const base = `${stamp}-${id}`;
  fs.writeFileSync(path.join(outDir, `${base}.stdout.log`), stdout);
  fs.writeFileSync(path.join(outDir, `${base}.stderr.log`), stderr);
  results.push({ id, status, exitCode, signal, durationMs, stdoutLog: `${base}.stdout.log`, stderrLog: `${base}.stderr.log` });
  console.log(`[${status}] ${id}: ${(durationMs / 1000).toFixed(1)}s${exitCode === null ? '' : ` (exit ${exitCode})`}`);
  if (status !== 'PASS') {
    const tail = (stdout + '\n' + stderr).trim().split(/\r?\n/).filter(Boolean).slice(-5);
    if (tail.length) console.log(tail.map(x => `  ${x}`).join('\n'));
  }
}
const count = s => results.filter(r => r.status === s).length;
const report = { schemaVersion: 1, project: 'BiForge', startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, summary: { pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED') }, overall: count('FAIL') || count('BLOCKED') ? 'FAIL' : 'PASS', results };
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const rows = results.map(r => `| ${r.status} | ${r.id} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.exitCode ?? '—'} |`);
const md = `# BiForge QA report\n\n- Started: ${startedAt}\n- Finished: ${report.finishedAt}\n- Runtime: ${report.node} (${report.platform})\n- Overall: **${report.overall}**\n- Summary: ${report.summary.pass} PASS, ${report.summary.fail} FAIL, ${report.summary.blocked} BLOCKED\n\n| Status | Check | Duration | Exit |\n|---|---|---:|---:|\n${rows.join('\n')}\n\nEach check has separate stdout/stderr logs in this directory.\n`;
fs.writeFileSync(path.join(outDir, 'summary.md'), md);
console.log(`\nSummary: ${report.summary.pass} PASS, ${report.summary.fail} FAIL, ${report.summary.blocked} BLOCKED`);
console.log('Reports: artifacts/qa/summary.md and results.json');
process.exitCode = report.overall === 'PASS' ? 0 : 1;
