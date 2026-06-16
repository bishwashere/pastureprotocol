/**
 * Shared credential helpers for skill executors.
 * Normalizes LLM-friendly aliases (@me) and config values that name env vars.
 */

const SELF_ALIASES = new Set(['@me', 'me', 'self', 'default', 'primary', 'authenticated']);

/**
 * If value names an env var, return its value; otherwise return the literal string.
 * @param {string|undefined|null} val
 * @returns {string|undefined}
 */
export function resolveEnvCredential(val) {
  if (val == null || val === '') return undefined;
  const s = String(val).trim();
  if (!s) return undefined;
  if (process.env[s] !== undefined) return process.env[s];
  return s;
}

/**
 * Map LLM self-references (@me, me, …) to empty so callers fall back to defaults.
 * @param {string|undefined|null} value
 * @returns {string}
 */
export function normalizeSelfAlias(value) {
  const v = (value ?? '').trim();
  if (!v) return '';
  if (SELF_ALIASES.has(v.toLowerCase())) return '';
  return v;
}

/**
 * Resolve account/email for Google skills: explicit arg, ignoring @me, else default.
 * @param {string|undefined|null} explicitAccount
 * @param {() => string} getDefaultAccount
 * @returns {string}
 */
export function resolveAccount(explicitAccount, getDefaultAccount) {
  const normalized = normalizeSelfAlias(explicitAccount);
  if (normalized) return normalized;
  return typeof getDefaultAccount === 'function' ? (getDefaultAccount() || '') : '';
}
