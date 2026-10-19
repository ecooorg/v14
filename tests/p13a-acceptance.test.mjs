// P13a acceptance (no database): patch tools, preflight, report, CI summary. Describes ARCHIVE/P13a-SPEC.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import {
  readTree, readZipTree, diffTrees, summaryLine, buildZip, preflight, allowlistFromToml, scanSecrets, firstFailure, ciSummary, overallStatus, renderReport,
} from '../scripts/patch-tools.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const B = (s) => Buffer.from(s);
const tree = (o) => new Map(Object.entries(o).map(([k, v]) => [k, B(v)]));
const pf = (o, deleted = []) => preflight({ files: tree(o), deleted, allowlist: allowlistFromToml(fs.readFileSync(path.join(root, '.gitleaks.toml'), 'utf8')) });
const fakeKey = 'gh' + 'p_' + 'a'.repeat(36); // built at run time: no secret literal in the repository

test('diff: changed files are replaced, new files added, missing files listed for deletion', () => {
  const d = diffTrees(tree({ 'a.md': '1', 'b.md': '2', 'c.md': '3' }), tree({ 'a.md': '1', 'b.md': '22', 'd.md': '4' }));
  assert.deepEqual(d, { replace: ['b.md'], add: ['d.md'], del: ['c.md'] });
  assert.match(summaryLine(d), /^заменить 1, добавить 1, удалить 1\n/);
  assert.match(summaryLine(d), /заменить: b\.md/);
  assert.equal(summaryLine({ replace: [], add: [], del: [] }), 'заменить 0, добавить 0, удалить 0');
});

test('zip: a GitHub wrapper folder is stripped; a flat zip is kept; the archive has no wrapper and no manifest', async () => {
  const wrapped = new JSZip(); wrapped.file('repo-main/server/a.ts', 'x'); wrapped.file('repo-main/README.md', 'y');
  assert.deepEqual([...(await readZipTree(await wrapped.generateAsync({ type: 'nodebuffer' }))).keys()].sort(), ['README.md', 'server/a.ts']);
  const flat = new JSZip(); flat.file('server/a.ts', 'x'); flat.file('README.md', 'y');
  assert.deepEqual([...(await readZipTree(await flat.generateAsync({ type: 'nodebuffer' }))).keys()].sort(), ['README.md', 'server/a.ts']);
  const built = await readZipTree(await buildZip(tree({ 'server/a.ts': 'x', 'docs/b.md': 'y' })));
  assert.deepEqual([...built.keys()].sort(), ['docs/b.md', 'server/a.ts']);
  assert.deepEqual(Object.keys((await JSZip.loadAsync(await buildZip(tree({ 'docs/b.md': 'y' })))).files), ['docs/b.md']); // no folder entries
});

test('preflight accepts a clean flat patch (including names that only look like a manifest)', () => {
  assert.deepEqual(pf({
    'README.md': 'x', 'package.json': '{}', 'server/files.ts': 'x', 'migrations/008_artifact_manifests.sql': 'x', 'public/manifest.json': '{}',
    '.github/workflows/ci.yml': 'x', 'docs/NEXT.md': 'x', 'tests/p13a-acceptance.test.mjs': 'x',
  }), []);
});

test('preflight rejects a manifest, nested folders, a wrapper or new top-level folder, unsafe paths', () => {
  for (const bad of ['manifest.json', 'MANIFEST.txt', 'file-list.txt', 'changed_files.md', 'MANIFEST']) assert.match(pf({ [bad]: 'x' })[0], /manifest or file-list/, bad);
  assert.match(pf({ 'docs/archive/old.md': 'x' })[0], /nested folder/);
  assert.match(pf({ 'src/a/b.ts': 'x' })[0], /nested folder/);
  assert.match(pf({ '.github/other/x.yml': 'x' })[0], /nested folder/);
  assert.match(pf({ 'bf-main/server/a.ts': 'x' })[0], /nested folder|top-level folder/);
  assert.match(pf({ 'tools/a.ts': 'x' })[0], /top-level folder "tools"/);
  for (const bad of ['../x.md', '/abs.md', 'docs\\a.md', 'docs//a.md']) assert.match(pf({ [bad]: 'x' })[0], /unsafe path/, bad);
});

test('preflight rejects secrets (several formats) and respects the allowlist of .gitleaks.toml', () => {
  assert.match(pf({ 'docs/a.md': `token ${fakeKey}` })[0], /github_token/);
  assert.match(pf({ 'server/a.ts': 'const k = "AIza' + 'A'.repeat(35) + '"' })[0], /google_api_key/);
  assert.match(pf({ 'server/a.ts': '-----BEGIN RSA PRIVATE ' + 'KEY-----' })[0], /private_key/);
  assert.match(pf({ 'docs/a.md': 'postgres://admin:S3cretValue@db.example.com/x' })[0], /url_password/);
  assert.match(pf({ 'server/a.ts': 'const apiKey = "' + 'a1B2'.repeat(8) + '";' })[0], /quoted_secret/);
  assert.deepEqual(pf({ 'docs/a.md': 'postgres://user:password@host/db and postgres://u:p@localhost/db and process.env.GEMINI_API_KEY' }), []);
  assert.deepEqual(pf({ 'tests/fixture.mjs': fakeKey }), []);
  assert.deepEqual(scanSecrets('plain text'), []);
});

test('preflight rejects a change or deletion of tests/acceptance/**', () => {
  assert.ok(pf({ 'tests/acceptance/a.test.mjs': 'x' }).some((x) => /protected path/.test(x)));
  assert.match(pf({}, ['tests/acceptance/a.test.mjs'])[0], /protected path/);
  assert.deepEqual(pf({}, ['docs/old.md']), []);
});

test('the real repository passes the preflight (no false positives)', () => {
  const files = readTree(root);
  assert.ok(files.size > 100);
  assert.deepEqual(preflight({ files, allowlist: allowlistFromToml(fs.readFileSync(path.join(root, '.gitleaks.toml'), 'utf8')) }), []);
});

test('first failure is found in TAP, spec and error output; nothing found gives null', () => {
  assert.equal(firstFailure('ok 1 - a\nnot ok 2 - budget blocks the call\n  ---'), 'budget blocks the call');
  assert.equal(firstFailure('✔ fine\n✖ plan is refused (12.5ms)\n'), 'plan is refused');
  assert.match(firstFailure('x\nAssertionError [ERR_ASSERTION]: 1 !== 2'), /AssertionError/);
  assert.equal(firstFailure('all good'), null);
});

test('CI summary: green is one line; red names the first failed test, or says there is no test log', () => {
  assert.deepEqual(ciSummary('success', []), { ok: true, text: 'CI: green' });
  assert.equal(ciSummary('failure', ['ok 1 - a', 'not ok 1 - live restart test']).text, 'CI: red. First failed: live restart test');
  assert.match(ciSummary('failure', []).text, /no test log/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
  fs.writeFileSync(path.join(dir, 'ci-check.log'), 'not ok 3 - something broke\n');
  const r = spawnSync('node', [path.join(root, 'scripts/ci-summary.mjs'), path.join(dir, 'ci-check.log'), path.join(dir, 'missing.log')], { env: { ...process.env, CI_STATUS: 'failure' }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^::error title=BiForge CI::CI: red\. First failed: something broke/);
});

test('the CI workflow writes the summary after every run and adds no new secret', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /if: always\(\)\n\s+run: node scripts\/ci-summary\.mjs ci-check\.log ci-live\.log ci-api\.log/);
  assert.match(ci, /CI_STATUS: \$\{\{ job\.status \}\}/);
  assert.deepEqual([...new Set([...ci.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))], ['GITHUB_TOKEN']);
});

test('report: statuses come from the commands; NOT_RUN and BLOCKED are never shown as PASS', () => {
  const cmds = [{ cmd: 'npm run check', status: 'PASS', note: 'exit 0' }, { cmd: 'live', status: 'NOT_RUN', note: 'DATABASE_URL is not set' }];
  assert.equal(overallStatus([], [cmds[0]]), 'PASS');
  assert.equal(overallStatus([], cmds), 'PARTIAL');
  assert.equal(overallStatus([], [...cmds, { cmd: 'b', status: 'BLOCKED', note: '' }]), 'PARTIAL');
  assert.equal(overallStatus([], [...cmds, { cmd: 'b', status: 'FAIL', note: '' }]), 'PARTIAL');
  assert.equal(overallStatus(['x: nested folder'], cmds), 'FAIL');
  const md = renderReport({ patch: 'P99', agent: 'tool', base: 'base.zip', diff: { replace: ['a.md'], add: [], del: ['c.md'] }, violations: [], commands: cmds, notes: '', ownerSteps: ['one', 'two', 'three'], status: 'PARTIAL' });
  assert.match(md, /\| `live` \| NOT_RUN \| DATABASE_URL is not set \|/);
  assert.match(md, /3\. three/);
  assert.match(md, /delete \(by hand\)/);
});

test('pack end to end: only changed and new files in the archive, report written, a bad patch gives no archive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  const write = (base, rel, text) => { const f = path.join(dir, base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const rel of ['a.md', 'docs/keep.md', 'docs/gone.md']) write('base', rel, `v1 ${rel}`);
  const fixturePackage = JSON.stringify({ scripts: { check: 'npm run check:docs', 'check:docs': 'node -e \"console.log(\\\'docs ok\\\')\"', 'fail-check': 'node -e \"process.exit(1)\"' } });
  write('base', 'package.json', fixturePackage); write('work', 'package.json', fixturePackage);
  for (const [rel, t] of [['a.md', 'v2'], ['docs/keep.md', 'v1 docs/keep.md'], ['server/new.ts', 'new']]) write('work', rel, t);
  const run = (extra) => spawnSync('node', [path.join(root, 'scripts/patch-pack.mjs'), '--base', path.join(dir, 'base'), '--patch', 'P99', '--agent', 'test', '--skip', 'ci,typecheck,check,check-version,live,build', ...extra],
    { cwd: path.join(dir, 'work'), env: { ...process.env, DATABASE_URL: '1' }, encoding: 'utf8' });
  const ok = run([]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /заменить 1, добавить 1, удалить 1/);
  const zip = await readZipTree(fs.readFileSync(path.join(dir, 'work/bf-P99.zip')));
  assert.deepEqual([...zip.keys()].sort(), ['a.md', 'server/new.ts']);
  const report = fs.readFileSync(path.join(dir, 'work/patch-report.md'), 'utf8');
  assert.match(report, /\| `npm run check \(expanded independent steps\)` \| NOT_RUN \| skipped by --skip check \|/);
  assert.doesNotMatch(report, /\| PASS \|/);
  // A failing quality check must still leave a verified archive and a PARTIAL report.
  fs.mkdirSync(path.join(dir, 'work/node_modules'), { recursive: true });
  const partial = run(['--steps', 'fail-check']);
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'work/bf-P99.zip')), true);
  const partialReport = fs.readFileSync(path.join(dir, 'work/patch-report.md'), 'utf8');
  assert.match(partialReport, /`PARTIAL`/);
  assert.match(partialReport, /fail-check.*FAIL/s);
  write('work', 'docs/deep/x.md', 'nested'); fs.rmSync(path.join(dir, 'work/bf-P99.zip'));
  const bad = run([]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /nested folder/);
  assert.equal(fs.existsSync(path.join(dir, 'work/bf-P99.zip')), false);
});


test('mandatory delivery contract requires a verified bf-PNN.zip and forbids diff-only handoff', () => {
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const prompt = fs.readFileSync(path.join(root, 'docs/PATCH_PROMPT.md'), 'utf8');
  const start = fs.readFileSync(path.join(root, 'docs/START_HERE.md'), 'utf8');
  const packer = fs.readFileSync(path.join(root, 'scripts/patch-pack.mjs'), 'utf8');
  for (const text of [agents, prompt]) {
    assert.match(text, /bf-PNN\.zip/);
    assert.match(text, /DELIVERY BLOCKED/);
    assert.match(text, /\.patch.*\.diff/s);
    assert.match(text, /read-back|reopen/i);
  }
  assert.match(start, /bf-PNN\.zip/);
  assert.match(packer, /opt\('out', `bf-\$\{archiveId\}\.zip`\)/);
  assert.match(packer, /readZipTree\(archiveBuffer\)/);
  assert.match(packer, /content mismatch for/);
});
