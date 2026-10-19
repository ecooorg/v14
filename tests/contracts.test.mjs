import test from 'node:test';
import assert from 'node:assert/strict';
import {
  idSchema, projectSchema, stateSchema, projectEventSchema,
  normalizedRequestSchema, normalizedResponseSchema, createProjectRequestSchema, updateProjectStateRequestSchema,
  BiForgeError, ValidationError, NotFoundError, ConflictError,
  UnauthorizedError, ForbiddenError, RateLimitedError, UnavailableError,
} from '../server/contracts.ts';

test('ID contract accepts stable safe IDs and rejects malformed IDs', () => {
  assert.equal(idSchema.parse('proj_123-A'), 'proj_123-A');
  for (const id of ['', 'contains space', '../escape', 'x'.repeat(129)]) assert.equal(idSchema.safeParse(id).success, false);
});

test('Project contract applies defaults and rejects unknown fields', () => {
  assert.equal(projectSchema.parse({ id: 'p1', name: ' Demo ' }).status, 'draft');
  assert.equal(projectSchema.safeParse({ id: 'p1', name: 'Demo', admin: true }).success, false);
  assert.equal(projectSchema.safeParse({ id: 'p1', name: '  ' }).success, false);
});

test('State accepts JSON-object shape; event validates actor and references', () => {
  assert.deepEqual(stateSchema.parse({ phase: 'draft', count: 2 }), { phase: 'draft', count: 2 });
  const event = { id: 'e1', projectId: 'p1', type: 'state.updated', actor: 'system', payload: {} };
  assert.equal(projectEventSchema.safeParse(event).success, true);
  assert.equal(projectEventSchema.safeParse({ ...event, actor: 'robot' }).success, false);
});

test('Normalized request/response contracts reject incompatible payloads', () => {
  assert.equal(normalizedRequestSchema.safeParse({ requestId: 'r1', operation: 'generate', input: {} }).success, true);
  assert.equal(normalizedRequestSchema.safeParse({ requestId: 'r1', operation: '', input: {} }).success, false);
  assert.equal(normalizedResponseSchema.safeParse({ requestId: 'r1', status: 'ok', output: 'done' }).success, true);
  assert.equal(normalizedResponseSchema.safeParse({ requestId: 'r1', status: 'error' }).success, false);
  assert.equal(normalizedResponseSchema.safeParse({ requestId: 'r1', status: 'ok', error: { code: 'X', message: 'bad', retryable: false } }).success, false);
});

test('Error classes expose stable machine-readable codes and retryability', () => {
  const errors = [new ValidationError('bad'), new NotFoundError(), new ConflictError(), new UnauthorizedError(), new ForbiddenError(), new RateLimitedError(), new UnavailableError()];
  assert.ok(errors.every((e) => e instanceof BiForgeError && typeof e.code === 'string'));
  assert.equal(errors[5].retryable, true);
  assert.equal(errors[6].retryable, true);
});

test('BX-05 event and normalized contracts are strict and stable', () => {
  const event = { id: 'e2', projectId: 'p1', type: 'state.updated', actor: 'human', payload: {} };
  assert.equal(projectEventSchema.safeParse({ ...event, unexpected: true }).success, false);
  assert.equal(normalizedRequestSchema.safeParse({ requestId: 'r2', operation: 'generate', input: {}, metadata: {}, unexpected: true }).success, false);
  assert.equal(normalizedResponseSchema.safeParse({ requestId: 'r2', status: 'error', error: { code: 'UPSTREAM', message: 'failed', retryable: true }, metadata: {} }).success, true);
});

test('BX-05 project API request contracts reject unknown fields and invalid versions', () => {
  assert.equal(createProjectRequestSchema.safeParse({ name: 'Project', state: {} }).success, true);
  assert.equal(createProjectRequestSchema.safeParse({ name: 'Project', isAdmin: true }).success, false);
  assert.equal(updateProjectStateRequestSchema.safeParse({ expected_version: 1, state: {} }).success, true);
  assert.equal(updateProjectStateRequestSchema.safeParse({ expected_version: '1', state: {} }).success, false);
});

test('P01 passport: default is valid, state with invalid passport is rejected', async () => {
  const { defaultPassport, passportSchema, stateSchemaWithPassport } = await import('../server/contracts.ts');
  assert.equal(passportSchema.parse(defaultPassport('Goal')).status, 'proposed');
  assert.ok(stateSchemaWithPassport.safeParse({ passport: defaultPassport() }).success);
  assert.ok(stateSchemaWithPassport.safeParse({ any: 1 }).success);
  assert.equal(stateSchemaWithPassport.safeParse({ passport: { ...defaultPassport(), executor: 'vendor' } }).success, false);
  assert.equal(stateSchemaWithPassport.safeParse({ passport: { ...defaultPassport(), extra: 1 } }).success, false);
});
