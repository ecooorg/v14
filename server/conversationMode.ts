/**
 * Mode detection and thin mode paragraph for Simple Mode conversation.
 * MP2: expand information recognition; default unclear intent to information;
 * decision only on explicit choice/decision signals.
 */

export type ConversationMode = 'information' | 'decision' | 'research' | 'engineering';

// Avoid \\b after Cyrillic (ASCII-oriented in JS).
const RE_RESEARCH = /(?:найди(?:те)?|поиск(?:ай|ать)?|сравни(?:те)?|сопоставь|наиболее\s+реалистичн|проанализируй|исследуй|источник(?:и|ов)?|find\s+(?:online|on\s+the\s+web)|search\s+(?:the\s+)?(?:web|internet|online)|compare|look\s+up|research|most\s+realistic|sources?\b)/i;
const RE_ENGINEERING = /(?:(?:напиши|сгенерируй|сделай)\s+(?:код|тест|спецификац|API|схем)|требования|критери(?:й|и)\s+приёмк|acceptance\s+criteria|unit\s+test|интеграционн(?:ый|ые)\s+тест|рефактор|pull\s+request|\bPR\b|TypeScript|Python\b|SQL\b|миграци(?:я|и)|implement|write\s+(?:code|tests?)|specification|design\s+the\s+(?:API|schema)|refactor)/i;
// Expanded: question words + tell/explain/suggest/help-with-info style requests (not only leading interrogative).
const RE_INFORMATION = /(?:^\s*(?:какой|какая|какие|какое|что|кто|где|когда|сколько|почему|зачем|как(?:ой|ая|ие|ое)?|есть\s+ли|what|who|where|when|how\s+much|how\s+many|why|is\s+there|does)(?=\s|[?!.,:;]|$)|(?:расскажи|объясни|подскажи|поясни|опиши|что\s+такое|tell\s+me|explain|describe|what\s+is|how\s+does|help\s+me\s+understand|give\s+me\s+(?:an?\s+)?(?:overview|summary|info)))/i;
const RE_DECISION = /(?:что\s+(?:(?:мне|нам|же|тут|теперь)\s+)*(?:делать|выбрать)(?:\s|[?!.,:;]|$)|как\s+поступить|решени[ея]|вариант(?:ы|ов)?|выбор(?:а|ом)?|стоит\s+ли|пора\s+ли\s+(?:мне|нам)|что\s+важнее|мне\s+(?:[а-яё]+\s+){0,6}?[а-яё]+(?:ть|ться|ти|тись|чь)\s+(?:[а-яё]+\s+){0,6}?или\s+(?:[а-яё]+\s+){0,2}?[а-яё]+(?:ть|ться|ти|тись|чь)(?=\s|[?!.,:;]|$)|(?:боюсь|опасаюсь|сомневаюсь)(?:\s|[?!.,:;]|$)|what\s+should\s+I\s+do|which\s+(?:option|path)|help\s+me\s+decide|should\s+I\b)/i;

export function detectConversationMode(
  lastUserText: string,
  opts: { userAskedSearch?: boolean; recentUserText?: string } = {},
): ConversationMode {
  const text = String(lastUserText || '');
  const recent = `${String(opts.recentUserText || '')}\n${text}`;
  // Explicit search intent from PI-02 takes precedence for Research.
  if (opts.userAskedSearch || RE_RESEARCH.test(recent)) return 'research';
  if (RE_ENGINEERING.test(recent)) return 'engineering';
  // Explicit decision/choice signals → decision.
  if (RE_DECISION.test(recent)) return 'decision';
  // Informational / orienting requests (expanded recognition).
  if (RE_INFORMATION.test(text) || RE_INFORMATION.test(recent)) return 'information';
  // Unclear intent: light Simple/information (MP2 decision).
  return 'information';
}

/** One short paragraph mixed into the shared system prompt. Does not restate HARD BOUNDARIES. */
export function modeParagraph(mode: ConversationMode): string {
  switch (mode) {
    case 'information':
      return `CURRENT FOCUS: Information request (Simple Mode). Answer the question directly in the first sentences. Use relevant general knowledge when no verified source is in this call. Approximate ranges and qualitative orienting answers are allowed when you have a reasonable basis; label them as general knowledge and worth verifying. Do not invent live measurements, fabricated citations, or claim you searched the web in this call. Do not open with methodology or why a perfect answer is impossible. Do not turn a factual question into a decision problem or ask for the user's purpose unless essential to answer. If the person forbids methodology or demands a direct answer, obey that constraint.`;
    case 'research':
      return `CURRENT FOCUS: Research / Analysis. Prioritise sources, comparisons and what can be verified. State confidence plainly. If no live search results are provided in this call, do not claim to have searched or verified anything. Still provide the best useful answer from supplied material and general knowledge, clearly distinguish it from verified current information, and name what remains to be checked. Never make the lack of live search the whole answer.`;
    case 'engineering':
      return `CURRENT FOCUS: Engineering. Aim at a checkable technical result: formal requirements, acceptance criteria, tests, explicit assumptions and gaps. Uncertainty becomes named assumptions and open gaps, not vague caveats.`;
    case 'decision':
    default:
      return `CURRENT FOCUS: Decision support. Emphasise scenarios under assumptions, the decisive unknown and the cheapest way to learn it, and symmetric critique of branches. Use questions only when the answer would materially change the analysis. Do not choose or rank options for the person.`;
  }
}
