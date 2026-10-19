import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const repo = fs.readFileSync(new URL('../server/projectRepository.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

// Updated in P56: the same contracts, asserted against the current code (messages and structure moved after BX-06).
test('Project Mode is opt-in and requires credentials plus PostgreSQL at startup', () => {
  assert.match(server, /ENABLE_PROJECT_MODE === 'true'/);
  assert.match(server, /ENABLE_PROJECT_MODE=true requires APP_PASSWORD and ENABLE_APP_AUTH=true/);
  assert.match(server, /Project Mode must never start without authentication/);
  assert.match(server, /ENABLE_PROJECT_MODE=true requires SESSION_SECRET/);
  assert.match(server, /ENABLE_PROJECT_MODE=true requires DATABASE_URL/);
  assert.match(server, /SESSION_SECRET is required \(at least 16 characters\)/);
});

test('Project Mode mutating routes require same-origin Origin and persistent rate limiting', () => {
  assert.match(server, /Project Mode writes require a same-origin request/);
  assert.match(server, /code: 'CSRF_ORIGIN'/);
  assert.match(server, /consumeRateLimit\(\{ key, limit: Number\(process\.env\.PROJECT_RATE_LIMIT_PER_MINUTE\) \|\| 300, windowMs: 60_000 \}\)/);
  assert.match(repo, /INSERT INTO rate_limits/);
});

test('Project Mode routes are gated and its UI is a separate switchable page', () => {
  assert.match(server, /PROJECT_MODE_DISABLED/);
  assert.match(server, /app\.get\('\/api\/projects'/);
  assert.match(server, /app\.post\('\/api\/projects'/);
  assert.match(main, /pathname === '\/project'/);
  assert.match(main, /lazy\(\(\) => import\('\.\/ProjectMode\.tsx'\)\)/);
  assert.match(app, /data-testid="start-mode-project"/);
  assert.match(app, /disabled=\{!projectModeEnabled\}/);
  assert.match(app, /if \(mode === 'Project' && !projectModeEnabled\) return;/);
});

test('Simple Mode still uses its existing decision state and local storage path', () => {
  assert.match(app, /getStoredDecisions/);
  assert.match(app, /saveDecisions/);
  assert.match(app, /chooseStartMode\('Simple'\)|mode === 'Simple'/);
});
