/**
 * P26a: path normalisation and skip rules
 */
import assert from 'node:assert/strict';
import { normalizePath, caseKey, matchesDefaultSkip, detectRootPrefix, stripRootPrefix } from '../src/workspace/paths.ts';

function t(name, fn) {
  try {
    fn();
    console.log('ok', name);
  } catch (e) {
    console.error('FAIL', name, e);
    process.exitCode = 1;
  }
}

t('normalize: a..b.txt is valid', () => {
  const r = normalizePath('src/a..b.txt');
  assert.equal(r.ok, true);
  assert.equal(r.path, 'src/a..b.txt');
});

t('normalize: rejects .. segment', () => {
  const r = normalizePath('foo/../etc/passwd');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'traversal');
});

t('normalize: rejects absolute', () => {
  assert.equal(normalizePath('/etc/passwd').ok, false);
  assert.equal(normalizePath('C:\\Windows\\x').reason, 'windows_drive');
});

t('normalize: rejects control and empty', () => {
  assert.equal(normalizePath('a/\x00/b').ok, false);
  assert.equal(normalizePath('').ok, false);
});

t('normalize: collapses empty segments and NFC', () => {
  const r = normalizePath('a//b/./c');
  assert.equal(r.ok, true);
  assert.equal(r.path, 'a/b/c');
});

t('caseKey lowercases', () => {
  assert.equal(caseKey('Src/App.TS'), caseKey('src/app.ts'));
});

t('default skip rules', () => {
  assert.equal(matchesDefaultSkip('node_modules/x'), 'node_modules/');
  assert.equal(matchesDefaultSkip('.git/config'), '.git/');
  assert.equal(matchesDefaultSkip('src/main.ts'), null);
});

t('root prefix', () => {
  assert.equal(detectRootPrefix(['bf-main/a.ts', 'bf-main/b.ts']), 'bf-main');
  assert.equal(detectRootPrefix(['a.ts', 'b.ts']), '');
  assert.equal(stripRootPrefix('bf-main/a.ts', 'bf-main'), 'a.ts');
});

console.log('workspace-paths done');
