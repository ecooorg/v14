import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectCapabilities } from '../server/projectCapabilities.ts';
import { githubWritesEnabled } from '../server/githubIntegration.ts';
import { describeCapabilities, PROJECT_SCOPE_TEXT, ZIP_OFF_HINT } from '../src/projectCapabilities.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const server = read('server.ts');
const gh = read('server/githubIntegration.ts');
const svc = read('server/codeTaskService.ts');
const pm = read('src/ProjectMode.tsx');

test('P53 capability matrix: model_patch = ZIP only; the diff-upload switch = the only write', () => {
  const c = (env, githubConfigured = true) => projectCapabilities({ env, githubConfigured });
  assert.deepEqual(c({}), { analysis: true, plans: true, programZip: false, manualDelivery: { githubRead: true }, githubWrite: false });
  const zip = c({ CODE_EXECUTOR: 'model_patch' });
  assert.equal(zip.programZip, true); assert.equal(zip.githubWrite, false);
  const up = c({ GITHUB_DIFF_UPLOAD: 'true' });
  assert.equal(up.programZip, false); assert.equal(up.githubWrite, true);
  const both = c({ CODE_EXECUTOR: 'model_patch', GITHUB_DIFF_UPLOAD: 'true' });
  assert.equal(both.programZip, true); assert.equal(both.githubWrite, true);
  assert.equal(c({ CODE_EXECUTOR: 'manual' }).programZip, false);
  assert.equal(c({}, false).manualDelivery.githubRead, false);
});

test('P53 capabilities carry booleans only and no variable values', () => {
  const caps = projectCapabilities({ env: { CODE_EXECUTOR: 'model_patch', GITHUB_APP_PRIVATE_KEY: 'SECRET', GEMINI_API_KEY: 'SECRET' }, githubConfigured: true });
  const flat = JSON.stringify(caps);
  assert.doesNotMatch(flat, /SECRET|model_patch|CODE_EXECUTOR|GITHUB/);
  const walk = (o) => Object.values(o).forEach((v) => (typeof v === 'object' ? walk(v) : assert.equal(typeof v, 'boolean')));
  walk(caps);
});

test('P53 default env: githubWritesEnabled follows the process environment, not CODE_EXECUTOR', () => {
  const prev = { e: process.env.CODE_EXECUTOR, u: process.env.GITHUB_DIFF_UPLOAD };
  try {
    delete process.env.GITHUB_DIFF_UPLOAD; process.env.CODE_EXECUTOR = 'model_patch';
    assert.equal(githubWritesEnabled(), false);
    assert.equal(projectCapabilities({ githubConfigured: false }).githubWrite, false);
    process.env.GITHUB_DIFF_UPLOAD = 'true';
    assert.equal(githubWritesEnabled(), true);
    assert.equal(projectCapabilities({ githubConfigured: false }).githubWrite, true);
  } finally {
    for (const [k, v] of [['CODE_EXECUTOR', prev.e], ['GITHUB_DIFF_UPLOAD', prev.u]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('P53 code: one write switch; no write path is enabled by model_patch', () => {
  assert.match(gh, /export const githubWritesEnabled = \(\): boolean => process\.env\.GITHUB_DIFF_UPLOAD === 'true';/);
  assert.doesNotMatch(gh, /githubWritesEnabled[^\n]*CODE_EXECUTOR/);
  assert.equal((svc.match(/deps\.diffUpload\?\.\(\) \?\? githubWritesEnabled\(\)/g) || []).length, 2);
  assert.doesNotMatch(svc, /diffUploadEnabled\(\) \|\| githubWritesEnabled\(\)/);
  assert.match(svc, /github_writes_disabled_bundle_available/);
});

test('P53 /api/session: capabilities only for a signed-in person with Project Mode on', () => {
  assert.match(server, /isAuthenticated && PROJECT_MODE_ENABLED \? projectCapabilities\(/);
  assert.match(server, /\.\.\.\(capabilities \? \{ capabilities \} : \{\}\)/);
  assert.match(server, /projectModeEnabled: PROJECT_MODE_ENABLED/);
});

test('P53 interface text: plain rows, scope sentence, no env names, no "administrator"', () => {
  const on = describeCapabilities({ analysis: true, plans: true, programZip: true, manualDelivery: { githubRead: true }, githubWrite: false });
  assert.equal(on.length, 5);
  assert.deepEqual(on.map((r) => r.on), [true, true, true, true, false]);
  const off = describeCapabilities({ analysis: true, plans: true, programZip: false, manualDelivery: { githubRead: false }, githubWrite: false });
  assert.equal(off.find((r) => r.label === 'Program as ZIP').note, ZIP_OFF_HINT);
  assert.match(JSON.stringify([on, off, PROJECT_SCOPE_TEXT, ZIP_OFF_HINT]), /^(?!.*(CODE_EXECUTOR|GITHUB_|model_patch|administrator)).*$/s);
  assert.equal(describeCapabilities(null)[0].on, false);
  assert.match(pm, /PROJECT_SCOPE_TEXT/);
  assert.match(pm, /What is available here/);
  assert.match(pm, /s\.capabilities && typeof s\.capabilities === 'object'/);
  assert.match(pm, /capabilities !== null && !capabilities\.programZip/);
  assert.doesNotMatch(pm, /when your administrator has enabled/);
});

test('P53 documents: ADR-06 Amendment 1 and STATUS carry the scope decision', () => {
  const adr = read('docs/ADR-06-github-repositories.md');
  assert.match(adr, /Amendment 1/);
  assert.match(adr, /analysis \+ ZIP/);
  assert.match(adr, /GITHUB_DIFF_UPLOAD=true/);
  assert.match(adr, /implies no GitHub write/);
  assert.match(read('docs/STATUS.md'), /ADR-06 Amendment 1/);
  assert.match(read('.env.example'), /does NOT switch on any GitHub write/);
});
