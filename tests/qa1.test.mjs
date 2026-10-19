/**
 * QA1 — cross-mode automated regression (offline, source + pure modules).
 * Proves mode selection, prompt packs, classification, soft-fail/retry wording,
 * UI start-screen contracts and key safety invariants without live providers.
 *
 * Run: node --test tests/qa1.test.mjs
 *      npm run test:qa1
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// Pure modules that do not transitively require zod / heavy deps
import { detectConversationMode, modeParagraph } from '../server/conversationMode.ts';
import { buildPromptCore } from '../server/promptCore.ts';

// ---------------------------------------------------------------------------
// 1. Simple — classification fixtures
// ---------------------------------------------------------------------------
test('QA1 Simple: information requests classify as information', () => {
  const samples = [
    'Расскажи про зиму в Граубюндене',
    'Объясни, как работает ипотека',
    'Подскажи, какая погода бывает в феврале в Альпах',
    'Какая температура зимой в Граубюндене?',
    'Tell me about winters in Graubünden',
    'Explain how a mortgage works',
    'What is a bifurcation diagram',
    'обычный текст без сигналов',
  ];
  for (const t of samples) {
    assert.equal(detectConversationMode(t), 'information', `expected information: ${t}`);
  }
});

test('QA1 Simple: explicit decision signals classify as decision', () => {
  const samples = [
    'Что мне делать с этим выбором?',
    'Стоит ли переезжать в другую страну?',
    'Не могу выбрать между двумя вариантами',
    'Should I take the offer?',
    'What should I do?',
  ];
  for (const t of samples) {
    assert.equal(detectConversationMode(t), 'decision', `expected decision: ${t}`);
  }
});

test('QA1 Simple: research and engineering signals', () => {
  assert.equal(detectConversationMode('Найди прогнозы погоды в сети'), 'research');
  assert.equal(detectConversationMode('Напиши unit test для API'), 'engineering');
  assert.equal(detectConversationMode('что угодно', { userAskedSearch: true }), 'research');
});

test('QA1 Simple: information mode paragraph has no decision rituals', () => {
  const para = modeParagraph('information');
  assert.match(para, /CURRENT FOCUS: Information request/i);
  assert.doesNotMatch(para, /STEP 0|SECOND TEST|homework/i);
});

// ---------------------------------------------------------------------------
// 2. Intent flags / soft-fail / retry — source contracts
// ---------------------------------------------------------------------------
test('QA1 Simple: intentFlags and soft-fail helpers are present and wired', () => {
  const flagsSrc = read('server/intentFlags.ts');
  assert.match(flagsSrc, /export function detectUserIntentFlags/);
  assert.match(flagsSrc, /export function informationSoftFail/);
  assert.match(flagsSrc, /export function informationRetryHint/);
  assert.match(flagsSrc, /userForbadeMethodology|userDemandedDirectAnswer|userCriticizedEvasion/);
  // Soft-fail must reject pure methodology / AI-lecture style answers
  assert.match(flagsSrc, /As an AI|methodology|limitation/i);
  const serverSrc = existsSync(join(root, 'server.ts')) ? read('server.ts') : '';
  if (serverSrc) {
    assert.match(serverSrc, /informationSoftFail/);
    assert.match(serverSrc, /informationRetryHint/);
  }
});

// ---------------------------------------------------------------------------
// 3. Expert — instruction isolation
// ---------------------------------------------------------------------------
test('QA1 Expert: EXPERT_STEP_PREFIX keeps depth and open dialogue', () => {
  const packs = read('server/promptPacks.ts');
  assert.match(packs, /export const EXPERT_STEP_PREFIX/);
  assert.match(packs, /Expert|depth|analysis|follow-up|stage/i);
  assert.doesNotMatch(packs, /end of stages|pipeline complete|no further questions/i);
});

// ---------------------------------------------------------------------------
// 4. Project — analyst instruction
// ---------------------------------------------------------------------------
test('QA1 Project: ANALYST_INSTRUCTION demands operational structure', () => {
  const ctx = read('server/contextBuilder.ts');
  assert.match(ctx, /export const ANALYST_INSTRUCTION/);
  assert.match(ctx, /Project Mode|project analyst/i);
  assert.match(ctx, /requirements|risks|gaps|facts/i);
  assert.match(ctx, /Do not invent|structured analysis/i);
});

// ---------------------------------------------------------------------------
// 5. Shared core honesty
// ---------------------------------------------------------------------------
test('QA1 Core: honesty about facts and search is present', () => {
  const core = buildPromptCore('2026-10-15');
  assert.match(core, /CURRENT DATE|2026-10-15/);
  assert.match(core, /HONESTY|search|do not claim/i);
  const coreSrc = read('server/promptCore.ts');
  assert.match(coreSrc, /CORE_HONESTY|do not claim to have searched/i);
});

// ---------------------------------------------------------------------------
// 6. UI1 start screen contracts
// ---------------------------------------------------------------------------
test('QA1 UI: start screen offers Simple / Expert / Project and disables unavailable Project', () => {
  const app = read('src/App.tsx');
  for (const mode of ['Simple', 'Expert', 'Project']) {
    assert.match(app, new RegExp(`<h2>${mode}</h2>`));
  }
  assert.match(app, /chooseStartMode\('Simple'\)/);
  assert.match(app, /chooseStartMode\('Expert'\)/);
  assert.match(app, /disabled=\{!projectModeEnabled\}/);
  assert.match(app, /Currently unavailable/);
  assert.match(app, /sessionStorage\.setItem\((START_MODE_KEY|'biforge-start-mode')/);
  assert.match(app, /if \(mode === 'Project' && !projectModeEnabled\) return/);
});

// ---------------------------------------------------------------------------
// 7. STATUS sequencing
// ---------------------------------------------------------------------------
test('QA1 docs: STATUS sequences UI1 → QA1 → MANUAL1', () => {
  const status = read('docs/STATUS.md');
  assert.match(status, /UI1/);
  const qa = status.indexOf('**QA1**');
  const manual = status.indexOf('**MANUAL1**');
  assert.ok(qa >= 0 && manual >= 0 && qa < manual, 'STATUS order QA1 before MANUAL1');
});

// ---------------------------------------------------------------------------
// 8. Triage / support wiring
// ---------------------------------------------------------------------------
test('QA1 contracts: triage and support markers remain wired', () => {
  const app = read('src/App.tsx');
  assert.match(app, /triage|DISTRESS_MARKERS|SUPPORT_CONTACTS/);
});

// ---------------------------------------------------------------------------
// 9. Integrity of prior mode regressions
// ---------------------------------------------------------------------------
test('QA1 integrity: MP2/MP3/P41 regression files exist', () => {
  for (const f of ['tests/mp2.test.mjs', 'tests/mp3.test.mjs', 'tests/p41-ui1.test.mjs']) {
    assert.ok(existsSync(join(root, f)), `missing ${f}`);
  }
});

console.log('QA1 offline cross-mode suite loaded');
