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
