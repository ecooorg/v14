/**
 * Bifurcation Engine server
 * API endpoints per step
 */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { SUPPORT_CONTACTS, hasDistressMarker } from './src/config/support.ts';
import { collectAllowedFromInput, validateNumbers } from './src/core/numberValidator.ts';

import { APP_VERSION } from './src/config.ts';
import { V17_LAYER_PROMPT, buildVisibleReply, firstQuestionOnly, mergeModelState, normalizeState, readInternalFlags, scrubInternalLabels } from './server/reasoningState.ts';
import { LoginLimiter, SESSION_COOKIE, clearedCookie, createSessionSigner, sessionCookie, stripMarkdown } from './server/security.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 256 * 1024;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const APP_AUTH_ENABLED = Boolean(APP_PASSWORD) && process.env.ENABLE_APP_AUTH !== 'false';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const signer = createSessionSigner(SESSION_SECRET || 'auth-disabled');
const loginLimiter = new LoginLimiter(Number(process.env.LOGIN_MAX_FAILS) || 10, (Number(process.env.LOGIN_WINDOW_MIN) || 15) * 60 * 1000);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cookieValue(req: express.Request, name: string): string | null {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setSession(res: express.Response): void {
  const token = signer.sign(Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000, NODE_ENV === 'production'));
}

function authenticated(req: express.Request): boolean {
  if (!APP_AUTH_ENABLED) return true;
  return signer.verify(cookieValue(req, SESSION_COOKIE));
}
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR) || 60;
const DAILY_CALL_CAP = Number(process.env.DAILY_CALL_CAP) || 200;
const NODE_ENV = process.env.NODE_ENV || 'development';


// Behind Railway's proxy: trust exactly the configured number of hops, so X-Forwarded-For cannot be spoofed.
app.set('trust proxy', process.env.TRUST_PROXY_HOPS !== undefined ? Number(process.env.TRUST_PROXY_HOPS) : (NODE_ENV === 'production' ? 1 : false));
app.use(express.json({ limit: MAX_BODY }));

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// Availability-first defaults. These are deliberately conservative: the router learns from
// real requests instead of assuming that the most intelligent model is the most available one.
// Stable model IDs only; legacy/latest aliases are not used in the default pool.
const LIGHT_MODELS = (
  process.env.MODEL_CASCADE_LIGHT ||
  'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.6-flash,gemini-3.7-flash,gemini-3.8-flash'
).split(',').map((s) => s.trim()).filter(Boolean);

const STRONG_MODELS = (
  process.env.MODEL_CASCADE_STRONG ||
  'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.6-flash,gemini-3.7-flash,gemini-3.8-flash'
).split(',').map((s) => s.trim()).filter(Boolean);

// Keep the whole request bounded. The router is designed to move to a reserve model
// quickly rather than hammering one overloaded model with repeated retries.
const LLM_PER_CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS) || 16000;
const LLM_TOTAL_DEADLINE_MS = Number(process.env.LLM_TOTAL_DEADLINE_MS) || 55000;
const MAX_MODEL_CALLS = Number(process.env.MAX_MODEL_CALLS) || 4;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || '';
const isLightModel = (m: string) => /lite/i.test(m);

// Adaptive, process-local model health. Railway replicas learn independently; that is
// intentional because it adds no extra external dependency or quota-consuming probe calls.
type ModelHealth = {
  successes: number;
  transientFailures: number;
  rateLimits: number;
  badModelErrors: number;
  timeouts: number;
  consecutiveFailures: number;
  ewmaLatencyMs: number;
  cooldownUntil: number;
  lastEventAt: number;
};
const modelHealth = new Map<string, ModelHealth>();
const MODEL_COOLDOWN_503_MS = 60 * 1000;
const MODEL_COOLDOWN_429_MS = 3 * 60 * 1000;
const MODEL_COOLDOWN_BAD_MS = 10 * 60 * 1000;
const BACKOFF_503_MIN_MS = 700;
const BACKOFF_503_MAX_MS = 1800;
const BACKOFF_429_MIN_MS = 4500;
const BACKOFF_429_MAX_MS = 9000;

// Rate limiting (in-memory)
const rateMap = new Map<string, { hour: number; count: number; day: number; dayCount: number }>();
let globalDay = new Date().toISOString().slice(0, 10);
let globalDayCount = 0;

function clientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function checkRate(req: express.Request, res: express.Response): boolean {
  const ip = clientIp(req);
  const nowHour = Math.floor(Date.now() / 3600000);
  const today = new Date().toISOString().slice(0, 10);
  if (today !== globalDay) {
    globalDay = today;
    globalDayCount = 0;
  }
  if (!byokFromRequest(req) && globalDayCount >= DAILY_CALL_CAP) {
    res.status(429).json({ success: false, error: 'Daily model call limit exceeded', code: 'DAILY_CAP' });
    return false;
  }
  let rec = rateMap.get(ip);
  if (!rec || rec.hour !== nowHour) {
    rec = { hour: nowHour, count: 0, day: Date.now(), dayCount: rec?.dayCount || 0 };
  }
  if (rec.count >= RATE_LIMIT_PER_HOUR) {
    res.status(429).json({ success: false, error: 'Hourly request limit', code: 'RATE_LIMIT' });
    return false;
  }
  rec.count++;
  rateMap.set(ip, rec);
  return true;
}

// Minimal password session endpoints. The decision engine itself is unchanged.
app.get('/api/session', (req, res) => {
  res.json({ success: true, authenticated: authenticated(req), required: APP_AUTH_ENABLED });
});

app.post('/api/login', (req, res) => {
  if (!APP_AUTH_ENABLED) return res.json({ success: true, authenticated: true, required: false });
  const password = String(req.body?.password || '');
  const a = Buffer.from(password);
  const b = Buffer.from(APP_PASSWORD);
  const ip = clientIp(req);
  const wait = loginLimiter.retryAfterSec(ip);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ success: false, code: 'TOO_MANY_ATTEMPTS', retryAfter: wait,
      error: `Too many failed sign-in attempts. Please try again in ${Math.ceil(wait / 60)} minute(s).` });
  }
  const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  if (!ok) loginLimiter.recordFailure(ip);
  if (!ok) return res.status(401).json({ success: false, error: 'Invalid password', code: 'INVALID_PASSWORD' });
  setSession(res);
  res.json({ success: true, authenticated: true, required: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearedCookie(NODE_ENV === 'production'));
  res.json({ success: true });
});

// Auth middleware for /api/*
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health' || req.path === '/api/session' || req.path === '/api/login' || req.path === '/api/logout') return next();
  if (!authenticated(req)) {
    return res.status(401).json({ success: false, error: 'Authentication required', code: 'UNAUTHORIZED' });
  }
  next();
});

const BASE_SYSTEM = `You are an analytical engine for a complex decision (Bifurcation Engine). The human keeps the right to decide: do not choose for them and do not substitute their values.
Do not imitate a person with life experience or feelings. Use what you are strong at: structuring, exposing hidden assumptions and contradictions, generating the space of possible actions, critique from the opposite side, scenarios, judging which unknown matters most, designing cheap tests, calculation on the user's own numbers.
Do not invent facts, amounts, deadlines, prices, probabilities, percentages, or organization names about the user's situation. Any percentage or probability must come from the user input. Derived numbers are allowed only when you put them in derived_numbers with numeric operands from the input and a machine-checkable arithmetic formula. Never put an ungrounded new number in prose.
"Insufficient data" is better than a confident guess; an acknowledged gap is better than a confident error.
For every claim, set source: USER_DATA, GENERAL_PATTERN, or GUESS.
Do not call a scenario a forecast; do not state probabilities.
Mark claims about the external world as requiring external verification.
Do not soften criticism (red team, pre-mortem).
Statements like "I decided" or "I know for sure" are hypotheses to test, not facts.
The options the user lists are what they currently see, not the whole space of possible actions. Never produce generic content that would fit any person in any situation: derive everything from this user's own facts.
Forbidden: best option, recommended, winner, score, ranking, optimal, you should choose. You may name the most informative next step, but never choose between options or values.
Reply only with JSON per the schema, no text outside the schema. Write every human-readable string in the language of the user's input; keep JSON keys and enum values exactly as specified in the schema.`;

function evaluateDerivedFormula(formula: string, operands: number[]): number | null {
  // Accept a small, explicitly arithmetic language only. Numeric literals in
  // the expression must be exactly the declared operands (same multiset; order
  // in the operands array is not semantically important). This avoids false
  // negatives when the model lists operands in a different order.
  let normalized = formula.toLowerCase()
    .replace(/,/g, '.')
    .replace(/×/g, '*').replace(/÷/g, '/')
    .replace(/\b(?:divided by|divide by|divided into|разделить на|делённый на|деленный на)\b/g, '/')
    .replace(/\b(?:multiplied by|multiply by|times|умножить на|умноженный на|умноженный)\b/g, '*')
    .replace(/\b(?:minus|subtract|less|минус|вычесть|вычитаем)\b/g, '-')
    .replace(/\b(?:plus|add|плюс|прибавить|складываем)\b/g, '+')
    .replace(/\b(?:equals|equal to|равно|получается|итого)\b/g, '=');

  const eq = normalized.indexOf('=');
  if (eq >= 0) normalized = normalized.slice(0, eq);

  const candidates = normalized.match(/[0-9.()+*/\-\s]+/g) || [];
  for (const raw of candidates) {
    const expr = raw.trim();
    if (!expr || !/[+*/-]/.test(expr)) continue;
    if (!/^[0-9.()+*/\-\s]+$/.test(expr)) continue;

    const literals = expr.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (literals.length !== operands.length) continue;

    // Compare operands as a multiset, not by order.
    const a = [...literals].sort((x, y) => x - y);
    const b = [...operands].sort((x, y) => x - y);
    if (a.some((n, i) => n !== b[i])) continue;

    const tokenRe = /\d+(?:\.\d+)?|[()+\-*/]/g;
    const tokens = expr.match(tokenRe) || [];
    if (tokens.join('') !== expr.replace(/\s+/g, '')) continue;

    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];
    const parseFactor = (): number | null => {
      const t = peek();
      if (t === '+' || t === '-') {
        take();
        const v = parseFactor();
        return v === null ? null : (t === '-' ? -v : v);
      }
      if (t === '(') {
        take();
        const v = parseExpr();
        if (peek() !== ')') return null;
        take();
        return v;
      }
      if (/^\d+(?:\.\d+)?$/.test(t || '')) {
        take();
        return Number(t);
      }
      return null;
    };
    const parseTerm = (): number | null => {
      let value = parseFactor();
      while (value !== null && (peek() === '*' || peek() === '/')) {
        const op = take();
        const rhs = parseFactor();
        if (rhs === null || (op === '/' && rhs === 0)) return null;
        value = op === '*' ? value * rhs : value / rhs;
      }
      return value;
    };
    const parseExpr = (): number | null => {
      let value = parseTerm();
      while (value !== null && (peek() === '+' || peek() === '-')) {
        const op = take();
        const rhs = parseTerm();
        if (rhs === null) return null;
        value = op === '+' ? value + rhs : value - rhs;
      }
      return value;
    };

    const value = parseExpr();
    if (value !== null && pos === tokens.length && Number.isFinite(value)) return value;
  }
  return null;
}
function validatedDerivedNumbers(out: string, input: string, extraAllowed: number[] = []): string[] {
  // A model cannot make its own number trustworthy merely by putting it in
  // derived_numbers. Every operand must be grounded in the supplied input (or
  // an explicitly allowed structural parameter), and the formula must reproduce
  // the claimed value independently on the server.
  const allowed = collectAllowedFromInput(input, extraAllowed);
  try {
    const m = out.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : out) as any;
    const list = obj?.derived_numbers || obj?.derivedNumbers || [];
    if (!Array.isArray(list)) return [];
    const trusted: string[] = [];
    for (const d of list) {
      if (!d || (typeof d.value !== 'number' && typeof d.value !== 'string') ||
          typeof d.formula !== 'string' || !d.formula.trim() || !Array.isArray(d.operands)) continue;
      const value = Number(String(d.value).replace(',', '.'));
      if (!Number.isFinite(value)) continue;

      // Percentage formulas may use 100 as a mathematical constant. All
      // other operands must be grounded in the user's input (or explicit
      // structural parameters).
      const FORMULA_CONSTANTS = new Set([0, 1, 100]);
      const operands: number[] = [];
      let operandsOk = true;
      for (const o of d.operands) {
        const n = typeof o === 'number' ? o : Number(String(o).replace(',', '.'));
        if (!Number.isFinite(n)) { operandsOk = false; break; }
        if (FORMULA_CONSTANTS.has(n)) { operands.push(n); continue; }
        const ns = String(n);
        if (!(allowed.has(ns) || allowed.has(ns.replace('.', ',')))) { operandsOk = false; break; }
        operands.push(n);
      }
      if (!operandsOk) continue;

      const calculated = evaluateDerivedFormula(d.formula, operands);
      // Derived values may be rounded for display (e.g. 177.78%), but only
      // after the server independently reproduces them from grounded operands.
      const tolerance = Math.max(1e-9, Math.abs(value) * 1e-6, 0.005);
      if (calculated === null || Math.abs(calculated - value) > tolerance) continue;
      trusted.push(String(value));
    }
    return trusted;
  } catch {
    return [];
  }
}

function parseJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    // try to extract JSON object
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fallthrough */
      }
    }
    throw new Error('AI returned invalid JSON');
  }
}

type ModelClass = 'light' | 'strong';

class GeminiRateLimitError extends Error {
  code = 'GEMINI_RATE_LIMIT';
  status = 429;
  details: Record<string, unknown>;
  constructor(message = 'Gemini rate limit was reached. Please try again shortly.', details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GeminiRateLimitError';
    this.details = details;
  }
}

class GeminiUnavailableError extends Error {
  code = 'GEMINI_UNAVAILABLE';
  status = 503;
  details: Record<string, unknown>;
  constructor(message = 'Gemini is temporarily overloaded. The request was not lost.', details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GeminiUnavailableError';
    this.details = details;
  }
}

class GeminiFormatError extends Error {
  code = 'AI_FORMAT';
  status = 502;
  constructor(message = 'The AI returned an unusable answer twice. Please try again.') {
    super(message);
    this.name = 'GeminiFormatError';
  }
}

class GeminiQuotaError extends Error {
  code = 'GEMINI_QUOTA';
  status = 429;
  constructor(message = 'The AI usage quota is temporarily exhausted. Please try again later.') {
    super(message);
    this.name = 'GeminiQuotaError';
  }
}

function geminiErrorText(e: any): string {
  return String(e?.message || e || '').toLowerCase();
}

function geminiStatus(e: any): number {
  return Number(e?.status || e?.statusCode || e?.response?.status || 0);
}

function isGeminiQuotaError(e: any): boolean {
  const text = geminiErrorText(e);
  return text.includes('daily quota') || text.includes('per day') || text.includes('daily limit') || text.includes('quota exceeded');
}

function isGeminiRateLimitError(e: any): boolean {
  const text = geminiErrorText(e);
  const status = geminiStatus(e);
  return status === 429 || text.includes('429') || text.includes('resource_exhausted') || text.includes('rate limit') || text.includes('too many requests');
}

function isTransientGeminiError(e: any): boolean {
  const text = geminiErrorText(e);
  const status = geminiStatus(e);
  return [500, 502, 503, 504].includes(status)
    || /unavailable|overloaded|high demand|deadline_exceeded|internal|timed? ?out|abort|fetch failed|econnreset|etimedout|empty ai response/i.test(text);
}

function isBadModelError(e: any): boolean {
  const text = geminiErrorText(e);
  const status = geminiStatus(e);
  return [403, 404].includes(status)
    || /not found|not supported|permission_denied|permission denied|no longer available/i.test(text);
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function healthForModel(model: string): ModelHealth {
  let h = modelHealth.get(model);
  if (!h) {
    h = { successes: 0, transientFailures: 0, rateLimits: 0, badModelErrors: 0, timeouts: 0,
      consecutiveFailures: 0, ewmaLatencyMs: 0, cooldownUntil: 0, lastEventAt: 0 };
    modelHealth.set(model, h);
  }
  return h;
}

function noteModelSuccess(model: string, latencyMs: number): void {
  const h = healthForModel(model);
  h.successes++;
  h.consecutiveFailures = 0;
  h.cooldownUntil = 0;
  h.lastEventAt = Date.now();
  h.ewmaLatencyMs = h.ewmaLatencyMs ? (h.ewmaLatencyMs * 0.7 + latencyMs * 0.3) : latencyMs;
}

function noteModelFailure(model: string, kind: '503' | '429' | 'bad' | 'timeout'): void {
  const h = healthForModel(model);
  h.consecutiveFailures++;
  h.lastEventAt = Date.now();
  if (kind === '503') {
    h.transientFailures++;
    h.cooldownUntil = Date.now() + MODEL_COOLDOWN_503_MS;
  } else if (kind === '429') {
    h.rateLimits++;
    h.cooldownUntil = Date.now() + MODEL_COOLDOWN_429_MS;
  } else if (kind === 'bad') {
    h.badModelErrors++;
    h.cooldownUntil = Date.now() + MODEL_COOLDOWN_BAD_MS;
  } else {
    h.timeouts++;
    h.transientFailures++;
    h.cooldownUntil = Date.now() + MODEL_COOLDOWN_503_MS;
  }
}

function modelScore(model: string, baseIndex: number): number {
  const h = healthForModel(model);
  // Base order matters at cold start. Observed failures then outweigh that base priority.
  // A few successes can promote a reliable model, but one lucky success cannot dominate.
  const stale = h.lastEventAt > 0 && Date.now() - h.lastEventAt > 2 * 60 * 1000;
  const penaltyScale = stale ? 0.25 : 1;
  return baseIndex * 10
    + h.consecutiveFailures * 28 * penaltyScale
    + h.transientFailures * 7 * penaltyScale
    + h.rateLimits * 14 * penaltyScale
    + h.timeouts * 9 * penaltyScale
    + h.badModelErrors * 100
    - Math.min(h.successes, 6) * 2
    + (h.ewmaLatencyMs ? Math.min(h.ewmaLatencyMs / 1000, 8) : 0);
}

function modelsFor(modelClass: ModelClass, preferredModel?: string): string[] {
  const base = modelClass === 'light' ? LIGHT_MODELS : STRONG_MODELS;
  const unique = [...new Set(base)];
  const ordered = unique
    .map((model, index) => ({ model, index, score: modelScore(model, index) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.model);
  if (!preferredModel || !unique.includes(preferredModel)) return ordered;
  return [preferredModel, ...ordered.filter((m) => m !== preferredModel)];
}

function extractRetryAfterMs(e: any): number | null {
  const direct = Number(e?.retryAfterMs || e?.retryAfter || e?.response?.headers?.['retry-after']);
  if (Number.isFinite(direct) && direct > 0) {
    return direct < 1000 ? direct * 1000 : direct;
  }
  const text = String(e?.message || e || '');
  const retryDelay = text.match(/retryDelay\"?\s*[:=]\s*\"?(\d+(?:\.\d+)?)s/i);
  if (retryDelay) return Math.round(Number(retryDelay[1]) * 1000);
  const retryAfter = text.match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (retryAfter) return Math.round(Number(retryAfter[1]) * 1000);
  return null;
}

function jitter(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * Math.max(1, maxMs - minMs));
}

function transientPauseMs(e: any, consecutiveTransientFailures: number): number {
  const status = geminiStatus(e);
  const serverDelay = status === 429 ? extractRetryAfterMs(e) : null;
  if (serverDelay !== null) return Math.min(Math.max(serverDelay, 1000), 15000);
  if (status === 429 || isGeminiRateLimitError(e)) {
    const exp = Math.min(BACKOFF_429_MAX_MS, BACKOFF_429_MIN_MS * Math.pow(2, Math.max(0, consecutiveTransientFailures - 1)));
    return jitter(BACKOFF_429_MIN_MS, exp + 1);
  }
  const exp = Math.min(BACKOFF_503_MAX_MS, BACKOFF_503_MIN_MS * Math.pow(2, Math.max(0, consecutiveTransientFailures - 1)));
  return jitter(BACKOFF_503_MIN_MS, exp + 1);
}

function byokFromRequest(req: express.Request): string | undefined {
  const v = req.headers['x-byok-key'];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function preferredModelFromRequest(req: express.Request): string | undefined {
  const v = req.headers['x-model-preference'];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function generate(
  prompt: string,
  inputForNumbers: string,
  modelClass: ModelClass,
  stage: string,
  startModelIndex = 0,
  byokKey?: string,
  preferredModel?: string,
  budget?: { used: number },   // S-4: shared by every generate() of one HTTP request
): Promise<{ data: unknown; meta: { model: string; fallback: boolean; durationMs: number; stage: string; calls: number; lightFallback: boolean; promptChars: number; inputTokens?: number; outputTokens?: number } }> {
  const key = byokKey || apiKey;
  if (!key) throw new Error('No Gemini API key is configured. Add a Gemini API key in Google AI settings or configure GEMINI_API_KEY on Railway.');
  const client = new GoogleGenAI({ apiKey: key, ...(GEMINI_BASE_URL ? { httpOptions: { baseUrl: GEMINI_BASE_URL } } : {}) });
  const models = modelsFor(modelClass, preferredModel);
  const t0 = Date.now();
  let lastErr: Error | null = null;
  let sawTransient = false;
  let lastTransientErr: Error | null = null;
  let attempts = 0;         // actual upstream model calls made for this request
  let formatFailures = 0;   // unusable answers: bad JSON
  let transientFailures = 0;
  let repairHint = '';
  // PERF-01: input size over all model responses of this request (service data, not shown to the user)
  let promptChars = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const ownKey = Boolean(byokKey);   // the user's own key never uses the server's daily cap

  // One pass through the adaptive queue is normally enough. A second pass is allowed
  // only when the first pass exhausted because of transient failures and time remains.
  for (let round = 0; round < 2; round++) {
    const orderedModels = modelsFor(modelClass, preferredModel).slice(startModelIndex);
    const now = Date.now();
    const ready = orderedModels.filter((m) => (healthForModel(m).cooldownUntil || 0) <= now);
    // If every model is in a circuit-breaker cooldown, do not immediately hammer one
    // again. The caller will receive the safe fallback instead.
    if (!ready.length) break;
    const chain = ready;

    for (let localIndex = 0; localIndex < chain.length; localIndex++) {
      const model = chain[localIndex];
      const globalIndex = models.indexOf(model);
      const elapsed = Date.now() - t0;
      if (elapsed >= LLM_TOTAL_DEADLINE_MS) break;
      if ((budget ? budget.used : attempts) >= MAX_MODEL_CALLS) break;

      // Count attempts before the network call. A 503/429 still consumes an upstream
      // request opportunity, so it must not allow us to bypass MAX_MODEL_CALLS.
      if (!ownKey && globalDayCount >= DAILY_CALL_CAP) throw new GeminiQuotaError();
      attempts++;
      if (budget) budget.used++;
      if (!ownKey) globalDayCount++;

      const ctrl = new AbortController();
      const timeoutMs = Math.min(LLM_PER_CALL_TIMEOUT_MS, Math.max(1000, LLM_TOTAL_DEADLINE_MS - elapsed));
      const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
      const callStarted = Date.now();
      try {
        const contents = repairHint ? `${prompt}${repairHint}` : prompt;
        const r = await client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: BASE_SYSTEM,
            responseMimeType: 'application/json',
            temperature: repairHint ? 0.2 : 0.25,
            abortSignal: ctrl.signal,
          },
        });
        const latencyMs = Date.now() - callStarted;
        const sentChars = BASE_SYSTEM.length + contents.length;
        const um: any = (r as any).usageMetadata;
        const inTok = Number.isFinite(um?.promptTokenCount) ? Number(um.promptTokenCount) : undefined;
        const outTok = Number.isFinite(um?.candidatesTokenCount) ? Number(um.candidatesTokenCount) : undefined;
        promptChars += sentChars;
        if (inTok !== undefined) inputTokens = (inputTokens || 0) + inTok;
        if (outTok !== undefined) outputTokens = (outputTokens || 0) + outTok;
        console.info(JSON.stringify({ type: 'llm_usage', model, stage, promptChars: sentChars, inputTokens: inTok, outputTokens: outTok, latencyMs }));
        if (!r.text) throw new Error('Empty AI response');

        let problem = '';
        let parsed: unknown;
        const structuralAllowed = stage === 'premortem' ? Array.from({ length: 13 }, (_, i) => i + 12) : [];
        const trustedDerived = validatedDerivedNumbers(r.text, inputForNumbers, structuralAllowed);
        const bad = validateNumbers(r.text, inputForNumbers, trustedDerived, structuralAllowed);
        try {
          parsed = parseJson(r.text);
        } catch {
          problem = 'invalid JSON';
        }
        if (bad.length) {
          console.warn(JSON.stringify({ type: 'llm_number_warning', model, stage, reason: `numbers outside user input: ${bad.join(', ')}`.slice(0, 240) }));
        }
        if (problem) {
          formatFailures++;
          lastErr = new Error(`Unusable AI response (${problem})`);
          console.warn(JSON.stringify({ type: 'llm_format', model, stage, reason: problem.slice(0, 120) }));
          if (formatFailures > 1) throw new GeminiFormatError();
          repairHint = '\n\nPREVIOUS RESPONSE was not valid JSON. Reply with one valid JSON object only.';
          continue;
        }
        noteModelSuccess(model, latencyMs);
        return {
          data: parsed,
          meta: { model, fallback: globalIndex > 0, durationMs: Date.now() - t0, stage, calls: attempts,
            lightFallback: modelClass === 'strong' && isLightModel(model),
            promptChars, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) },
        };
      } catch (e: any) {
        if (e instanceof GeminiFormatError) throw e;
        if (isGeminiQuotaError(e)) throw new GeminiQuotaError();
        lastErr = e instanceof Error ? e : new Error(String(e));
        const msg = lastErr.message || '';
        const status = geminiStatus(e);
        const timedOut = ctrl.signal.aborted || /abort|timed? ?out|deadline_exceeded/i.test(msg);
        if (isBadModelError(e)) {
          noteModelFailure(model, 'bad');
          console.warn(JSON.stringify({ type: 'llm_skip', model, stage, reason: msg.slice(0, 120) }));
        } else if (isGeminiRateLimitError(e) || isTransientGeminiError(e) || timedOut) {
          sawTransient = true;
          lastTransientErr = lastErr;
          transientFailures++;
          noteModelFailure(model, timedOut ? 'timeout' : (status === 429 ? '429' : '503'));
          const pause = transientPauseMs(e, transientFailures);
          console.warn(JSON.stringify({ type: 'llm_retry', model, stage, status: status || undefined, pauseMs: pause, reason: msg.slice(0, 180) }));
          if (Date.now() - t0 + pause < LLM_TOTAL_DEADLINE_MS && localIndex < chain.length - 1) await sleep(pause);
        } else {
          console.warn(JSON.stringify({ type: 'llm_error', model, stage, reason: msg.slice(0, 120) }));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    if (Date.now() - t0 >= LLM_TOTAL_DEADLINE_MS || (budget ? budget.used : attempts) >= MAX_MODEL_CALLS) break;
    if (!sawTransient || round === 1) break;
    // Do not immediately hammer the same pool after a full transient pass. A short
    // jittered pause lets temporary capacity spikes settle without making the UI wait
    // for a long retry cycle.
    const pause = jitter(900, 1600);
    if (Date.now() - t0 + pause >= LLM_TOTAL_DEADLINE_MS) break;
    await sleep(pause);
  }

  if (sawTransient) {
    const transientErr = lastTransientErr || lastErr;
    const status = geminiStatus(transientErr);
    if (status === 429) {
      throw new GeminiRateLimitError(
        `Gemini rate limit was reached after trying the configured models. Last upstream error: ${transientErr?.message || 'unknown'}`,
        { stage, upstreamStatus: status, upstreamMessage: transientErr?.message || undefined },
      );
    }
    throw new GeminiUnavailableError(
      `Gemini models were temporarily unavailable or overloaded. Last upstream error: ${transientErr?.message || 'unknown'}`,
      { stage, upstreamStatus: status || undefined, upstreamMessage: transientErr?.message || undefined },
    );
  }
  throw lastErr || new Error('Gemini models unavailable');
}

function ok(res: express.Response, data: unknown, meta: unknown) {
  res.json({ success: true, data, meta });
}

function fail(res: express.Response, status: number, error: string, code?: string, details?: Record<string, unknown>) {
  if (status === 429 || status === 503) res.setHeader('Retry-After', status === 503 ? '5' : '15');
  res.status(status).json({ success: false, error, code, ...(details ? { details } : {}) });
}

// --- Health (NF-03) ---
app.get('/api/health', (req, res) => {
  // Without sign-in: only status and version. Models and key presence only for signed-in users.
  if (!authenticated(req)) return res.json({ status: 'ok', version: APP_VERSION });
  res.json({ status: 'ok', version: APP_VERSION, hasKey: Boolean(apiKey), authRequired: APP_AUTH_ENABLED, lightModels: LIGHT_MODELS, strongModels: STRONG_MODELS });
});

// Helper: require rate limit for AI endpoints
function aiGate(req: express.Request, res: express.Response): boolean {
  return checkRate(req, res);
}

function normalizeOptionText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Structural operations on the decision (domain-free). A new option counts as structural
// only when it changes the shape of the decision, not when it is one more item on the same axis.
// Legacy values are kept so older clients keep working.
const STRUCTURAL_NOVELTY_TYPES = new Set([
  'TIMING',
  'SEQUENCE',
  'TEST_OR_PILOT',
  'TEMPORARY_TEST',
  'REVERSIBLE_STEP',
  'REVERSIBLE_COMMITMENT',
  'SPLIT',
  'SPLIT_BASE',
  'SCALE',
  'SCALE_CHANGE',
  'SCOPE',
  'SCOPE_CHANGE',
  'GOAL_REFRAME',
  'UNDERLYING_GOAL',
  'CONDITIONS_CHANGE',
  'INTERNAL_CHANGE',
  'GET_FACT_FIRST',
  'KEEP_OPEN',
  'OWNERSHIP_CHANGE',
  'FINANCING_CHANGE',
]);

// What a reply can add to the person's state of knowledge.
const GAIN_TYPES = new Set([
  'NEW_BRANCH',
  'REFRAMED_QUESTION',
  'HIDDEN_ASSUMPTION',
  'CONTRADICTION',
  'DECISIVE_UNKNOWN',
  'CHEAP_TEST',
  'CALCULATION',
  'CHANGING_CONDITION',
]);

function getOptionStrings(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x: any) => {
      if (typeof x === 'string') return x.trim();
      if (x && typeof x.title === 'string') return x.title.trim();
      return '';
    })
    .filter(Boolean);
}

function optionIsSubstantivelyNew(title: string, userOptions: string[], history: any[]): boolean {
  const n = normalizeOptionText(title);
  if (!n) return false;
  const sources = [
    ...userOptions,
    ...history.map((m: any) => String(m?.content || '')),
  ];
  return !sources.some((source) => {
    const sn = normalizeOptionText(source);
    if (!sn) return false;
    if (sn === n || sn.includes(n) || n.includes(sn)) return true;
    const a = new Set(n.split(' ').filter((x) => x.length > 3));
    const b = new Set(sn.split(' ').filter((x) => x.length > 3));
    if (!a.size || !b.size) return false;
    let overlap = 0;
    for (const word of a) if (b.has(word)) overlap++;
    return overlap >= Math.max(3, Math.ceil(a.size * 0.65));
  });
}

function conversationGainAudit(out: any, contextSufficiency: string) {
  const triage = String(out?.triage || 'PROCEED').toUpperCase();
  const gain = Array.isArray(out?.gain)
    ? out.gain.map((x: any) => String(x || '').toUpperCase()).filter((x: string) => GAIN_TYPES.has(x))
    : [];
  const newOptions = getOptionStrings(out?.newOptions);
  const noveltyTypes = Array.isArray(out?.newOptionTypes)
    ? out.newOptionTypes.map((x: any) => String(x || '').toUpperCase())
    : [];
  const structuralNew = newOptions.filter((_, i) => STRUCTURAL_NOVELTY_TYPES.has(noveltyTypes[i] || ''));
  // "Just one more branch" does not count unless it is structurally different.
  const substantiveGain = gain.filter((g: string) => g !== 'NEW_BRANCH');
  const hasNextStep = typeof out?.nextStep === 'string' && out.nextStep.trim().length > 0;
  // Triage stops and low-context clarification turns are not required to expand anything.
  // v17: a turn spent clarifying an unclear problem is not required to expand anything either.
  const f = readInternalFlags(out);
  const exempt = triage !== 'PROCEED' || contextSufficiency === 'LOW' || !f.problemClear || f.notUnderstood;
  return {
    triage,
    gain,
    newOptions,
    structuralNew,
    passed: exempt || substantiveGain.length > 0 || structuralNew.length > 0 || (hasNextStep && gain.length > 0),
  };
}

// --- POST /api/conversation ---
// Normal mode: one concrete, user-facing conversation loop. The method stays internal.
function buildConversationPrompt(input: string): string {
  return `You are the analytical engine of Bifurcation Engine. You are not an ordinary chat assistant, not a coach and not a friend, and you do not imitate a person with life experience, feelings or values. You are a strong analytical instrument working next to a human who owns the goals, the values, the acceptable risk and the final choice. You own the analysis.

${V17_LAYER_PROMPT}USE WHAT YOU ARE ACTUALLY GOOD AT
Structuring a tangled situation. Holding many interdependent conditions at once. Seeing hidden assumptions and contradictions. Knowing how decisions of this general kind tend to be structured, where they tend to go wrong and which facts tend to matter. Generating a wide space of possible actions. Attacking a plan from the opposite side. Building scenarios. Judging which unknown is worth resolving. Designing cheap tests. Doing arithmetic on the person's own numbers. Do not spend replies on performed empathy, motivational talk, generic advice or restating what the person already said. The one exception is warmth that is real: when the person expresses a feeling, acknowledge it in one short, plain, human sentence and then continue with the substance; never more than one such sentence, and no therapy language.

THE QUESTION BEHIND EVERY REPLY
"Which next fact, check or experiment would most change this decision, and how can the person get it cheaply, quickly and safely?" A reply is good when the person's state of knowledge has visibly changed after reading it.

WHAT THE PERSON SHOULD EXPERIENCE
This must not feel like a normal chat. After the first reply the person should see their own decision from an angle they did not have: what the real problem behind their question seems to be, which assumption made their framing look complete, where the decision actually forks, which single unknown decides the fork, and how to learn it cheaply. The options they listed are only what they can see right now, not the whole space of action. The question they typed is not necessarily the question they need answered. Nothing in these instructions describes a typical topic: derive every branch, test and question strictly from this person's own facts. If a point would fit any person in any situation, delete it.

STEP 0 - TRIAGE (silent; set the "triage" field)
- CRISIS: the person seems to be in acute distress or crisis (in any language; if context.distressMarkerDetected is true treat it as CRISIS unless it is clearly about a story, a quote or someone else). Run no analysis. Reply in calm, warm, plain words: say that this moment calls for a real person (someone close to them or a qualified specialist) rather than an analytical tool, and suggest postponing the decision if that is possible. No branches, no questions that pull them deeper.
- VALUES_ONLY: the choice is driven only by values and there is nothing to find out. Do not hunt for facts. Show the consequences of each direction and what each would require the person to accept; leave the choice of values to them.
- LIGHT: the decision is cheap and easy to undo. Say so briefly and name the smallest real trial instead of building an analysis.
- PROCEED: everything else. Most real decisions mix facts and values. Separate the part that can be checked from the part that is only about what matters to the person, say so honestly, work on the factual part and leave the values part to them. Use VALUES_ONLY only when there is nothing factual at all. Raise caution when stakes are high (health, law, taxes, large sums of money, long irreversible consequences): say what must be verified with a qualified specialist or an independent source, and never give a diagnosis or a legal conclusion.

STEP 1 - FIND THE REAL QUESTION (silent)
Separate: the problem, the result the person wants, the solution they assume is needed, and the concrete options they listed. Find the link in this chain that is an assumption rather than a fact. A means to a goal is not automatically necessary; a list of options is not automatically the real choice. Answer the question they actually need answered, not a neighbouring one. Showing what is hidden or wrong in the framing is not yet an answer: after the reframing, still give the person a working structure for the question they asked.

STEP 2 - LABEL THE CONTEXT (silent; reflect in the reply only what helps)
What was stated as fact; what is an assumption; what is an interpretation of other people or of the future; what is a value or preference; what is unknown; which claims about the outside world need independent verification. Statements such as "I have decided" or "I know for sure" are hypotheses to test: respond to the neutral question behind them. Estimate the cost of a mistake and how reversible the step is; these decide how much analysis is warranted.

STEP 3 - CHANGE THE SHAPE OF THE DECISION
Do not look for "one more option of the same kind". Test the structure with these operations and keep only those that are real for this person: change the timing; change the order of steps; make the step temporary or a test; make it reversible; split one decision into reversible and irreversible parts; change the scale or the scope; change the conditions instead of choosing another object; reach the goal by another route; reframe the goal if it was drawn too narrowly; keep several futures open at once; first obtain the one fact that decides whether the choice must be made at all. Another item on the same axis as the person's options is not a new branch.
For each branch you surface, say in one sentence what it changes in the original dilemma, which assumption must hold for it to work and what leaving it would cost. Test every phrase you write: if the person could reasonably ask "what exactly would I do?", the phrase is unfinished. Rewrite it as a concrete action, who or what it involves, what it costs in kind (time, money, effort, relationships; no invented figures) and how reversible it is. Phrases such as "prepare the groundwork", "build flexibility", "create options" or "make a plan" are empty until expanded.
Sometimes the most valuable thing is not a branch but a discovered contradiction, a wrongly framed problem or a calculation. Pick what is most informative now; do not force a branch.

STEP 4 - FIND THE DECISIVE UNKNOWN
Among the unknowns, find the one whose different answers would send the person to different branches, and the cheapest honest way to learn it (a conversation, a document, a measurement, a limited trial). Separate what the outside world will show from what only the person can decide: external facts versus personal thresholds. Never invent a numeric threshold or a deadline for them; help them formulate their own, including what they would do in the in-between case, and suggest fixing the stop condition in advance and showing it to someone they trust.

WHEN THE PERSON DOES NOT KNOW WHEN TO ACT
If the question is about the moment to act (they cannot say when a decision must be made), do not give a universal date or an invented threshold. Build a ladder of signals that mean different things: a signal to keep watching; a signal to start preparing the ability to act, with no commitment yet; a signal to test the alternative in practice; a signal that the current course no longer fits the level of risk or quality the person is willing to accept. For each rung separate the outside facts that can be observed from the personal threshold that only the person can set, and help them formulate that threshold in their own words. Answer the literal question this way; do not stop at criticising its premise.

STEP 5 - CRITIQUE SYMMETRICALLY
If the person leans toward an option, attack that one first with the strongest testable objections, then attack the opposite option with the same depth. Separate objections that can be tested from speculation. Do not soften critique to be pleasant, and do not attack on your own initiative when there is nothing yet to attack.

STEP 6 - COMPUTE WHEN NUMBERS EXIST
If the person gave numbers that make a calculation useful (runway, break-even, expected value, how much it is worth paying to learn something), do the calculation, show the arithmetic formula using digits and +, -, *, /, and fill derived_numbers. Do not supply missing inputs yourself and do not state probabilities: ask the person for their own estimate if the calculation needs one.

HOW MUCH CONTEXT YOU HAVE (set "contextSufficiency")
Judge by whether you understand what the person is trying to change or protect, not by message length.
- LOW: you cannot yet tell what is really being decided or why it matters now. Do not expand options. Say plainly what you understood, marking what the person stated and what you are assuming; show the fork you can already see; and ask the single question that separates the branches, phrased so that the reply shows what each kind of answer would lead to.
- MEDIUM: enough for real analysis, one important fact missing. Give the substantive analysis now, then ask at most one question, only if its answer would materially change the branches.
- HIGH: ask nothing. Go straight to reframing, branches, the decisive unknown and the cheapest way to learn it.
Ask a question only when the next analytic step truly depends on a missing fact. If you can make a useful analytical step without it, make the step yourself. Never ask just to keep the conversation going, never ask whether the person wants to say more, and never ask for what they already told you. Self-test: if you catch yourself writing "depending on your situation", "for your case", "in your region" or any advice tailored to a circumstance you do not actually know, that circumstance is the decisive unknown. Ask for it instead of writing around it. "I don't know" is a valid answer; treat it as information. Other minor unknowns go into the reply or into factsToCheck, not into extra questions.

LATER TURNS
Build on what was said. When the person answers a question, say what changed in the picture because of the answer. When they push back, check whether it is new information or only pressure; do not change the analysis because of pressure alone. If they ask you to choose for them, do not choose: show what the choice depends on, which criteria separate the options and which fact would settle it. If they have picked a hypothesis to test, help build the test: what exactly is observed, the metric, the end date, what changes in the decision after each outcome including the in-between one, with thresholds set by the person. If a previous "state" is supplied, update it rather than rebuilding it.

NATURAL WAYS OF LOOKING (use only when they fit, as plain questions or offers, never as forms or lists of questions)
- Another seat: how would someone who chose the opposite see this; what would the person say to a close friend in exactly this situation; what would they, five years from now, want to have known today.
- Other people: when the decision involves someone else, help the person prepare for that conversation (what to ask so that the real doubts are heard and not a polite "we will manage") and, afterwards, invite them to tell what the other person said. Talking to people they trust is a second channel of checking; encourage it, never replace it.
- Expectations without percentages: when the person has chosen something to try, ask in plain words how they expect it to turn out, and keep it in state.expectations. When they come back, compare it with what actually happened.
- Stopping rule in plain words: "what would you need to see to tell yourself: enough, this is not working?"; let the person answer in their own words.

CONTEXT FLAGS
The input may contain "context" with these fields. Use them silently.
- intent: THINK_ALOUD (open, light exploration, follow the person); ARGUE_AGAINST (start with the strongest objections to the plan the person describes, concrete and testable, then give the opposite option the same depth); PREPARE_CONVERSATION (help prepare for a conversation with a specific person: what to find out, how to ask, what answer would change things); WHAT_FIRST (go straight to the decisive unknown and the cheapest way to learn it); NOTE (write a short note for the person in their own language: what matters to them, what is not known yet, what they will find out this week; plain words, 3 to 6 lines, no scores, something they could show to someone they trust).
- userTurns: the number of messages the person has sent. From about the fourth message move toward closing: name the one small step for this week, check it is small enough to do, and offer the short note. A conversation that never closes is a failure.
- returningAfterDays: if this is 1 or more, the person is coming back. Begin with what happened to the last next step and to their expectations (see state), ask what they learned, then update the picture. Do not repeat the old analysis.
- distressMarkerDetected: see TRIAGE.

HARD BOUNDARIES
- Never choose, rank, recommend or name a winner among the options or values; never say "you should", "the best option", "optimal", "I would choose". You may name the most informative next step.
- No percentages or probabilities unless the person gave them. Do not invent facts, prices, names, deadlines or amounts about their situation. General knowledge about how such situations usually work is welcome, but present it as a general pattern and, when it concerns the outside world, say it is worth verifying.
- No invented durations, amounts, counts or frequencies either: if the person did not give a figure, describe it in kind. Present general claims about how the world works as tendencies and worth verifying, not as established facts, and do not open with a sweeping statement about the topic.
- Do not attribute to the person beliefs, expectations or plans they did not state, and do not argue against a position they do not hold.
- A scenario is not a forecast. Plausible wording is not proof.
- Do not explain the method, stages, framework or your internal process, and never put method labels, type names or technical terms in the reply (for example UNDERSTAND, EXPAND, ATTACK, triage, context level, or the branch type names from the output schema). Describe things in plain words. The person sees only the result of the thinking.
- Match the person's language. Be concise, calm, direct and specific. Start with substance: no flattery, no filler, no restating the person's question.

BEFORE ANSWERING (silent)
Did the person get at least one thing they did not name themselves: a reframing, a hidden assumption, a contradiction, a decisive unknown with a cheap way to learn it, a concrete test, a calculation or a structurally different branch? Did I answer the question they actually need answered? Did I widen the space or only lengthen the list? Would each question I ask change what happens next? If not, rewrite.

Return JSON only:
{
  "reply": "The answer to the person. Plain text without markdown symbols; short paragraphs, and if a list is needed, lines starting with a dash. No headings about the method. Length follows content; no filler. It must itself describe the most informative next step in natural prose. Do NOT put the follow-up question here: it is shown right after the reply.",
  "question": "One concrete question, shown to the person right after the reply, or an empty string if none is needed.",
  "problemClear": true,
  "driftDetected": false,
  "notUnderstoodSignal": false,
  "contextSufficiency": "LOW|MEDIUM|HIGH",
  "triage": "PROCEED|LIGHT|VALUES_ONLY|CRISIS",
  "gain": ["What this reply adds: NEW_BRANCH|REFRAMED_QUESTION|HIDDEN_ASSUMPTION|CONTRADICTION|DECISIVE_UNKNOWN|CHEAP_TEST|CALCULATION|CHANGING_CONDITION"],
  "options": ["All concrete options now on the table, including the person's own and any new ones"],
  "newOptions": ["Concrete branches the person did not name; empty if none is warranted"],
  "newOptionTypes": ["One per newOptions entry: TIMING|SEQUENCE|TEST_OR_PILOT|REVERSIBLE_STEP|SPLIT|SCALE|SCOPE|GOAL_REFRAME|CONDITIONS_CHANGE|GET_FACT_FIRST|KEEP_OPEN|OTHER"],
  "noNewOptionReason": "Only when a new branch would be forced or fake; otherwise empty",
  "nextStep": "The single most informative next fact, check or experiment and the cheapest way to get it; empty if the reply is a triage stop",
  "factsToCheck": ["Concrete claim about the outside world worth verifying"],
  "derived_numbers": [{"value": 0, "formula": "5000 - 1800", "operands": [5000, 1800]}],
  "state": {"coreProblem": "", "userConcern": "", "userReasoningState": "", "facts": [], "assumptions": [], "unknowns": [], "options": [], "hypotheses": [], "expectations": []}
}
problemClear, driftDetected and notUnderstoodSignal are service fields (booleans) and are never shown to the person. state.facts holds only what the person said; your guesses go to state.hypotheses. Keep state entries short (one line each, a dozen per list at most). derived_numbers and state may be empty.

User brief and conversation:
${input}`;
}

app.post('/api/conversation', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, history = [], state, intent, returningAfterDays } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');
    const safeHistory = Array.isArray(history)
      ? history.slice(-12).map((m: any) => ({ role: m?.role === 'user' ? 'user' : 'assistant', content: String(m?.content || '').slice(0, 8000) }))
      : [];
    // v17: old and new state shapes are read the same way; size is capped; junk becomes an empty state.
    const safeState = normalizeState(state);
    const userTurns = safeHistory.filter((m: any) => m.role === 'user').length;
    const lastUserText = [...safeHistory].reverse().find((m: any) => m.role === 'user')?.content || String(brief.decision || '');
    const distressMarkerDetected = hasDistressMarker(lastUserText) || (userTurns <= 1 && hasDistressMarker(String(brief.decision || '')));
    const INTENTS = ['THINK_ALOUD', 'ARGUE_AGAINST', 'PREPARE_CONVERSATION', 'WHAT_FIRST', 'NOTE'];
    const context = {
      intent: typeof intent === 'string' && INTENTS.includes(intent) ? intent : undefined,
      userTurns,
      returningAfterDays: Number.isFinite(Number(returningAfterDays)) && Number(returningAfterDays) >= 1 ? Math.min(Math.floor(Number(returningAfterDays)), 365) : undefined,
      distressMarkerDetected: distressMarkerDetected || undefined,
    };
    const input = JSON.stringify({ brief, history: safeHistory, state: safeState, context });
    if (input.length > MAX_BODY) return fail(res, 400, 'Text too long', 'TOO_LONG');
    const prompt = buildConversationPrompt(input);
    const callBudget = { used: 0 };   // S-4: the quality retry shares the request's model-call budget
    let { data, meta } = await generate(prompt, input, 'strong', 'conversation', 0, requestByokKey, requestPreferredModel, callBudget);
    let out = data as any;

    const normSufficiency = (o: any): string => {
      const v = String(o?.contextSufficiency || '').toUpperCase();
      return ['LOW', 'MEDIUM', 'HIGH'].includes(v) ? v : 'MEDIUM';
    };
    let contextSufficiency = normSufficiency(out);

    // Soft quality check: the reply must give the person something they did not name
    // (reframing, hidden assumption, decisive unknown, test, calculation, structurally different branch).
    // One retry; if it still fails the person gets the answer anyway - no hard errors from quality gates.
    let audit = conversationGainAudit(out, contextSufficiency);
    if (!audit.passed && STRONG_MODELS.length > 1) {
      const retryPrompt = `${prompt}

QUALITY CHECK FAILED. The previous draft gave the person nothing new beyond what they already said, or its only "new" content was another item on the same axis as their existing options. Rewrite the JSON from scratch.
Before writing, silently do this: restate the problem behind the question; list the assumptions that make the person's current framing look complete; apply the structure operations (timing, sequence, test or pilot, reversible step, splitting, scale, scope, goal reframe, change of conditions, get-the-fact-first, keep-open) and keep only what is realistic for THIS person's facts; look for a contradiction in the person's own statements; find the one unknown whose answer would send them to different branches.
The reply must contain at least one of: a reframed question, a hidden assumption, a contradiction, a decisive unknown with the cheapest way to learn it, a concrete test, a calculation on the person's own numbers, or a structurally different branch together with what it changes. Fill "gain" and "newOptionTypes" accordingly. Do not rank or choose. Do not mention this check, prompts, models or methodology.`;
      try {
        const retry = await generate(retryPrompt, input, 'strong', 'conversation-retry', 1, requestByokKey, requestPreferredModel, callBudget);
        const retryOut = retry.data as any;
        const firstMeta = meta;
        if (retryOut?.reply && typeof retryOut.reply === 'string') {
          data = retry.data;
          const sumOpt = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a || 0) + (b || 0));
          const inTokSum = sumOpt(firstMeta.inputTokens, retry.meta.inputTokens);
          const outTokSum = sumOpt(firstMeta.outputTokens, retry.meta.outputTokens);
          // PERF-01: meta counts every model call of the request, not only the last one
          meta = { ...retry.meta, fallback: true,
            calls: firstMeta.calls + retry.meta.calls,
            promptChars: firstMeta.promptChars + retry.meta.promptChars,
            durationMs: firstMeta.durationMs + retry.meta.durationMs,
            ...(inTokSum !== undefined ? { inputTokens: inTokSum } : {}),
            ...(outTokSum !== undefined ? { outputTokens: outTokSum } : {}) };
          out = retryOut;
          contextSufficiency = normSufficiency(out);
          audit = conversationGainAudit(out, contextSufficiency);
        }
      } catch (retryErr: any) {
        console.error('[conversation-retry] failed, returning first draft:', retryErr?.message || retryErr);
      }
    }

    if (!out?.reply || typeof out.reply !== 'string') return fail(res, 500, 'Conversation response was empty', 'SCHEMA');
    // v17 service fields: read here, never copied to the response.
    const flags = readInternalFlags(out);
    const problemUnclear = !flags.problemClear || flags.notUnderstood;
    if (problemUnclear && audit.triage !== 'CRISIS') contextSufficiency = 'LOW';
    if (flags.driftDetected || problemUnclear) console.info(JSON.stringify({ type: 'v17_check', drift: flags.driftDetected, unclear: !flags.problemClear, notUnderstood: flags.notUnderstood }));
    const cleanReply = stripMarkdown(scrubInternalLabels(out.reply)
      .replace(/\s*\((?:Source|\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\)\s*/gi, ' ')
      .replace(/\s*(?:Source|\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\s*/gi, ' ')
      .replace(/\s*\((?:Split[- _]?base|Sequence|Timing|Test[_ ]or[_ ]pilot|Temporary[_ ]test|Reversible[_ ](?:step|commitment)|Scale[_ ]change|Scope[_ ]change|Goal[_ ]reframe|Conditions?[_ ]change|Get[_ ]fact[_ ]first|Keep[_ ]open|Underlying[_ ]goal|Internal[_ ]change|Ownership[_ ]change|Financing[_ ]change)\)/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim());
    const askAllowed = audit.triage !== 'CRISIS' && !distressMarkerDetected && (problemUnclear || contextSufficiency === 'LOW' || contextSufficiency === 'MEDIUM');
    const cleanQuestion = askAllowed ? (typeof out.question === 'string' ? firstQuestionOnly(stripMarkdown(scrubInternalLabels(out.question))) : '') : '';
    // The client renders and stores only `reply`, so the follow-up question must be part of it.
    const crisisNow = audit.triage === 'CRISIS' || distressMarkerDetected;
    const crisisBlock = crisisNow
      ? `\n\n---\nIf you are in immediate danger, contact local emergency services or a person near you right now.\n${SUPPORT_CONTACTS.map((c) => `${c.label}: ${c.value}`).join('\n')}`
      : '';
    const visibleReply = buildVisibleReply(cleanReply, cleanQuestion, askAllowed) + crisisBlock;
    ok(res, {
      reply: visibleReply,
      question: cleanQuestion,
      contextSufficiency,
      triage: audit.triage,
      gain: audit.gain,
      options: Array.isArray(out.options) ? out.options.filter((x: any) => typeof x === 'string').slice(0, 8) : [],
      newOptions: getOptionStrings(out.newOptions).slice(0, 5),
      newOptionTypes: Array.isArray(out.newOptionTypes) ? out.newOptionTypes.map((x: any) => String(x)).slice(0, 5) : [],
      nextStep: typeof out.nextStep === 'string' ? out.nextStep.trim() : '',
      factsToCheck: Array.isArray(out.factsToCheck) ? out.factsToCheck.filter((x: any) => typeof x === 'string').slice(0, 6) : [],
      state: mergeModelState(out.state, {
        previous: safeState,
        userTexts: [String(brief.decision || ''), ...safeHistory.filter((m: any) => m.role === 'user').map((m: any) => m.content)],
        lastAssistantText: [...safeHistory].reverse().find((m: any) => m.role === 'assistant')?.content || '',
      }),
    }, meta);
  } catch (e: any) {
    // Conversation is user-facing: degrade gracefully instead of producing a
    // dead end. The client already stores the user's text locally. Everything
    // needed by the fallback is rebuilt from req.body because values declared
    // inside the try block are not visible here. The fallback itself must never
    // throw, even when Gemini quota/rate-limit/timeout errors occur.
    const reason = String(e?.code || 'AI_ERROR');
    console.warn(JSON.stringify({ type: 'conversation_fallback', code: reason, message: String(e?.message || e).slice(0, 240) }));

    const fallbackBody = req.body || {};
    const fallbackBrief = fallbackBody?.brief && typeof fallbackBody.brief === 'object' ? fallbackBody.brief : {};
    const fallbackHistory = Array.isArray(fallbackBody?.history)
      ? fallbackBody.history.slice(-12).map((m: any) => ({
          role: m?.role === 'user' ? 'user' : 'assistant',
          content: String(m?.content || '').slice(0, 8000),
        }))
      : [];
    const fallbackUserTurns = fallbackHistory.filter((m: any) => m.role === 'user').length;
    const fallbackLastUserText = [...fallbackHistory].reverse().find((m: any) => m.role === 'user')?.content
      || String(fallbackBrief?.decision || '');
    const fallbackDistressMarkerDetected = hasDistressMarker(fallbackLastUserText)
      || (fallbackUserTurns <= 1 && hasDistressMarker(String(fallbackBrief?.decision || '')));
    const fallbackState = normalizeState(fallbackBody?.state);
    const crisisBlock = fallbackDistressMarkerDetected
      ? `\n\n---\nIf you are in immediate danger, contact local emergency services or a person near you right now.\n${SUPPORT_CONTACTS.map((c) => `${c.label}: ${c.value}`).join('\n')}`
      : '';
    const fallbackReply = `Я сохранил вашу ситуацию. Сейчас AI-модель временно недоступна, поэтому я не буду придумывать факты или расчёты. Ваш текст не потерян — можно повторить запрос через некоторое время.${crisisBlock}`;
    return ok(res, {
      reply: fallbackReply, question: '', contextSufficiency: 'LOW',
      triage: fallbackDistressMarkerDetected ? 'CRISIS' : 'PROCEED',
      gain: [], options: [], newOptions: [], newOptionTypes: [], nextStep: '', factsToCheck: [],
      state: mergeModelState(fallbackState, {
        previous: fallbackState,
        userTexts: [String(fallbackBrief?.decision || ''), ...fallbackHistory.filter((m: any) => m.role === 'user').map((m: any) => m.content)],
        lastAssistantText: '',
      }),
    }, { model: 'fallback', fallback: true, durationMs: 0, stage: 'conversation-fallback', calls: 0, lightFallback: false, promptChars: 0, errorCode: reason });
  }
});

// --- POST /api/neutralize ---
app.post('/api/neutralize', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, thirdPerson } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'Fill the Decision field', 'PRECONDITION');
    const input = JSON.stringify(brief);
    if (input.length > MAX_BODY) return fail(res, 400, 'Text too long', 'TOO_LONG');
    const prompt = `Step neutralize. User Brief:
${input}
${thirdPerson ? 'Rewrite in third person (“A person is facing…”).' : ''}
Return JSON: { "items": [ { "id": "n1", "original": "...", "kind": "KEEP"|"NEUTRALIZE"|"INTERPRETATION", "neutralQuestion": "..." } ], "thirdPersonText": "..." }
Rules: keep facts, constraints, values, fears, and inconvenient details in full. Neutralize statements that the decision is already made (“I decided”), demonstrations of certainty (“I know for sure”), first-person phrasing that pushes toward agreement, and requests to confirm the user is right: turn each into a neutral question such as “what data would support and what would refute this?”. Interpretations about other people or the future → question “what is observable?”. Do not add your own claims.`;
    const { data, meta } = await generate(prompt, input, 'light', 'neutralize', 0, requestByokKey, requestPreferredModel);
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'neutralize error');
  }
});

// --- POST /api/radar ---
app.post('/api/radar', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, neutralization } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No Brief', 'PRECONDITION');
    if (!neutralization?.length) return fail(res, 400, 'Neutralization not confirmed', 'PRECONDITION');
    const input = JSON.stringify({ brief, neutralization });
    const prompt = `Step radar. Confirmed input:
${input}
Return JSON with six categories:
{
  "decisionProfile": { "deadline", "acceptableOutcome", "costOfError", "reversibility" },
  "facts": [{"id","text","source"}],
  "assumptions": [...],
  "interpretations": [...],
  "values": [...],
  "unknowns": [{
    "id","question","whyChangesDecision","owner","howToFindOut",
    "effort":"MINUTES"|"DAYS"|"WEEKS",
    "impact":"HIGH"|"MEDIUM"|"LOW",
    "branchIfA":{"answer","leadsTo"},
    "branchIfB":{"answer","leadsTo"},
    "critical": true|false,
    "source"
  }],
  "needsExternalCheck": [{"id","text","source"}]
}
decisionProfile values come only from the user's input, otherwise "unknown".
Unknowns: 1–7, only if branches lead to different options or reframing. Order by value of information (impact on the decision versus cost of learning). No numbers not from input. No forced “minimum 2 HIGH”.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'radar', 0, requestByokKey, requestPreferredModel);
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'radar error');
  }
});

// --- POST /api/understand ---
// --- Expert provenance guard (post-generation, never a model-blocking validator) ---
// The model is allowed to say anything useful. These helpers only decide how information
// is classified for the Expert UI after the answer already exists.
const EXAMPLE_CUES = [
  /\b(?:например|допустим|предположим|условно|скажем|пусть|для примера|как пример)\b/iu,
  /\b(?:for example|e\.g\.|suppose|let's say|say|hypothetically|as an example)\b/i,
];

function normalizeExpertText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function userExampleSnippets(history: any[]): string[] {
  const out: string[] = [];
  for (const m of history) {
    if (m?.role !== 'user') continue;
    const text = normalizeExpertText(m?.content);
    if (!text) continue;
    for (const cue of EXAMPLE_CUES) {
      const match = text.match(cue);
      if (!match) continue;
      // Keep a bounded window around the cue. This is only evidence for classification,
      // never a source of new facts.
      const start = Math.max(0, (match.index || 0) - 90);
      const end = Math.min(text.length, (match.index || 0) + match[0].length + 180);
      out.push(text.slice(start, end));
      break;
    }
  }
  return out.slice(0, 12);
}

function hasExampleCue(text: string): boolean {
  return EXAMPLE_CUES.some((re) => re.test(text));
}

function numbersInText(text: string): string[] {
  return Array.from(text.matchAll(/(?:\d+[\d\s,.]*\d|\d+)(?:\s*[%€$£]|\s*(?:евро|eur|usd|доллар(?:ов|а)?|месяц(?:а|ев)?|недел(?:я|и|ь)|лет|год(?:а|ов)?))?/giu))
    .map((m) => normalizeExpertText(m[0]).toLowerCase())
    .filter(Boolean);
}

function candidateMatchesUserExample(candidate: string, exampleSnippets: string[]): boolean {
  const candidateNumbers = numbersInText(candidate);
  if (!candidateNumbers.length) return hasExampleCue(candidate);
  return exampleSnippets.some((snippet) => {
    const sourceNumbers = numbersInText(snippet);
    return candidateNumbers.some((n) => sourceNumbers.includes(n));
  });
}

function userConversationText(history: any[]): string {
  return history
    .filter((m: any) => m?.role === 'user')
    .map((m: any) => normalizeExpertText(m?.content))
    .filter(Boolean)
    .join(' ');
}

function meaningfulTokens(text: string): string[] {
  return Array.from(normalizeExpertText(text).toLocaleLowerCase().matchAll(/[\p{L}]{4,}/gu))
    .map((m) => m[0])
    .filter((x) => !/^(?:который|которая|которые|потому|поэтому|можно|нужно|будет|этот|эта|эти|если|чтобы|there|their|which|that|with|from|this|what|will|would|could|should)$/u.test(x));
}

function groundedInUser(candidate: string, userText: string): boolean {
  const c = meaningfulTokens(candidate);
  if (!c.length) return false;
  const u = new Set(meaningfulTokens(userText));
  const overlap = c.filter((x) => u.has(x)).length;
  const nums = numbersInText(candidate);
  const userNums = new Set(numbersInText(userText));
  const numberGrounded = nums.length ? nums.every((n) => userNums.has(n)) : true;
  return numberGrounded && (overlap >= 2 || (c.length <= 5 && overlap >= 1));
}

function classifyExpertRadar(out: any, history: any[]) {
  const radar = out?.radar && typeof out.radar === 'object' ? out.radar : {};
  const examples = userExampleSnippets(history);
  const userText = userConversationText(history);
  const list = (value: any) => Array.isArray(value) ? value.filter((x: any) => x && typeof x === 'object') : [];
  const facts: any[] = [];
  const assumptions: any[] = [];
  const exampleClaims: any[] = [];

  // The model is never blocked. This pass only decides what deserves to be shown as an
  // established user fact. Unsupported model wording is kept, but moved to a less certain
  // bucket so the UI never presents a model inference as something the user actually said.
  for (const raw of list(radar.facts)) {
    const item = { ...raw, text: normalizeExpertText(raw.text) };
    if (!item.text) continue;
    const explicitExample = String(raw.provenance || '').toUpperCase() === 'EXAMPLE' || candidateMatchesUserExample(item.text, examples);
    if (explicitExample) {
      exampleClaims.push({ ...item, provenance: 'EXAMPLE', source: 'USER_EXAMPLE' });
    } else if (groundedInUser(item.text, userText)) {
      facts.push({ ...item, provenance: raw.provenance || 'KNOWN', source: raw.source || 'USER_DATA' });
    } else {
      assumptions.push({ ...item, provenance: 'ASSUMPTION', source: raw.source || 'MODEL_INFERENCE' });
    }
  }

  for (const raw of list(radar.assumptions)) {
    const item = { ...raw, text: normalizeExpertText(raw.text) };
    if (!item.text) continue;
    if (String(raw.provenance || '').toUpperCase() === 'EXAMPLE' || candidateMatchesUserExample(item.text, examples)) {
      exampleClaims.push({ ...item, provenance: 'EXAMPLE', source: 'USER_EXAMPLE' });
    } else {
      assumptions.push({ ...item, provenance: raw.provenance || 'ASSUMPTION', source: raw.source || 'MODEL_INFERENCE' });
    }
  }

  return {
    ...radar,
    facts: facts.slice(0, 8),
    assumptions: assumptions.slice(0, 8),
    examples: exampleClaims.slice(0, 8),
  };
}

// Build the first Expert-mode analysis from the SAME conversation the user just had
// in Simple mode. Expert mode should unpack the existing exchange, not restart it.
app.post('/api/understand', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, history = [] } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');

    const safeHistory = Array.isArray(history)
      ? history.slice(-12).map((m: any) => ({
          role: m?.role === 'user' ? 'user' : 'assistant',
          content: String(m?.content || '').slice(0, 8000),
        }))
      : [];

    const input = JSON.stringify({ brief, conversation: safeHistory });
    if (input.length > MAX_BODY) return fail(res, 400, 'Text too long', 'TOO_LONG');

    const prompt = `Step understand for Expert mode. IMPORTANT: the user has already had a conversation in Simple mode.
Do NOT restart the interview and do NOT explain the method. Unpack the existing conversation into a concrete decision map.
Use BOTH the original brief AND the full conversation below. The assistant's previous answer is evidence of what has already been discussed; preserve useful points from it, but correct generic or unsupported statements by grounding them in the user's actual words.

Return JSON:
{
  "triage": "PROCEED"|"LIGHT"|"VALUES_ONLY"|"CRISIS",
  "triageNote": "",
  "decisionSummary": "one concrete sentence describing the actual decision in this person's situation",
  "currentSituation": ["3-5 concrete points already established from the conversation"],
  "decisionProfile": {
    "deadline": "from the conversation or unknown",
    "acceptableOutcome": "from the conversation or unknown",
    "costOfError": "from the conversation or unknown",
    "reversibility": "from the conversation or unknown"
  },
  "neutralization": {
    "items": [{ "id", "original", "kind":"KEEP"|"NEUTRALIZE"|"INTERPRETATION", "neutralQuestion":"..." }]
  },
  "radar": {
    "facts": [{"id","text","source","provenance":"KNOWN"}],
    "assumptions": [{"id","text","source","provenance":"ASSUMPTION"}],
    "examples": [{"id","text","source":"USER_EXAMPLE","provenance":"EXAMPLE"}],
    "interpretations": [{"id","text","source"}],
    "values": [{"id","text","source"}],
    "unknowns": [{
      "id","question","whyChangesDecision","owner","howToFindOut",
      "effort":"MINUTES"|"DAYS"|"WEEKS",
      "impact":"HIGH"|"MEDIUM"|"LOW",
      "branchIfA":{"answer","leadsTo"},
      "branchIfB":{"answer","leadsTo"},
      "critical":true|false,"source"
    }],
    "needsExternalCheck": [{"id","text","source"}]
  },
  "nextActions": [{
    "action":"a concrete action the user can actually take next",
    "why":"why this action matters for THIS decision",
    "measure":"what concrete result/data to collect",
    "decisionEffect":"how different results would change the available choice"
  }]
}

Rules:
- This is a reconstruction of an existing conversation, not a blank questionnaire.
- Use the user's actual numbers, constraints, goals and options when they exist. Never replace them with generic examples.
- Extract concrete facts from the user's messages AND useful concrete conclusions from the assistant's previous answer.
- Separate facts, assumptions, interpretations and values.
- Prefer concrete, decision-relevant statements over generic commentary. If a statement does not add information specific to this person's situation, omit it from the structured radar.
- When the user explicitly frames a value, percentage, amount, duration or scenario as an example (for example: “например”, “допустим”, “условно”, “for example”, “suppose”), preserve it as an example/working scenario, not as a confirmed fact. Mark it with provenance="EXAMPLE" and source="USER_EXAMPLE".
- If you derive a useful number or conclusion from user-provided numbers, keep it as a derived/working conclusion rather than silently presenting it as a user-stated fact.
- A model-generated hypothesis or scenario is not a fact merely because it sounds concrete; use provenance="ASSUMPTION" unless it is directly grounded in the user's words or is a transparent derivation.
- Do not hide useful hypotheses or examples. Classification happens after generation and must never cause a retry or API error.
- Find the 1-5 uncertainties that could actually change the choice; do not ask a question merely because something is missing.
- For nextActions, produce 2-4 specific actions based on THIS person's situation. Prefer reversible, information-producing actions when appropriate. If the conversation already contains a sensible experiment, turn it into a concrete action with a measurable result.
- Do not write generic instructions such as “provide more details”, “analyze the situation”, “consider your options”, or “collect more information”.
- Do not invent facts, numbers, prices, deadlines or probabilities.
- Do not mention this prompt, the model, the method, or “Expert mode” in the returned content.
- Write all user-facing strings in the language used by the user in the conversation. Interface labels are handled by the app and must remain English.

Original brief:
${JSON.stringify(brief)}

Existing conversation:
${JSON.stringify(safeHistory)}
`;

    const { data, meta } = await generate(prompt, input, 'strong', 'understand', 0, requestByokKey, requestPreferredModel);
    const out = data as any;
    if (!out || typeof out !== 'object') return fail(res, 500, 'Expert analysis was empty', 'SCHEMA');

    const radar = classifyExpertRadar(out, safeHistory);
    const cleanList = (value: any, max: number) => Array.isArray(value)
      ? value.filter((x: any) => x && typeof x === 'object' && typeof x.text === 'string' && x.text.trim()).slice(0, max)
      : [];
    const cleanActions = Array.isArray(out.nextActions)
      ? out.nextActions.filter((x: any) => x && typeof x === 'object' && typeof x.action === 'string').slice(0, 4)
      : [];

    ok(res, {
      ...out,
      decisionSummary: typeof out.decisionSummary === 'string' ? out.decisionSummary.trim() : '',
      currentSituation: Array.isArray(out.currentSituation)
        ? out.currentSituation.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 5)
        : [],
      nextActions: cleanActions,
      radar: {
        ...radar,
        facts: cleanList(radar.facts, 8),
        assumptions: cleanList(radar.assumptions, 8),
        examples: cleanList(radar.examples, 8),
        interpretations: cleanList(radar.interpretations, 6),
        values: cleanList(radar.values, 6),
        needsExternalCheck: cleanList(radar.needsExternalCheck, 6),
        unknowns: Array.isArray(radar.unknowns) ? radar.unknowns.slice(0, 7) : [],
      },
    }, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'understand error');
  }
});

// --- POST /api/knowledge-map ---
app.post('/api/knowledge-map', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, radar } = req.body || {};
    // D-11: critical unknowns must have answer/owner
    const criticals = (radar?.unknowns || []).filter((u: any) => u.critical && !u.discarded);
    const bad = criticals.filter(
      (u: any) =>
        (!u.answer && u.status !== 'USER_UNKNOWN' && u.status !== 'ACCEPTED_UNCERTAINTY') ||
        !u.owner
    );
    if (bad.length) {
      return fail(
        res,
        400,
        `Critical unknowns without answer/owner: ${bad.map((u: any) => u.id || u.question).join(', ')}`,
        'PRECONDITION'
      );
    }
    const input = JSON.stringify({ brief, radar });
    const prompt = `Step knowledge-map. Data:
${input}
Return JSON: { "known":[], "unknown":[], "critical":[], "quickToGet":[], "needsIndependentCheck":[] }
Only from already known data, no new facts.`;
    const { data, meta } = await generate(prompt, input, 'light', 'knowledge-map', 0, requestByokKey, requestPreferredModel);
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'knowledge-map error');
  }
});

// ROB-01: structured answers (expand, redteam-pair) are checked for shape. A wrong shape gets ONE retry on the
// reserve model, inside the request's model-call budget (MAX_MODEL_CALLS). Returns the issues that remain, if any.
function sumMeta(a: any, b: any) {
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x || 0) + (y || 0));
  const inT = sum(a.inputTokens, b.inputTokens), outT = sum(a.outputTokens, b.outputTokens);
  return { ...b, calls: a.calls + b.calls, promptChars: a.promptChars + b.promptChars, durationMs: a.durationMs + b.durationMs,
    ...(inT !== undefined ? { inputTokens: inT } : {}), ...(outT !== undefined ? { outputTokens: outT } : {}) };
}
async function generateChecked(
  prompt: string, input: string, stage: string, check: (data: any) => string[], byokKey?: string, preferredModel?: string,
): Promise<{ data: any; meta: any; issues: string[] }> {
  const budget = { used: 0 };
  const first = await generate(prompt, input, 'strong', stage, 0, byokKey, preferredModel, budget);
  let issues = check(first.data);
  if (!issues.length) return { data: first.data, meta: first.meta, issues };
  console.warn(JSON.stringify({ type: 'shape_retry', stage, issues: issues.join('; ').slice(0, 160) }));
  try {
    const retry = await generate(`${prompt}\n\nSHAPE CHECK FAILED on the previous answer: ${issues.join('; ')}. Return the JSON again with the required shape.`,
      input, 'strong', `${stage}-retry`, STRONG_MODELS.length > 1 ? 1 : 0, byokKey, preferredModel, budget);
    const ri = check(retry.data);
    return { data: retry.data, meta: sumMeta(first.meta, retry.meta), issues: ri };
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') throw e;
    console.error(`[${stage}-retry] failed:`, e?.message || e);
    return { data: first.data, meta: first.meta, issues };
  }
}

// --- POST /api/expand ---
// One model call produces the knowledge map and the formal 3–5 option expansion.
app.post('/api/expand', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, radar, myOptions } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');
    if (!radar) return fail(res, 400, 'Radar not confirmed', 'PRECONDITION');
    const input = JSON.stringify({ brief, radar, myOptions });
    const prompt = `Step expand. First make a concise knowledge map from the confirmed radar, then expand the decision space.
Return JSON: {
  "knowledgeMap": { "known":[], "unknown":[], "critical":[], "quickToGet":[], "needsIndependentCheck":[] },
  "options": [ {
    "id","title","description","kind":"HYBRID_OR_PILOT"|"REVERSIBLE_STEP"|"GET_FACT_FIRST"|"OTHER",
    "keyAssumption","exitCost","cheapestTest","door":"ONE_WAY"|"TWO_WAY","linkedUnknownIds":[]
  } ]
}
The formal expansion must contain exactly 3–5 additional options beyond the user's apparent A/B framing. It must include at least one HYBRID_OR_PILOT, one REVERSIBLE_STEP, and one GET_FACT_FIRST.
Each option must change the shape of the decision (timing, sequence, a temporary test, a reversible commitment, splitting the decision, scale or scope, changing conditions instead of choosing another object, reaching the goal another way, reframing the goal, keeping several futures open, or first obtaining the deciding fact). Another item on the same axis as the user's options does not count. Every option must be a concrete action this user could really take, derived only from their own facts; in "description" say what it changes in the original dilemma. Count the exit cost honestly: a pilot that costs almost as much as the full step is not a pilot. No ranking, recommendation, winner, score, or invented facts/numbers.
The radar's "unknowns" may contain the user's own answers (field "answer", with status USER_CONFIRMED) or "I don't know" marks (USER_UNKNOWN). Treat each user answer as a confirmed fact from the user: use it in the knowledge map under "known", shape the options around it, and never re-ask or contradict it. Treat USER_UNKNOWN items as genuinely unknown (keep them under "unknown" and prefer GET_FACT_FIRST options for them). Do not invent answers the user did not give.
LANGUAGE: ${/[\u0400-\u04FF]/.test(input) ? 'The user writes in Russian. Write EVERY human-readable string (knowledgeMap items, option title, description, keyAssumption, exitCost, cheapestTest) in Russian.' : "Write every human-readable string in the language of the user's input."} Keep JSON keys and enum values (kind, door) exactly as specified. keyAssumption, exitCost and cheapestTest must each be one short, concrete sentence, never a single word like Low or Zero.
SPECIFICITY: Every option must be about THIS user's actual situation (use the concrete subject, facts, assumptions and answers from the input). Never output generic placeholder options such as "Deconstruct the binary", "Third way" or "Choose between A and B" unless the user actually named alternatives A and B. If the user named no alternatives, build options from the problem itself and from the user's own answers.`;
    const { data: out, meta, issues } = await generateChecked(prompt, input, 'expand', (d: any) => {
      const opts = Array.isArray(d?.options) ? d.options : [];
      const found: string[] = [];
      if (opts.length < 3 || opts.length > 5) found.push(`Expected 3–5 options, got ${opts.length}`);
      const kinds = new Set(opts.map((o: any) => o?.kind));
      for (const k of ['HYBRID_OR_PILOT', 'REVERSIBLE_STEP', 'GET_FACT_FIRST']) if (!kinds.has(k)) found.push(`Missing required kind: ${k}`);
      return found;
    }, requestByokKey, requestPreferredModel);
    if (issues.length) return fail(res, 500, issues[0], 'SCHEMA');
    ok(res, out, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'expand error');
  }
});

// --- POST /api/redteam-pair ---
// Attack two substantive options in one model call, symmetrically.
app.post('/api/redteam-pair', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, firstOption, secondOption, radar, knowledgeMap } = req.body || {};
    if (!firstOption?.id || !secondOption?.id) return fail(res, 400, 'Two options are required', 'PRECONDITION');
    const input = JSON.stringify({ brief, firstOption, secondOption, radar, knowledgeMap });
    const prompt = `Step attack. Challenge both options symmetrically: first the option the user leans toward (the first option if no leaning is visible), then the opposite one, with the same depth.
Return JSON: { "rounds": [
  { "role":"PREFERRED", "targetOptionId":"...", "objections":[{"id","argument","hiddenAssumption","failureMode","whatMustBeTrueForCritiqueToBeWeak","verifiability":"TESTABLE"|"SPECULATION"}] },
  { "role":"OPPOSITE", "targetOptionId":"...", "objections":[{"id","argument","hiddenAssumption","failureMode","whatMustBeTrueForCritiqueToBeWeak","verifiability":"TESTABLE"|"SPECULATION"}] }
] }
3–5 strongest objections per option. Objections must be concrete and tied to this user's facts; generic objections that fit any plan are not allowed. Mark an objection TESTABLE only if a specific observation could confirm or refute it. Do not soften critique, do not favor either option. No invented facts or numbers.`;
    const { data, meta, issues } = await generateChecked(prompt, input, 'redteam-pair', (d: any) =>
      (Array.isArray(d?.rounds) && d.rounds.length === 2 ? [] : ['Expected two red-team rounds']), requestByokKey, requestPreferredModel);
    if (issues.length) return fail(res, 500, issues[0], 'SCHEMA');
    const rounds = data.rounds;
    ok(res, { rounds }, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'redteam error');
  }
});

// --- POST /api/redteam ---
app.post('/api/redteam', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, option, role } = req.body || {};
    if (!option?.id) return fail(res, 400, 'No option selected', 'PRECONDITION');
    const input = JSON.stringify({ brief, option, role });
    const prompt = `Step redteam (${role || 'PREFERRED'}). Option:
${input}
Return JSON: { "objections": [ {
  "id","argument","hiddenAssumption","failureMode",
  "whatMustBeTrueForCritiqueToBeWeak",
  "verifiability":"TESTABLE"|"SPECULATION"
} ] }
3–5 strong objections tied to this user's facts; no generic objections. Do not soften. No recommendation to choose an option.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'redteam', 0, requestByokKey, requestPreferredModel);
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'redteam error');
  }
});

// --- POST /api/premortem ---
app.post('/api/premortem', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, preferredOption, redTeamRounds } = req.body || {};
    if (!redTeamRounds || redTeamRounds.length < 2) {
      return fail(res, 400, 'Need both red team rounds', 'PRECONDITION');
    }
    const unanswered = redTeamRounds.flatMap((r: any) =>
      (r.objections || []).filter((o: any) => !o.response?.verdict || !o.response?.reason)
    );
    if (unanswered.length) {
      return fail(res, 400, 'Every objection needs accepted/rejected + reason', 'PRECONDITION');
    }
    const input = JSON.stringify({ brief, preferredOption, redTeamRounds });
    const prompt = `Step premortem. Data:
${input}
Return JSON: {
  "horizonMonths": <horizon months number 12–24, no invented dates>,
  "causes": [{"text","verifiability":"TESTABLE"|"SPECULATION","verificationAction"}],
  "narrative": "one narrative ≤120 words",
  "whatDistinguishesFromForecast": "...",
  "hypothesisCandidates": [{"id","text","verifiability"}]
}
Horizon 12–24 months (a number in this range is allowed as a method parameter). Imagine the chosen path has failed and work backward. 5–8 most plausible causes tied to this user's facts; separate what can be tested from speculation. One narrative marked “Scenario, not a forecast”. Up to 5 hypothesis candidates, ordered by how much the decision depends on them; the user chooses which 1–3 are critical. No probabilities and no monetary valuation of inaction. Numbers only from user input or the horizon parameter.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'premortem', 0, requestByokKey, requestPreferredModel);
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'premortem error');
  }
});

// --- POST /api/experiment-draft ---
app.post('/api/experiment-draft', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { brief, hypotheses } = req.body || {};
    const selected = (hypotheses || []).filter((h: any) => h.selectedByUser);
    if (selected.length < 1 || selected.length > 3) {
      return fail(res, 400, 'Select 1–3 testable hypotheses', 'PRECONDITION');
    }
    const input = JSON.stringify({ brief, hypotheses: selected });
    const prompt = `Step experiment-draft. Hypotheses:
${input}
Return JSON: { "drafts": [ {
  "hypothesisId","whyCritical","test","metric","deadlineWords",
  "threshold_questions":["..."],
  "intermediateOutcomeQuestion":"what will you do if the result lands between the success and stop thresholds?",
  "whoCountsQuestion":"which participants, customers or observations count and which do not (define before the test, e.g. exclude the close circle)",
  "decisionAfterEachOutcome":{"success":"...","failure":"...","inBetween":"..."},
  "killCriteriaQuestions":["measurable stop condition the user must set before starting, and what to do next after stopping"],
  "costOfErrorAndReversibility":"how costly and how reversible this test is",
  "validity_threats":[{"threat","protection"}],
  "reviewPointQuestions":["what will be compared with the forecast at 30, 90, 180 days"],
  "shareWithThirdParty":"one sentence: give a copy of thresholds and stop conditions to a trusted person before the test starts",
  "ifSuccessHint","ifFailureHint"
} ] }
Prefer the test with the highest value of information at the lowest cost and risk. The test must be able to change the decision. No numeric thresholds: the human sets thresholds and records their own forecast and confidence. Everything derived from this user's own facts.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'experiment-draft', 0, requestByokKey, requestPreferredModel);
    // Ensure no numeric thresholds in schema sense
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'experiment-draft error');
  }
});

// --- POST /api/forecast-wording ---
app.post('/api/forecast-wording', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { experiment } = req.body || {};
    if (!experiment) return fail(res, 400, 'No experiment card', 'PRECONDITION');
    const input = JSON.stringify(experiment);
    const prompt = `Step forecast-wording. Card:
${input}
Return JSON: { "wordings": { "30": "...", "90": "...", "180": "..." } }
Only observable criteria: what exactly will count as having come true, and by which observation. No percentages or confidence: the human records their own probability and confidence. If there are no grounds for a criterion at some horizon, say so instead of inventing one.`;
    const { data, meta } = await generate(prompt, input, 'light', 'forecast-wording', 0, requestByokKey, requestPreferredModel);
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'forecast-wording error');
  }
});

// S-5: format problems of a synthesis answer (empty list = fine). Word count is skipped for CJK text (no spaces).
function synthesisIssues(data: unknown): string[] {
  const paras = Array.isArray((data as any)?.paragraphs) ? (data as any).paragraphs.filter((p: any) => typeof p === 'string' && p.trim()) : [];
  const issues: string[] = [];
  if (paras.length !== 5) issues.push(`${paras.length} paragraphs instead of 5`);
  const text = paras.join(' ');
  if (!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)) {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 225 || words > 385) issues.push(`${words} words instead of 250-350`);
  }
  return issues;
}

// --- POST /api/synthesis ---
app.post('/api/synthesis', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const body = req.body || {};
    const input = JSON.stringify(body);
    const prompt = `Step synthesis. Full decision context:
${input}
Return JSON: {
  "paragraphs": ["paragraph1","paragraph2","paragraph3","paragraph4","paragraph5"],
  "derived_numbers": [{"value": <number>,"formula":"arithmetic expression using only operands from input","operands":[<from input>]}],
  "open_gaps": [],
  "needs_external_check": []
}
Exactly 5 paragraphs of coherent prose, 250–350 words total. Cover, in this order: (1) what is known; (2) what is not known; (3) which facts or test results could change the decision; (4) the next step with the most information for the least cost, and how the path branches on the user's own thresholds; (5) what requires external verification, the main risks, and where this analysis could be wrong or sensitive to wording or to the model.
Do not choose for the user: one conditional path, not a verdict “choose X”. The user takes and records the decision. Numbers only from input or in derived_numbers with an arithmetic formula that exactly reproduces the value. No “best”, “optimal”, or probabilities.`;
    const callBudget = { used: 0 };
    let { data, meta } = await generate(prompt, input, 'strong', 'synthesis', 0, requestByokKey, requestPreferredModel, callBudget);
    // S-5: the prompt asks for 5 paragraphs and 250-350 words; check it (tolerance 10 %), one retry, never a hard error
    let issues = synthesisIssues(data);
    if (issues.length) {
      try {
        const retry = await generate(`${prompt}\n\nFORMAT CHECK FAILED on the previous draft: ${issues.join('; ')}. Rewrite the JSON: exactly 5 paragraphs, 250–350 words in total, same rules.`, input, 'strong', 'synthesis-retry', STRONG_MODELS.length > 1 ? 1 : 0, requestByokKey, requestPreferredModel, callBudget);
        const ri = synthesisIssues(retry.data);
        const um = meta as any, rm = retry.meta as any;
        const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a || 0) + (b || 0));
        const inT = sum(um.inputTokens, rm.inputTokens), outT = sum(um.outputTokens, rm.outputTokens);
        if (ri.length < issues.length) { data = retry.data; issues = ri; meta = rm; }
        meta = { ...meta, calls: um.calls + rm.calls, promptChars: um.promptChars + rm.promptChars, durationMs: um.durationMs + rm.durationMs,
          ...(inT !== undefined ? { inputTokens: inT } : {}), ...(outT !== undefined ? { outputTokens: outT } : {}) };
      } catch (retryErr: any) {
        console.error('[synthesis-retry] failed, returning first draft:', retryErr?.message || retryErr);
      }
    }
    ok(res, data, issues.length ? { ...(meta as any), warnings: issues.map((i) => `SYNTHESIS_FORMAT: ${i}`) } : meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'synthesis error');
  }
});

// --- POST /api/review ---
app.post('/api/review', async (req, res) => {
  try {
    const requestByokKey = byokFromRequest(req);
    const requestPreferredModel = preferredModelFromRequest(req);
    if (!aiGate(req, res)) return;
    const { journalEntry, brief } = req.body || {};
    const input = JSON.stringify({ journalEntry, brief });
    const prompt = `Step review. Journal entry:
${input}
Return JSON: { "questions": [
  {"area":"DATA","question":"..."},
  {"area":"ASSUMPTION","question":"..."},
  {"area":"REASONING","question":"..."},
  {"area":"EXECUTION","question":"..."},
  {"area":"LUCK","question":"..."}
] }
Questions only, no diagnosis and no changing the forecast. Tie each question to this entry's own forecast and fact. Chance (area "LUCK") is the last question and is asked only after the other four: if the same decision were taken many times with the same data, would the outcome differ often enough to count as chance?`;
    const { data, meta } = await generate(prompt, input, 'light', 'review', 0, requestByokKey, requestPreferredModel);
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code, e.details);
    if (e?.code === 'GEMINI_UNAVAILABLE') return fail(res, 503, e.message, e.code, e.details);
    fail(res, 500, e.message || 'review error');
  }
});

// Legacy endpoints return 410
app.post('/api/analyze-full', (_req, res) => {
  fail(res, 410, 'Monolithic analysis removed. Use step endpoints.', 'GONE');
});
app.post('/api/radar-legacy', (_req, res) => {
  fail(res, 410, 'Legacy radar. Use /api/neutralize → /api/radar.', 'GONE');
});

// EVPI is client-side only (G-09) — optional server echo for tests
app.post('/api/evpi', (req, res) => {
  const { p, G, L, c } = req.body || {};
  const pNorm = p > 1 ? p / 100 : p;
  const evOpen = pNorm * G - (1 - pNorm) * L;
  const bestNoInfo = Math.max(evOpen, 0);
  const evPerfect = pNorm * G;
  const evpiVal = evPerfect - bestNoInfo;
  ok(res, { evOpen, bestNoInfo, evPerfect, evpi: evpiVal, testCost: c }, { model: 'local', fallback: false, durationMs: 0, stage: 'evpi' });
});

async function start() {
  if (APP_AUTH_ENABLED && SESSION_SECRET.length < 16) {
    throw new Error('SESSION_SECRET is required (at least 16 characters) when password sign-in is enabled.');
  }
  if (NODE_ENV === 'production' && !APP_AUTH_ENABLED) {
    console.error('!!! WARNING: password sign-in is DISABLED in production (APP_PASSWORD empty or ENABLE_APP_AUTH=false). The site and its AI endpoints are open to everyone. !!!');
  }
  if (NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }
  app.listen(PORT, () => {
    console.log(`Bifurcation Engine v${APP_VERSION} on :${PORT} (${NODE_ENV})`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
