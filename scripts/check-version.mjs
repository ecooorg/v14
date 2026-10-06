// QA-01c: one current version everywhere. Run: node scripts/check-version.mjs
import { readFileSync, existsSync } from 'node:fs';
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
const errors = [];
const cfg = read('src/config.ts') || '';
const V = (cfg.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (!V) { console.error('APP_VERSION not found in src/config.ts'); process.exit(1); }

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== V) errors.push(`package.json version ${pkg.version} != ${V}`);
if (!(read('README.md') || '').split('\n')[0].includes(`v${V}`)) errors.push('README.md title lacks v' + V);
if (!(read('DEPLOY_RAILWAY.md') || '').split('\n')[0].includes(`v${V}`)) errors.push('DEPLOY_RAILWAY.md title lacks v' + V);
if (!(read('CHANGELOG_AGENT_BEHAVIOR.md') || '').includes(`## v${V}`)) errors.push('CHANGELOG lacks section v' + V);

const server = read('server.ts') || '';
if (/const\s+APP_VERSION\s*=/.test(server)) errors.push('server.ts defines its own APP_VERSION');
if (!/import\s*\{[^}]*APP_VERSION[^}]*\}\s*from\s*'\.\/src\/config/.test(server)) errors.push('server.ts does not import APP_VERSION from src/config');
for (const f of ['src/i18n/en.ts', 'src/core/icsBuilder.ts'])
  if (!(read(f) || '').includes('APP_VERSION')) errors.push(f + ' does not use APP_VERSION');

// No stale numbers/labels as the current version. Storage keys and file names such as
// bifurcation-v13-library.json or *_v15 are not matched (preceded by - or _).
const files = ['README.md','DEPLOY_RAILWAY.md','server.ts','src/App.tsx','src/config.ts','src/i18n/en.ts',
  'src/core/icsBuilder.ts','index.html','railway.toml','.env.example'];
const stale = /(?<![\w-])v(?:1\d)(?![\w])|\b1\d\.\d+\.\d+(?:-\w+)?\b|recovery/i;
// Older labels are allowed only in the changelog, and in code comments that name the version that introduced a rule.
for (const f of files) (read(f) || '').split('\n').forEach((line, i) => {
  if (stale.test(line) && !line.includes('Before You Choose') && !/^\s*(\/\/|\/\*|\*)/.test(line)) errors.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
});
if (errors.length) { console.error('Version check FAILED:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('Version check OK: ' + V);
