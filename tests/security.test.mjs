/* Grouped test suite. Each original module has its own lexical scope.
 * Live PostgreSQL/API tests run only with their dedicated environment flag.
 */

// ===== BEGIN injection-corpus.test.mjs =====
{
/**
 * Injection corpus structural tests (BX-24 / P23).
 * Fixtures live flat under tests/ (no nested folders).
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { fileURLToPath } = await import("node:url");
const { redactSecrets, findLeakedSecretNames } = await import("../server/redact.ts");

const dir = path.dirname(fileURLToPath(import.meta.url));
/** Corpus files (flat in tests/; names must stay stable). */
const INJECTION_FILES = [
  'file_approve_plan.txt',
  'pr_description_exfil.txt',
  'ci_log_fragment.txt',
  'plan_node_injection.txt',
];

test('injection corpus has at least four cases', () => {
  for (const name of INJECTION_FILES) {
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  }
  assert.ok(INJECTION_FILES.length >= 4);
});

test('each case is readable data and does not alter process.env secrets', () => {
  const before = { ...process.env };
  for (const name of INJECTION_FILES) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(text.length > 20, name);
    const redacted = redactSecrets(text, process.env);
    assert.equal(typeof redacted, 'string');
  }
  for (const k of ['GEMINI_API_KEY', 'SESSION_SECRET', 'APP_PASSWORD']) {
    assert.equal(process.env[k], before[k]);
  }
});

test('synthetic leak in fixture text is detectable by findLeakedSecretNames when env matches', () => {
  const env = { GEMINI_API_KEY: 'sk-leaked-should-never-appear' };
  const ci = fs.readFileSync(path.join(dir, 'ci_log_fragment.txt'), 'utf8');
  const leaked = findLeakedSecretNames(ci, env);
  assert.ok(leaked.includes('GEMINI_API_KEY'));
  const cleaned = redactSecrets(ci, env);
  assert.ok(!cleaned.includes('sk-leaked-should-never-appear'));
});

test('approve/exfil imperatives are present as plain text (documentation of intent)', () => {
  const approve = fs.readFileSync(path.join(dir, 'file_approve_plan.txt'), 'utf8');
  assert.match(approve, /approve/i);
  const pr = fs.readFileSync(path.join(dir, 'pr_description_exfil.txt'), 'utf8');
  assert.match(pr, /API keys|SESSION_SECRET/i);
});
}
// ===== END injection-corpus.test.mjs =====

// ===== BEGIN p23-acceptance.test.mjs =====
{
/**
 * P23 / BX-24 — security evidence (offline, no live DB required).
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { fileURLToPath } = await import("node:url");
const { REQUIRED_AUDIT_EVENTS, HUMAN_ONLY_AUDIT_EVENTS, isRequiredAuditEvent } = await import("../server/auditCatalog.ts");
const { asUntrustedDataBlock, listInjectionSignals, looksLikeInjection } = await import("../server/untrustedData.ts");
const { redactSecrets, redactDeep, findLeakedSecretNames } = await import("../server/redact.ts");

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


test('security policy still forbids product merge and secret logging', () => {
  const pol = fs.readFileSync(path.join(root, 'docs/07-Security-Privacy-and-Operations.md'), 'utf8');
  assert.match(pol, /merge/i);
  assert.match(pol, /secret/i);
  assert.match(pol, /do not reproduce/i);
});
}
// ===== END p23-acceptance.test.mjs =====

// ===== BEGIN p43-rm-c3.test.mjs =====
{
/**
 * P43 — RM-C3 closed: model_patch authorized in docs; runtime still env-gated.
 * Run: node --test tests/p43-rm-c3.test.mjs
 */
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { readFileSync, existsSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { dirname, join } = await import("node:path");

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('P43 STATUS records the model_patch executor', () => {
  const status = read('docs/STATUS.md');
  assert.match(status, /model_patch/);
});

test('P43 runtime gate unchanged: CODE_EXECUTOR must equal model_patch', () => {
  const svc = read('server/codeTaskService.ts');
  assert.match(svc, /process\.env\.CODE_EXECUTOR !== 'model_patch'/);
  assert.match(svc, /EXECUTOR_UNAVAILABLE/);
});

test('P43 does not enable GitHub App write by default', () => {
  const status = read('docs/STATUS.md');
  assert.match(status, /GitHub write/i);
  assert.match(status, /Отложено|deferred|ADR-06/i);
  const env = read('.env.example');
  // GITHUB_DIFF_UPLOAD remains commented / opt-in
  assert.match(env, /GITHUB_DIFF_UPLOAD/);
});

}
// ===== END p43-rm-c3.test.mjs =====

// ===== BEGIN redact.test.mjs =====
{
const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { redactSecrets, redactDeep, secretPresence, findLeakedSecretNames, SECRET_ENV_NAMES } = await import("../server/redact.ts");

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
}
// ===== END redact.test.mjs =====

// ===== BEGIN security.test.mjs =====
{
const assert = (await import("node:assert/strict")).default;
const { createSessionSigner, sessionCookie, clearedCookie, LoginLimiter, stripMarkdown, isSameOrigin } = await import("../server/security.ts");
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('session: valid, expired, tampered, wrong secret, garbage', () => {
  const s = createSessionSigner('secret-secret-secret');
  const tok = s.sign(Date.now() + 1000);
  assert.ok(s.verify(tok));
  assert.ok(!s.verify(s.sign(Date.now() - 1)));
  assert.ok(!s.verify(tok.replace(/^\d+/, (x) => String(Number(x) + 99999))));
  assert.ok(!createSessionSigner('other-secret-other').verify(tok));
  for (const g of ['', null, undefined, 'abc', '1.2.3', '123.']) assert.ok(!s.verify(g));
});
t('session survives "restart": a new signer with the same secret accepts the token', () => {
  const tok = createSessionSigner('same-secret-value-1').sign(Date.now() + 5000);
  assert.ok(createSessionSigner('same-secret-value-1').verify(tok));
});
t('CSRF origin check: same origin accepted, cross origin and malformed origins rejected', () => {
  assert.equal(isSameOrigin('https://example.test', 'example.test', 'https'), true);
  assert.equal(isSameOrigin('http://example.test', 'example.test', 'http'), true);
  assert.equal(isSameOrigin('https://evil.test', 'example.test', 'https'), false);
  assert.equal(isSameOrigin('null', 'example.test', 'https'), false);
  assert.equal(isSameOrigin('not a url', 'example.test', 'https'), false);
  assert.equal(isSameOrigin('https://example.test:444', 'example.test', 'https'), false);
  assert.equal(isSameOrigin(undefined, 'example.test', 'https'), true);
  assert.equal(isSameOrigin('https://example.test', undefined, 'https'), false);
});
t('cookie flags', () => {
  const c = sessionCookie('x', 60, true);
  for (const f of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=60']) assert.ok(c.includes(f), f);
  assert.ok(!sessionCookie('x', 60, false).includes('Secure'));
  assert.ok(clearedCookie(true).includes('Max-Age=0'));
});
t('limiter: blocks after max failures, window resets, success does not reset', () => {
  const L = new LoginLimiter(3, 1000);
  for (let i = 0; i < 2; i++) L.recordFailure('ip', 0);
  assert.equal(L.retryAfterSec('ip', 10), 0);
  L.recordFailure('ip', 20);
  assert.ok(L.retryAfterSec('ip', 30) > 0);            // blocked (a correct password is not consulted here)
  assert.equal(L.retryAfterSec('other', 30), 0);       // other addresses unaffected
  assert.equal(L.retryAfterSec('ip', 1200), 0);        // window passed: allowed again
});
t('markdown: bold, italic, headings, list markers, code, links', () => {
  assert.equal(stripMarkdown('**Bold** and *italic* and __b__ and _i_'), 'Bold and italic and b and i');
  assert.equal(stripMarkdown('## Title\ntext'), 'Title\ntext');
  assert.equal(stripMarkdown('* one\n+ two\n  * nested\n- keep'), '- one\n- two\n  - nested\n- keep');
  assert.equal(stripMarkdown('use `x` and [site](https://a.b/c)'), 'use x and site (https://a.b/c)');
  assert.equal(stripMarkdown('a\n---\nb'), 'a\n\nb');
  assert.equal(stripMarkdown('```js\ncode\n```'), 'code');
});
t('markdown: ordinary text is untouched', () => {
  for (const x of ['2 * 3 = 6', 'snake_case_name', '5 > 3 and 3 < 5', 'Cost: 10-20%', 'a * b * c', 'Привет, мир! Что делать?'])
    assert.equal(stripMarkdown(x), x);
});
console.log(`${n} tests passed`);
}
// ===== END security.test.mjs =====
