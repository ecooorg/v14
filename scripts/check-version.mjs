// QA-01c: one current version everywhere. Source of truth: APP_VERSION in src/config.ts.
// Product version equals the current patch number (P19 → "19"). Run: node scripts/check-version.mjs
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
const cl = read('CHANGELOG_AGENT_BEHAVIOR.md') || '';
if (!new RegExp(`^## v${V.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(cl)) errors.push('CHANGELOG lacks section ## v' + V);

const server = read('server.ts') || '';
if (/const\s+APP_VERSION\s*=/.test(server)) errors.push('server.ts defines its own APP_VERSION');
if (!/import\s*\{[^}]*APP_VERSION[^}]*\}\s*from\s*'\.\/src\/config/.test(server)) errors.push('server.ts does not import APP_VERSION from src/config');
for (const f of ['src/icsBuilder.ts'])
  if (!(read(f) || '').includes('APP_VERSION')) errors.push(f + ' does not use APP_VERSION');

// Stale labels: old semver (1.x.x) and old vNN labels that are not the current product version.
// Current V (e.g. "19") is allowed everywhere it is required.
const files = ['README.md','DEPLOY_RAILWAY.md','server.ts','src/App.tsx','src/config.ts','src/en.ts',
  'src/icsBuilder.ts','index.html','railway.toml','.env.example'];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stale = new RegExp(
  String.raw`(?<![\w-])v(?:1\d)(?![\w])|\b1\.\d+\.\d+(?:-\w+)?\b|\b1[0-9]\.\d+\.\d+(?:-\w+)?\b|recovery`,
  'i'
);
for (const f of files) (read(f) || '').split('\n').forEach((line, i) => {
  if (/^\s*(\/\/|\/\*|\*)/.test(line) || line.includes('Before You Choose')) return;
  // Strip the current version so it never counts as stale
  const cleaned = line
    .replace(new RegExp(String.raw`\bv?${escape(V)}\b`, 'g'), '')
    .replace(new RegExp(String.raw`Product version:\s*${escape(V)}`, 'gi'), '');
  if (stale.test(cleaned)) errors.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
});
if (errors.length) { console.error('Version check FAILED:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('Version check OK: ' + V);
