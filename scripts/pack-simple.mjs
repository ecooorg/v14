#!/usr/bin/env node
/**
 * Simple, predictable patch packer (P19 standard).
 * Usage: node scripts/pack-simple.mjs --base <base.zip|folder> --patch P19 [--out bf-P19.zip]
 * - Diffs work tree vs base, includes only new/changed files (relative paths).
 * - Handles moves into ARCHIVE/ and CONCEPTS/.
 * - Excludes ignored paths, the archive itself, empty dirs.
 * - Timeout-safe: no child processes that can hang; pure Node + JSZip.
 * - Prints file list and exits non-zero on preflight failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readTree, readZipTree, diffTrees, buildZip, preflight, allowlistFromToml, isIgnored } from './patch-tools.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const root = process.cwd();
const basePath = opt('base');
const patch = opt('patch', 'PNN');
if (!basePath || !fs.existsSync(basePath)) {
  console.error('Usage: node scripts/pack-simple.mjs --base <archive.zip|folder> --patch <PNN> [--out bf-PNN.zip]');
  process.exit(64);
}
const outName = opt('out', `bf-${patch.toLowerCase().replace(/^p/, 'P')}.zip`.replace('PP', 'P'));
const outPath = path.resolve(outName);

const TIMEOUT_MS = 120_000;
const timer = setTimeout(() => { console.error('TIMEOUT: pack exceeded 120 s'); process.exit(124); }, TIMEOUT_MS);

try {
  const base = fs.statSync(basePath).isDirectory() ? readTree(basePath) : await readZipTree(fs.readFileSync(basePath));
  const work = readTree(root);
  const diff = diffTrees(base, work);
  const files = new Map([...diff.replace, ...diff.add].map((rel) => [rel, work.get(rel)]));
  // Drop the output archive itself if it appears in the tree
  files.delete(path.basename(outPath));
  files.delete(outName);
  const toml = fs.existsSync('.gitleaks.toml') ? fs.readFileSync('.gitleaks.toml', 'utf8') : '';
  const violations = preflight({ files, deleted: diff.del, allowlist: allowlistFromToml(toml) });
  if (violations.length) {
    console.error('PREFLIGHT FAIL:');
    for (const v of violations) console.error(' -', v);
    process.exit(1);
  }
  const buf = await buildZip(files);
  fs.writeFileSync(outPath, buf);
  console.log(`OK: ${outPath}`);
  console.log(`replace ${diff.replace.length}, add ${diff.add.length}, delete (owner hand) ${diff.del.length}`);
  for (const r of diff.replace) console.log(`  R ${r}`);
  for (const a of diff.add) console.log(`  A ${a}`);
  for (const d of diff.del.slice(0, 30)) console.log(`  D ${d}`);
  if (diff.del.length > 30) console.log(`  ... and ${diff.del.length - 30} more deletions`);
  clearTimeout(timer);
  process.exit(0);
} catch (e) {
  clearTimeout(timer);
  console.error('PACK ERROR:', e?.message ?? e);
  process.exit(1);
}
