/**
 * Sign-in hardening (SEC-01) and reply cleanup (FIX-01).
 * Pure helpers with no Express dependency, so they can be tested directly.
 */
import crypto from 'node:crypto';

/* ---------- Signed session cookie (HMAC, stateless: survives restarts and deploys) ---------- */

export function createSessionSigner(secret: string) {
  const mac = (expires: string) => crypto.createHmac('sha256', secret).update('be_session.' + expires).digest('hex');
  return {
    sign(expiresAtMs: number): string { const e = String(Math.floor(expiresAtMs)); return `${e}.${mac(e)}`; },
    verify(token: string | null | undefined, now = Date.now()): boolean {
      if (!token) return false;
      const [e, sig, extra] = token.split('.');
      if (!e || !sig || extra !== undefined || !/^\d+$/.test(e)) return false;
      const want = Buffer.from(mac(e)), got = Buffer.from(sig);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
      return Number(e) > now;
    },
  };
}

export const SESSION_COOKIE = 'be_session';

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/* ---------- Failed-login limiter: N failures per window per address ---------- */

export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 15 * 60 * 1000) {}
  private recent(key: string, now: number): number[] {
    const list = (this.fails.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.fails.set(key, list); else this.fails.delete(key);
    return list;
  }
  /** Seconds until a new attempt is allowed, or 0 if not blocked. */
  retryAfterSec(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.max] + this.windowMs - now) / 1000));
  }
  /** Only failures count. A success does NOT reset the counter; the window does. */
  recordFailure(key: string, now = Date.now()): void {
    const list = this.recent(key, now); list.push(now); this.fails.set(key, list);
    if (this.fails.size > 5000) for (const k of this.fails.keys()) this.recent(k, now);
  }
}

/* ---------- FIX-01: remove markdown symbols from chat replies ---------- */

export function stripMarkdown(input: string): string {
  let t = String(input ?? '').replace(/\r\n/g, '\n');
  t = t.replace(/^[ \t]*`{3,}[^\n]*\n?/gm, '');                          // code fences (keep the content)
  t = t.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');           // horizontal rules
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');                         // headings
  t = t.replace(/^[ \t]*>[ \t]?/gm, '');                                  // blockquotes
  t = t.replace(/^([ \t]*)[*+][ \t]+/gm, '$1- ');                         // * and + list markers -> dash
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');    // links
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');                  // bold
  t = t.replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, '$1'); // *italic*
  t = t.replace(/(?<!\w)_(?![\s_])([^_\n]+?)(?<![\s_])_(?!\w)/g, '$1');   // _italic_
  t = t.replace(/`([^`\n]+)`/g, '$1');                                    // inline code
  t = t.replace(/\*\*/g, '');                                             // stray bold markers
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
