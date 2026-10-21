import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = ['README.md', 'AGENTS.md', 'docs'];
const files = [];

function walk(p) {
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (ent.isFile() && full.endsWith('.md')) files.push(full);
  }
}

for (const c of candidates) {
  const full = path.join(root, c);
  if (!fs.existsSync(full)) continue;
  if (fs.statSync(full).isDirectory()) walk(full);
  else files.push(full);
}

const errors = [];

for (const file of [...new Set(files)]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '');
    if (!raw || /^(?:https?:|mailto:|tel:|#|data:|\{\{)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#')[0].split('?')[0]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      errors.push(`${path.relative(root, file)}: link escapes repository: ${raw}`);
    } else if (!fs.existsSync(resolved)) {
      errors.push(`${path.relative(root, file)}: missing link target: ${raw}`);
    }
  }
}

const pathDocs = ['AGENTS.md', 'README.md', 'docs/DEPLOY.md', 'docs/START_HERE.md', 'docs/STATUS.md', 'docs/README.md'];
const EXT = /\.(md|ts|tsx|mjs|json|toml|yaml|yml|txt|sql|sh|html|css|png|svg|example|csv)$/i;
const GENERATED = /^(dist|dist-server|node_modules|artifacts)(\/|$)|^perf-report\.json$/;
let pathChecks = 0;

function existsAsPath(fromFile, tok) {
  const candidates = [
    path.resolve(root, tok),
    path.resolve(path.dirname(fromFile), tok),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

for (const rel of pathDocs) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    errors.push(`${rel}: file listed for path checks is missing`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const line of text.split('\n')) {
    if (/will be created|to be created|retired from the repository/i.test(line)) continue;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      let tok = m[1].trim();
      if (/\s/.test(tok) || /[*<>{}$=:|(),;@]/.test(tok) || /XX|NN|0X/.test(tok) || /^(https?|mailto):/i.test(tok)) continue;
      tok = tok.replace(/^\.\//, '').replace(/\/$/, '');
      if (!tok || tok.startsWith('/') || !(EXT.test(tok) || m[1].trim().endsWith('/')) || GENERATED.test(tok)) continue;
      if (/^docs\/\d{2}$/.test(tok)) continue;
      // skip bare filenames that are only historical mentions
      if (/BiForge_TZ|SPEC_PRODUCT|SPEC_ENGINE|REPO_MAP|PATCH_JOURNAL|CURRENT_STATE|OWNER_OPS/i.test(tok) && !tok.includes('/')) continue;
      pathChecks++;
      if (!existsAsPath(file, tok)) {
        errors.push(`${rel}: missing path in backticks: ${m[1]}`);
      }
    }
  }
}

if (errors.length) {
  console.error(`check:docs failed (${errors.length} problem(s))`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log(`check:docs OK (${files.length} Markdown files, ${pathChecks} backticked paths checked)`);
