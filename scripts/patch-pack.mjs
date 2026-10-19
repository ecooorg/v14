// Patch delivery runner: preflight and archive creation are independent from quality checks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readTree, readZipTree, diffTrees, summaryLine, buildZip, preflight, allowlistFromToml, firstFailure, overallStatus, renderReport } from './patch-tools.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const root = process.cwd();
const basePath = opt('base');
if (!basePath || !fs.existsSync(basePath)) {
  console.error('Usage: npm run patch:pack -- --base <archive.zip|folder> --patch <PNN> --agent "<tool, model>"');
  process.exit(64);
}
const patch = opt('patch', 'PNN');
const archiveId = patch.toUpperCase().replace(/[^A-Z0-9._-]/g, '_');
const outPath = path.resolve(opt('out', `bf-${archiveId}.zip`));
const reportPath = path.resolve(opt('report', 'patch-report.md'));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const skip = new Set(opt('skip', '').split(',').map((x) => x.trim()).filter(Boolean));
const LIMITS = { ci: 600, typecheck: 300, check: 900, live: 600, build: 300, 'check-version': 120 };
const DEPENDENCY_FREE = new Set(['check-version', 'check:docs', 'lint:copy', 'test:version']);
const logPatch = opt('patch', 'PNN').replace(/[^a-zA-Z0-9._-]/g, '_');
const logDir = path.resolve('patch-logs', logPatch);
fs.mkdirSync(logDir, { recursive: true });

const base = fs.statSync(basePath).isDirectory() ? readTree(basePath) : await readZipTree(fs.readFileSync(basePath));
const work = readTree(root);
const diff = diffTrees(base, work);
const files = new Map([...diff.replace, ...diff.add].map((rel) => [rel, work.get(rel)]));
const toml = fs.existsSync('.gitleaks.toml') ? fs.readFileSync('.gitleaks.toml', 'utf8') : '';
const violations = preflight({ files, deleted: diff.del, allowlist: allowlistFromToml(toml) });
const commands = [];
const agent = opt('agent', 'not stated');
const ownerSteps = opt('owner-steps') ? opt('owner-steps').split(';').map((s) => s.trim()) : [
  'Загрузить файлы архива в main; дождаться CI и сверить commit в /health.',
  'Открыть сайт и /project, проверить сценарий, затронутый патчем.',
  `Сверить оставшиеся падения с docs/${patch}-REPORT.md.`
];

function writeReport(status) {
  fs.writeFileSync(reportPath, renderReport({ patch, agent, base: path.basename(basePath), diff, violations, commands, notes: opt('notes'), ownerSteps, status }));
}

// A critical preflight violation blocks delivery; no quality checks are needed for an invalid patch.
if (violations.length) {
  commands.push({ cmd: 'quality checks and archive', status: 'NOT_RUN', note: 'not run because critical preflight violations block archive creation', logPath: '' });
  writeReport('FAIL');
  console.error(`Preflight failed, archive NOT built:\n${violations.map((x) => `- ${x}`).join('\n')}\nReport: ${reportPath}`);
  process.exit(1);
}

// Build and verify the ZIP before running potentially slow checks, so test failures cannot delay delivery.
let archiveBuffer;
try {
  archiveBuffer = await buildZip(files);
  const verified = await readZipTree(archiveBuffer);
  if (verified.size !== files.size) throw new Error(`file count mismatch: expected ${files.size}, got ${verified.size}`);
  for (const [rel, buf] of files) {
    const actual = verified.get(rel);
    if (!actual || !actual.equals(buf)) throw new Error(`content mismatch for ${rel}`);
  }
  fs.writeFileSync(outPath, archiveBuffer);
  console.log(`Archive created and verified: ${outPath} (${files.size} files)`);
} catch (err) {
  commands.push({ cmd: 'build and verify archive', status: 'FAIL', note: `archive error: ${err.message}`, logPath: '' });
  writeReport('FAIL');
  console.error(`Archive failed: ${err.message}\nReport: ${reportPath}`);
  process.exit(2);
}

function run(cmd, npmArgs, { dropDb = false, key, timeoutSec } = {}) {
  return new Promise((resolve) => {
    const logName = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
    const logPath = path.join(logDir, `${logName}.log`);
    if (skip.has(key)) {
      commands.push({ cmd, status: 'NOT_RUN', note: `skipped by --skip ${key}`, logPath });
      console.log(`[SKIP] ${cmd}`);
      return resolve();
    }
    if (key !== 'ci' && !DEPENDENCY_FREE.has(key) && !fs.existsSync('node_modules')) {
      commands.push({ cmd, status: 'BLOCKED', note: 'node_modules is missing; run npm ci', logPath });
      console.log(`[BLOCKED] ${cmd}: node_modules is missing`);
      return resolve();
    }
    const env = { ...process.env };
    if (dropDb) { delete env.DATABASE_URL; delete env.PGSSLMODE; }
    const limit = Math.max(1, Number(opt(`timeout-${key}`, timeoutSec ?? LIMITS[key] ?? 600)) || LIMITS[key] || 600);
    const out = fs.createWriteStream(logPath, { flags: 'w' });
    const started = Date.now();
    let settled = false;
    let timedOut = false;
    let tail = '';
    console.log(`[RUN] ${cmd} (timeout ${limit}s; log ${logPath})`);
    const child = spawn('npm', npmArgs, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => { out.write(chunk); tail = (tail + chunk.toString()).slice(-12000); process.stdout.write(chunk); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    }, limit * 1000);
    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); out.end();
      commands.push({ cmd, status: 'FAIL', note: `spawn error: ${err.message}`, logPath });
      console.log(`[FAIL] ${cmd}: ${err.message}`);
      resolve();
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); out.end();
      const sec = Math.round((Date.now() - started) / 1000);
      let result;
      if (timedOut) result = { status: 'TIMEOUT', note: `TIMEOUT after ${limit} s; last output: ${tail.trim().split('\n').slice(-8).join(' / ')}` };
      else if (code === 0) result = { status: 'PASS', note: `exit 0, ${sec} s` };
      else result = { status: 'FAIL', note: `exit ${code ?? signal}, ${sec} s; first failure: ${firstFailure(tail) ?? tail.trim().split('\n').slice(-3).join(' / ')}` };
      commands.push({ cmd, ...result, logPath });
      console.log(`[${result.status}] ${cmd} (${sec}s) — ${result.note}`);
      resolve();
    });
  });
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const requestedSteps = opt('steps');
const checkScripts = [...(pkg.scripts.check?.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g) ?? [])].map((m) => m[1]);
let steps = requestedSteps ? requestedSteps.split(',').map((x) => x.trim()).filter(Boolean).flatMap((step) => step === 'check' ? checkScripts : [step]) : checkScripts;
// Build is a single dedicated stage at the end, even if the caller lists it in --steps.
steps = steps.filter((step) => step !== 'build');
if (!requestedSteps && skip.has('check')) {
  commands.push({ cmd: 'npm run check (expanded independent steps)', status: 'NOT_RUN', note: 'skipped by --skip check', logPath: '' });
  steps = [];
}
if (flag('ci')) await run('npm ci', ['ci', '--no-audit', '--no-fund'], { key: 'ci', timeoutSec: LIMITS.ci });
if (!requestedSteps && !skip.has('check-version')) await run('node scripts/check-version.mjs', ['exec', '--', 'node', 'scripts/check-version.mjs'], { key: 'check-version' });
else if (skip.has('check-version')) commands.push({ cmd: 'node scripts/check-version.mjs', status: 'NOT_RUN', note: 'skipped by --skip check-version', logPath: '' });

const uniqueSteps = [...new Set(steps)];
for (const step of uniqueSteps) {
  if (step === 'check:version') {
    await run('node scripts/check-version.mjs', ['exec', '--', 'node', 'scripts/check-version.mjs'], { key: 'check-version' });
    continue;
  }
  if (!pkg.scripts[step]) {
    commands.push({ cmd: `npm run ${step}`, status: 'FAIL', note: 'unknown script in --steps', logPath: '' });
    console.log(`[FAIL] unknown script: ${step}`);
    continue;
  }
  await run(`npm run ${step}`, ['run', step], { key: step, dropDb: true, timeoutSec: step === 'typecheck' ? LIMITS.typecheck : LIMITS[step] ?? 600 });
}

if (process.env.DATABASE_URL && !skip.has('live')) {
  await run('npm run test:database:live', ['run', 'test:database:live'], { key: 'database-live', timeoutSec: LIMITS.live });
  await run('npm run test:bx06:api', ['run', 'test:bx06:api'], { key: 'bx06-api-live', timeoutSec: LIMITS.live });
} else if (skip.has('live')) {
  commands.push({ cmd: 'live database and API tests', status: 'NOT_RUN', note: 'skipped by --skip live', logPath: '' });
} else {
  commands.push({ cmd: 'live database and API tests', status: 'NOT_RUN', note: 'DATABASE_URL is not set: live tests were not run', logPath: '' });
}

// Build is a single, independent quality check; it does not rebuild the already-created patch archive.
await run('npm run build', ['run', 'build'], { dropDb: true, key: 'build', timeoutSec: LIMITS.build });
const status = overallStatus([], commands);
writeReport(status);
console.log(summaryLine(diff));
console.log(`Archive: ${outPath}\nReport: ${reportPath}\nStatus: ${status}${status === 'PASS' ? '' : ' (НЕ ГОТОВ К ЗАГРУЗКЕ: см. отчёт)'}`);
process.exit(0);
