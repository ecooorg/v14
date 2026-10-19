/**
 * P56: regression guard for the whole product (owner rule: later patches only improve and fix, they never silently remove a function).
 *  1. Every test file is wired into an npm script, and every test:* script is part of `npm run check` (or is one of the separate CI steps).
 *  2. The public surface listed in tests/feature-manifest.json (API routes, modules, key screens and controls, check chain) is still there.
 * Removing something on purpose: edit tests/feature-manifest.json in the same patch and explain it in docs/PATCH_JOURNAL.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const pkg = JSON.parse(read('package.json')).scripts;
const manifest = JSON.parse(read('tests/feature-manifest.json'));
const hint = 'If this removal is intentional, update tests/feature-manifest.json in the same patch and explain it in docs/PATCH_JOURNAL.md.';

// Test scripts that run as their own CI step (they need PostgreSQL, a browser or network), not inside `npm run check`.
const SEPARATE_CI_STEPS = new Set(['lint', 'test:ui', 'verify:connections', 'test:database:live', 'test:bx06:api']);

function currentRoutes() {
  const files = ['server.ts', ...fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.ts')).map((f) => `server/${f}`)];
  const out = new Set();
  for (const f of files) for (const m of read(f).matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  return out;
}

test('P56 every test file is run by some npm script (no silent orphans)', () => {
  const scripts = Object.values(pkg).join(' ');
  const files = fs.readdirSync(path.join(root, 'tests')).filter((f) => /\.(test\.)?mjs$/.test(f) && f !== 'ui-check.mjs');
  const orphans = files.filter((f) => !scripts.includes(`tests/${f}`));
  assert.deepEqual(orphans, [], `These test files are not run by any npm script, so CI never runs them: ${orphans.join(', ')}`);
});

test('P56 every test script is part of the check chain or a separate CI step', () => {
  const chain = new Set([...pkg.check.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
  for (const name of Object.keys(pkg)) {
    if (!/^(test|lint|typecheck|verify)/.test(name) || name === 'check') continue;
    assert.ok(chain.has(name) || SEPARATE_CI_STEPS.has(name), `npm script ${name} is not in "check" and is not a listed separate CI step`);
  }
  for (const name of chain) assert.ok(pkg[name], `"check" runs npm run ${name}, but the script does not exist`);
  for (const name of SEPARATE_CI_STEPS) assert.ok(pkg[name], `separate CI step ${name} is missing`);
});

test('P56 nothing was dropped from the check chain', () => {
  const chain = new Set([...pkg.check.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
  const dropped = manifest.checkChain.filter((n) => !chain.has(n));
  assert.deepEqual(dropped, [], `These checks used to run in "check" and no longer do: ${dropped.join(', ')}. ${hint}`);
});

test('P56 every API route of the manifest is still registered', () => {
  const now = currentRoutes();
  const gone = manifest.routes.filter((r) => !now.has(r));
  assert.deepEqual(gone, [], `API routes removed or renamed: ${gone.join(', ')}. ${hint}`);
  assert.ok(manifest.routes.length >= 70, 'the manifest must keep covering the API');
});

test('P56 every module of the manifest still exists', () => {
  const gone = manifest.modules.filter((m) => !exists(m));
  assert.deepEqual(gone, [], `Modules removed or renamed: ${gone.join(', ')}. ${hint}`);
});

test('P56 key screens and controls are still in the code', () => {
  const gone = [];
  for (const [file, needles] of Object.entries(manifest.ui)) {
    const text = read(file);
    for (const n of needles) if (!text.includes(n)) gone.push(`${file}: ${n}`);
  }
  assert.deepEqual(gone, [], `Controls or wiring removed: ${gone.join(' | ')}. ${hint}`);
  assert.ok(Object.keys(manifest.ui).length >= 5);
});

test('P56 the manifest itself is current enough: new routes and modules do not need a manifest edit, removals do', () => {
  assert.equal(typeof manifest._about, 'string');
  assert.ok(new Set(manifest.routes).size === manifest.routes.length, 'no duplicate routes in the manifest');
  assert.ok(manifest.routes.every((r) => /^(GET|POST|PUT|PATCH|DELETE) (\/|\*)/.test(r)));
});
