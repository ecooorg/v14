// P10 acceptance expectations (TZ 16.3 step 2). Protected by Test Integrity: change only with the owner's approval.
// They describe ARCHIVE/P10-SPEC.md and are expected to FAIL until P10 is implemented. No database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { REGISTRY_SEED, registryEntrySchema } from '../server/modelRegistry.ts';
import {
  loadGoldenTasks, scoreAnalysis, scoreVerify, buildEvalPrompt, createGoldenFakeAdapter, runGoldenEval, suggestQualityClass, renderReport,
} from '../server/goldenEval.ts';

const tasks = loadGoldenTasks();
const entry = (providerId, modelId, extra = {}) => registryEntrySchema.parse({ ...REGISTRY_SEED[0], providerId, modelId, costTier: 'free', ...extra });
const models = () => [
  { entry: entry('fs', 'a', { pricing: { inputPerMTok: 1, outputPerMTok: 2 } }), adapter: createGoldenFakeAdapter('fs', 'strong', tasks) },
  { entry: entry('fw', 'b'), adapter: createGoldenFakeAdapter('fw', 'weak', tasks) },
];
const run = (m = models()) => runGoldenEval({ tasks, models: m, mode: 'fake', date: '2026-10-11' });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('task set: 18 tasks, both languages, both kinds, defects inside the artifact, clean controls', () => {
  assert.ok(tasks.length >= 15 && tasks.length <= 20);
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  for (const lang of ['ru', 'en']) assert.ok(tasks.filter((t) => t.lang === lang).length >= 6, lang);
  const analysis = tasks.filter((t) => t.kind === 'analysis'), verify = tasks.filter((t) => t.kind === 'verify');
  assert.ok(analysis.length >= 8 && verify.length >= 6);
  assert.ok(verify.filter((t) => t.defects.length > 0).length >= 5);
  assert.ok(verify.filter((t) => t.defects.length === 0).length >= 2);
  for (const t of verify) for (const d of t.defects) assert.ok(d.line >= 1 && d.line <= t.artifact.split('\n').length, `${t.id} ${d.id}`);
});

test('loadGoldenTasks rejects an invalid file', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g-')), 't.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, tasks: tasks.slice(0, 3) }));
  assert.throws(() => loadGoldenTasks(f));
});

test('scoreAnalysis: reference passes; missing mention, too few ops and invalid shape fail', () => {
  const t = tasks.find((x) => x.kind === 'analysis');
  assert.equal(scoreAnalysis(t, t.reference).pass, true);
  const noOps = scoreAnalysis(t, { summary: t.reference.summary, patch: { ops: [] } });
  assert.equal(noOps.pass, false);
  const miss = scoreAnalysis(t, { summary: 'nothing', patch: { ops: t.reference.patch.ops.map((o) => ({ ...o, item: { text: 'x', ref: 'msg:1' } })) } });
  assert.equal(miss.pass, false); assert.ok(miss.missing.length > 0);
  assert.equal(scoreAnalysis(t, 'garbage').invalid, true);
});

test('scoreVerify: exact lines pass; miss, wrong line and false alarm on a clean task are counted', () => {
  const t = tasks.find((x) => x.kind === 'verify' && x.defects.length > 0);
  const clean = tasks.find((x) => x.kind === 'verify' && x.defects.length === 0);
  const hit = t.defects.map((d) => ({ severity: d.severity, line: d.line, text: 'x' }));
  const ok = scoreVerify(t, { findings: hit });
  assert.deepEqual([ok.pass, ok.tp, ok.fn, ok.fp], [true, t.defects.length, 0, 0]);
  const none = scoreVerify(t, { findings: [] });
  assert.deepEqual([none.pass, none.tp, none.fn], [false, 0, t.defects.length]);
  const wrong = scoreVerify(t, { findings: [{ severity: 'low', line: 999, text: 'x' }] });
  assert.equal(wrong.fp, 1); assert.equal(wrong.fn, t.defects.length);
  assert.equal(scoreVerify(clean, { findings: [] }).pass, true);
  assert.equal(scoreVerify(clean, { findings: [{ severity: 'low', line: 1, text: 'x' }] }).fp, 1);
  assert.equal(scoreVerify(t, { nope: 1 }).invalid, true);
});

test('prompt: verify prompt numbers the lines and does not reveal defects', () => {
  const t = tasks.find((x) => x.kind === 'verify' && x.defects.length > 0);
  const p = buildEvalPrompt(t);
  assert.match(p, /^1: /m); assert.ok(p.includes(t.criteria[0]));
  for (const d of t.defects) assert.equal(p.includes(d.note), false);
  assert.ok(buildEvalPrompt(tasks.find((x) => x.kind === 'analysis')).includes('JSON'));
});

test('run: strong fake passes everything, weak fake does not; counts, units and cost are filled', async () => {
  const r = await run();
  assert.equal(r.mode, 'fake'); assert.equal(r.date, '2026-10-11'); assert.equal(r.tasks, tasks.length);
  const [s, w] = r.models;
  assert.equal(s.model, 'fs/a'); assert.equal(w.model, 'fw/b');
  assert.equal(s.analysis.passed, s.analysis.total); assert.equal(s.verify.passed, s.verify.total);
  assert.equal(s.verify.f1, 1); assert.equal(s.verify.fp, 0);
  assert.ok(w.analysis.passed < w.analysis.total); assert.ok(w.verify.passed < w.verify.total); assert.ok(w.verify.f1 < 1);
  assert.equal(s.tasks.length, tasks.length);
  assert.ok(s.units >= tasks.length); assert.ok(s.costUsd > 0); assert.equal(w.costUsd, null);
});

test('run is deterministic and survives an adapter error', async () => {
  assert.deepEqual(await run(), await run());
  const failing = { id: 'bad', capabilities: () => ['json_output'], async call(r) { return { status: 'error', usage: { input: 0, cached: 0, output: 0 }, latencyMs: 1, providerId: 'bad', modelId: r.modelId, retryable: false, errorClass: 'PROVIDER_AUTH' }; } };
  const r = await runGoldenEval({ tasks, models: [{ entry: entry('bad', 'm'), adapter: failing }], mode: 'fake', date: '2026-10-11' });
  const m = r.models[0];
  assert.equal(m.errors, tasks.length); assert.equal(m.analysis.passed, 0); assert.equal(m.tasks[0].errorClass, 'PROVIDER_AUTH');
});

test('quality class: thresholds 0.85 / 0.6, always provisional', async () => {
  const mk = (p, f1) => ({ analysis: { passed: p, total: 10 }, verify: { f1 } });
  assert.equal(suggestQualityClass(mk(9, 0.9)).class, 'A');
  assert.equal(suggestQualityClass(mk(7, 0.6)).class, 'B');
  assert.equal(suggestQualityClass(mk(3, 0.2)).class, 'C');
  assert.equal(suggestQualityClass(mk(10, 1)).provisional, true);
  const r = await run();
  assert.equal(suggestQualityClass(r.models[0]).class, 'A'); assert.notEqual(suggestQualityClass(r.models[1]).class, 'A');
});

test('report: required sections, every task and model, hypothesis and owner wording, cross-model line', async () => {
  const r = await run();
  const md = renderReport(r);
  assert.match(md, /^# Golden-eval report/m);
  assert.match(md, /^Mode: fake$/m); assert.match(md, /^Date: 2026-10-11$/m); assert.match(md, new RegExp(`^Tasks: ${tasks.length}$`, 'm'));
  for (const h of ['## Summary', '## Per-task results', '## Cross-model check', '## Limits']) assert.ok(md.includes(h), h);
  for (const t of tasks) assert.ok(md.includes(t.id), t.id);
  for (const m of ['fs/a', 'fw/b']) assert.ok(md.includes(m));
  assert.match(md, /provisional/); assert.match(md, /hypothesis/i); assert.match(md, /cross_model/); assert.match(md, /owner/i);
  assert.equal(md.includes('NOT_RUN(no_second_provider)'), false);
  const one = renderReport(await run([models()[0]]));
  assert.ok(one.includes('NOT_RUN(no_second_provider)'));
  assert.equal(renderReport(r), md);
});

test('CLI: --fake writes a deterministic report; without --fake it refuses with code 2', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g-')), 'r.md');
  const args = ['--import', 'tsx', path.join(root, 'scripts/golden-eval.mjs'), '--fake', '--date', '2026-10-11', '--out', out];
  execFileSync(process.execPath, args, { cwd: root });
  const a = fs.readFileSync(out, 'utf8');
  execFileSync(process.execPath, args, { cwd: root });
  assert.equal(fs.readFileSync(out, 'utf8'), a);
  assert.match(a, /^Mode: fake$/m); assert.ok(a.includes('fake-strong/model-a') && a.includes('fake-weak/model-b'));
  const live = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/golden-eval.mjs')], { cwd: root });
  assert.equal(live.status, 2);
});

test('deliverables: golden-eval script, ADR-04 draft, npm scripts, check includes test:p10', () => {
  // ARCHIVE/GOLDEN-EVAL-REPORT.md is optional (off-repo history). Prove the generator works into a temp file.
  const out = path.join(root, 'tests/p10-golden-tmp.md');
  try { fs.unlinkSync(out); } catch { /* missing */ }
  const args = ['--import', 'tsx', path.join(root, 'scripts/golden-eval.mjs'), '--fake', '--date', '2026-10-16', '--out', out];
  execFileSync(process.execPath, args, { cwd: root });
  const report = fs.readFileSync(out, 'utf8');
  assert.match(report, /^Mode: fake$/m); assert.match(report, /^# Golden-eval report/m);
  try { fs.unlinkSync(out); } catch { /* ignore */ }
  const adr = fs.readFileSync(path.join(root, 'docs/ADR-04-cross-model-policy.md'), 'utf8');
  assert.match(adr, /Draft/); assert.match(adr, /owner/i); assert.match(adr, /hypothesis/i);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['eval:golden'] && pkg.scripts['test:p10']);
  assert.ok(pkg.scripts.check.includes('npm run test:p10'));
});
