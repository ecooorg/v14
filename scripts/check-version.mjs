/**
 * Product version: only src/config.ts APP_VERSION and package.json "version".
 * Markdown is not version-gated.
 */
import { readFileSync, existsSync } from 'node:fs';

const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
const errors = [];
const cfg = read('src/config.ts') || '';
const V = (cfg.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (!V) {
  console.error('APP_VERSION not found in src/config.ts');
  process.exit(1);
}
const pkgRaw = read('package.json');
if (!pkgRaw) {
  console.error('package.json missing');
  process.exit(1);
}
const pkg = JSON.parse(pkgRaw);
if (pkg.version !== V) errors.push(`package.json version ${pkg.version} != APP_VERSION ${V}`);

const server = read('server.ts') || '';
if (/const\s+APP_VERSION\s*=/.test(server)) errors.push('server.ts defines its own APP_VERSION');
if (!/import\s*\{[^}]*APP_VERSION[^}]*\}\s*from\s*'\.\/src\/config/.test(server)) {
  errors.push("server.ts does not import APP_VERSION from './src/config'");
}

if (errors.length) {
  console.error('Version check FAILED:\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log('Version check OK: ' + V);
