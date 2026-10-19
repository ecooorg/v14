// P09 live expectations (PostgreSQL). Protected by Test Integrity. Expected to FAIL until P09 is implemented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, getProject, updateProjectState } from '../server/projectRepository.ts';
import { runAnalysis, AnalysisError } from '../server/analysisService.ts';
import { getPool, closeDatabase } from '../server/database.ts';
import { newRouterState } from '../server/router.ts';
import { createQuotaTracker } from '../server/budget.ts';
import { saveHealthEvent, loadHealthRows, loadRouterState, loadQuotaRows } from '../server/modelHealth.ts';
import { createFakeAdapter } from '../server/fakeProvider.ts';
import { REGISTRY_SEED, registryEntrySchema } from '../server/modelRegistry.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for live PostgreSQL tests');
const out = { summary: 'ok', patch: { ops: [{ op: 'add', section: 'facts', item: { text: 'A fact', ref: 'msg:1' } }] } };

// A unique provider id per test keeps these tests isolated from other live tests that share the database.
const isolated = (pid) => ({ registry: [registryEntrySchema.parse({ ...REGISTRY_SEED[0], providerId: pid, modelId: 'm', costTier: 'free' })] });

async function confirmedProject() {
  const p = await createProject({ name: `P09 ${Date.now()}-${Math.random().toString(16).slice(2, 6)}` });
  const cur = await getProject(p.id);
  await updateProjectState({ projectId: p.id, expectedVersion: 1, actor: 'human', sourceRef: 'ci', state: { ...cur.state, passport: { ...cur.state.passport, projectType: 'software', goal: 'g', users: 'u', inputsOutputs: 'io', constraints: 'c', securityData: 's', successCriteria: 'ok', budget: { calls: 10, tokens: 100000, executorRuns: 1 }, executor: 'manual', humanLevel: 'supervised', status: 'confirmed' } } });
  return p;
}

test('model_health: events are persisted and loaded back', async () => {
  const model = `ci/m-${Date.now()}`;
  await saveHealthEvent({ type: 'call', model, ok: true, latencyMs: 100 });
  await saveHealthEvent({ type: 'call', model, ok: false, latencyMs: 10, errorClass: 'PROVIDER_QUOTA' });
  await saveHealthEvent({ type: 'cooldown', model, until: Date.now() + 60_000 });
  const row = (await loadHealthRows()).find((r) => r.key === model);
  assert.equal(row.successes, 1); assert.equal(row.failures, 1); assert.equal(row.lastErrorClass, 'PROVIDER_QUOTA'); assert.ok(row.cooldownUntil > Date.now());
});

test('PROVIDER_AUTH survives a restart: persisted disable, audit event, fresh state does not call the provider', async () => {
  const p = await confirmedProject();
  const pid = `ci-auth-${Date.now()}`;
  const failing = createFakeAdapter(pid, ['auth']);
  await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'x' }, { ...isolated(pid), adapters: { [pid]: failing }, router: newRouterState(), quota: createQuotaTracker() }), (e) => e instanceof AnalysisError && e.code === 'MODEL_UNAVAILABLE');
  const pool = await getPool();
  const audit = await pool.query("SELECT details FROM audit_events WHERE event_type='provider.disabled' ORDER BY created_at DESC LIMIT 1");
  assert.equal(audit.rows[0].details.provider_id, pid);
  const state = await loadRouterState(newRouterState());   // what a restarted process would load
  assert.ok(state.disabledProviders.has(pid));
  const again = createFakeAdapter(pid, ['success'], out);
  await assert.rejects(() => runAnalysis({ projectId: p.id, expectedVersion: 2, task: 'y' }, { ...isolated(pid), adapters: { [pid]: again }, router: newRouterState(), quota: createQuotaTracker() }), (e) => e instanceof AnalysisError && e.code === 'MODEL_UNAVAILABLE');
  assert.equal(again.calls.length, 0);
  await pool.query("DELETE FROM model_health WHERE key=$1 OR key LIKE $2", [pid, `${pid}/%`]);   // leave the shared test database clean
});

test('day cap: at 100 % the analysis is refused before any call; a normal run reports its budget', async () => {
  const pool = await getPool();
  const ok = await confirmedProject();
  const pid = `ci-cap-${Date.now()}`;
  const adapter = createFakeAdapter(pid, ['success'], out);
  const r = await runAnalysis({ projectId: ok.id, expectedVersion: 2, task: 'normal' }, { ...isolated(pid), adapters: { [pid]: adapter }, router: newRouterState(), quota: createQuotaTracker() });
  assert.equal(r.budget.level, 'ok'); assert.equal(r.budget.cap_units, 300); assert.ok(r.budget.used_units >= 1);

  const full = await confirmedProject();
  await pool.query("INSERT INTO usage_ledger(id,run_id,provider_id,model_id,status,units) VALUES($1,$2,'gemini','m','ok',300)", [`ci-cap-${full.id}`, `${full.id}:old`]);
  const idle = createFakeAdapter(pid, ['success'], out);
  await assert.rejects(() => runAnalysis({ projectId: full.id, expectedVersion: 2, task: 'z' }, { ...isolated(pid), adapters: { [pid]: idle }, router: newRouterState(), quota: createQuotaTracker() }),
    (e) => e instanceof AnalysisError && e.code === 'DAILY_BUDGET_EXCEEDED' && e.status === 429);
  assert.equal(idle.calls.length, 0);
  await pool.query("DELETE FROM model_health WHERE key LIKE $1", [`${pid}/%`]);
});

test('quota rows come from the ledger (last 24 h)', async () => {
  const pool = await getPool();
  const id = `ci-q-${Date.now()}`;
  await pool.query("INSERT INTO usage_ledger(id,run_id,provider_id,model_id,input_tokens,output_tokens,status,units) VALUES($1,$2,'qprov','qmodel',400,100,'ok',1)", [id, `${id}:r`]);
  const rows = await loadQuotaRows(Date.now() - 86_400_000);
  const mine = rows.find((x) => x.providerId === 'qprov' && x.modelId === 'qmodel');
  assert.equal(mine.tokens, 500); assert.ok(Date.now() - mine.atMs < 60_000);
  await pool.query('DELETE FROM usage_ledger WHERE id=$1', [id]);
});

test.after(async () => { await closeDatabase(); });
