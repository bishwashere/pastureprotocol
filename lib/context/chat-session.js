/**
 * Backend chat sessions per log key (owner, per-DM jid, group jid).
 * - Auto-rotate at sessionResetHour (default 03:00) in agents.defaults.userTimezone (or host TZ).
 * - Manual rotate when the user asks to start a new session.
 * Logs keep all exchanges; LLM context only includes the current sessionId.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getStateDir, ensureStateDir, getConfigPath } from '../util/paths.js';
import { getResolvedTimezone } from '../util/timezone.js';

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

/** True when the message is only a session-reset command (no follow-up task). */
export function isNewSessionOnlyRequest(text) {
  const t = String(text || '').trim();
  return t.length > 0 && NEW_SESSION_ONLY_RE.test(t);
}

export const NEW_SESSION_ACK = 'New session started.';

/** Manual rotate + message is only "new session" (etc.) — skip the agent turn. */
export function shouldAckNewSessionOnly(sessionReason, userText) {
  return sessionReason === 'manual' && isNewSessionOnlyRequest(userText);
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

// ── Reply-mode preference (per session) ───────────────────────────────────────

/**
 * Phrases that switch the agent's reply mode for this session.
 * Matches "reply in text", "text mode", "respond as text", "switch to text", etc.
 */
const REPLY_TEXT_MODE_RE =
  /\b(reply|respond|answer|write|talk)\s+(back\s+)?(in|as|using|with)\s+text\b|\btext\s+(mode|only|replies)\b|\bswitch\s+to\s+text\b|\bno\s+(more\s+)?voice\b|\bstop\s+voice\s+(replies|messages)?\b|\btext\s+me\b/i;

const REPLY_VOICE_MODE_RE =
  /\b(reply|respond|answer|talk)\s+(back\s+)?(in|as|using|with)\s+voice\b|\bvoice\s+(mode|replies)\b|\bswitch\s+to\s+voice\b|\buse\s+voice\b/i;

/**
 * Returns 'text' or 'voice' if the message is a reply-mode switch command, null otherwise.
 * @param {string} text
 * @returns {'text' | 'voice' | null}
 */
export function detectReplyModeSwitch(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (REPLY_TEXT_MODE_RE.test(t)) return 'text';
  if (REPLY_VOICE_MODE_RE.test(t)) return 'voice';
  return null;
}

/**
 * Persist a reply-mode preference ('text' | 'voice') for the current session entry.
 * Silently no-ops if the logKey has no active session yet.
 * @param {string} logKey
 * @param {'text' | 'voice'} mode
 */
export function setSessionReplyMode(logKey, mode) {
  const key = String(logKey || '').trim();
  if (!key) return;
  const all = loadAllState();
  if (!all[key]) return;
  all[key].replyMode = mode === 'text' ? 'text' : 'voice';
  saveAllState(all);
}

/**
 * Read the reply-mode preference for the current session.
 * Defaults to 'voice' when not set (i.e. every new session starts as voice).
 * @param {string} logKey
 * @returns {'text' | 'voice'}
 */
export function getSessionReplyMode(logKey) {
  const key = String(logKey || '').trim();
  if (!key) return 'voice';
  const all = loadAllState();
  return all[key]?.replyMode === 'text' ? 'text' : 'voice';
}

// ── Work-mode preference (per session) ────────────────────────────────────────
// "single" — default. Tool-execution focused. The agent answers directly using
//            its own skills. No work-durability classification, no delegation
//            routing, no mission/project context blocks.
// "multi"  — full multi-agent orchestration: work-durability + delegation
//            router + mission/project intake + team capability evaluation.
//
// Every NEW session starts in "single". The user opts into "multi" each
// session by telling the agent (in any language / phrasing) that they want
// to start work / collaborate with the team. Once multi is active it is sticky
// for the session; later turns only look for a strong request to switch back.
// Detection is LLM-driven — see lib/agent/work-mode.js. No regex, no keyword
// markers.

/** @type {'single' | 'multi'} */
export const DEFAULT_WORK_MODE = 'single';

/**
 * Persist a work-mode preference ('single' | 'multi') for the current session entry.
 * Silently no-ops if the logKey has no active session yet.
 * @param {string} logKey
 * @param {'single' | 'multi'} mode
 */
export function setSessionWorkMode(logKey, mode) {
  const key = String(logKey || '').trim();
  if (!key) return;
  const all = loadAllState();
  if (!all[key]) return;
  all[key].workMode = mode === 'multi' ? 'multi' : 'single';
  saveAllState(all);
}

/**
 * Read the work-mode preference for the current session.
 * Defaults to 'single' when not set (i.e. every new session starts single-agent).
 * @param {string} logKey
 * @returns {'single' | 'multi'}
 */
export function getSessionWorkMode(logKey) {
  const key = String(logKey || '').trim();
  if (!key) return DEFAULT_WORK_MODE;
  const all = loadAllState();
  return all[key]?.workMode === 'multi' ? 'multi' : 'single';
}

export const WORK_MODE_ENABLED_ACK =
  "Work mode on — I'll involve the team and track this as durable work for the rest of this session.";
export const WORK_MODE_DISABLED_ACK =
  "Work mode off — back to single-agent for the rest of this session. I'll handle requests directly with my own tools.";
