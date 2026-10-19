/**
 * P48 — uncertainty core + epistemic verifier pure contracts (no live providers).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('P48 uncertainty contract is single-copy in promptPacks (not duplicated in core)', async () => {
  const { buildPromptCore, CORE_UNCERTAINTY_HEADING } = await import('../server/promptCore.ts');
  const core = buildPromptCore('2026-10-16');
  assert.match(core, /HONESTY ABOUT FACTS/);
  // Core must NOT embed a second UNAVAILABLE block (PI-01 requires exactly one in the full prompt).
  assert.equal(core.split(CORE_UNCERTAINTY_HEADING).length - 1, 0);
  const packs = read('server/promptPacks.ts');
  assert.match(packs, /UNAVAILABLE_CONTRACT/);
  assert.equal(packs.split('WHEN THE IDEAL ANSWER IS UNAVAILABLE').length - 1, 1);
});

test('P48 shouldRunVerifier skips without key and on crisis', async () => {
  const { shouldRunVerifier, hasFactualSurface } = await import('../server/epistemicVerifier.ts');
  const flags = {
    userForbadeQuestions: false,
    userAskedApproximate: false,
    userAskedSearch: false,
    userCriticizedEvasion: false,
    userDemandedDirectAnswer: false,
    userForbadeMethodology: false,
  };
  assert.equal(shouldRunVerifier({
    hasGroqKey: false, triage: 'PROCEED', hasDocument: false,
    conversationMode: 'research', flags, replyText: 'Snow is 2m deep',
  }), false);
  assert.equal(shouldRunVerifier({
    hasGroqKey: true, triage: 'CRISIS', hasDocument: false,
    conversationMode: 'research', flags, replyText: 'x',
  }), false);
  assert.equal(shouldRunVerifier({
    hasGroqKey: true, triage: 'PROCEED', hasDocument: true,
    conversationMode: 'research', flags, replyText: 'x',
  }), false);
  assert.equal(shouldRunVerifier({
    hasGroqKey: true, triage: 'PROCEED', hasDocument: false,
    conversationMode: 'research', flags, replyText: 'plain',
  }), true);
  assert.equal(shouldRunVerifier({
    hasGroqKey: true, triage: 'PROCEED', hasDocument: false,
    conversationMode: 'information', flags: { ...flags, userAskedSearch: true }, replyText: 'plain',
  }), true);
  assert.ok(hasFactualSurface('About 35% of cases in 2024 https://example.com'));
  assert.equal(hasFactualSurface('Hello there'), false);
});

test('P48 parseVerifierPayload accepts valid JSON and rejects garbage', async () => {
  const { parseVerifierPayload, skippedEpistemic } = await import('../server/epistemicVerifier.ts');
  const ok = parseVerifierPayload({
    claims: [{ text: 'Winter is cold', kind: 'hypothesis' }, { text: '', kind: 'fact' }, { text: 'x', kind: 'nope' }],
    issues: ['weak grounding'],
    check_suggestions: ['verify year'],
  });
  assert.ok(ok);
  assert.equal(ok.claims.length, 1);
  assert.equal(ok.claims[0].kind, 'hypothesis');
  assert.equal(ok.issues.length, 1);
  assert.equal(parseVerifierPayload(null), null);
  assert.equal(parseVerifierPayload({ claims: [] }), null);
  const sk = skippedEpistemic('skipped');
  assert.equal(sk.verifier, 'skipped');
  assert.deepEqual(sk.claims, []);
});

test('P48 runEpistemicVerifier degrades on adapter error without throwing', async () => {
  const { runEpistemicVerifier } = await import('../server/epistemicVerifier.ts');
  const failAdapter = {
    async call() {
      return { status: 'error', errorClass: 'PROVIDER_TRANSIENT', message: '429', latencyMs: 1, providerId: 'groq', modelId: 'x', retryable: true };
    },
  };
  const r = await runEpistemicVerifier({
    userText: 'q', replyText: 'a 2024 10%', adapter: failAdapter, modelId: 'openai/gpt-oss-20b',
  });
  assert.equal(r.verifier, 'error');
  assert.deepEqual(r.claims, []);
});

test('P48 runEpistemicVerifier maps ok JSON to groq', async () => {
  const { runEpistemicVerifier } = await import('../server/epistemicVerifier.ts');
  const okAdapter = {
    async call() {
      return {
        status: 'ok',
        output: { claims: [{ text: 'X is 10%', kind: 'hypothesis' }], issues: [], check_suggestions: ['check source'] },
        latencyMs: 1, providerId: 'groq', modelId: 'openai/gpt-oss-20b', retryable: false,
      };
    },
  };
  const r = await runEpistemicVerifier({ userText: 'q', replyText: 'a', adapter: okAdapter });
  assert.equal(r.verifier, 'groq');
  assert.equal(r.claims[0].kind, 'hypothesis');
  assert.equal(r.check_suggestions[0], 'check source');
});

test('P48 server wires epistemic without hard-fail path', () => {
  const src = read('server.ts');
  assert.match(src, /runEpistemicVerifier/);
  assert.match(src, /shouldRunVerifier/);
  assert.match(src, /epistemic,/);
  assert.match(src, /epistemic_verifier/);
  // Primary reply still sent; verifier failure must not throw out of handler path
  assert.match(src, /skippedEpistemic\('error'\)/);
});

test('P48 soft-fail / information path remains present', () => {
  const src = read('server.ts');
  assert.match(src, /informationSoftFail/);
  assert.match(src, /informationRetryHint/);
  assert.match(src, /One retry max/);
});

test('P48 docs and version surfaces', () => {
  assert.match(read('docs/P48-SPEC.md'), /variant A/i);
  // The version moves with every patch; P48 only requires that it is at least 48 and that package.json agrees with src/config.ts
  // (scripts/check-version.mjs owns the full consistency rules).
  const version = read('src/config.ts').match(/APP_VERSION = '(\d+)'/)?.[1];
  assert.ok(version && Number(version) >= 48, `APP_VERSION must be a number >= 48, got ${version}`);
  assert.match(read('package.json'), new RegExp(`"version": "${version}"`));
});
