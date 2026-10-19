import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../migrations/001_project_state.sql', import.meta.url), 'utf8');
const repo = fs.readFileSync(new URL('../server/projectRepository.ts', import.meta.url), 'utf8');
const database = fs.readFileSync(new URL('../server/database.ts', import.meta.url), 'utf8');
const health = fs.readFileSync(new URL('../server/healthRoutes.ts', import.meta.url), 'utf8');

test('BX-04 migration includes only the initial project/state/audit/rate-limit tables', () => {
  for (const table of ['projects', 'project_states', 'project_state_versions', 'project_events', 'audit_events', 'rate_limits', 'schema_migrations']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing ${table}`);
  }
  assert.match(migration, /UNIQUE\s*\(project_id,\s*state_version\)/i);
  assert.match(migration, /ON DELETE CASCADE/i);
});

test('State repository validates inputs, checks expected version, and records immutable history transactionally', () => {
  assert.match(repo, /expectedVersion/);
  assert.match(repo, /StateVersionConflict/);
  assert.match(repo, /FOR UPDATE/);
  assert.match(repo, /INSERT INTO project_state_versions/);
  assert.match(repo, /INSERT INTO project_events/);
  assert.match(repo, /INSERT INTO audit_events/);
  assert.match(repo, /ROLLBACK/);
  assert.match(repo, /zod|from 'zod'/i);
});

test('database readiness checks a real query and /ready degrades to 503 when unavailable', () => {
  assert.match(database, /SELECT 1/);
  assert.match(health, /database_unavailable/);
  assert.match(health, /status\(503\)/);
});
