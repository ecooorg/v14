#!/usr/bin/env node
/**
 * Pilot helper (PA-03 / RM-F1 candidate): render evidence.json as a concise Markdown report.
 * Dependency-free and read-only. It never prints raw input JSON or unknown object fields.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function redact(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_TOKEN]')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\r\n|]+/g, ' ')
    .slice(0, 240);
}

export function renderEvidenceMarkdown(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('evidence_root_must_be_object');
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const lines = [
    '# Evidence report',
    '',
    `- Generated: ${redact(data.generated_at || data.generatedAt || 'unknown')}`,
    `- Commit: ${redact(data.commit || 'unknown')}`,
    `- Run: ${redact(data.run || 'not linked')}`,
    `- Checks: ${checks.length}`,
    '',
    '| Check | Status | Detail |',
    '|---|---|---|',
  ];
  for (const item of checks) {
    if (!item || typeof item !== 'object') continue;
    lines.push(`| ${redact(item.id || item.name || 'unnamed')} | ${redact(item.status || 'UNKNOWN')} | ${redact(item.detail || item.reason || '')} |`);
  }
  lines.push('', '## Evidence boundary', '', 'This report is a rendering of the supplied evidence file, not an independent verification. Missing fields are not treated as PASS.', '');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const inputPath = arg('--input') || 'evidence.json';
  const outputPath = arg('--out');
  const markdown = renderEvidenceMarkdown(fs.readFileSync(inputPath, 'utf8'));
  if (outputPath) fs.writeFileSync(outputPath, markdown);
  else process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) { console.error(`evidence-to-markdown failed: ${String(error?.message || 'invalid_input').slice(0, 100)}`); process.exitCode = 1; }
}
