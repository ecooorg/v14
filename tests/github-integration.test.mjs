import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGitHubAppJwt, permissionsWithinMaximum, verifyGitHubWebhookSignature, verifyGitHubAppConnection } from '../server/githubIntegration.ts';

test('GitHub App JWT is RS256, issuer-bound and expires within ten minutes', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createGitHubAppJwt('12345', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 1_800_000_000);
  const [head, body, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url').toString()).alg, 'RS256');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.equal(payload.iss, '12345');
  assert.ok(payload.exp - payload.iat <= 9 * 60);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url')), true);
});

test('permissions reject excess rights and require the declared minimum', () => {
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' }, false), true);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'read' }, false), false);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read', administration: 'read' }, false), false);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'write', checks: 'read', pull_requests: 'write' }, true), true);
  assert.equal(permissionsWithinMaximum({ metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' }, true), false);
});

test('webhook HMAC is verified against raw bytes in constant-time-safe format', () => {
  const body = Buffer.from('{"action":"opened"}');
  const secret = 'webhook-test-secret';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyGitHubWebhookSignature(body, signature, secret), true);
  assert.equal(verifyGitHubWebhookSignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, undefined, secret), false);
  assert.equal(verifyGitHubWebhookSignature(body, signature, ''), false);
});

test('GitHub connection check uses installation token then repository API without exposing token', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes('/access_tokens')) return new Response(JSON.stringify({ token: 'private-token', permissions: { metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' } }), { status: 201 });
    return new Response(JSON.stringify({ full_name: 'owner/repo' }), { status: 200 });
  };
  const result = await verifyGitHubAppConnection({ appId: '123', installationId: '456', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), owner: 'owner', repository: 'repo', apiBaseUrl: 'https://github.test' }, fetcher);
  assert.deepEqual(result, { status: 'OK', permissions: { metadata: 'read', contents: 'read', checks: 'read', pull_requests: 'read' }, repository: 'owner/repo' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-token');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});
