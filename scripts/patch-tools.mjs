// Patch tools (P13a, TZ 16.3.2): tree diff, cumulative archive, preflight, report, CI summary. Library; the commands are patch-pack.mjs and ci-summary.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';

export const ALLOWED_TOP = ['server', 'src', 'tests', 'scripts', 'docs', 'migrations', 'public', 'ARCHIVE', 'CONCEPTS'];
const IGNORED = [/^node_modules\//, /^dist\//, /^dist-server\//, /^\.git\//, /^artifacts\//, /^perf-report\.json$/, /^[^/]+\.zip$/, /^patch-report\.md$/, /^patch-logs\//, /^ci-[a-z]+\.log$/, /\.tsbuildinfo$/];
export const isIgnored = (rel) => IGNORED.some((re) => re.test(rel));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

/** Map rel path -> Buffer for a directory (ignored paths skipped). */
export function readTree(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name); const rel = posix(path.relative(dir, full));
      if (ent.isDirectory()) { if (!isIgnored(rel + '/')) walk(full); } else if (ent.isFile() && !isIgnored(rel)) out.set(rel, fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** Map rel path -> Buffer for a zip. One wrapper folder (GitHub style `repo-main/`) is stripped. */
export async function readZipTree(buf) {
  const zip = await JSZip.loadAsync(buf); const files = Object.values(zip.files).filter((f) => !f.dir);
  const first = new Set(files.map((f) => f.name.split('/')[0]));
  const wrapper = first.size === 1 && files.every((f) => f.name.includes('/')) && ![...first].some((s) => ALLOWED_TOP.includes(s) || s === '.github') ? [...first][0] + '/' : '';
  const out = new Map();
  for (const f of files) { const rel = f.name.slice(wrapper.length); if (!isIgnored(rel)) out.set(rel, await f.async('nodebuffer')); }
  return out;
}

/** replace = changed files, add = new files, del = files missing from the work tree (the owner deletes them by hand). */
export function diffTrees(base, work) {
  const replace = []; const add = []; const del = [];
  for (const [rel, buf] of work) { if (!base.has(rel)) add.push(rel); else if (sha(base.get(rel)) !== sha(buf)) replace.push(rel); }
  for (const rel of base.keys()) if (!work.has(rel)) del.push(rel);
  return { replace: replace.sort(), add: add.sort(), del: del.sort() };
}
export const summaryLine = (d) => `заменить ${d.replace.length}, добавить ${d.add.length}, удалить ${d.del.length}`
  + [['заменить', d.replace], ['добавить', d.add], ['удалить', d.del]].filter(([, l]) => l.length).map(([k, l]) => `\n  ${k}: ${l.join(', ')}`).join('');

export async function buildZip(files) {
  const zip = new JSZip();
  for (const [rel, buf] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) zip.file(rel, buf, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const SECRET_RULES = [
  ['google_api_key', /AIza[0-9A-Za-z_-]{35}/], ['openai_style_key', /\bsk-[A-Za-z0-9_-]{20,}/], ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['github_pat', /github_pat_[A-Za-z0-9_]{20,}/], ['aws_key', /\bAKIA[0-9A-Z]{16}\b/], ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['groq_key', /\bgsk_[A-Za-z0-9]{20,}/], ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['url_password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:(?!(?:password|pass|pwd|secret|changeme|user|x+|\*+)@)[^\s@/]{3,}@(?!localhost|127\.0\.0\.1|\$|\{|<)[^\s/]+/i],
  ['quoted_secret', /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{24,}['"]/i],
];
export const scanSecrets = (text) => SECRET_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
/** Allowlisted paths of `.gitleaks.toml` (regexes in triple single quotes). */
export const allowlistFromToml = (toml) => [...toml.matchAll(/'''(.+?)'''/g)].map((m) => new RegExp(m[1]));
const MANIFEST = /^(?:manifest|patch[-_]?manifest|file[-_]?list|files[-_]?list|changed[-_]?files|list[-_]?of[-_]?files)(?:\.(?:json|txt|md|ya?ml|csv|lst))?$/i;

/** Violations of the delivery rules (AGENTS 4-5, TZ 16.3.2 item 3). Empty list = the archive may be handed over. */
export function preflight({ files, deleted = [], allowlist = [] }) {
  const v = [];
  for (const [rel, buf] of files) {
    const seg = rel.split('/');
    if (!rel || rel.startsWith('/') || rel.includes('\\') || seg.some((s) => s === '' || s === '..' || s === '.')) { v.push(`${rel}: unsafe path`); continue; }
    if (seg.length === 1) { if (MANIFEST.test(rel)) v.push(`${rel}: manifest or file-list file must not be in the archive`); }
    else if (seg.length === 2) { if (!ALLOWED_TOP.includes(seg[0])) v.push(`${rel}: new or wrapper top-level folder "${seg[0]}" (the structure is flat)`); }
    else if (!(seg.length === 3 && seg[0] === '.github' && seg[1] === 'workflows') && !(seg.length === 3 && seg[0] === 'src' && seg[1] === 'workspace')) v.push(`${rel}: nested folder (the structure is flat)`);
    if (rel.startsWith('tests/acceptance/')) v.push(`${rel}: protected path tests/acceptance/**`);
    if (allowlist.some((re) => re.test(rel)) || buf.includes(0)) continue;
    for (const name of scanSecrets(buf.toString('utf8'))) v.push(`${rel}: possible secret (${name})`);
  }
  for (const rel of deleted) if (rel.startsWith('tests/acceptance/')) v.push(`${rel}: protected path tests/acceptance/** is missing from the work tree`);
  return v;
}

/** First failed test or error in a log (TAP, spec reporter, npm error). */
export function firstFailure(log) {
  for (const re of [/^\s*not ok \d+ - (.+)$/m, /^\s*[✖✗] (.+?)(?: \(\d[\d.]*ms\))?$/m, /^(.*(?:AssertionError|Error:).*)$/m, /^(npm error .+)$/m]) {
    const m = log.match(re); if (m) return m[1].trim().slice(0, 200);
  }
  return null;
}

/** Short CI result for the step summary and the failure annotation (TZ 16.3.2 item 7). */
export function ciSummary(status, logs) {
  if (status === 'success') return { ok: true, text: 'CI: green' };
  const found = logs.map((l) => firstFailure(l)).find(Boolean);
  return { ok: false, text: `CI: red. First failed: ${found ?? 'no test log (see the failed step)'}` };
}

export function overallStatus(preflightViolations, commands) {
  if (preflightViolations.length) return 'FAIL';
  // PASS means every required check actually passed. Unrun or blocked checks are never green.
  if (commands.some((c) => ['FAIL', 'TIMEOUT', 'KNOWN_FAIL', 'BLOCKED', 'NOT_RUN'].includes(c.status))) return 'PARTIAL';
  return 'PASS';
}

export function renderReport({ patch, agent, base, diff, violations, commands, notes, ownerSteps, status }) {
  const rows = commands.map((c) => `| \`${c.cmd}\` | ${c.status} | ${c.note.replace(/\|/g, '/').replace(/\n/g, ' ')} |`).join('\n');
  const red = commands.filter((c) => c.status !== 'PASS');
  const redTable = red.length ? '\n## Ошибки, таймауты и пропущенные проверки\n\n| Этап | Статус | Лог | Детали |\n|---|---|---|---|\n' + red.map((c) => `| ${c.cmd} | ${c.status} | ${c.logPath || 'см. примечание'} | ${c.note.replace(/\|/g, '/').replace(/\n/g, ' ')} |`).join('\n') + '\n' : '';
  const list = (t, l) => (l.length ? l.map((f) => `| \`${f}\` | ${t} |`).join('\n') : '');
  const files = [list('replace', diff.replace), list('add', diff.add), list('delete (by hand)', diff.del)].filter(Boolean).join('\n') || '| (no changes) | |';
  const steps = ownerSteps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `# ${patch} — отчёт\n\n## Статус\n\`${status}\`${status === 'PASS' ? ' по локальным проверкам; окончательный PASS даёт CI на опубликованном коммите (D-08)' : ''}\n\n## Сводка\n- **Патч:** ${patch}\n- **Инструмент и модель:** ${agent}\n- **Базовый архив:** ${base}\n- **Состав:** ${summaryLine(diff).split('\n')[0]}\n\n## Файлы\n| Файл | Изменение |\n|---|---|\n${files}\n\n## Preflight и архив\n${violations.length ? violations.map((x) => `- FAIL: ${x}`).join('\n') : '- PASS: состав и пути проверены; архив создан до запуска проверок и проверен повторным чтением ZIP.'}\n\n## Команды (только выполненные скриптом)\n| Команда | Результат | Примечание |\n|---|---|---|\n${rows}\n${redTable}\nСтатусы этапов: PASS, FAIL, BLOCKED, TIMEOUT, KNOWN_FAIL, NOT_RUN. Итог PASS означает, что все учтённые проверки прошли; любой FAIL/TIMEOUT/BLOCKED/NOT_RUN даёт PARTIAL, если preflight пройден. Критическое нарушение preflight блокирует архив и даёт FAIL.\n\n## Не сделано и известные проблемы\n${notes || 'Не указано исполнителем.'}\n\n## Действия владельца на Railway\n${steps}\n`;
}
