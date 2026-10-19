/**
 * PA-02: E-01 harness shape, validation, and gate-eval consumption.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests/pa02-fixtures.json');
const harness = path.join(root, 'scripts/e01-harness.mjs');

test('fixtures: exactly three tasks with package + modelPatch + manual', () => {
  const data = JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  assert.equal(data.tasks.length, 3);
  for (const t of data.tasks) {
    assert.ok(t.taskId);
    assert.ok(t.package?.allowedPaths);
    assert.ok(t.modelPatch?.files?.length);
    assert.ok(t.manual?.sha);
    assert.ok(String(t.manual.ciUrl).startsWith('https://'));
  }
});

test('e01-harness dry-run: writes e01-results.json with rule outcome', () => {
  const out = path.join(root, 'tests/pa02-e01-out.json');
  try {
    const r = spawnSync(process.execPath, [harness, '--fixtures', fixtures, '--out', out], {
      encoding: 'utf8',
      cwd: root,
      timeout: 15_000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(result.experiment, 'E-01');
    assert.equal(result.pairs.length, 6);
    assert.ok(['POSITIVE', 'NEGATIVE', 'NEEDS_HUMAN', 'INSUFFICIENT_EVIDENCE'].includes(result.rule.outcome));
    assert.ok(result.rule.reason);
    // Fixture model patches are valid → applied; human minutes 5*3 vs 12+18+25
    assert.equal(result.rule.outcome, 'POSITIVE');
  } finally {
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

test('e01-harness: rejects protected path in a synthetic fixture', () => {
  const bad = path.join(root, 'tests/pa02-bad-tmp.json');
  const out = path.join(root, 'tests/pa02-bad-out.json');
  const data = JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  data.tasks[0].modelPatch = {
    files: [{ path: 'tests/acceptance/hack.test.mjs', action: 'create', content: 'x\n' }],
  };
  fs.writeFileSync(bad, JSON.stringify(data));
  try {
    const r = spawnSync(process.execPath, [harness, '--fixtures', bad, '--out', out], {
      encoding: 'utf8',
      cwd: root,
      timeout: 15_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    const m1 = result.pairs.find((p) => p.taskId === 'e01-t1' && p.side === 'model_patch');
    assert.equal(m1.applied, false);
    assert.ok(result.rule.outcome === 'NEGATIVE' || result.rule.outcome === 'INSUFFICIENT_EVIDENCE');
  } finally {
    if (fs.existsSync(bad)) fs.unlinkSync(bad);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

test('gate-eval can score E-01 table when present (shape only)', async () => {
  const gatePath = path.join(root, 'scripts/gate-eval.mjs');
  assert.ok(fs.existsSync(gatePath), 'gate-eval.mjs from PA-01');
  // Minimal evidence blob with e01 embedded — gate-eval may ignore unknown keys; we only check it still runs.
  const evidence = {
    steps: {},
    e01: {
      pairs: [
        { taskId: 't1', side: 'model_patch', applied: true, ciGreenFirst: true, fixes: 0, humanMinutes: 5, costUsd: 0.01, sha: 'a'.repeat(40), ciUrl: 'https://example.com/1' },
        { taskId: 't1', side: 'manual', applied: true, ciGreenFirst: true, fixes: 0, humanMinutes: 10, costUsd: 0, sha: 'b'.repeat(40), ciUrl: 'https://example.com/2' },
      ],
    },
  };
  const evFile = path.join(root, 'tests/pa02-evidence-tmp.json');
  fs.writeFileSync(evFile, JSON.stringify(evidence));
  try {
    const r = spawnSync(process.execPath, [gatePath, '--all', '--input', evFile], {
      encoding: 'utf8',
      cwd: root,
      timeout: 15_000,
    });
    // gate-eval may exit 0 or print cards; absence of crash is enough for shape compatibility
    assert.ok(r.status === 0 || r.status === 1 || r.status === 2, `status ${r.status}: ${r.stderr}\n${r.stdout}`);
  } finally {
    if (fs.existsSync(evFile)) fs.unlinkSync(evFile);
  }
});
