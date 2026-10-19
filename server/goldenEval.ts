import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { providerResponseSchema, errorResponse, ProviderError, type ProviderAdapter, type ProviderResponse } from './adapter.ts';
import type { RegistryEntry } from './modelRegistry.ts';
import { unitsFor, shadowCostUsd } from './budget.ts';
import { statePatchSchema } from './statePipeline.ts';

/** Golden-eval (TZ BX-14, P10): deterministic scoring of models on a fixed task set. The result is a hypothesis, not a decision (TZ 7.6, ADR-04). */
const severity = z.enum(['low', 'medium', 'high']);
export const analysisOutputSchema = z.object({ summary: z.string(), patch: statePatchSchema }).strict();
export const verifyOutputSchema = z.object({ findings: z.array(z.object({ severity, line: z.number().int(), text: z.string() }).strict()) }).strict();

const base = { id: z.string().min(1), lang: z.enum(['ru', 'en']), title: z.string().min(1) };
const analysisTask = z.object({ ...base, kind: z.literal('analysis'), task: z.string().min(1), context: z.string(), mustMention: z.array(z.string().min(1)).min(1), minOps: z.number().int().min(1), reference: analysisOutputSchema }).strict();
const verifyTask = z.object({
  ...base, kind: z.literal('verify'), criteria: z.array(z.string().min(1)).min(1), artifact: z.string().min(1),
  defects: z.array(z.object({ id: z.string().min(1), line: z.number().int().min(1), severity, note: z.string() }).strict()),
}).strict();
export const goldenTaskSchema = z.discriminatedUnion('kind', [analysisTask, verifyTask]);
export type GoldenTask = z.infer<typeof goldenTaskSchema>;
type AnalysisTask = z.infer<typeof analysisTask>;
type VerifyTask = z.infer<typeof verifyTask>;

const DEFAULT_TASKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/golden-tasks.json');

export function loadGoldenTasks(file: string = DEFAULT_TASKS): GoldenTask[] {
  const { tasks } = z.object({ version: z.literal(1), tasks: z.array(goldenTaskSchema) }).strict().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (tasks.length < 15 || tasks.length > 20) throw new Error(`Golden set must have 15-20 tasks, has ${tasks.length}`);
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error('Duplicate task id');
  for (const t of tasks) if (t.kind === 'verify') {
    const n = t.artifact.split('\n').length;
    for (const d of t.defects) if (d.line > n) throw new Error(`${t.id}/${d.id}: defect line ${d.line} is outside the artifact (${n} lines)`);
  }
  return tasks;
}

export function scoreAnalysis(task: AnalysisTask, output: unknown): { pass: boolean; invalid: boolean; missing: string[] } {
  const p = analysisOutputSchema.safeParse(output);
  if (!p.success) return { pass: false, invalid: true, missing: [] };
  const text = `${p.data.summary} ${JSON.stringify(p.data.patch.ops)}`.toLowerCase();
  const missing = task.mustMention.filter((m) => !text.includes(m.toLowerCase()));
  return { pass: p.data.patch.ops.length >= task.minOps && missing.length === 0, invalid: false, missing };
}

export function scoreVerify(task: VerifyTask, output: unknown): { pass: boolean; invalid: boolean; tp: number; fn: number; fp: number; missed: string[] } {
  const p = verifyOutputSchema.safeParse(output);
  if (!p.success) return { pass: false, invalid: true, tp: 0, fn: task.defects.length, fp: 0, missed: task.defects.map((d) => d.id) };
  const matched = new Set<string>();
  let fp = 0;
  for (const f of p.data.findings) {
    const d = task.defects.find((x) => x.line === f.line && !matched.has(x.id));
    if (d) matched.add(d.id); else fp++;
  }
  const fn = task.defects.length - matched.size;
  return { pass: fn === 0 && fp === 0, invalid: false, tp: matched.size, fn, fp, missed: task.defects.filter((d) => !matched.has(d.id)).map((d) => d.id) };
}

export function buildEvalPrompt(task: GoldenTask): string {
  if (task.kind === 'analysis') {
    return `Task: ${task.task}\n\nContext:\n${task.context}\n\nReply with one JSON object only, in the language of the task: {"summary": string, "patch": {"ops": [{"op": "add", "section": "facts|unknowns|hypotheses|risks|requirements", "item": {"text": string, "ref": string}}]}}`;
  }
  const numbered = task.artifact.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
  return `Check the artifact against the criteria.\n\nCriteria:\n${task.criteria.map((c) => `- ${c}`).join('\n')}\n\nArtifact:\n${numbered}\n\nReply with one JSON object only: {"findings": [{"severity": "low|medium|high", "line": number, "text": string}]}. Report only real defects; if there are none, return an empty list.`;
}

/** Fake provider for the harness: 'strong' answers from the references, 'weak' fails on a fixed pattern. Deterministic, no network. */
export function createGoldenFakeAdapter(providerId: string, profile: 'strong' | 'weak', tasks: GoldenTask[]): ProviderAdapter {
  return {
    id: providerId,
    capabilities: () => ['json_output'],
    async call(req): Promise<ProviderResponse> {
      const idx = tasks.findIndex((t) => t.id === req.metadata?.taskId);
      const latencyMs = profile === 'strong' ? 40 : 80;
      if (idx < 0) return errorResponse(new ProviderError('INVALID_REQUEST', 'unknown task'), { providerId, modelId: req.modelId, latencyMs });
      const t = tasks[idx];
      const weak = profile === 'weak';
      const output = t.kind === 'analysis'
        ? (weak && idx % 3 === 0 ? { summary: '', patch: { ops: [] } } : t.reference)
        : (weak && idx % 2 === 0 ? { findings: [{ severity: 'low', line: 1, text: 'Possible issue' }] } : { findings: t.defects.map((d) => ({ severity: d.severity, line: d.line, text: d.note })) });
      return providerResponseSchema.parse({
        status: 'ok', output, latencyMs, providerId, modelId: req.modelId, retryable: false,
        usage: { input: Math.ceil(req.prompt.length / 4), cached: 0, output: Math.ceil(JSON.stringify(output).length / 4) },
      });
    },
  };
}

export interface EvalModel { entry: RegistryEntry; adapter: ProviderAdapter }
export interface ModelResult {
  model: string; provider: string;
  analysis: { passed: number; total: number };
  verify: { tp: number; fn: number; fp: number; passed: number; total: number; recall: number; precision: number; f1: number };
  units: number; costUsd: number | null; avgLatencyMs: number; errors: number;
  tasks: { id: string; kind: string; pass: boolean; errorClass?: string; units: number }[];
}
export interface EvalRun { mode: 'fake' | 'live'; date: string; tasks: number; models: ModelResult[] }

export async function runGoldenEval(o: { tasks: GoldenTask[]; models: EvalModel[]; mode: 'fake' | 'live'; date: string; timeoutMs?: number }): Promise<EvalRun> {
  const models: ModelResult[] = [];
  for (const m of o.models) {
    const r: ModelResult = { model: `${m.entry.providerId}/${m.entry.modelId}`, provider: m.entry.providerId, analysis: { passed: 0, total: 0 }, verify: { tp: 0, fn: 0, fp: 0, passed: 0, total: 0, recall: 0, precision: 0, f1: 0 }, units: 0, costUsd: m.entry.pricing ? 0 : null, avgLatencyMs: 0, errors: 0, tasks: [] };
    let latency = 0;
    for (const t of o.tasks) {
      let resp: ProviderResponse | undefined; let errorClass: string | undefined;
      try { resp = await m.adapter.call({ requestId: `eval-${t.id}`, modelId: m.entry.modelId, prompt: buildEvalPrompt(t), json: true, metadata: { taskId: t.id } }, { timeoutMs: o.timeoutMs ?? 90_000 }); }
      catch { errorClass = 'PROVIDER_TRANSIENT'; }
      let units = 0;
      if (resp) {
        latency += resp.latencyMs;
        const inTok = resp.usage.input ?? 0, outTok = resp.usage.output ?? 0;
        units = inTok + outTok > 0 ? unitsFor(inTok, outTok) : 0;
        if (r.costUsd !== null) r.costUsd += shadowCostUsd({ input: inTok, output: outTok }, m.entry.pricing) ?? 0;
        if (resp.status === 'error') errorClass = resp.errorClass ?? 'unknown';
      }
      r.units += units;
      const output = resp && resp.status === 'ok' ? resp.output : undefined;
      let pass: boolean;
      if (t.kind === 'analysis') { pass = scoreAnalysis(t, output).pass; r.analysis.total++; if (pass) r.analysis.passed++; }
      else { const s = scoreVerify(t, output); pass = s.pass; r.verify.total++; if (pass) r.verify.passed++; r.verify.tp += s.tp; r.verify.fn += s.fn; r.verify.fp += s.fp; }
      if (errorClass) r.errors++;
      r.tasks.push({ id: t.id, kind: t.kind, pass, ...(errorClass ? { errorClass } : {}), units });
    }
    const v = r.verify;
    v.recall = v.tp + v.fn > 0 ? v.tp / (v.tp + v.fn) : 1;
    v.precision = v.tp + v.fp > 0 ? v.tp / (v.tp + v.fp) : 1;
    v.f1 = v.precision + v.recall > 0 ? (2 * v.precision * v.recall) / (v.precision + v.recall) : 0;
    r.avgLatencyMs = o.tasks.length ? latency / o.tasks.length : 0;
    if (r.costUsd !== null) r.costUsd = Math.round(r.costUsd * 1e8) / 1e8;
    models.push(r);
  }
  return { mode: o.mode, date: o.date, tasks: o.tasks.length, models };
}

/** Provisional only (TZ 7.1): the report suggests, the owner decides what goes into the registry. */
export function suggestQualityClass(m: { analysis: { passed: number; total: number }; verify: { f1: number } }): { class: 'A' | 'B' | 'C'; provisional: true; score: number } {
  const rate = m.analysis.total ? m.analysis.passed / m.analysis.total : 0;
  const score = (rate + m.verify.f1) / 2;
  return { class: score >= 0.85 ? 'A' : score >= 0.6 ? 'B' : 'C', provisional: true, score };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
export function renderReport(run: EvalRun): string {
  const L: string[] = ['# Golden-eval report', '', `Mode: ${run.mode}`, `Date: ${run.date}`, `Tasks: ${run.tasks}`, ''];
  L.push('## Summary', '', '| Model | Analysis passed | Verify passed | Recall | Precision | F1 | False positives | Units | Shadow cost, USD | Avg latency, ms | Errors | Suggested class |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of run.models) {
    const q = suggestQualityClass(m);
    L.push(`| ${m.model} | ${m.analysis.passed}/${m.analysis.total} | ${m.verify.passed}/${m.verify.total} | ${pct(m.verify.recall)} | ${pct(m.verify.precision)} | ${pct(m.verify.f1)} | ${m.verify.fp} | ${m.units} | ${m.costUsd === null ? 'n/a' : m.costUsd} | ${Math.round(m.avgLatencyMs)} | ${m.errors} | ${q.class} (provisional) |`);
  }
  L.push('', '## Per-task results', '', `| Task | Kind | ${run.models.map((m) => m.model).join(' | ')} |`, `| --- | --- | ${run.models.map(() => '---').join(' | ')} |`);
  const first = run.models[0]?.tasks ?? [];
  first.forEach((t, i) => L.push(`| ${t.id} | ${t.kind} | ${run.models.map((m) => { const x = m.tasks[i]; return x.errorClass ? `ERROR ${x.errorClass}` : x.pass ? 'pass' : 'FAIL'; }).join(' | ')} |`));
  L.push('', '## Cross-model check', '');
  const providers = [...new Set(run.models.map((m) => m.provider))];
  if (providers.length < 2) L.push('NOT_RUN(no_second_provider): only one provider was evaluated, so no independent verifier pair exists (TZ 7.6). A human decides.');
  else {
    L.push('Possible executor/verifier pairs from different providers (hypothesis only; verify F1 of the verifier):', '');
    for (const e of run.models) for (const v of run.models) if (e.provider !== v.provider) L.push(`- executor ${e.model} → verifier ${v.model} (verify F1 ${pct(v.verify.f1)})`);
  }
  L.push('', '## Limits', '',
    `- This report is a **hypothesis**, not a decision. ${run.tasks} tasks are too few for a statistical conclusion (TZ 7.6).`,
    run.mode === 'fake' ? '- Mode `fake`: the run measures the harness (tasks, scoring, report), not any real model. Suggested classes are not applied anywhere.' : '- Mode `live`: results depend on the provider state on the run date.',
    '- Suggested `quality_class` values stay `provisional`; the owner decides what goes into the registry.',
    '- Enabling `cross_model` is the owner\'s decision under ADR-04 and does not depend on this report.', '');
  return L.join('\n');
}
