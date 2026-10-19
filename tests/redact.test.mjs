import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSecrets,
  redactDeep,
  secretPresence,
  findLeakedSecretNames,
  SECRET_ENV_NAMES,
} from '../server/redact.ts';

const ENV = {
  GEMINI_API_KEY: 'sk-gemini-SUPER-SECRET-value-999',
  GROQ_API_KEY: 'gsk_groq_SECRET_ABCDEFGH',
  SESSION_SECRET: 'session-secret-value-long',
  APP_PASSWORD: 'app-password-xyz',
  DATABASE_URL: 'postgres://user:pass@host/db',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvSecretKeyMaterial\n-----END PRIVATE KEY-----',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret-value-12',
};

test('redactSecrets removes known values', () => {
  const text = `key=${ENV.GEMINI_API_KEY} and ${ENV.GROQ_API_KEY}`;
  const out = redactSecrets(text, ENV);
  assert.ok(!out.includes(ENV.GEMINI_API_KEY));
  assert.ok(!out.includes(ENV.GROQ_API_KEY));
  assert.ok(out.includes('[REDACTED]'));
});

test('redactDeep redacts secret-named keys and values', () => {
  const input = {
    ok: true,
    GEMINI_API_KEY: ENV.GEMINI_API_KEY,
    nested: { token: 'plain', note: `uses ${ENV.SESSION_SECRET}` },
    list: [ENV.APP_PASSWORD, 'safe'],
  };
  const out = redactDeep(input, ENV);
  assert.equal(out.GEMINI_API_KEY, '[REDACTED]');
  assert.ok(!JSON.stringify(out).includes(ENV.SESSION_SECRET));
  assert.ok(!JSON.stringify(out).includes(ENV.APP_PASSWORD));
  assert.equal(out.list[1], 'safe');
});

test('secretPresence reports booleans only', () => {
  const p = secretPresence(['GEMINI_API_KEY', 'MISSING_KEY'], ENV);
  assert.equal(p.GEMINI_API_KEY, true);
  assert.equal(p.MISSING_KEY, false);
});

test('findLeakedSecretNames detects leaks', () => {
  const leaked = findLeakedSecretNames(`log: ${ENV.GROQ_API_KEY}`, ENV);
  assert.deepEqual(leaked, ['GROQ_API_KEY']);
  assert.deepEqual(findLeakedSecretNames('clean log', ENV), []);
});

test('SECRET_ENV_NAMES covers core product secrets', () => {
  for (const n of ['GEMINI_API_KEY', 'SESSION_SECRET', 'DATABASE_URL', 'GITHUB_WEBHOOK_SECRET']) {
    assert.ok(SECRET_ENV_NAMES.includes(n), n);
  }
});
