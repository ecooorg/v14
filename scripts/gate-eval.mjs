#!/usr/bin/env node
/**
 * PA-01 — gate evaluator. Applies the decision rules of TZ 11.9 (E-01 / ADR-10) and TZ 17 (G1a…G4)
 * to evidence rows and prints a decision card (docs/DECISION_CARD_TEMPLATE.md). No network, no secrets, no side effects.
 *
 * Usage:
 *   node scripts/gate-eval.mjs --card <ADR-10|G1a|G1|G2|G3|G4> --input evidence.json [--json]
 *   node scripts/gate-eval.mjs --all --input evidence.json
 *
 * evidence.json: { "date": "YYYY-MM-DD", "commit": "<sha>", "ci": "<url>",
 *   "steps": { "RM-B4": { "status": "PASS", "record": "<path or url>", "note": "", "by": "owner", "reason": "" } },
 *   "e01": [ { "task","executor","applies","ci_first_green","green","fixes","human_minutes","cost","sha","ci_url" } ] }
 * The evaluator never sets a decision: it only recommends. The Navigator answers the card.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'REAL_ONLY', 'WAIVED', 'OWNER_ATTESTED', 'SCRIPTED_HUMAN_STEP', 'PARTIAL'];

/** Steps whose nature is an owner judgement; an owner attestation with a record may close them (and nothing else). */
export const ATTEST_ALLOWED = new Set(['RM-A2', 'RM-B1']);

const range = (p, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `RM-${p}${a + i}`);

/** Required evidence steps per gate (docs/NEXT.md; TZ 17). The decision step itself (RM-B7, RM-D6, RM-F8) is not in the list. */
export const GATES = {
  G1a: ['RM-B1'],
  G1: ['RM-B2', 'RM-B3'],
  G2: ['RM-B4', 'RM-B5', 'RM-B6'],
  G3: [...range('D', 1, 5)],
  G4: [...range('E', 1, 7), ...range('F', 1, 6)],
};
/** Added to G3 when the E-01 branch was positive (stage C). */
export const G3_IF_POSITIVE = ['RM-C2', 'RM-C3'];

const RULES = {
  'ADR-10': 'TZ 11.9: model_patch reached green CI within 2 fixes in at least 2 of 3 tasks and is not worse than manual in summed human time',
  G1a: 'TZ 17 / 18.0: vertical slice; owner notes on a real analysis',
  G1: 'TZ 17: second provider confirmed (or REAL_ONLY with reason); real fallback smoke',
  G2: 'TZ 17 / 18.1: scenario 18.1 with data, E-01 done, ADR-10 decided',
  G3: 'TZ 17: GitHub, Gate Engine, Repair Loop, pilot task to PR and human decision',
  G4: 'TZ 17: security evidence, backup and restore, rollback drill, pilot S3 accepted, cost report',
};

// ---------- secrets ----------
const SECRET_NAME = /KEY|SECRET|PASSWORD|DATABASE_URL|TOKEN/;
const SECRET_SHAPE = /AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|gsk_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
/** Remove values of secret-named environment variables and well-known key shapes from any outgoing text. */
export function scrub(text, env = process.env) {
  let out = String(text);
  for (const n of Object.keys(env)) {
    const v = env[n];
    if (SECRET_NAME.test(n) && typeof v === 'string' && v.length >= 6) out = out.split(v).join('[redacted]');
  }
  return out.replace(SECRET_SHAPE, '[redacted]');
}

// ---------- steps ----------
const has = (s) => typeof s === 'string' && s.trim().length > 0;

/** Verdict of one step: satisfied or not, with the reason and a deviation note if a weaker evidence kind was used. */
export function stepVerdict(id, row) {
  if (!row || typeof row !== 'object') return { id, status: 'NOT_RUN', ok: false, failed: false, why: 'no evidence row' };
  const st = String(row.status || '').toUpperCase();
  const record = has(row.record);
  if (!STATUSES.includes(st)) return { id, status: 'NOT_RUN', ok: false, failed: false, why: `unknown status ${String(row.status).slice(0, 30)}` };
  if (st === 'FAIL') return { id, status: 'FAIL', ok: false, failed: true, why: 'step failed', record: row.record };
  if (st === 'PASS') return record
    ? { id, status: 'PASS', ok: true, failed: false, record: row.record }
    : { id, status: 'NOT_RUN', ok: false, failed: false, why: 'PASS without a record in the repository counts as NOT_RUN' };
  if (st === 'SCRIPTED_HUMAN_STEP') return record
    ? { id, status: st, ok: true, failed: false, record: row.record, deviation: `${id}: human step was scripted in a test project (mechanism proven, human judgement not exercised)` }
    : { id, status: 'NOT_RUN', ok: false, failed: false, why: 'scripted step without a record' };
  if (st === 'OWNER_ATTESTED') return ATTEST_ALLOWED.has(id) && record
    ? { id, status: st, ok: true, failed: false, record: row.record, deviation: `${id}: owner attestation instead of measured data` }
    : { id, status: 'NOT_RUN', ok: false, failed: false, why: ATTEST_ALLOWED.has(id) ? 'attestation without a record' : 'attestation is not accepted for this step (needs data)' };
  if (st === 'WAIVED') return row.by === 'owner' && has(row.reason)
    ? { id, status: st, ok: true, failed: false, record: row.record, deviation: `${id}: WAIVED by owner: ${String(row.reason).slice(0, 120)}` }
    : { id, status: 'NOT_RUN', ok: false, failed: false, why: 'WAIVED needs by=owner and a reason' };
  return { id, status: st, ok: false, failed: false, why: row.note ? String(row.note).slice(0, 120) : `status ${st}` };
}

// ---------- E-01 ----------
const SHA = /^[0-9a-f]{7,40}$/i;
function validPair(p) {
  return p && typeof p === 'object' && has(p.task) && (p.executor === 'manual' || p.executor === 'model_patch')
    && typeof p.applies === 'boolean' && typeof p.green === 'boolean'
    && Number.isInteger(p.fixes) && p.fixes >= 0
    && typeof p.human_minutes === 'number' && p.human_minutes >= 0
    && typeof p.cost === 'number' && p.cost >= 0
    && typeof p.sha === 'string' && SHA.test(p.sha) && typeof p.ci_url === 'string' && /^https:\/\//.test(p.ci_url);
}
export const pairSuccess = (p) => p.applies && p.green && p.fixes <= 2;

/** TZ 11.9 decision rule. Returns { result, mp, mn, timeMp, timeManual, problems }. */
export function evaluateE01(rows) {
  const problems = [];
  if (!Array.isArray(rows) || rows.length === 0) return { result: 'INSUFFICIENT_EVIDENCE', problems: ['no E-01 rows'] };
  rows.forEach((p, i) => { if (!validPair(p)) problems.push(`row ${i + 1} is incomplete or invalid (SHA, CI link, numbers required)`); });
  const ok = rows.filter(validPair);
  const tasks = [...new Set(ok.map((p) => p.task))];
  if (tasks.length !== 3) problems.push(`need exactly 3 tasks, found ${tasks.length}`);
  for (const t of tasks) for (const ex of ['manual', 'model_patch']) {
    const n = ok.filter((p) => p.task === t && p.executor === ex).length;
    if (n !== 1) problems.push(`task "${t}": expected one ${ex} row, found ${n}`);
  }
  if (problems.length) return { result: 'INSUFFICIENT_EVIDENCE', problems };
  const mpRows = ok.filter((p) => p.executor === 'model_patch');
  const mnRows = ok.filter((p) => p.executor === 'manual');
  const mp = mpRows.filter(pairSuccess).length;
  const mn = mnRows.filter(pairSuccess).length;
  const sum = (a) => a.reduce((s, p) => s + p.human_minutes, 0);
  const timeMp = sum(mpRows), timeManual = sum(mnRows);
  let result;
  if (mp >= 2 && timeMp <= timeManual) result = 'POSITIVE';
  else if (mp < 2 && mn < 2) result = 'BOTH_FAILED';
  else if (mp < 2 && mn >= 2) result = 'NEGATIVE';
  else result = 'NEEDS_HUMAN'; // model_patch succeeded but is worse in human time: the TZ leaves "clearly worse" to the owner
  return { result, mp, mn, timeMp, timeManual, problems: [] };
}

// ---------- gates ----------
export function evaluateGate(gate, evidence = {}) {
  let required = GATES[gate];
  if (!required) throw new Error(`unknown gate ${gate}`);
  const branch = evidence.e01 ? evaluateE01(evidence.e01).result : evidence.e01_branch;
  if (gate === 'G3' && branch === 'POSITIVE') required = [...required, ...G3_IF_POSITIVE];
  const steps = evidence.steps || {};
  const verdicts = required.map((id) => stepVerdict(id, steps[id]));
  const failed = verdicts.some((v) => v.failed);
  const complete = verdicts.every((v) => v.ok);
  return {
    gate, verdicts,
    result: failed ? 'NEGATIVE' : complete ? 'POSITIVE' : 'INSUFFICIENT_EVIDENCE',
    deviations: verdicts.filter((v) => v.deviation).map((v) => v.deviation),
  };
}

// ---------- card ----------
const ACCEPT_TEXT = {
  'ADR-10': {
    POSITIVE: 'write docs/ADR-10-code-executor.md status ACCEPTED with the E-01 table; tick RM-B6 in docs/NEXT.md; prepare the P19x SPEC (stage C)',
    NEGATIVE: 'write ADR-10 ACCEPTED with the negative outcome; CODE_EXECUTOR stays manual; skip stage C; go to stage D',
    BOTH_FAILED: 'write ADR-10 ACCEPTED with the outcome "both failed"; narrow S3 to specification and package preparation; owner reviews G3',
  },
};
const REJECT_TEXT = {
  'ADR-10': 'ADR-10 stays INTERIM; more E-01 data is collected (separate tasks or a new model)',
};

function recommendation(card, result, ev) {
  if (card === 'ADR-10') {
    if (result === 'POSITIVE' || result === 'NEGATIVE' || result === 'BOTH_FAILED') return ['ACCEPT', `E-01 outcome ${result}: the rule of TZ 11.9 selects its branch mechanically`];
    if (result === 'NEEDS_HUMAN') return ['NO_RECOMMENDATION', 'model_patch passed on tasks but is worse in human time; "clearly worse" is the owner\'s judgement'];
    return ['COLLECT_MORE', 'the E-01 table is incomplete or invalid'];
  }
  if (result === 'POSITIVE') return ['ACCEPT', `all required steps of ${card} have records`];
  if (result === 'NEGATIVE') return ['REJECT', 'at least one required step failed'];
  return ['COLLECT_MORE', `${ev.verdicts.filter((v) => !v.ok).length} required step(s) lack accepted evidence`];
}

/** Build the structured card for ADR-10 or a gate. */
export function buildCard(card, evidence = {}) {
  const date = evidence.date || 'unknown';
  const base = { card, date, commit: evidence.commit || 'unknown', ci: evidence.ci || 'unknown', rule: RULES[card] };
  if (card === 'ADR-10') {
    const e = evaluateE01(evidence.e01);
    const rows = (Array.isArray(evidence.e01) ? evidence.e01 : []).map((p) => `${p.task || '?'} / ${p.executor || '?'} | ${validPair(p) ? (pairSuccess(p) ? 'PASS' : 'FAIL') : 'NOT_RUN'} | ${p.sha || '-'} ${p.ci_url || ''}`.trim());
    if (!rows.length) rows.push('E-01 table | NOT_RUN | no rows');
    const [rec, why] = recommendation(card, e.result, e);
    return { ...base, evidence: rows.concat(e.problems.map((m) => `problem | NOT_RUN | ${m}`), e.mp !== undefined ? [`summary | model_patch ${e.mp}/3 vs manual ${e.mn}/3; human minutes ${e.timeMp} vs ${e.timeManual}`] : []),
      result: e.result, recommendation: rec, why, deviations: [],
      ifAccepted: ACCEPT_TEXT['ADR-10'][e.result] || 'nothing is changed', ifRejected: REJECT_TEXT['ADR-10'] };
  }
  const ev = evaluateGate(card, evidence);
  const [rec, why] = recommendation(card, ev.result, ev);
  return { ...base, evidence: ev.verdicts.map((v) => `${v.id} | ${v.status} | ${v.record || v.why || '-'}`),
    result: ev.result, recommendation: rec, why, deviations: ev.deviations,
    ifAccepted: `record "${card} accepted" with the date in docs/CURRENT_STATE.md; tick the decision step in docs/NEXT.md`,
    ifRejected: 'the gate stays open; the missing or failed steps are listed above' };
}

export function renderCard(c) {
  const lines = [
    `CARD: ${c.card}`,
    `DATE: ${c.date}   COMMIT: ${c.commit}   CI: ${c.ci}`,
    `RULE: ${c.rule}`,
    'EVIDENCE:', ...c.evidence.map((r) => `  ${r}`),
    `RULE RESULT: ${c.result}`,
    `RECOMMENDATION: ${c.recommendation} - ${c.why}`,
    `DEVIATIONS FROM THE TZ: ${c.deviations.length ? c.deviations.join('; ') : 'none'}`,
    `IF ACCEPTED, THE AI ASSISTANT WILL: ${c.ifAccepted}`,
    `IF REJECTED: ${c.ifRejected}`,
    `REPLY: "ok ${c.card}" or "no ${c.card}: <reason>"`,
  ];
  return scrub(lines.join('\n'));
}

// ---------- CLI ----------
function main() {
  const a = process.argv.slice(2);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const input = val('--input');
  if (!input) { console.error('usage: gate-eval.mjs (--card <ADR-10|G1a|G1|G2|G3|G4> | --all) --input evidence.json [--json]'); process.exit(1); }
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(input, 'utf8')); } catch (e) { console.error(`cannot read evidence: ${e.message}`); process.exit(1); }
  const names = a.includes('--all') ? ['ADR-10', 'G1a', 'G1', 'G2', 'G3', 'G4'] : [val('--card')];
  if (names.some((n) => n !== 'ADR-10' && !GATES[n])) { console.error('unknown card'); process.exit(1); }
  const cards = names.map((n) => buildCard(n, evidence));
  if (a.includes('--json')) console.log(scrub(JSON.stringify(cards, null, 2)));
  else console.log(cards.map(renderCard).join('\n\n'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
