/** "Whole decision review" as a document: everything the person entered and decided, in plain words. Empty parts are skipped. */
import type { Decision } from '../types/decision';
import type { DocBlock, DocumentSpec } from './attachments';
import { detectUiLanguage } from '../i18n/ui';

const L = {
  en: { brief: 'Decision', goal: 'Goal', deadline: 'Deadline', facts: 'Facts', unknowns: 'Unknowns', assumptions: 'Assumptions', values: 'Values', constraints: 'Constraints',
    options: 'Options', hypotheses: 'Hypotheses to check', experiments: 'Experiments', test: 'Test', metric: 'Metric', until: 'Until', success: 'Success if', stop: 'Stop if',
    decided: 'My decision', onValues: 'On which values', underData: 'Under which data', accepted: 'Uncertainties I accept', synthesis: 'Summary', journal: 'Journal', forecast: 'Forecast', result: 'Result' },
  ru: { brief: 'Решение', goal: 'Цель', deadline: 'Срок', facts: 'Факты', unknowns: 'Что неизвестно', assumptions: 'Допущения', values: 'Ценности', constraints: 'Ограничения',
    options: 'Варианты', hypotheses: 'Гипотезы для проверки', experiments: 'Эксперименты', test: 'Проверка', metric: 'Метрика', until: 'Срок', success: 'Успех, если', stop: 'Остановка, если',
    decided: 'Моё решение', onValues: 'На каких ценностях', underData: 'При каких данных', accepted: 'Неопределённости, которые я принимаю', synthesis: 'Резюме', journal: 'Журнал', forecast: 'Прогноз', result: 'Результат' },
};

export function decisionToDocument(d: Decision): DocumentSpec {
  const sample = [d.title, d.brief?.decision, d.brief?.goal, ...(d.brief?.facts || [])].join(' ').slice(0, 1500);
  const t = detectUiLanguage(sample) === 'ru' ? L.ru : L.en;
  const blocks: DocBlock[] = [];
  const clean = (v: unknown) => String(v ?? '').trim();
  const para = (head: string, text: unknown) => { const s = clean(text); if (s) blocks.push({ type: 'heading', text: head }, { type: 'paragraph', text: s }); };
  const list = (head: string, items: unknown[]) => { const xs = (items || []).map(clean).filter(Boolean); if (xs.length) blocks.push({ type: 'heading', text: head }, { type: 'bullets', items: xs }); };
  const b = d.brief;
  para(t.brief, b?.decision); para(t.goal, b?.goal); para(t.deadline, b?.deadline);
  list(t.facts, b?.facts); list(t.unknowns, b?.unknowns); list(t.assumptions, b?.assumptions); list(t.values, b?.values); list(t.constraints, b?.constraints);
  list(t.options, [
    ...(d.options || []).map((o) => [o.title, o.description].map(clean).filter(Boolean).join(': ')),
    ...(b?.myOptions || []).filter((m) => !(d.options || []).some((o) => o.id === m.id)).map((m) => m.title),
  ]);
  list(t.hypotheses, (d.hypotheses || []).map((h) => h.rewrittenByUser || h.text));
  const exps = (d.experiments || []).map((e) => [
    e.test && `${t.test}: ${e.test}`, e.metric && `${t.metric}: ${e.metric}`, e.deadline && `${t.until}: ${e.deadline}`,
    e.successThreshold && `${t.success}: ${e.successThreshold}`, e.stopThreshold && `${t.stop}: ${e.stopThreshold}`,
  ].filter(Boolean).join('. '));
  list(t.experiments, exps);
  if (d.decision) {
    const h = d.decision;
    para(t.decided, h.whatIDecided); para(t.onValues, h.onWhichValues); para(t.underData, h.underWhichData); list(t.accepted, h.acceptedUncertainties);
  }
  if (d.synthesis) para(t.synthesis, d.synthesis.editedByUser || (d.synthesis.paragraphs || []).map(clean).filter(Boolean).join('\n\n'));
  list(t.journal, (d.journal || []).map((j) => [clean(j.hypothesis), j.forecastWording && `${t.forecast}: ${clean(j.forecastWording)}`, (j as any).fact && `${t.result}: ${clean((j as any).fact)}`].filter(Boolean).join('. ')));
  return { title: clean(d.title) || clean(b?.decision).slice(0, 80) || 'Decision', fileName: 'decision-review', blocks: blocks.length ? blocks : [{ type: 'paragraph', text: ' ' }] };
}
