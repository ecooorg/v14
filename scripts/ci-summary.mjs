// CI result for the owner (P13a, TZ 16.3.2 item 7): one line in the job summary and, when red, an error annotation with the first failed test. No secrets, no network.
import fs from 'node:fs';
import { ciSummary } from './patch-tools.mjs';

const logs = process.argv.slice(2).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
const r = ciSummary(process.env.CI_STATUS ?? 'unknown', logs);
console.log(r.ok ? r.text : `::error title=BiForge CI::${r.text}`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${r.text}\n`);
