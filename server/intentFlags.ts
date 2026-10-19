/**
 * PI-02 (TZ-INSTRUCTIONS-01 P2): server-side intent flags from the last user text.
 * Pure detectors — no Express, no model calls.
 * MP3: information-mode soft quality signals (limitation-only, methodology preamble,
 * invented precision argument, lecture after ban).
 */

export type UserIntentFlags = {
  userForbadeQuestions: boolean;
  userAskedApproximate: boolean;
  userAskedSearch: boolean;
  userCriticizedEvasion: boolean;
  userForbadeMethodology: boolean;
  userDemandedDirectAnswer: boolean;
};

export type GainAuditSlice = {
  substantiveGain: string[];
  structuralNew: string[];
  hasNextStep: boolean;
};

// Note: avoid \\b after Cyrillic — JS word boundaries are ASCII-oriented.
const RE_FORBADE_QUESTIONS = /(?:^|[\s,.;:!?«»"'])(?:не\s+задавай(?:те)?(?:\s+вопрос(?:ов|ы|а)?)?|не\s+спрашивай(?:те)?|без\s+вопрос(?:ов|ов)|больше\s+ничего\s+не\s+(?:говори|спрашивай)|просто\s+(?:дай(?:\s+ответ)?|ответь)|don'?t\s+ask(?:\s+(?:me\s+)?(?:any\s+)?questions?)?|do\s+not\s+ask(?:\s+(?:me\s+)?(?:any\s+)?questions?)?|no\s+questions(?:\s+please)?|just\s+(?:give|answer|tell)(?:\s+(?:me\s+)?(?:the\s+)?answer)?|stop\s+asking)(?=$|[\s,.;:!?«»"'])/i;
const RE_ASKED_APPROXIMATE = /(?:приблизит(?:ельн(?:ая|о|ый|ую)|ельно)|примерно|груб(?:ая|о|ую)\s+оценк|оценка\s+без\s+гарантии|предварительн(?:ая|о|ый)|ballpark|rough\s+(?:estimate|figure|number|guess)|approximate(?:ly)?|without\s+(?:a\s+)?guarantee|order\s+of\s+magnitude)/i;
const RE_ASKED_SEARCH = /(?:найди(?:те)?(?:\s+(?:в\s+(?:сети|интернете)|онлайн|прогноз(?:ы)?))?|поиск(?:ай|ать)?(?:\s+в\s+(?:сети|интернете))?|(?:^|[\s,.;:!?])в\s+сети|(?:^|[\s,.;:!?])в\s+интернете|find\s+(?:(?:it|them|this|that|forecasts?|data|info(?:rmation)?)\s+)?(?:online|on\s+the\s+web|on\s+the\s+internet)|search\s+(?:the\s+)?(?:web|internet|online)|look\s+up\s+(?:online|on\s+the\s+web)|google\b)/i;
const RE_CRITICIZED_EVASION = /(?:это\s+не\s+решает(?:\s+мою\s+задачу)?|не\s+решает\s+(?:мою\s+)?задачу|не\s+помогает|бесполезн(?:о|ый|ая)|увилива(?:ешь|ние)|ты\s+уклоняешься|this\s+does\s+not\s+solve\s+(?:my\s+)?(?:task|problem)|doesn'?t\s+(?:solve|help)|you(?:'re|\s+are)\s+avoiding|useless\s+answer|not\s+what\s+I\s+(?:asked|need))/i;
const RE_LIMITATION_ONLY = /(?:невозможн|недоступн|не\s+могу\s+(?:дать|предсказать|спрогнозировать)|точный\s+(?:прогноз|ответ)\s+невозможен|cannot\s+(?:give|provide|predict)|impossible\s+to\s+(?:give|predict)|no\s+(?:exact|precise)\s+(?:forecast|answer)|I\s+(?:cannot|can't)\s+(?:give|provide))/i;
const RE_FORBADE_METHODOLOGY = /(?:не\s+(?:пиши|рассказывай|говори)(?:\s+мне)?\s+(?:о\s+)?методик|не\s+поучай|без\s+методик|не\s+объясняй\s+(?:метод|методик|как\s+работа)|don'?t\s+(?:lecture|explain\s+(?:the\s+)?(?:method|methodology))|no\s+methodology|stop\s+lecturing)/i;
const RE_DEMANDED_DIRECT = /(?:ответь\s+на\s+мой\s+вопрос|дай\s+прогноз|просто\s+ответь|только\s+ответ|answer\s+my\s+question|just\s+answer|give\s+(?:me\s+)?(?:the\s+)?(?:forecast|answer)|directly\s+answer)/i;

// MP3: methodology / lecture preamble before substance (opening patterns).
const RE_METHODOLOGY_PREAMBLE = /^(?:(?:сначала|прежде\s+всего|важно\s+понять|нужно\s+учесть|для\s+начала|прежде\s+чем\s+ответить|перед\s+тем\s+как|в\s+целом|в\s+рамках|с\s+точки\s+зрения\s+методолог|as\s+a\s+(?:language\s+)?model|I\s+(?:am|I'm)\s+(?:an?\s+)?AI|before\s+(?:I\s+)?(?:answer|can\s+answer)|it\s+is\s+important\s+to\s+(?:understand|note)|first(?:ly)?,?\s+(?:it\s+is|we\s+must|one\s+must)|from\s+a\s+methodological)|(?:к\s+сожалению,?\s+)?(?:я\s+)?(?:не\s+могу\s+дать\s+точный|не\s+располагаю\s+актуальн|точный\s+(?:прогноз|ответ)\s+невозможен)|(?:unfortunately,?\s+)?I\s+(?:cannot|can't)\s+(?:give|provide)\s+(?:an?\s+)?(?:exact|precise|current))/i;

// MP3: arguing with an invented precision / live-data requirement the user did not ask for.
const RE_INVENTED_PRECISION = /(?:для\s+(?:точного|полного|актуального)\s+(?:ответа|прогноза|анализа)\s+(?:нужн|требу|необходим)|без\s+(?:точных|актуальных|живых)\s+(?:данных|измерений|источников)|(?:I\s+)?(?:need|require)\s+(?:exact|precise|live|current)\s+(?:data|measurements|sources)|without\s+(?:exact|precise|live|current)\s+(?:data|measurements)|(?:cannot|can't)\s+answer\s+without\s+(?:exact|precise|live))/i;

// MP3: lecture / methodology content (broader than opening preamble).
const RE_LECTURE_CONTENT = /(?:методик(?:а|и|ой)|методолог(?:ия|ии)|как\s+работает\s+(?:модель|система)|ограничени(?:я|ям)\s+(?:модели|ИИ|AI)|(?:language\s+)?model\s+(?:limitation|cannot|doesn't)|I\s+am\s+(?:just\s+)?(?:an?\s+)?(?:AI|language\s+model)|as\s+an?\s+(?:AI|assistant|language\s+model))/i;

export function detectUserIntentFlags(lastUserText: string, history: Array<{ role: string; content: string }> = []): UserIntentFlags {
  const text = String(lastUserText || '');
  const recentUser = history
    .filter((m) => m?.role === 'user')
    .slice(-4)
    .map((m) => String(m.content || ''))
    .join('\n');
  return {
    userForbadeQuestions: RE_FORBADE_QUESTIONS.test(text) || RE_FORBADE_QUESTIONS.test(recentUser),
    userAskedApproximate: RE_ASKED_APPROXIMATE.test(text),
    userAskedSearch: RE_ASKED_SEARCH.test(text),
    userCriticizedEvasion: RE_CRITICIZED_EVASION.test(text),
    userForbadeMethodology: RE_FORBADE_METHODOLOGY.test(text) || RE_FORBADE_METHODOLOGY.test(recentUser),
    userDemandedDirectAnswer: RE_DEMANDED_DIRECT.test(text) || RE_DEMANDED_DIRECT.test(recentUser),
  };
}

/** Soft-audit helper: reply is essentially only an explanation of limits (no gain, no next step). */
export function isLimitationOnlyReply(out: any, audit: GainAuditSlice): boolean {
  if (audit.substantiveGain.length > 0 || audit.structuralNew.length > 0 || audit.hasNextStep) return false;
  const reply = String(out?.reply || '');
  if (!reply.trim()) return true;
  return RE_LIMITATION_ONLY.test(reply);
}

/**
 * MP3: soft quality fail for Simple/information mode.
 * Detects typical evasive drafts without requiring the heavy decision gain-audit.
 * Returns true when a short information-mode retry is warranted.
 */
export function informationSoftFail(out: any, flags: UserIntentFlags): boolean {
  const reply = String(out?.reply || '').trim();
  if (!reply) return true;

  // Answer that is only limitations / impossibility.
  if (RE_LIMITATION_ONLY.test(reply) && reply.length < 900) {
    // Allow a short limitation note if substance appears early; otherwise fail.
    const firstChunk = reply.slice(0, 280);
    if (RE_LIMITATION_ONLY.test(firstChunk) && !/\d|°|℃|снег|температур|зима|winter|snow|climate|region/i.test(firstChunk)) {
      return true;
    }
  }

  // Methodology / "I am an AI" / precision-impossibility preamble before substance.
  if (RE_METHODOLOGY_PREAMBLE.test(reply)) return true;

  // Invented precision / live-data requirement the user did not state.
  if (RE_INVENTED_PRECISION.test(reply) && !flags.userAskedSearch) return true;

  // After an explicit ban on methodology / demand for a direct answer, still lecturing.
  if ((flags.userForbadeMethodology || flags.userDemandedDirectAnswer) && RE_LECTURE_CONTENT.test(reply)) {
    return true;
  }

  // Negative feedback on previous turn: still limitation-only or pure lecture.
  if (flags.userCriticizedEvasion) {
    if (RE_LIMITATION_ONLY.test(reply) || RE_METHODOLOGY_PREAMBLE.test(reply) || RE_LECTURE_CONTENT.test(reply)) {
      return true;
    }
  }

  return false;
}

/** Repair hint for information-mode soft retry (kept short; does not switch to decision package). */
export function informationRetryHint(flags: UserIntentFlags): string {
  let hint = `QUALITY CHECK (information mode). The previous draft was evasive: methodology preamble, limitations-only, or an invented precision requirement. Rewrite the JSON from scratch.
Open with the substance of the answer in the first sentences. Use relevant general knowledge; label approximate ranges as general knowledge worth verifying. Do not open with methodology, model limits, or why a perfect answer is impossible. Do not invent a stricter question than the person asked. Do not turn a factual question into a decision problem.`;
  if (flags.userForbadeMethodology || flags.userDemandedDirectAnswer) {
    hint += `\nThe person demanded a direct answer and/or forbade methodology. Obey that constraint.`;
  }
  if (flags.userCriticizedEvasion) {
    hint += `\nThe person said the previous answer did not help. Change the approach: give a usable orienting answer, not the same limitation lecture.`;
  }
  if (flags.userAskedApproximate) {
    hint += `\nThe person asked for an approximate or preliminary result. Give a rough available result with explicit caveats.`;
  }
  return hint;
}
