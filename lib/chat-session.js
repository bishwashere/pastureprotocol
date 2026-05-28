/**
 * Backend chat sessions per log key (owner, per-DM jid, group jid).
 * - Auto-rotate at sessionResetHour (default 03:00) in agents.defaults.userTimezone (or host TZ).
 * - Manual rotate when the user asks to start a new session.
 * Logs keep all exchanges; LLM context only includes the current sessionId.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getStateDir, ensureStateDir, getConfigPath } from './paths.js';
import { getResolvedTimezone } from './timezone.js';

const SESSIONS_DIR = 'chat-sessions';
const STATE_FILE = 'state.json';
const DEFAULT_RESET_HOUR = 3;

/** @typedef {{ sessionId: string, startedAtMs: number, boundaryKey: string, reason?: string }} SessionEntry */

function getSessionsStatePath() {
  return join(getStateDir(), SESSIONS_DIR, STATE_FILE);
}

function loadAllState() {
  const p = getSessionsStatePath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveAllState(data) {
  ensureStateDir();
  const dir = join(getStateDir(), SESSIONS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getSessionsStatePath(), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Hour (0–23) when the daily session boundary occurs in the configured timezone.
 * @returns {number}
 */
export function getSessionResetHour() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    if (!raw?.trim()) return DEFAULT_RESET_HOUR;
    const config = JSON.parse(raw);
    const def = config.agents?.defaults;
    if (def && def.sessionResetHour != null) {
      const h = Math.floor(Number(def.sessionResetHour));
      if (h >= 0 && h <= 23) return h;
    }
  } catch (_) {}
  return DEFAULT_RESET_HOUR;
}

/**
 * Local calendar parts in an IANA timezone.
 * @param {Date} date
 * @param {string} tz
 */
function getLocalYmdHm(date, tz) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10),
  };
}

/**
 * Session day bucket: before resetHour belongs to the previous calendar day.
 * @param {Date} [date]
 * @param {string} [tz]
 * @param {number} [resetHour]
 * @returns {string} e.g. "2026-05-28"
 */
export function getSessionDayKey(date = new Date(), tz, resetHour = getSessionResetHour()) {
  const resolvedTz = tz || getResolvedTimezone();
  let parts = getLocalYmdHm(date, resolvedTz);
  if (parts.hour < resetHour) {
    const approx = new Date(date.getTime() - 24 * 60 * 60 * 1000);
    parts = getLocalYmdHm(approx, resolvedTz);
  }
  return (
    `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  );
}

/**
 * @param {string} logKey - Storage key (log jid or group jid)
 * @returns {SessionEntry | null}
 */
export function getCurrentSession(logKey) {
  const key = String(logKey || '').trim();
  if (!key) return null;
  const all = loadAllState();
  const entry = all[key];
  if (!entry || !entry.sessionId) return null;
  return entry;
}

/**
 * @param {string} logKey
 * @param {'daily'|'manual'} reason
 * @param {Date} [now]
 * @returns {SessionEntry}
 */
export function startNewSession(logKey, reason, now = new Date()) {
  const key = String(logKey || '').trim();
  if (!key) throw new Error('logKey required');
  const boundaryKey = getSessionDayKey(now);
  const sessionId =
    reason === 'manual'
      ? `m-${now.getTime()}`
      : `d-${boundaryKey}`;
  const entry = {
    sessionId,
    startedAtMs: now.getTime(),
    boundaryKey,
    reason,
  };
  const all = loadAllState();
  all[key] = entry;
  saveAllState(all);
  console.log('[session] New session for', key.slice(0, 24), '→', sessionId, `(${reason})`);
  return entry;
}

const NEW_SESSION_ONLY_RE =
  /^\s*(\/new(-session)?|start\s+(a\s+)?new\s+session|new\s+session|fresh\s+session|begin\s+(a\s+)?new\s+session|reset\s+(the\s+)?session)\s*\.?\s*$/i;

const NEW_SESSION_PREFIX_RE =
  /^(start\s+(a\s+)?new\s+session|new\s+session)[\s,.:!—-]+/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isNewSessionRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (NEW_SESSION_ONLY_RE.test(t)) return true;
  if (NEW_SESSION_PREFIX_RE.test(t)) return true;
  return false;
}

/**
 * Ensure the log key has a current session; rotate on 3 AM boundary or user request.
 * @param {string} logKey
 * @param {{ userText?: string, now?: Date, tz?: string }} [opts]
 * @returns {{ sessionId: string, rotated: boolean, reason: 'daily'|'manual'|null, entry: SessionEntry }}
 */
export function ensureChatSession(logKey, opts = {}) {
  const key = String(logKey || '').trim();
  const now = opts.now || new Date();
  const tz = opts.tz || getResolvedTimezone();
  const dayKey = getSessionDayKey(now, tz);
  const userText = opts.userText != null ? String(opts.userText) : '';

  let entry = getCurrentSession(key);
  let rotated = false;
  let reason = null;

  if (userText && isNewSessionRequest(userText)) {
    entry = startNewSession(key, 'manual', now);
    rotated = true;
    reason = 'manual';
  } else if (!entry) {
    entry = startNewSession(key, 'daily', now);
    rotated = true;
    reason = 'daily';
  } else if (entry.boundaryKey !== dayKey) {
    entry = startNewSession(key, 'daily', now);
    rotated = true;
    reason = 'daily';
  }

  return {
    sessionId: entry.sessionId,
    rotated,
    reason,
    entry,
  };
}

/**
 * Filter parsed log rows to the active session (backend context only).
 * @param {Array<{ sessionId?: string }>} rows
 * @param {string|null|undefined} sessionId
 */
export function filterRowsForSession(rows, sessionId) {
  if (!sessionId) return rows;
  return rows.filter((row) => row.sessionId === sessionId);
}
