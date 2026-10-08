import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(f, 'utf8');
const app = read('src/components/ConversationFiles.tsx');
const shell = read('src/App.tsx');
const errors = read('src/i18n/errors.ts');
const ui = read('src/i18n/ui.ts');
const server = read('server.ts');
const cfg = read('src/config.ts');
const pkg = JSON.parse(read('package.json'));

assert.match(cfg, /APP_VERSION\s*=\s*'1\.5\.0'/);
assert.equal(pkg.version, '1.5.0');
for (const label of ['Shorter', 'Add table', 'Remove section', 'Choose heading', 'Save…', 'Word (.docx)', 'PDF', 'Google Docs']) assert.match(app, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(app, /\/api\/revise-document/);
assert.match(app, /onDocumentEdit/);
assert.match(shell, /Retry/);
assert.match(shell, /onDrop/);
assert.match(shell, /From backup/);
assert.match(shell, /Export all/);
assert.match(shell, /360/);
for (const code of ['TOO_LARGE','UNSUPPORTED_TYPE','UNREADABLE','EMPTY','EMPTY_TEXT','RATE_LIMIT','ATTACH_FAILED','EXPORT_FAILED','BAD_FORMAT','EMPTY_DOCUMENT','BAD_UPLOAD','TOO_LONG','PRECONDITION']) assert.match(errors, new RegExp(code));
assert.match(ui, /'Shorter': 'Короче'/);
assert.match(ui, /'Add table': 'Добавить таблицу'/);
assert.match(server, /app\.post\('\/api\/revise-document'/);
console.log('package C static checks passed');
