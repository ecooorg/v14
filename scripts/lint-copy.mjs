#!/usr/bin/env node
/** Fail if non-English UI literals appear outside allowed files (LNG-1). */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const APP = path.join(ROOT, 'app');
// Cyrillic / CJK in TSX as string literals is banned except i18n
const BAD = /['"`][^'"`]*[А-Яа-яЁё\u4e00-\u9fff]/
let failed = false;

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(tsx|ts|jsx|js)$/.test(name) && !name.includes('i18n') && !name.includes('support') && !name.includes('coffee')) {
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        if (BAD.test(line)) {
          console.error(`${p}:${i + 1}: possible non-English UI literal`);
          failed = true;
        }
      });
    }
  }
}
walk(APP);
if (failed) process.exit(1);
console.log('lint:copy ok');
