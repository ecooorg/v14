#!/usr/bin/env node
/**
 * PA-04: merge one or more e01-run.json (+ optional minutes) into NOTES markdown
 * and RESULTS json shapes. No network. No secrets.
 *
 * Usage:
 *   node scripts/e01-notes-merge.mjs --runs tests/pa04-fixtures.json --minutes t1:model:8,t1:manual:12 --out-dir /tmp/e01-out
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const runsPath = opt('runs', 'tests/pa04-fixtures.json');
const minutesArg = opt('minutes', '');
const outDir = opt('out-dir', '.');

function parseMinutes(s) {
  const map = new Map();
  if (!s) return map;
  for (const part of s.split(',')) {
    const [key, val] = part.split(':').length === 3
      ? [`${part.split(':')[0]}:${part.split(':')[1]}`, part.split(':')[2]]
      : [null, null];
    // format task:side:minutes e.g. t1:model:8
    const m = /^e?0?1?-?(t[123]):(model|manual):(\d+)$/i.exec(part.trim())
      || /^(t[123]):(model|manual):(\d+)$/i.exec(part.trim());
    if (m) map.set(`${m[1].toLowerCase()}:${m[2].toLowerCase()}`, Number(m[3]));
  }
  return map;
}

function normalizeSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'model' || s === 'model_patch') return 'model_patch';
  if (s === 'manual') return 'manual';
  return s;
}

function loadRuns(p) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.runs)) return data.runs;
  return [data];
}

const minutes = parseMinutes(minutesArg);
const runs = loadRuns(runsPath);

const pairs = runs.map((r) => {
  const taskRaw = String(r.taskId || r.task || '').replace(/^e01-/, '');
  const taskId = taskRaw.startsWith('t') ? `e01-${taskRaw}` : String(r.taskId || 'e01-t?');
  const side = normalizeSide(r.side);
  const key = `${taskId.replace('e01-', '')}:${side === 'model_patch' ? 'model' : 'manual'}`;
  const humanMinutes = minutes.has(key)
    ? minutes.get(key)
    : Number(r.humanMinutes ?? 0);
  return {
    taskId,
    side,
    applied: r.applied !== false,
    ciGreenFirst: Boolean(r.ciGreenFirst ?? r.green ?? false),
    fixes: Number(r.fixes ?? 0),
    humanMinutes,
    costUsd: Number(r.costUsd ?? 0),
    sha: r.sha || null,
    ciUrl: r.ciUrl || r.workflowRun || null,
    prUrl: r.prUrl || null,
    notes: r.tool ? `tool: ${r.tool}` : (r.notes || null),
  };
});

const lines = ['# E-01 notes', '', `generated: ${new Date().toISOString()}`, ''];
for (const p of pairs) {
  lines.push(`## ${p.taskId} ${p.side}`);
  lines.push(`- applied: ${p.applied ? 'да' : 'нет'}`);
  lines.push(`- ciGreenFirst: ${p.ciGreenFirst ? 'да' : 'нет'}`);
  lines.push(`- fixes: ${p.fixes}`);
  lines.push(`- humanMinutes: ${p.humanMinutes}`);
  lines.push(`- sha: ${p.sha || ''}`);
  lines.push(`- ciUrl: ${p.ciUrl || ''}`);
  if (p.prUrl) lines.push(`- prUrl: ${p.prUrl}`);
  if (p.notes) lines.push(`- notes: ${p.notes}`);
  lines.push('');
}

const results = {
  experiment: 'E-01',
  generatedAt: new Date().toISOString(),
  test_repo: 'ecooorg/biforge-e01-lab',
  pairs,
};

fs.mkdirSync(outDir, { recursive: true });
const notesPath = path.join(outDir, 'E01-NOTES.md');
const resultsPath = path.join(outDir, 'E01-RESULTS.json');
fs.writeFileSync(notesPath, lines.join('\n'));
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ notesPath, resultsPath, pairs: pairs.length }, null, 2));
