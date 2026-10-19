import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const database = fs.readFileSync(new URL('../server/database.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../server/healthRoutes.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const projectUI = fs.readFileSync(new URL('../src/ProjectMode.tsx', import.meta.url), 'utf8');
const appUI = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const modeMenuUI = fs.readFileSync(new URL('../src/ModeMenu.tsx', import.meta.url), 'utf8');

test('BX-06 Project Mode is opt-in and fails closed without required security settings', () => {
  assert.match(server, /ENABLE_PROJECT_MODE === 'true'/);
  assert.match(server, /requires APP_PASSWORD and ENABLE_APP_AUTH=true/);
  assert.match(server, /requires SESSION_SECRET/);
  assert.match(server, /requires DATABASE_URL/);
  assert.match(server, /Project Mode authentication required/);
  assert.match(server, /Project Mode writes require a same-origin request/);
});

test('BX-06 Project Mode uses persistent PostgreSQL rate limits and returns 429', () => {
  assert.match(server, /consumeRateLimit\(/);
  assert.match(server, /key: `login:\$\{ip\}`/);
  assert.match(server, /auth\.login\.succeeded/);
  assert.match(server, /RATE_LIMIT_UNAVAILABLE/);
  assert.match(server, /RATE_LIMITED/);
  assert.match(database, /schema_migrations/);
  assert.match(database, /001_project_state/);
});

test('BX-06 Simple Mode and Project Mode have separate UI entry points', () => {
  assert.match(main, /window\.location\.pathname === '\/project'/);
  assert.match(main, /<Root \/>/);
  assert.match(projectUI, /\/api\/projects/);
  assert.match(projectUI, /expected_version/);
  assert.match(projectUI, /projectModeEnabled/);
  assert.match(projectUI, /Project Mode is disabled/);
  assert.match(projectUI, /async function logout/);
  assert.match(projectUI, /href="\/"/);
  assert.match(server, /projectModeEnabled: PROJECT_MODE_ENABLED/);
  assert.match(appUI, /projectModeEnabled=\{projectModeEnabled\}/);
  // P51: the Project entry lives in the shared Mode menu and leaves the chat shell through chooseStartMode
  assert.match(modeMenuUI, /mode: 'Project'/);
  assert.match(appUI, /window\.location\.href = '\/project'/);
  assert.match(appUI, /expertMode=\{expertMode\}[\s\S]*?onSelectMode=/);
});

test('health and readiness expose stable JSON status contracts', () => {
  assert.match(routes, /app\.get\('\/health'/);
  assert.match(routes, /app\.get\('\/ready'/);
  assert.match(routes, /database_unavailable/);
});
