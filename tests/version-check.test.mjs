// VER-02: the version check must catch a stale version label (the README once kept "17.0.0" unnoticed).
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const FILES = ['package.json', 'README.md', 'DEPLOY_RAILWAY.md', 'CHANGELOG_AGENT_BEHAVIOR.md', 'server.ts', 'index.html', 'railway.toml', '.env.example',
  'src/config.ts', 'src/App.tsx', 'src/i18n/en.ts', 'src/core/icsBuilder.ts'];
const here = process.cwd();
function run(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'vcheck-'));
  for (const f of FILES) { try { mkdirSync(join(dir, f, '..'), { recursive: true }); cpSync(join(here, f), join(dir, f)); } catch {} }
  mutate?.(dir);
  return spawnSync('node', [join(here, 'scripts/check-version.mjs')], { cwd: dir, encoding: 'utf8' });
}
const edit = (f, fn) => (dir) => writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), 'utf8')));
let failed = 0;
const T = (name, ok, note = '') => { if (!ok) { failed++; console.log('FAIL', name, note); } };

const clean = run();
T('clean tree passes', clean.status === 0, clean.stderr);
const r17 = run(edit('README.md', (t) => t + '\n17.0.0 - old label\n'));
T('stale 17.0.0 in README is caught', r17.status === 1 && /README\.md/.test(r17.stderr), r17.stderr);
const r16 = run(edit('DEPLOY_RAILWAY.md', (t) => t + '\nWorks since v16.\n'));
T('stale v16 in DEPLOY is caught', r16.status === 1 && /DEPLOY_RAILWAY\.md/.test(r16.stderr), r16.stderr);
const rpkg = run(edit('package.json', (t) => t.replace(/"version": "[^"]+"/, '"version": "1.2.3"')));
T('package.json mismatch is caught', rpkg.status === 1 && /package\.json/.test(rpkg.stderr), rpkg.stderr);
const rcmt = run(edit('server.ts', (t) => t + '\n// v17: comment about where a rule came from\n'));
T('old label inside a code comment is allowed', rcmt.status === 0, rcmt.stderr);

console.log(failed ? `${failed} failed` : 'version-check tests passed');
process.exit(failed ? 1 : 0);
