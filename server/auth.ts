/**
 * Tester-code auth + HttpOnly session (INF-1…3)
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SESSION_COOKIE = 'be_session';
const SESSION_DAYS = 30;

export type SessionPayload = { testerId: string; exp: number };

function secret(): string {
  const s = process.env.SESSION_SECRET || '';
  if (!s && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production');
  }
  return s || 'dev-only-secret';
}

/** Parse TESTER_CODES=label:code,label2:code2 */
export function loadTesterCodes(): Map<string, string> {
  const raw = process.env.TESTER_CODES || '';
  const map = new Map<string, string>();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const idx = p.indexOf(':');
    if (idx === -1) {
      map.set(p, p);
    } else {
      const label = p.slice(0, idx).trim();
      const code = p.slice(idx + 1).trim();
      if (label && code) map.set(code, label);
    }
  }
  return map;
}

export function assertAuthConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing: string[] = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
    missing.push('SESSION_SECRET (min 16 characters)');
  }
  if (loadTesterCodes().size === 0) {
    missing.push('TESTER_CODES (example: alice:MySecretCode1,bob:MySecretCode2)');
  }
  if (missing.length) {
    throw new Error(
      'Missing required environment variables on the host:\n  - ' +
        missing.join('\n  - ') +
        '\nSet them in Railway → Variables, then redeploy.',
    );
  }
}

export function verifyTesterCode(code: string): string | null {
  const map = loadTesterCodes();
  const incoming = Buffer.from(String(code || ''));
  let found: string | null = null;
  for (const [c, label] of map) {
    const candidate = Buffer.from(c);
    if (incoming.length === candidate.length && crypto.timingSafeEqual(incoming, candidate)) {
      found = label;
    }
  }
  return found;
}

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function unsign(token: string): SessionPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (!payload.testerId || !payload.exp || Date.now() > payload.exp) return null;
    const labels = new Set(loadTesterCodes().values());
    if (loadTesterCodes().size > 0 && !labels.has(payload.testerId)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, testerId: string): void {
  const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  const token = sign({ testerId, exp });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  );
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`);
}

export function readSession(req: Request): SessionPayload | null {
  const raw = req.headers.cookie || '';
  const match = raw
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(SESSION_COOKIE + '='));
  if (!match) return null;
  return unsign(match.slice(SESSION_COOKIE.length + 1));
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ success: false, code: 'UNAUTHORIZED', error: 'Sign in required' });
    return;
  }
  (req as Request & { testerId: string }).testerId = session.testerId;
  next();
}

const loginAttempts = new Map<string, { n: number; reset: number }>();

export function checkLoginRate(ip: string): boolean {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now > rec.reset) {
    rec = { n: 0, reset: now + 15 * 60 * 1000 };
  }
  rec.n++;
  loginAttempts.set(ip, rec);
  return rec.n <= 10;
}
