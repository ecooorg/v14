/**
 * API routes (INF, SM, conversation)
 */
import { Router, type Request, type Response } from 'express';
import {
  verifyTesterCode,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  requireAuth,
  checkLoginRate,
} from './auth.ts';
import { checkLimits, clientIp, metricLog, aiEnabled } from './limits.ts';
import { generateContent } from './llm.ts';
import { CONVERSATION_SYSTEM, conversationUserPayload } from './prompts.ts';
import { hasDistressMarker, SUPPORT_CONTACTS } from '../app/support.ts';

const router = Router();

router.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

router.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  if (!checkLoginRate(ip)) {
    res.status(429).json({ success: false, code: 'LOGIN_RATE_LIMIT', error: 'Too many login attempts' });
    return;
  }
  const code = String(req.body?.code || '');
  const testerId = verifyTesterCode(code);
  if (!testerId) {
    res.status(401).json({ success: false, code: 'INVALID_CODE', error: 'Invalid access code' });
    return;
  }
  setSessionCookie(res, testerId);
  metricLog({ event: 'login', testerId });
  res.json({ success: true, data: { testerId } });
});

router.post('/api/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get('/api/session', (req, res) => {
  const s = readSession(req);
  if (!s) {
    res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
    return;
  }
  res.json({ success: true, data: { testerId: s.testerId, aiEnabled: aiEnabled() } });
});

router.post('/api/conversation', requireAuth, async (req: Request, res: Response) => {
  const testerId = (req as Request & { testerId: string }).testerId;
  if (!checkLimits(req, res, testerId)) return;

  const body = req.body || {};
  const recentMessages: { role: string; text: string }[] = Array.isArray(body.recentMessages)
    ? body.recentMessages
    : [];
  const lastUser = [...recentMessages].reverse().find((m) => m.role === 'user');
  const text = lastUser?.text || '';

  // Crisis markers (client + server)
  if (hasDistressMarker(text)) {
    metricLog({ event: 'conversation', testerId, step: 'crisis', status: 'safety' });
    res.json({
      success: true,
      data: {
        reply:
          'It sounds like you may need real human support right now. Please reach out to a local help service or someone you trust before continuing with this decision tool.\n\n' +
          SUPPORT_CONTACTS.map((c) => `• ${c.label}: ${c.value}`).join('\n'),
        nextStep: null,
        event: null,
        safety: true,
      },
    });
    return;
  }

  const byokKey = typeof req.headers['x-byok-key'] === 'string' ? req.headers['x-byok-key'] : undefined;

  try {
    const userPayload = conversationUserPayload({
      compactState: body.compactState || {},
      recentMessages,
      returningAfterDays: body.returningAfterDays,
      mode: body.mode,
    });
    const result = await generateContent({
      system: CONVERSATION_SYSTEM,
      user: userPayload,
      kind: 'strong',
      byokKey,
    });

    // Split optional NEXTJSON trailer
    let reply = result.text;
    let nextStep: string | null = null;
    let event: string | null = null;
    const jsonIdx = reply.lastIndexOf('NEXTJSON:');
    if (jsonIdx !== -1) {
      const raw = reply.slice(jsonIdx + 'NEXTJSON:'.length).trim();
      reply = reply.slice(0, jsonIdx).trim();
      try {
        const parsed = JSON.parse(raw) as { nextStepSummary?: unknown; nextStep?: unknown; event?: unknown };
        const events = new Set(['START','CONTINUE','EXPAND_DONE','ATTACK_DONE','HYPOTHESES_CHOSEN','CARD_LOCKED','RESULT_RECORDED','DECISION_REVISED','NEW_CYCLE','CLOSE','BACK']);
        nextStep = typeof parsed.nextStepSummary === 'string' ? parsed.nextStepSummary : typeof parsed.nextStep === 'string' ? parsed.nextStep : null;
        event = typeof parsed.event === 'string' && events.has(parsed.event) ? parsed.event : null;
      } catch {
        /* invalid trailer is not applied to domain state */
      }
    }

    metricLog({
      event: 'conversation',
      testerId,
      step: 'conversation',
      model: result.model,
      latencyMs: result.durationMs,
      status: 'ok',
      byok: Boolean(byokKey),
    });

    res.json({
      success: true,
      data: { reply, nextStep, event, meta: { model: result.model, fallback: result.fallback, at: Date.now(), durationMs: result.durationMs, schemaVersion: 15 } },
    });
  } catch (e: unknown) {
    const err = e as Error & { code?: string };
    const code = err.code || 'LLM_ERROR';
    metricLog({ event: 'conversation', testerId, step: 'conversation', status: 'error', code, detail: String(err.message || '').slice(0, 300) });
    if (code === 'PROVIDER_QUOTA') {
      res.status(429).json({
        success: false,
        code: 'PROVIDER_QUOTA',
        error: 'Provider daily quota reached. Try again tomorrow or use your own Gemini API key in settings.',
      });
      return;
    }
    if (code === 'PROVIDER_OVERLOADED') {
      res.status(503).json({
        success: false,
        code,
        error: 'The model is overloaded right now. Please try again in a minute.',
      });
      return;
    }
    res.status(500).json({ success: false, code, error: 'Model request failed' });
  }
});

export default router;
