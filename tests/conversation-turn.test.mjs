/**
 * Conversation turn focus: a quality retry must answer the LATEST message, never fall back to the opening one
 * (brief.decision). Regression for the dialogue where a "rewrite from scratch" retry re-answered the first question.
 * Pure tests: no network, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ANSWER_TARGET_RULE, relevance, openingDrift, retryDriftedToOpening } from '../server/turnFocus.ts';
import { buildSimpleConversationPrompt } from '../server/promptPacks.ts';

const OPENING = 'На каких языках должны быть написаны программы чтобы из них можно было сделать apk для android?';
const LATEST = 'Я понимаю просто ты сказал что я должен контролировать стабильность работы хостинга но какие могут быть проблемы со стабильностью railway?';
const GOOD = 'Проблемы со стабильностью Railway бывают такими: перезапуски контейнера при деплое, лимиты ресурсов на тарифе, сбои платформы и зависимость от одного региона. Для вашего агента это значит, что стоит настроить healthcheck и мониторинг.';
const DRIFTED = 'Собрать APK-файл для Android можно практически из любого языка: Kotlin и Java — основные языки Android, C и C++ через NDK, Dart с Flutter, JavaScript с React Native, C# в MAUI.';

test('relevance: a reply about the latest question is closer to it than to the opening one', () => {
  assert.ok(relevance(GOOD, LATEST) > relevance(GOOD, OPENING));
  assert.ok(relevance(DRIFTED, OPENING) > relevance(DRIFTED, LATEST));
  assert.ok(openingDrift(DRIFTED, LATEST, OPENING) > 0.15);
  assert.ok(openingDrift(GOOD, LATEST, OPENING) <= 0);
});

test('retry that drifted back to the opening message is rejected; a good retry is accepted', () => {
  assert.equal(retryDriftedToOpening(GOOD, DRIFTED, LATEST, OPENING), true);
  assert.equal(retryDriftedToOpening(DRIFTED, GOOD, LATEST, OPENING), false);
  assert.equal(retryDriftedToOpening(GOOD, GOOD, LATEST, OPENING), false);
});

test('first turn (latest message is the opening message) is never treated as drift', () => {
  assert.equal(retryDriftedToOpening('x', DRIFTED, OPENING, OPENING), false);
  assert.equal(retryDriftedToOpening('x', DRIFTED, '', OPENING), false);
  assert.equal(retryDriftedToOpening('x', DRIFTED, LATEST, ''), false);
});

test('every conversation prompt names the latest message as the answer target', () => {
  const input = JSON.stringify({ brief: { decision: OPENING }, history: [{ role: 'user', content: LATEST }] });
  for (const mode of ['information', 'decision']) {
    for (const productMode of ['Simple', 'Expert']) {
      const p = buildSimpleConversationPrompt(input, '', '', '2026-10-19', mode, productMode);
      assert.ok(p.includes(ANSWER_TARGET_RULE), `${mode}/${productMode}`);
      assert.ok(p.indexOf(ANSWER_TARGET_RULE) < p.indexOf('User brief and conversation:'));
    }
  }
  assert.match(ANSWER_TARGET_RULE, /last entry with role "user" in "history"/);
});

test('server guards the retry and does not duplicate the latest message in the model input (Token Economy)', () => {
  const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /currentUserMessage/);
  assert.match(src, /retryDriftedToOpening\(out\.reply, retryOut\.reply, lastUserText/);
  assert.match(src, /if \(!retryDrifted && retryOut\?\.reply/);
});

// ===== P57 latency policy (pure, no network) =====
import {
  LATENCY_DEFAULTS, readLatencyPolicy, shouldSkipQualityRetry, trimOlderAssistantMessages, createPhaseTimer,
} from '../server/latencyPolicy.ts';

test('P57: defaults and environment overrides', () => {
  assert.deepEqual(readLatencyPolicy({}), LATENCY_DEFAULTS);
  const p = readLatencyPolicy({ QUALITY_RETRY_MAX_ELAPSED_MS: '0', EPISTEMIC_TIMEOUT_MS: '9000', OLDER_ASSISTANT_MAX_CHARS: '0' });
  assert.equal(p.retryMaxElapsedMs, 0);          // 0 switches the guard off (old behaviour)
  assert.equal(p.verifierTimeoutMs, 9000);
  assert.equal(p.olderAssistantMaxChars, 0);     // 0 switches shortening off (old behaviour)
  const bad = readLatencyPolicy({ QUALITY_RETRY_MAX_ELAPSED_MS: 'abc', EPISTEMIC_TIMEOUT_MS: '5', OLDER_ASSISTANT_MAX_CHARS: '' });
  assert.equal(bad.retryMaxElapsedMs, LATENCY_DEFAULTS.retryMaxElapsedMs);
  assert.equal(bad.verifierTimeoutMs, 1000);     // clamped
  assert.equal(bad.olderAssistantMaxChars, LATENCY_DEFAULTS.olderAssistantMaxChars);
});

test('P57: the quality retry is skipped only after a slow turn', () => {
  assert.equal(shouldSkipQualityRetry(3000, 12000), false);
  assert.equal(shouldSkipQualityRetry(12000, 12000), false);
  assert.equal(shouldSkipQualityRetry(12001, 12000), true);
  assert.equal(shouldSkipQualityRetry(60000, 0), false);   // guard off
  assert.equal(shouldSkipQualityRetry(Number.NaN, 12000), false);
});

test('P57: only older assistant messages are shortened; user messages and the latest exchange stay complete', () => {
  const long = 'x'.repeat(5000);
  const h = [
    { role: 'user', content: long }, { role: 'assistant', content: long },
    { role: 'user', content: long }, { role: 'assistant', content: long },
    { role: 'user', content: long }, { role: 'assistant', content: long },
  ];
  const out = trimOlderAssistantMessages(h, 2, 2500);
  assert.equal(out.length, h.length);
  assert.equal(out[1].content.length, 2501);                 // older assistant: cut + ellipsis
  assert.equal(out[3].content.length, 2501);
  for (const i of [0, 2, 4]) assert.equal(out[i].content, long);   // every user message intact
  for (const i of [4, 5]) assert.equal(out[i].content, long);      // last two messages intact
  assert.equal(h[1].content, long);                                // input not mutated
  assert.equal(trimOlderAssistantMessages(h, 2, 0), h);            // 0 = off
  assert.equal(trimOlderAssistantMessages(h.slice(0, 2), 2, 10).length, 2);
});

test('P57: phase timer sums phases and reports the total', () => {
  let t = 1000;
  const timer = createPhaseTimer(() => t);
  t += 40; timer.mark('a');
  t += 100; timer.mark('b');
  t += 10; timer.mark('a');
  assert.deepEqual(timer.summary(), { a: 50, b: 100, totalMs: 150 });
});

test('P57: server wires the latency policy without removing the quality retry', () => {
  const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(src, /readLatencyPolicy\(\)/);
  assert.match(src, /shouldSkipQualityRetry\(Date\.now\(\) - requestStartedAt, LATENCY\.retryMaxElapsedMs\)/);
  assert.match(src, /if \(needRetry && !retrySkippedForLatency && STRONG_MODELS\.length > 1\)/);   // retry still exists
  assert.match(src, /timeoutMs: LATENCY\.verifierTimeoutMs/);
  assert.match(src, /trimOlderAssistantMessages\(recent, LATENCY\.recentMessagesKept/);
  assert.match(src, /type: 'conversation_timing'/);
});
