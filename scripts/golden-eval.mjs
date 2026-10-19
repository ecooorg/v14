// Golden-eval runner (P10). Fake adapters only: `tsx scripts/golden-eval.mjs --fake [--date YYYY-MM-DD] [--out path]`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoldenTasks, createGoldenFakeAdapter, runGoldenEval, renderReport } from '../server/goldenEval.ts';
import { REGISTRY_SEED, registryEntrySchema } from '../server/modelRegistry.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!args.includes('--fake')) { console.error('Live mode is not part of P10. Run with --fake.'); process.exit(2); }
const date = opt('--date') ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('--date must be YYYY-MM-DD'); process.exit(2); }
const out = path.resolve(opt('--out') ?? path.join(root, 'ARCHIVE/GOLDEN-EVAL-REPORT.md'));

const tasks = loadGoldenTasks();
const entry = (providerId, modelId, extra = {}) => registryEntrySchema.parse({ ...REGISTRY_SEED[0], providerId, modelId, costTier: 'free', ...extra });
const run = await runGoldenEval({
  tasks, mode: 'fake', date,
  models: [
    { entry: entry('fake-strong', 'model-a', { pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 } }), adapter: createGoldenFakeAdapter('fake-strong', 'strong', tasks) },
    { entry: entry('fake-weak', 'model-b'), adapter: createGoldenFakeAdapter('fake-weak', 'weak', tasks) },
  ],
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, renderReport(run));
console.log(`golden-eval: report written to ${path.relative(root, out) || out}`);
