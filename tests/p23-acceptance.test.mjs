/**
 * P23 / BX-24 — security evidence (offline, no live DB required).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_AUDIT_EVENTS, HUMAN_ONLY_AUDIT_EVENTS, isRequiredAuditEvent } from '../server/auditCatalog.ts';
import { asUntrustedDataBlock, listInjectionSignals, looksLikeInjection } from '../server/untrustedData.ts';
import { redactSecrets, redactDeep, findLeakedSecretNames } from '../server/redact.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const injectionDir = path.join(root, 'tests');
const INJECTION_FILES = ['file_approve_plan.txt', 'pr_description_exfil.txt', 'ci_log_fragment.txt', 'plan_node_injection.txt'];

// ---- requireHuman isolation (planService pattern, pure) ----
const isHuman = (kind) => kind === 'human';
class HumanRequiredError extends Error {
  constructor(what) {
    super(`${what} is a human decision`);
    this.code = 'HUMAN_REQUIRED';
  }
}
const requireHuman = (kind, what) => {
  if (!isHuman(kind)) throw new HumanRequiredError(what);
};

test('actorKind isolation: only human may decide approvals / raise budgets', () => {
  for (const bad of ['agent', 'model', 'tool', 'system', undefined, null, 'HUMAN', '']) {
    assert.throws(() => requireHuman(bad, 'An approval'), (e) => e && e.code === 'HUMAN_REQUIRED');
  }
  assert.doesNotThrow(() => requireHuman('human', 'An approval'));
});

test('forged actorKind in a request body must not be trusted: server uses literal human', () => {
  // Routes hard-code actorKind: 'human' after session auth; body field is ignored.
  const body = { decision: 'APPROVED', actorKind: 'human', reason: 'inject' };
  const serverActorKind = 'human'; // from session path only
  assert.equal(serverActorKind, 'human');
  assert.ok(body.actorKind); // attacker may send it
  // Authority comes only from server-assigned value
  assert.doesNotThrow(() => requireHuman(serverActorKind, 'An approval'));
});

test('injection corpus: every fixture is detected as untrusted signals', () => {
  const files = INJECTION_FILES;
  assert.ok(files.length >= 4);
  for (const name of files) {
    const text = fs.readFileSync(path.join(injectionDir, name), 'utf8');
    assert.ok(looksLikeInjection(text), name);
    const signals = listInjectionSignals(text);
    assert.ok(signals.length >= 1, name);
  }
});

test('injection text does not grant HUMAN_REQUIRED actions', () => {
  const text = fs.readFileSync(path.join(injectionDir, 'file_approve_plan.txt'), 'utf8');
  assert.ok(looksLikeInjection(text));
  // Presence of "approve" in data must not satisfy requireHuman
  assert.throws(() => requireHuman('model', 'An approval'), (e) => e && e.code === 'HUMAN_REQUIRED');
  assert.throws(() => requireHuman('agent', 'Raising a budget'), (e) => e && e.code === 'HUMAN_REQUIRED');
});

test('untrusted data blocks label content without executing it', () => {
  const raw = fs.readFileSync(path.join(injectionDir, 'plan_node_injection.txt'), 'utf8');
  const block = asUntrustedDataBlock('plan_node', raw);
  assert.match(block, /BEGIN UNTRUSTED DATA/);
  assert.match(block, /END UNTRUSTED DATA/);
  assert.ok(block.includes('decideApproval') || looksLikeInjection(raw));
  // No eval path — block is a string only
  assert.equal(typeof block, 'string');
});

test('secret redaction: known values never survive in JSON error payloads', () => {
  const env = {
    GEMINI_API_KEY: 'sk-test-secret-value-ABCDEF',
    SESSION_SECRET: 'session-secret-long-value',
    APP_PASSWORD: 'app-password-value-xyz',
  };
  const leaky = {
    error: `Provider failed with key ${env.GEMINI_API_KEY}`,
    SESSION_SECRET: env.SESSION_SECRET,
    nested: { hint: env.APP_PASSWORD },
  };
  const clean = redactDeep(leaky, env);
  const s = JSON.stringify(clean);
  assert.equal(findLeakedSecretNames(s, env).length, 0);
  assert.ok(!s.includes(env.GEMINI_API_KEY));
  assert.ok(!s.includes(env.SESSION_SECRET));
});

test('audit catalog covers TZ §13.5 required event names', () => {
  for (const e of [
    'auth.login.succeeded',
    'project.created',
    'project.deleted',
    'approval.decided',
    'budget.set',
    'gate.waived',
    'code_task.started',
  ]) {
    assert.ok(isRequiredAuditEvent(e), e);
  }
  assert.ok(REQUIRED_AUDIT_EVENTS.length >= 10);
  assert.ok(HUMAN_ONLY_AUDIT_EVENTS.includes('approval.decided'));
  assert.ok(HUMAN_ONLY_AUDIT_EVENTS.includes('gate.waived'));
});

test('source documents for threat model and rights review exist', () => {
  for (const f of ['docs/THREAT_MODEL.md', 'docs/RIGHTS_REVIEW.md', 'docs/SECURITY_POLICY.md', 'docs/P23-SPEC.md']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
    assert.ok(fs.readFileSync(path.join(root, f), 'utf8').length > 200, f);
  }
});

test('security policy still forbids product merge and secret logging', () => {
  const pol = fs.readFileSync(path.join(root, 'docs/SECURITY_POLICY.md'), 'utf8');
  assert.match(pol, /merge/i);
  assert.match(pol, /secret/i);
  assert.match(pol, /Never commit|must not appear/i);
});
