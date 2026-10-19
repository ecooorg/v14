// MP3: information-mode output quality guard, soft retry, mode regression fixtures.
// Unit only: informationSoftFail / informationRetryHint; classification; server wiring via source read.
// Does not call live models; does not change tests/regression.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectUserIntentFlags,
  informationSoftFail,
  informationRetryHint,
  isLimitationOnlyReply,
} from '../server/intentFlags.ts';
import { detectConversationMode, modeParagraph } from '../server/conversationMode.ts';
import { buildPromptCore } from '../server/promptCore.ts';

const emptyFlags = detectUserIntentFlags('');
const directFlags = detectUserIntentFlags('Просто ответь, не поучай и без методики');
const evasionFlags = detectUserIntentFlags('Это не решает мою задачу, ты уклоняешься');
const approxFlags = detectUserIntentFlags('Дай приблизительную оценку');

// ---------- Soft-fail: limitation-only / methodology preamble / invented precision ----------
{
  assert.equal(informationSoftFail({ reply: '' }, emptyFlags), true, 'empty reply fails');
  assert.equal(
    informationSoftFail({ reply: 'К сожалению, точный прогноз невозможен без актуальных данных.' }, emptyFlags),
    true,
    'limitation-only fails',
  );
  assert.equal(
    informationSoftFail({ reply: 'Before I can answer, it is important to understand the limitations of the model.' }, emptyFlags),
    true,
    'methodology preamble fails',
  );
  assert.equal(
    informationSoftFail({ reply: 'Для точного ответа нужны актуальные измерения и живые источники.' }, emptyFlags),
    true,
    'invented precision fails',
  );
  const good = {
    reply:
      'Зимой в Граубюндене обычно холодно: в долинах около −5…0 °C, в высокогорье часто −10…−15 °C. Снег лежит с декабря по март; в Давосе и Санкт-Морице много солнечных дней. Это ориентир из общих климатических сведений, стоит сверить с актуальным прогнозом.',
  };
  assert.equal(informationSoftFail(good, emptyFlags), false, 'substance-first winter answer passes');
  console.log('mp3 soft-fail detectors OK');
}

// ---------- Soft-fail respects intent flags ----------
{
  const lecture = { reply: 'As an AI language model I cannot give exact forecasts. Methodology requires live data.' };
  assert.equal(informationSoftFail(lecture, emptyFlags), true, 'AI lecture fails even without flags');
  assert.equal(informationSoftFail(lecture, directFlags), true, 'lecture after direct demand fails');
  assert.equal(informationSoftFail(lecture, evasionFlags), true, 'lecture after evasion critique fails');
  const okAfterDirect = {
    reply: 'В феврале в Граубюндене типичны −5…0 °C в долинах и устойчивый снежный покров в горах.',
  };
  assert.equal(informationSoftFail(okAfterDirect, directFlags), false, 'direct substance passes with direct flags');
  console.log('mp3 intent-flag soft-fail OK');
}

// ---------- Retry hint stays in information mode ----------
{
  const hint = informationRetryHint(directFlags);
  assert.ok(/information mode/i.test(hint), 'hint labels information mode');
  assert.ok(!/STEP 0|SECOND TEST|structure operations|newOptionTypes|\bgain\b/i.test(hint), 'hint does not switch to decision package');
  assert.ok(/direct answer|methodology/i.test(hint), 'hint mentions direct/methodology constraint');
  const approxHint = informationRetryHint(approxFlags);
  assert.ok(/approximate|preliminary|rough/i.test(approxHint), 'approx hint present');
  console.log('mp3 retry hint OK');
}

// ---------- Mode regression fixtures (offline) ----------
{
  const graubunden = 'Расскажи про зиму в Граубюндене';
  assert.equal(detectConversationMode(graubunden), 'information');
  const para = modeParagraph('information');
  assert.ok(/CURRENT FOCUS: Information request/i.test(para));
  assert.ok(!/STEP 0|SECOND TEST|homework/i.test(para));
  assert.ok(buildPromptCore('2026-10-14').includes('CURRENT DATE'));

  const serverSrc = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(serverSrc.includes('informationSoftFail'), 'server wires informationSoftFail');
  assert.ok(serverSrc.includes('informationRetryHint'), 'server wires informationRetryHint');
  assert.ok(/infoRetry/.test(serverSrc), 'server has information retry branch');
  assert.ok(serverSrc.includes('conversationGainAudit'), 'gain-audit retained for non-information');
  assert.ok(serverSrc.includes('EXPERT_STEP_PREFIX + prompt'), 'Expert path still prefixes its steps');

  // Expert / Project string contracts (read from source files without loading full module graphs).
  const packs = readFileSync(new URL('../server/promptPacks.ts', import.meta.url), 'utf8');
  assert.ok(packs.includes('Do not choose or rank options for the person') && packs.includes('explicit assumptions'));
  const ctx = readFileSync(new URL('../server/contextBuilder.ts', import.meta.url), 'utf8');
  assert.ok(ctx.includes('Prefer operational precision') && ctx.includes('Do not chat or coach'));
  console.log('mp3 mode fixtures OK');
}

// ---------- isLimitationOnlyReply still works for non-information path ----------
{
  const auditEmpty = { substantiveGain: [], structuralNew: [], hasNextStep: false };
  assert.equal(isLimitationOnlyReply({ reply: 'Точный прогноз невозможен' }, auditEmpty), true);
  assert.equal(
    isLimitationOnlyReply({ reply: 'Примерно −5 °C в долинах' }, { substantiveGain: ['CALC'], structuralNew: [], hasNextStep: false }),
    false,
  );
  console.log('mp3 limitation helper OK');
}

console.log('mp3 all unit checks passed');
