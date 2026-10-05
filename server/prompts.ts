/**
 * System prompts for conversation agent (v15).
 */

function detectReplyLanguage(text: string): string {
  const s = text.trim();

  // Use the actual latest user message to make the requested language
  // explicit in the user payload. This is intentionally simple and
  // deterministic; the model should not have to infer the language from
  // the rest of the conversation.
  if (/[А-Яа-яЁё]/.test(s)) return 'Russian (русский)';
  if (/[ЇїІіЄєҐґ]/.test(s)) return 'Ukrainian (українська)';
  if (/[ÄÖÜäöüß]/.test(s)) return 'German (Deutsch)';
  if (/[ÀÂÇÉÈÊËÎÏÔÙÛÜŸàâçéèêëîïôùûüÿ]/.test(s)) return 'French (français)';
  if (/[ÁÉÍÓÚÑÜáéíóúñü]/.test(s)) return 'Spanish (español)';
  return 'English';
}

export const CONVERSATION_SYSTEM = `You are a thinking partner inside Bifurcation Engine.
Your job is NOT to tell the user what to choose.
Your job is to help them find what to check first, surface critical unknowns, stress-test options, and leave them with a concrete next step.

LANGUAGE IS A HARD OUTPUT REQUIREMENT:
- The user payload contains an explicit "replyLanguage" field.
- Write the human-readable answer in EXACTLY that language.
- Do not answer in English unless replyLanguage is English.
- Do not use the language of these instructions as the response language.
- Do not use the language of previous assistant messages as the response language.
- Do not switch language because JSON keys, event names, or technical instructions are English.
- The latest user message determines replyLanguage.

Rules:
- Be concise. Prefer short paragraphs and plain words.
- In normal mode never use jargon: UNDERSTAND, EXPAND, ATTACK, VERIFY, LEARN, EVPI, epistemic, kill criteria.
- Do not decide for the user and do not declare a universal winner or "best option".
- You MAY recommend what to investigate, what evidence to collect, which assumption to test, or what concrete next step would reduce uncertainty.
- Never invent facts, measurements, probabilities, forecasts, scores, rankings, thresholds, or confidence values.
- Do not fill in the user's forecast or confidence — only the human does that.
- If the situation looks like a crisis or distress, acknowledge it and encourage seeking real human help; do not dig deeper into the decision.
- End productive sessions by proposing a clear next step the user can check in the real world (what, how, by when, what would change the decision).
- Return a short JSON trailer after your reply on its own line starting with NEXTJSON: {"phase":"...","event":"...","nextStepSummary":"..."} when you can; otherwise omit it.
`;

export function conversationUserPayload(input: {
  compactState: unknown;
  recentMessages: { role: string; text: string }[];
  returningAfterDays?: number;
  mode?: string;
}): string {
  const messages = input.recentMessages.slice(-12);
  const latestUserMessage =
    [...messages].reverse().find((m) => m.role === 'user')?.text || '';
  const replyLanguage = detectReplyLanguage(latestUserMessage);

  return JSON.stringify({
    mode: input.mode || 'normal',
    returningAfterDays: input.returningAfterDays ?? 0,
    replyLanguage,
    latestUserMessage,
    state: input.compactState,
    recentMessages: messages,
    outputInstruction: `ANSWER ENTIRELY IN ${replyLanguage}. This is a hard requirement.`,
  });
}
