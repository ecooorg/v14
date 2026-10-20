/**
 * Turn focus for Simple/Expert conversation.
 *
 * The request JSON starts with `brief.decision`, which is the person's FIRST message of the conversation.
 * A quality retry ("rewrite from scratch") used to make the model answer that opening message again instead of the
 * latest one. These pure helpers (a) state the answer target explicitly and (b) detect a retry that drifted back to the
 * opening question so the first draft can be kept. No I/O.
 */

/** One block added to the user section of every conversation prompt. */
export const ANSWER_TARGET_RULE = `ANSWER TARGET: Answer the person's LATEST message: the last entry with role "user" in "history". "brief.decision" is only how the conversation began: do not answer it again unless the latest message asks for that. Use the earlier "history" entries for what was already said, and do not repeat an earlier answer.`;

const STOP = new Set([
  'этот', 'этого', 'этом', 'который', 'которая', 'которые', 'какие', 'какой', 'какая', 'если', 'чтобы', 'когда', 'тоже', 'очень',
  'просто', 'можно', 'нужно', 'будет', 'быть', 'есть', 'или', 'что', 'как', 'для', 'при', 'там', 'тут', 'вот', 'так', 'уже', 'только',
  'that', 'this', 'with', 'from', 'have', 'what', 'which', 'would', 'could', 'should', 'about', 'there', 'their', 'then', 'than', 'also',
]);

const stem = (w: string): string => w.slice(0, 5);

function stems(text: string): string[] {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter((w) => w.length >= 4 && !STOP.has(w)).map(stem);
}

/** Share (0..1) of the distinctive words of `query` that also appear (by 5-letter stem) in `reply`. */
export function relevance(reply: string, query: string): number {
  const q = [...new Set(stems(query))];
  if (!q.length) return 0;
  const r = new Set(stems(reply));
  return q.filter((s) => r.has(s)).length / q.length;
}

const norm = (t: string): string => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** How much closer a reply is to the opening message than to the latest message (> 0: leans to the opening one). */
export function openingDrift(reply: string, latest: string, opening: string): number {
  return relevance(reply, opening) - relevance(reply, latest);
}

/**
 * True when the quality-retry draft went back to the opening message while the first draft did not.
 * The caller then keeps the first draft. Never true when the latest message IS the opening one (first turn).
 */
export function retryDriftedToOpening(
  firstReply: string,
  retryReply: string,
  latestUserText: string,
  openingText: string,
): boolean {
  if (!norm(latestUserText) || !norm(openingText) || norm(latestUserText) === norm(openingText)) return false;
  const retryDrift = openingDrift(retryReply, latestUserText, openingText);
  const firstDrift = openingDrift(firstReply, latestUserText, openingText);
  return retryDrift > 0.15 && retryDrift > firstDrift + 0.1;
}
