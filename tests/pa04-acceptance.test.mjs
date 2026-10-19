/**
 * PA-04: notes-merge helper (lab workflow templates may live off-repo).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('e01-notes-merge builds NOTES and RESULTS from fixtures', () => {
  const out = path.join(root, 'tests/pa04-out-tmp');
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/e01-notes-merge.mjs'),
      '--runs',
      path.join(root, 'tests/pa04-fixtures.json'),
      '--minutes',
      't1:model:9,t1:manual:14',
      '--out-dir',
      out,
    ],
    { encoding: 'utf8', cwd: root, timeout: 15_000 },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const notes = fs.readFileSync(path.join(out, 'E01-NOTES.md'), 'utf8');
  const results = JSON.parse(fs.readFileSync(path.join(out, 'E01-RESULTS.json'), 'utf8'));
  assert.ok(notes.includes('e01-t1 model_patch') || notes.includes('e01-t1'));
  assert.equal(results.pairs.length, 2);
  assert.equal(results.pairs[0].humanMinutes, 9);
  assert.equal(results.pairs[1].humanMinutes, 14);
  fs.rmSync(out, { recursive: true, force: true });
});

test('CONCEPTS e01 lab files are optional (off-repo allowed)', () => {
  // CONCEPTS/e01-task.yml and e01-lab-SETUP.md may be removed after local backup (HISTORY_OFFREPO).
  assert.ok(fs.existsSync(path.join(root, 'scripts/e01-notes-merge.mjs')));
});
