import { z } from 'zod';
import { buildContext, type ContextArtifact } from './contextBuilder.ts';
import { applyPatchToProject, PatchRejectedError } from './stateService.ts';
import { getProject, recordAuditEvent, StateVersionConflict } from './projectRepository.ts';
import { readArtifact, saveArtifact } from './artifactRepository.ts';
import { ledgerEntryFromResponse, writeLedgerEntry } from './ledger.ts';
import { newRouteDecisionId, writeRouteDecision } from './routeDecisions.ts';
import { DEFAULT_TASK_UNITS, DEFAULT_DAILY_UNITS, createQuotaTracker, shadowCostUsd, budgetLevel, runBudget, unitsFor } from './budget.ts';
import { guardModelCall } from './planService.ts';
import { loadRouterState, loadQuotaRows, rehydrateQuota, saveHealthEvent, type HealthEvent } from './modelHealth.ts';
import { newRouterState, routeCall, type RouterState } from './router.ts';
import { REGISTRY_SEED, type RegistryEntry } from './modelRegistry.ts';
import { statePatchSchema, SECTIONS, type Section } from './statePipeline.ts';
import { getPool } from './database.ts';
import type { ProviderAdapter } from './adapter.ts';
import crypto from 'node:crypto';

/** Slice S1 (TZ 18.0): project -> State -> model call -> patch -> human review -> artifact. A model never writes State directly. */
export class AnalysisError extends Error { constructor(readonly code: string, message: string, readonly status = 400) { super(message); } }
const outputSchema = z.object({ summary: z.string().max(20000).default(''), patch: statePatchSchema }).strict();
const routerState: RouterState = newRouterState();

export interface AnalysisDeps { adapters: Record<string, ProviderAdapter>; registry?: RegistryEntry[]; router?: RouterState; maxTokens?: number; quota?: ReturnType<typeof createQuotaTracker> }

/** Process-wide quota tracker; restored from the ledger (last 24 h) on the first analysis. */
const quotaTracker = createQuotaTracker();
let quotaHydrated = false;

async function usedUnitsToday(projectId: string): Promise<number> {
  const pool = await getPool();
  const r = await pool.query(`SELECT COALESCE(SUM(l.units),0) AS u FROM usage_ledger l WHERE l.created_at >= now() - interval '24 hours' AND (starts_with(l.run_id, $1) OR l.run_id IN (SELECT r.id FROM runs r WHERE r.project_id=$2))`, [`${projectId}:`, projectId]);
  return Number(r.rows[0].u);
}

export async function runAnalysis(input: { projectId: string; expectedVersion: number; task: string; artifactIds?: string[]; taskId?: string; runId?: string; artifactFilename?: string; artifactId?: string; signal?: AbortSignal }, deps: AnalysisDeps) {
  const task = z.string().trim().min(1).max(4000).parse(input.task);
  const project = await getProject(input.projectId);
  if (!project) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' });
  if (Number(project.state_version) !== input.expectedVersion) throw new StateVersionConflict(input.expectedVersion, Number(project.state_version));
  if ((project.state.passport as { status?: string } | undefined)?.status !== 'confirmed') throw new AnalysisError('PASSPORT_NOT_CONFIRMED', 'Confirm the project passport before running an analysis', 409);
  const artifacts: ContextArtifact[] = [];
  for (const id of (input.artifactIds ?? []).slice(0, 5)) {
    const a = await readArtifact(id);
    if (!a || a.project_id !== input.projectId) throw new AnalysisError('ARTIFACT_NOT_FOUND', 'Artifact not found in this project', 404);
    artifacts.push({ id, version: Number(a.version), filename: a.filename, text: a.text });
  }
  const usedToday = await usedUnitsToday(input.projectId);
  if (budgetLevel(usedToday, DEFAULT_DAILY_UNITS).level === 'stop') throw new AnalysisError('DAILY_BUDGET_EXCEEDED', 'The daily budget of this project is used up', 429);
  const routerSt = await loadRouterState(deps.router ?? routerState);
  const quota = deps.quota ?? quotaTracker;
  if (deps.quota || !quotaHydrated) { if (!deps.quota) quotaHydrated = true; rehydrateQuota(quota, await loadQuotaRows(Date.now() - 86_400_000), Date.now()); }
  const ctx = buildContext({ state: project.state, task, artifacts, maxTokens: deps.maxTokens });
  const runId = input.runId ?? `${input.projectId}:${crypto.randomBytes(6).toString('hex')}`;
  const guardedAdapters: Record<string, ProviderAdapter> = Object.fromEntries(Object.entries(deps.adapters).map(([providerId, adapter]) => [providerId, {
    id: adapter.id, capabilities: () => adapter.capabilities(), call: async (req, opts) => {
      if (input.signal?.aborted) throw Object.assign(new Error('Run cancelled'), { name: 'AbortError' });
      if (input.taskId) await guardModelCall({ taskId: input.taskId, runId, request: { tokens: ctx.tokens.total + (req.maxOutputTokens ?? 1024), units: unitsFor(ctx.tokens.total, req.maxOutputTokens ?? 1024) }, actor: 'worker' });
      return adapter.call(req, { ...opts, ...(input.signal ? { signal: input.signal } : {}) });
    },
  } as ProviderAdapter]));
  const routeDecisionId = newRouteDecisionId();
  const sensitivity = 'normal' as const;   // the project-level sensitivity field arrives with the passport extension; open-publication work is `normal` (ADR-07)
  const route = await routeCall({ requestId: runId, system: ctx.system, prompt: ctx.prompt, json: true, metadata: {} }, {
    registry: deps.registry ?? REGISTRY_SEED, adapters: guardedAdapters, state: routerSt, required: ['json_output'], timeoutMs: 90_000,
    sensitivity, paidApproved: [], budget: { remainingUnits: runBudget(usedToday, { dayCap: DEFAULT_DAILY_UNITS, taskUnits: DEFAULT_TASK_UNITS }) }, quota, deadlineAt: Date.now() + 90_000,
    onHealth: async (e: HealthEvent) => {
      await saveHealthEvent(e);
      if (e.type === 'provider_disabled') await recordAuditEvent({ eventType: 'provider.disabled', actor: 'system', details: { provider_id: e.providerId, reason: e.reason } });
    }, estimatedInputTokens: ctx.tokens.total,
    onCall: async (resp, info) => { await writeLedgerEntry(ledgerEntryFromResponse(resp, { runId, retries: info.retries, routeDecisionId, units: info.units, costEstimate: shadowCostUsd({ input: resp.usage.input ?? 0, output: resp.usage.output ?? 0 }, info.entry.pricing) })); },
  });
  try { await writeRouteDecision(routeDecisionId, route.decision, { runId, sensitivity, status: route.status }); } catch { /* the decision log must not break the run */ }
  if (route.status !== 'ok' || !route.response) throw new AnalysisError('MODEL_UNAVAILABLE', `The model call failed (${route.decision.reason ?? route.response?.errorClass ?? 'unknown'})`, 502);
  const parsed = outputSchema.safeParse(route.response.output);
  if (!parsed.success) throw new AnalysisError('INVALID_OUTPUT', 'The model returned an unusable result', 502);
  const sourceRef = `run:${runId}`;
  const saved = await applyPatchToProject({ projectId: input.projectId, expectedVersion: input.expectedVersion, patch: parsed.data.patch, actor: 'agent', sourceRef });
  const art = await saveArtifact({
    projectId: input.projectId, ...(input.artifactId ? { artifactId: input.artifactId } : {}), filename: input.artifactFilename ?? 'analysis.md', mime: 'text/markdown', createdBy: sourceRef, derivedFrom: [`state:v${input.expectedVersion}`, ...artifacts.map((a) => `artifact:${a.id}@${a.version}`)],
    text: `# Analysis\n\n**Task:** ${task}\n\n${parsed.data.summary}\n\n## Proposed changes\n\n\`\`\`json\n${JSON.stringify(saved.changes, null, 2)}\n\`\`\`\n\nModel: ${route.response.providerId}/${route.response.modelId}. Run: ${runId}.\n`,
  });
  await recordAuditEvent({ eventType: 'analysis.completed', actor: 'agent', projectId: input.projectId, details: { run_id: runId, artifact_id: art.artifactId, version: art.version, estimated_input_tokens: ctx.tokens.total } });
  const usage = route.response.usage;
  return { state_version: saved.state_version, changes: saved.changes, summary: parsed.data.summary, artifact: art, run_id: runId, model: `${route.response.providerId}/${route.response.modelId}`,
    tokens: { estimated: ctx.tokens, actual: usage }, budget: { used_units: usedToday + route.decision.unitsSpent, cap_units: DEFAULT_DAILY_UNITS, level: budgetLevel(usedToday + route.decision.unitsSpent, DEFAULT_DAILY_UNITS).level },
    included: ctx.included, excluded_count: ctx.excluded.length, route: route.decision };
}

/** Human review of one item: confirm or reject. Goes through the same pipeline (actor human). */
export async function reviewItem(input: { projectId: string; expectedVersion: number; section: string; id: string; action: 'confirm' | 'reject'; reason?: string }) {
  const section = z.enum(['facts', 'unknowns', 'hypotheses', 'risks', 'requirements']).parse(input.section) as Section;
  const rk = SECTIONS[section].reviewKey!;
  const op = input.action === 'reject' ? { op: 'reject', section, id: input.id, reason: input.reason } : { op: 'update', section, id: input.id, changes: { [rk]: 'confirmed' } };
  return applyPatchToProject({ projectId: input.projectId, expectedVersion: input.expectedVersion, patch: { ops: [op] }, actor: 'human', sourceRef: 'ui:review' });
}

/** Only a human creates decisions. */
export async function addDecision(input: { projectId: string; expectedVersion: number; text: string; rationale: string }) {
  return applyPatchToProject({ projectId: input.projectId, expectedVersion: input.expectedVersion, actor: 'human', sourceRef: 'ui:decision', patch: { ops: [{ op: 'add', section: 'decisions', item: { text: input.text, rationale: input.rationale } }] } });
}

export async function listProjectArtifacts(projectId: string) {
  const pool = await getPool();
  const r = await pool.query(`SELECT DISTINCT ON (artifact_id) artifact_id, version, filename, size, hash, created_by, created_at FROM artifacts WHERE project_id=$1 ORDER BY artifact_id, version DESC`, [projectId]);
  return r.rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function listProjectLedger(projectId: string, limit = 50) {
  const pool = await getPool();
  const r = await pool.query(`SELECT l.run_id, l.provider_id, l.model_id, l.input_tokens, l.cached_tokens, l.output_tokens, l.latency_ms, l.retries, l.status, l.error_class, l.created_at FROM usage_ledger l WHERE starts_with(l.run_id, $1) OR l.run_id IN (SELECT r.id FROM runs r WHERE r.project_id=$2) ORDER BY l.created_at DESC LIMIT $3`, [`${projectId}:`, projectId, limit]);
  return r.rows;
}
export { PatchRejectedError };
