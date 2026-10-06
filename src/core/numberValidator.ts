/** Number validation: model output may only contain numeric claims grounded in user input or independently validated derivations. */

const EN_ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const RU_ONES: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
  тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19,
};
const RU_TENS: Record<string, number> = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90 };
const RU_HUNDREDS: Record<string, number> = { сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900 };

/** Numeric tokens, including ordinary amounts/counts and percentages. */
export function extractNums(s: string): string[] {
  return [...s.matchAll(/(?<![\p{L}_])[-+]?\d+(?:[.,]\d+)?%?/gu)].map((m) => m[0].replace(',', '.'));
}

function parseWordSequence(words: string[]): number | null {
  if (!words.length) return null;
  const all = { ...EN_ONES, ...EN_TENS, ...RU_ONES, ...RU_TENS, ...RU_HUNDREDS } as Record<string, number>;
  if (words.length === 1 && Object.prototype.hasOwnProperty.call(all, words[0])) return all[words[0]];

  let total = 0;
  let current = 0;
  let seen = false;
  for (const word of words) {
    if (Object.prototype.hasOwnProperty.call(EN_ONES, word) || Object.prototype.hasOwnProperty.call(RU_ONES, word)) {
      current += all[word]; seen = true; continue;
    }
    if (Object.prototype.hasOwnProperty.call(EN_TENS, word) || Object.prototype.hasOwnProperty.call(RU_TENS, word)) {
      current += all[word]; seen = true; continue;
    }
    if (Object.prototype.hasOwnProperty.call(RU_HUNDREDS, word)) {
      current += all[word]; seen = true; continue;
    }
    if (word === 'hundred' || word === 'сто') {
      current = (current || 1) * 100; seen = true; continue;
    }
    if (word === 'thousand' || word === 'тысяча' || word === 'тысячи' || word === 'тысяч') {
      total += (current || 1) * 1000; current = 0; seen = true; continue;
    }
    return null;
  }
  return seen ? total + current : null;
}

/** Extract common English/Russian number words, including simple compound forms. */
export function expandWordNumerals(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z]+|[а-яё]+/giu) || [];
  const known = new Set([...Object.keys(EN_ONES), ...Object.keys(EN_TENS), ...Object.keys(RU_ONES), ...Object.keys(RU_TENS), ...Object.keys(RU_HUNDREDS), 'hundred', 'thousand', 'тысяча', 'тысячи', 'тысяч']);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!known.has(tokens[i])) { i++; continue; }
    let j = i;
    while (j < tokens.length && known.has(tokens[j])) j++;
    const value = parseWordSequence(tokens.slice(i, j));
    if (value !== null) out.push(String(value));
    i = j;
  }
  return out;
}

export function collectAllowedFromInput(input: string, extraAllowed: number[] = []): Set<string> {
  const allowed = new Set<string>([
    ...extractNums(input),
    ...expandWordNumerals(input),
    ...extraAllowed.filter(Number.isFinite).map(String),
  ]);
  return allowed;
}


const GENERIC_COUNT_NOUNS = new Set([
  // English: model-generated structure, not user-specific measurements.
  'option', 'options', 'step', 'steps', 'factor', 'factors', 'point', 'points',
  'question', 'questions', 'reason', 'reasons', 'example', 'examples', 'criterion', 'criteria',
  'branch', 'branches', 'path', 'paths', 'idea', 'ideas', 'item', 'items', 'way', 'ways',
  // Russian: generic structure of an analysis/recommendation.
  'вариант', 'варианта', 'вариантов', 'шаг', 'шага', 'шагов', 'фактор', 'фактора', 'факторов',
  'пункт', 'пункта', 'пунктов', 'вопрос', 'вопроса', 'вопросов', 'причина', 'причины', 'причин',
  'пример', 'примера', 'примеров', 'критерий', 'критерия', 'критериев', 'ветка', 'ветки', 'веток',
  'путь', 'пути', 'путей', 'идея', 'идеи', 'идей', 'способ', 'способа', 'способов', 'условие', 'условия', 'условий',
]);

const FACT_UNITS = new Set([
  // Time / duration / deadlines.
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'hour', 'hours', 'minute', 'minutes',
  'день', 'дня', 'дней', 'неделя', 'недели', 'недель', 'месяц', 'месяца', 'месяцев', 'год', 'года', 'лет',
  'час', 'часа', 'часов', 'минута', 'минуты', 'минут',
  // Money / quantities / rates.
  'percent', 'percentage', 'eur', 'euro', 'euros', 'usd', 'dollar', 'dollars',
  '%', 'евро', 'доллар', 'доллара', 'долларов', 'рубль', 'рубля', 'рублей',
]);

function normalizedWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+|[а-яё]+/giu) || [];
}

function isGenericWordNumberContext(text: string, value: string): boolean {
  const words = normalizedWords(text);
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  // A short generic count such as "2–3 factors" / "three options" is
  // structural prose, not a claim about the user's situation. Numeric facts
  // with a unit ("3 months", "70 percent") remain strictly validated below.
  for (let i = 0; i < words.length; i++) {
    const parsed = parseWordSequence([words[i]]);
    if (parsed !== n) continue;
    const next = words[i + 1];
    if (next && GENERIC_COUNT_NOUNS.has(next)) return true;
  }
  return false;
}

function isGenericNumericContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, Math.min(text.length, end + 32));
  // Ordered/list labels: "1." / "2)" / "3:".
  if (/^\s*[.) :]/.test(after) && /(?:^|\n)\s*$/.test(before)) return true;
  // Generic model-generated structure: "2–3 factors", "3 options", etc.
  const m = after.match(/^\s*(?:[-–—]\s*\d+\s*)?([a-zа-яё]+)/iu);
  return !!m && GENERIC_COUNT_NOUNS.has(m[1].toLowerCase());
}

export function validateNumbers(out: string, input: string, derived: string[] = [], extraAllowed: number[] = []): string[] {
  const allowed = collectAllowedFromInput(input, extraAllowed);
  for (const d of derived) allowed.add(String(d).replace(',', '.'));

  const idLike = new Set<string>();
  for (const m of out.matchAll(/\b(?:obj|hyp|n|exp|c|id)[-_]?(\d+)\b/gi)) idLike.add(m[1]);

  const bad: string[] = [];
  for (const m of out.matchAll(/(?<![\p{L}_])[-+]?\d+(?:[.,]\d+)?%?/gu)) {
    const n = m[0].replace(',', '.');
    if (allowed.has(n)) continue;
    if (n.endsWith('%') && allowed.has(n.slice(0, -1))) continue;
    if (idLike.has(n)) continue;
    if (isGenericNumericContext(out, m.index ?? 0, (m.index ?? 0) + m[0].length)) continue;
    bad.push(n);
  }

  // Word numerals are only strict when they participate in a factual unit
  // such as "three months" or "seventy percent". Standalone generic counts
  // such as "two options" are structural and should not make an otherwise
  // valid answer unusable.
  const allowedWord = new Set(allowed);
  const wordNums: string[] = [];
  const tokens = normalizedWords(out);
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseWordSequence([tokens[i]]);
    if (parsed === null) continue;
    const value = String(parsed);
    if (allowedWord.has(value)) continue;
    const next = tokens[i + 1];
    if (next && GENERIC_COUNT_NOUNS.has(next)) continue;
    if (next && FACT_UNITS.has(next)) wordNums.push(`word:${value}`);
  }
  return [...bad, ...wordNums];
}
