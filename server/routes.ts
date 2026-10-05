/**
 * API routes for v15, with the v13 analytical conversation engine restored.
 */
import { Router, type Request, type Response } from 'express';
import { verifyTesterCode, setSessionCookie, clearSessionCookie, readSession, requireAuth, checkLoginRate } from './auth.ts';
import { checkLimits, clientIp, metricLog, aiEnabled } from './limits.ts';
import { generateContent } from './llm.ts';
import { buildConversationPrompt } from './prompts.ts';
import { hasDistressMarker, SUPPORT_CONTACTS } from '../app/support.ts';

const router = Router();

router.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '15.0.0' }));

router.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  if (!checkLoginRate(ip)) return res.status(429).json({ success: false, code: 'LOGIN_RATE_LIMIT', error: 'Too many login attempts' });
  const testerId = verifyTesterCode(String(req.body?.code || ''));
  if (!testerId) return res.status(401).json({ success: false, code: 'INVALID_CODE', error: 'Invalid access code' });
  setSessionCookie(res, testerId);
  metricLog({ event: 'login', testerId });
  res.json({ success: true, data: { testerId } });
});

router.post('/api/logout', (_req, res) => { clearSessionCookie(res); res.json({ success: true }); });

router.get('/api/session', (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
  res.json({ success: true, data: { testerId: s.testerId, aiEnabled: aiEnabled() } });
});

const STRUCTURAL_NOVELTY_TYPES = new Set([
  'TIMING','SEQUENCE','TEST_OR_PILOT','TEMPORARY_TEST','REVERSIBLE_STEP','REVERSIBLE_COMMITMENT','SPLIT','SPLIT_BASE','SCALE','SCALE_CHANGE','SCOPE','SCOPE_CHANGE','GOAL_REFRAME','UNDERLYING_GOAL','CONDITIONS_CHANGE','INTERNAL_CHANGE','GET_FACT_FIRST','KEEP_OPEN','OWNERSHIP_CHANGE','FINANCING_CHANGE',
]);
const GAIN_TYPES = new Set(['NEW_BRANCH','REFRAMED_QUESTION','HIDDEN_ASSUMPTION','CONTRADICTION','DECISIVE_UNKNOWN','CHEAP_TEST','CALCULATION','CHANGING_CONDITION']);

function getOptionStrings(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x: any) => typeof x === 'string' ? x.trim() : x && typeof x.title === 'string' ? x.title.trim() : '').filter(Boolean);
}
function normalizeOptionText(s: string): string { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function optionIsSubstantivelyNew(title: string, userOptions: string[], history: any[]): boolean {
  const n = normalizeOptionText(title); if (!n) return false;
  return [...userOptions, ...history.map((m: any) => String(m?.content || ''))].every((source) => {
    const sn = normalizeOptionText(source); if (!sn) return true;
    if (sn === n || sn.includes(n) || n.includes(sn)) return false;
    const a = new Set(n.split(' ').filter((x) => x.length > 3));
    const b = new Set(sn.split(' ').filter((x) => x.length > 3));
    let overlap = 0; for (const word of a) if (b.has(word)) overlap++;
    return overlap < Math.max(3, Math.ceil(a.size * 0.65));
  });
}
function conversationGainAudit(out: any, contextSufficiency: string) {
  const triage = String(out?.triage || 'PROCEED').toUpperCase();
  const gain = Array.isArray(out?.gain) ? out.gain.map((x: any) => String(x || '').toUpperCase()).filter((x: string) => GAIN_TYPES.has(x)) : [];
  const newOptions = getOptionStrings(out?.newOptions);
  const noveltyTypes = Array.isArray(out?.newOptionTypes) ? out.newOptionTypes.map((x: any) => String(x || '').toUpperCase()) : [];
  const structuralNew = newOptions.filter((_, i) => STRUCTURAL_NOVELTY_TYPES.has(noveltyTypes[i] || ''));
  const substantiveGain = gain.filter((g: string) => g !== 'NEW_BRANCH');
  const hasNextStep = typeof out?.nextStep === 'string' && out.nextStep.trim().length > 0;
  const exempt = triage !== 'PROCEED' || contextSufficiency === 'LOW';
  return { triage, gain, newOptions, structuralNew, passed: exempt || substantiveGain.length > 0 || structuralNew.length > 0 || (hasNextStep && gain.length > 0) };
}
function parseJson(text: string): any {
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]);
    throw new Error('AI returned invalid JSON');
  }
}
function cleanReplyText(s: string): string {
  return s.replace(/\s*\((?:Source|Источник):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\)\s*/gi, ' ')
    .replace(/\s*(?:Source|Источник):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\s*/gi, ' ')
    .replace(/\s*\((?:Split[- _]?base|Sequence|Timing|Test[_ ]or[_ ]pilot|Temporary[_ ]test|Reversible[_ ](?:step|commitment)|Scale[_ ]change|Scope[_ ]change|Goal[_ ]reframe|Conditions?[_ ]change|Get[_ ]fact[_ ]first|Keep[_ ]open|Underlying[_ ]goal|Internal[_ ]change|Ownership[_ ]change|Financing[_ ]change)\)/gi, '')
    .replace(/[ 	]{2,}/g, ' ').trim();
}

router.post('/api/conversation', requireAuth, async (req: Request, res: Response) => {
  const testerId = (req as Request & { testerId: string }).testerId;
  if (!checkLimits(req, res, testerId)) return;
  const body = req.body || {};
  const recentMessages = Array.isArray(body.recentMessages)
    ? body.recentMessages.slice(-12).map((m: any) => ({ role: m?.role === 'user' ? 'user' : 'assistant', content: String(m?.text ?? m?.content ?? '').slice(0, 8000) }))
    : [];
  const lastUserText = [...recentMessages].reverse().find((m: any) => m.role === 'user')?.content || '';

  if (hasDistressMarker(lastUserText)) {
    metricLog({ event: 'conversation', testerId, step: 'crisis', status: 'safety' });
    return res.json({ success: true, data: { reply: SUPPORT_CONTACTS.map((c) => `${c.label}: ${c.value}`).join('\n'), nextStep: null, event: null, safety: true } });
  }

  const history = recentMessages;
  const decision = String(history.find((m: any) => m.role === 'user')?.content || lastUserText || '');
  const userTurns = history.filter((m: any) => m.role === 'user').length;
  const returningAfterDays = Number(body.returningAfterDays);
  const input = JSON.stringify({
    brief: { decision },
    history,
    state: body.compactState || {},
    context: {
      intent: typeof body.mode === 'string' ? body.mode : undefined,
      userTurns,
      returningAfterDays: Number.isFinite(returningAfterDays) && returningAfterDays >= 1 ? Math.min(Math.floor(returningAfterDays), 365) : undefined,
      distressMarkerDetected: false,
    },
  });

  const byokKey = typeof req.headers['x-byok-key'] === 'string' ? req.headers['x-byok-key'] : undefined;

  try {
    const prompt = buildConversationPrompt(input);
    const first = await generateContent({ system: 'Return valid JSON only. Follow the analytical engine instructions in the user prompt. Never replace the requested language with English.', user: prompt, kind: 'strong', byokKey, json: true });
    let out = parseJson(first.text);
    let meta = first;
    const suff = () => ['LOW','MEDIUM','HIGH'].includes(String(out?.contextSufficiency || '').toUpperCase()) ? String(out.contextSufficiency).toUpperCase() : 'MEDIUM';
    let audit = conversationGainAudit(out, suff());

    if (!audit.passed) {
      const retry = `${prompt}

QUALITY CHECK FAILED. Rewrite the JSON from scratch. The previous answer added nothing genuinely new. It MUST add at least one reframing, hidden assumption, contradiction, decisive unknown with a cheap way to learn it, concrete test, calculation on the user's numbers, changing condition, or structurally different branch. Do not merely ask the user to explain the same decision again. Do not choose for the user. Keep the exact language of the latest user message.`;
      try {
        const second = await generateContent({ system: 'Return valid JSON only. This is a quality-repair pass. Follow the analytical engine instructions and answer in the latest user language.', user: retry, kind: 'strong', byokKey, json: true });
        const candidate = parseJson(second.text);
        if (candidate?.reply && typeof candidate.reply === 'string') { out = candidate; meta = { ...second, fallback: true }; audit = conversationGainAudit(out, suff()); }
      } catch (e) {
        metricLog({ event: 'conversation_retry', testerId, status: 'error', detail: String((e as Error)?.message || e).slice(0, 200) });
      }
    }

    if (!out?.reply || typeof out.reply !== 'string') throw new Error('Conversation response was empty');
    const contextSufficiency = suff();
    const askAllowed = audit.triage !== 'CRISIS' && (contextSufficiency === 'LOW' || contextSufficiency === 'MEDIUM');
    const question = askAllowed && typeof out.question === 'string' ? out.question.trim() : '';
    let reply = cleanReplyText(out.reply);
    if (question && !normalizeOptionText(reply).includes(normalizeOptionText(question))) reply += `

${question}`;

    const allowedEvents = new Set(['START','CONTINUE','EXPAND_DONE','ATTACK_DONE','HYPOTHESES_CHOSEN','CARD_LOCKED','RESULT_RECORDED','DECISION_REVISED','NEW_CYCLE','CLOSE','BACK']);
    const event = allowedEvents.has(String(body.event || '')) ? String(body.event) : (audit.triage === 'PROCEED' ? 'CONTINUE' : null);

    metricLog({ event: 'conversation', testerId, step: 'conversation', model: meta.model, latencyMs: meta.durationMs, status: 'ok', byok: Boolean(byokKey) });
    return res.json({ success: true, data: {
      reply,
      nextStep: typeof out.nextStep === 'string' ? out.nextStep.trim() : '',
      event,
      contextSufficiency,
      triage: audit.triage,
      gain: audit.gain,
      options: Array.isArray(out.options) ? out.options.filter((x: any) => typeof x === 'string').slice(0, 8) : [],
      newOptions: getOptionStrings(out.newOptions).filter((x) => optionIsSubstantivelyNew(x, history.filter((m: any) => m.role === 'user').map((m: any) => m.content), history)).slice(0, 5),
      newOptionTypes: Array.isArray(out.newOptionTypes) ? out.newOptionTypes.map((x: any) => String(x)).slice(0, 5) : [],
      factsToCheck: Array.isArray(out.factsToCheck) ? out.factsToCheck.filter((x: any) => typeof x === 'string').slice(0, 6) : [],
      state: out.state && typeof out.state === 'object' ? out.state : undefined,
      meta: { model: meta.model, fallback: meta.fallback, at: Date.now(), durationMs: meta.durationMs, schemaVersion: 15 },
    } });
  } catch (e: unknown) {
    const err = e as Error & { code?: string };
    const code = err.code || 'LLM_ERROR';
    metricLog({ event: 'conversation', testerId, step: 'conversation', status: 'error', code, detail: String(err.message || '').slice(0, 300) });
    if (code === 'PROVIDER_QUOTA') return res.status(429).json({ success: false, code, error: 'Provider daily quota reached. Try again later or use your own Gemini API key in settings.' });
    if (code === 'PROVIDER_OVERLOADED') return res.status(503).json({ success: false, code, error: 'The model is overloaded right now. Please try again in a minute.' });
    return res.status(500).json({ success: false, code, error: 'Model request failed' });
  }
});

export default router;
