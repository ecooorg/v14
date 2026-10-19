/**
 * Secret redaction helpers (foundation for BX-24 / P23 and used by P15a monitoring).
 * Never log or return raw secret values; only names and present:true|false.
 */

/** Well-known env var name patterns that hold secrets (names only, not values). */
export const SECRET_ENV_NAMES = [
  'GEMINI_API_KEY',
  'GEMINI_API_KEY_FREE',
  'GROQ_API_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'SESSION_SECRET',
  'APP_PASSWORD',
  'DATABASE_URL',
] as const;

const PLACEHOLDER = '[REDACTED]';

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every occurrence of known secret *values* (from env) in text.
 * Empty or very short values are ignored to avoid over-redaction.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  let out = text;
  const values = new Set<string>();
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (typeof v === 'string' && v.length >= 8) values.add(v);
  }
  // Also catch common key-shaped substrings that might leak from partial env dumps
  for (const v of values) {
    out = out.split(v).join(PLACEHOLDER);
  }
  return out;
}

/**
 * Recursively walk a JSON-compatible value and redact string leaves that equal
 * a known secret value. Object keys that look like secret names get their
 * string values replaced even if the value is not in env (defense in depth).
 */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const secretValues = new Set<string>();
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (typeof v === 'string' && v.length >= 8) secretValues.add(v);
  }
  const secretKey = /(_KEY|_SECRET|_PASSWORD|PRIVATE_KEY|DATABASE_URL|TOKEN)$/i;

  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      if (secretValues.has(v)) return PLACEHOLDER;
      return redactSecrets(v, env);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (secretKey.test(k) && typeof val === 'string') out[k] = PLACEHOLDER;
        else out[k] = walk(val);
      }
      return out;
    }
    return v;
  }
  return walk(value) as T;
}

/** Report presence of env secrets without values (for verify/monitor output). */
export function secretPresence(names: readonly string[] = SECRET_ENV_NAMES, env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const n of names) out[n] = Boolean(env[n] && String(env[n]).length > 0);
  return out;
}

/**
 * Assert that none of the known secret values appear in text.
 * Returns the list of env names whose values were found (for test diagnostics).
 */
export function findLeakedSecretNames(text: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const leaked: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (typeof v === 'string' && v.length >= 8 && text.includes(v)) leaked.push(name);
  }
  return leaked;
}
