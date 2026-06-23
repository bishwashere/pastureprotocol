/**
 * Chat log: append each user/assistant exchange to workspace/chat-log/private/<jid>.jsonl.
 * Used so memory search can pull from conversation history ("Remember what we said yesterday?").
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { filterRowsForSession, getCurrentSession } from './chat-session.js';
import { getResolvedTimezone } from '../util/timezone.js';

const CHAT_LOG_DIR = 'chat-log';
const PRIVATE_CHAT_DIR = 'private';
/** Virtual day keys for dashboard/API (`chat-log/day/YYYY-MM-DD`). */
export const CHAT_LOG_DAY_PREFIX = `${CHAT_LOG_DIR}/day/`;

/** Default user+assistant pairs included in LLM context per turn (override via config.chatHistoryExchanges). */
export const DEFAULT_CHAT_HISTORY_EXCHANGES = 20;

/** @param {number|string|undefined|null} value */
export function resolveChatHistoryExchanges(value) {
  return Math.max(1, Math.floor(Number(value)) || DEFAULT_CHAT_HISTORY_EXCHANGES);
}

/**
 * @param {string} workspaceDir
 * @returns {string} Absolute path to chat-log dir
 */
function getChatLogDir(workspaceDir) {
  return join(workspaceDir, CHAT_LOG_DIR);
}

/** Legacy mangled filename base (pre-human-readable migration). */
function legacyMangledJidToFileBase(jid) {
  if (jid == null || String(jid).trim() === '') return 'unknown';
  return String(jid).trim().replace(/[^0-9a-zA-Z._-]/g, '_') || 'unknown';
}

/**
 * Human-readable filename base for a private chat log.
 * Examples: owner, telegram-123456789, whatsapp-15551234567
 * @param {string|null|undefined} jid
 * @returns {string}
 */
export function logJidToFileBase(jid) {
  if (jid == null || String(jid).trim() === '') return 'unknown';
  const s = String(jid).trim();
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s) && !s.includes('@')) return s;
  const waMatch = s.match(/^(\d+)@s\.whatsapp\.net$/i);
  if (waMatch) return `whatsapp-${waMatch[1]}`;
  if (/^\d+$/.test(s)) return `telegram-${s}`;
  return legacyMangledJidToFileBase(s);
}

/** @param {string} fileBase - basename without .jsonl */
function fileBaseToLogJid(fileBase) {
  const base = String(fileBase || '').trim();
  if (!base || base === 'unknown') return 'unknown';
  const tg = base.match(/^telegram-(\d+)$/);
  if (tg) return tg[1];
  const wa = base.match(/^whatsapp-(\d+)$/);
  if (wa) return `${wa[1]}@s.whatsapp.net`;
  const legacyWa = base.match(/^(\d+)_s_whatsapp_net$/);
  if (legacyWa) return `${legacyWa[1]}@s.whatsapp.net`;
  if (/^\d+$/.test(base)) return base;
  return base;
}

/** @param {string} filePath */
function readLogJidFromPrivateFile(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]);
      if (row?.jid != null && String(row.jid).trim() !== '') return String(row.jid).trim();
    }
  } catch (_) {}
  const base = filePath.split(/[/\\]/).pop()?.replace(/\.jsonl$/, '') || 'unknown';
  return fileBaseToLogJid(base);
}

/**
 * Resolve the on-disk path for a private chat log (new name first, legacy fallback).
 * @param {string} workspaceDir
 * @param {string} jid
 * @returns {string} Absolute path (may not exist yet)
 */
function resolvePrivateLogFilePath(workspaceDir, jid) {
  const dir = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR);
  const newPath = join(dir, logJidToFileBase(jid) + '.jsonl');
  if (existsSync(newPath)) return newPath;
  const legacyPath = join(dir, legacyMangledJidToFileBase(jid) + '.jsonl');
  if (legacyPath !== newPath && existsSync(legacyPath)) return legacyPath;
  return newPath;
}

function privateLogRelPath(jid) {
  return `${CHAT_LOG_DIR}/${PRIVATE_CHAT_DIR}/${logJidToFileBase(jid)}.jsonl`;
}

/**
 * Append one exchange to chat-log/private/<jid>.jsonl (one file per chat).
 * @param {string} workspaceDir
 * @param {{ user: string, assistant: string, timestampMs: number, jid?: string, sessionId?: string }} exchange
 * @returns {{ path: string, lineNumber: number }} Relative path and 1-based line number of this exchange
 */
export function appendExchange(workspaceDir, exchange) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('workspaceDir is required');
  }
  const { user, assistant, timestampMs, jid, sessionId } = exchange;
  const logJid = jid != null && String(jid).trim() !== '' ? String(jid).trim() : 'unknown';
  const line = JSON.stringify({
    ts: timestampMs,
    jid: logJid === 'unknown' ? null : logJid,
    sessionId: sessionId != null ? String(sessionId) : undefined,
    user: String(user ?? '').trim(),
    assistant: String(assistant ?? '').trim(),
  }) + '\n';

  const dir = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fileName = logJidToFileBase(logJid) + '.jsonl';
  const filePath = join(dir, fileName);
  appendFileSync(filePath, line, 'utf8');
  const content = readFileSync(filePath, 'utf8');
  const lineNumber = content.split('\n').filter((l) => l.trim()).length;
  return { path: CHAT_LOG_DIR + '/' + PRIVATE_CHAT_DIR + '/' + fileName, lineNumber };
}

/**
 * List private chat jids that have activity, sorted by last activity (newest first).
 * File names are logJidToFileBase(jid). Jids are read from each file's JSONL rows when listing.
 * @param {string} workspaceDir
 * @returns {Array<{ jid: string, lastTs: number }>} Sorted by lastTs descending
 */
export function getPrivateChatJidsByLastActivity(workspaceDir) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return [];
  const dir = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR);
  if (!existsSync(dir)) return [];
  let files = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
      .map((f) => f.name.replace(/\.jsonl$/, ''));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of files) {
    const filePath = join(dir, name + '.jsonl');
    const jid = readLogJidFromPrivateFile(filePath);
    const ts = getLastExchangeTimestamp(workspaceDir, jid);
    if (ts != null) out.push({ jid, lastTs: ts });
  }
  out.sort((a, b) => b.lastTs - a.lastTs);
  return out;
}

/**
 * Timestamp of the last exchange in this private chat (any message in or out).
 * Used by Tide to enforce silence cooldown: don't poke until there's been real quiet.
 * @param {string} workspaceDir
 * @param {string} jid - Chat id (Telegram or WhatsApp)
 * @returns {number | null} Last exchange ts in ms, or null if no exchanges
 */
export function getLastExchangeTimestamp(workspaceDir, jid, sessionId) {
  if (!workspaceDir || typeof workspaceDir !== 'string' || jid == null || String(jid).trim() === '') return null;
  const sid = sessionId ?? getCurrentSession(String(jid).trim())?.sessionId;
  const perJidPath = resolvePrivateLogFilePath(workspaceDir, jid);
  if (!existsSync(perJidPath)) return null;
  try {
    const content = readFileSync(perJidPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]);
      if (row == null || typeof row.ts !== 'number') continue;
      if (sid && row.sessionId !== sid) continue;
      return row.ts;
    }
    return null;
  } catch (_) {
    return null;
  }
}

const GROUP_CHAT_LOG_DIR = 'group-chat-log';

/**
 * Append one exchange to group-chat-log/<groupJid>/YYYY-MM-DD.jsonl.
 * Used only for Telegram groups so main chat-log and main memory are never polluted by group traffic.
 * @param {string} workspaceDir
 * @param {string} groupJid - Telegram group chat id (negative number string)
 * @param {{ user: string, assistant: string, timestampMs: number }} exchange
 * @returns {{ path: string, lineNumber: number }} Relative path (e.g. group-chat-log/-12345/2025-02-16.jsonl)
 */
export function appendGroupExchange(workspaceDir, groupJid, exchange) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('workspaceDir is required');
  }
  const safeId = String(groupJid).trim().replace(/[^0-9-]/g, '_') || 'group';
  const { user, assistant, timestampMs, sessionId: exchangeSessionId } = exchange;
  const date = new Date(timestampMs);
  const dateStr =
    date.getFullYear() +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0');
  const dir = join(workspaceDir, GROUP_CHAT_LOG_DIR, safeId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, dateStr + '.jsonl');
  const sessionId = exchangeSessionId != null ? String(exchangeSessionId) : undefined;
  const line = JSON.stringify({
    ts: timestampMs,
    sessionId,
    user: String(user ?? '').trim(),
    assistant: String(assistant ?? '').trim(),
  }) + '\n';
  appendFileSync(filePath, line, 'utf8');
  const content = readFileSync(filePath, 'utf8');
  const lineNumber = content.split('\n').filter((l) => l.trim()).length;
  const relPath = GROUP_CHAT_LOG_DIR + '/' + safeId + '/' + dateStr + '.jsonl';
  return { path: relPath, lineNumber };
}

function rowsToHistoryMessages(rows) {
  const out = [];
  for (const ex of rows) {
    out.push({ role: 'user', content: ex.user || '(no text)' });
    out.push({ role: 'assistant', content: ex.assistant || '(no text)' });
  }
  return out;
}

function parsePrivateLogLines(lines, sessionId) {
  const rows = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row == null || (row.user == null && row.assistant == null)) continue;
      rows.push({
        ts: row.ts || 0,
        sessionId: row.sessionId,
        user: String(row.user ?? '').trim(),
        assistant: String(row.assistant ?? '').trim(),
      });
    } catch (_) {}
  }
  const filtered = filterRowsForSession(rows, sessionId);
  filtered.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return filtered;
}

/**
 * Read the last N exchanges from group-chat-log for a Telegram group.
 * Used so the bot has recent group context (e.g. other people's questions) when replying in group chat.
 * @param {string} workspaceDir
 * @param {string} groupJid - Telegram group chat id (e.g. "-12345")
 * @param {number} maxExchanges - Max number of user+assistant pairs to return (e.g. 5)
 * @returns {Array<{ role: string, content: string }>} Messages in LLM order (user, assistant, user, ...)
 */
export function readLastGroupExchanges(workspaceDir, groupJid, maxExchanges = DEFAULT_CHAT_HISTORY_EXCHANGES, sessionId) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return [];
  const n = resolveChatHistoryExchanges(maxExchanges);
  const sid = sessionId ?? getCurrentSession(String(groupJid).trim())?.sessionId;
  const safeId = String(groupJid).trim().replace(/[^0-9-]/g, '_') || 'group';
  const dir = join(workspaceDir, GROUP_CHAT_LOG_DIR, safeId);
  if (!existsSync(dir)) return [];
  let files = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
      .map((f) => f.name)
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
  const all = [];
  for (const name of files) {
    const path = join(dir, name);
    try {
      const content = readFileSync(path, 'utf8');
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          if (row != null && (row.user != null || row.assistant != null)) {
            all.push({
              ts: row.ts || 0,
              sessionId: row.sessionId,
              user: String(row.user ?? '').trim(),
              assistant: String(row.assistant ?? '').trim(),
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  const filtered = filterRowsForSession(all, sid);
  filtered.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return rowsToHistoryMessages(filtered.slice(-n));
}

/**
 * Read the last N exchanges for a private/DM jid from chat-log/private/<jid>.jsonl.
 * @param {string} workspaceDir
 * @param {string} jid - Chat id (e.g. Telegram chat id or WhatsApp jid)
 * @param {number} maxExchanges - Max number of user+assistant pairs to return (configurable; rough context is enough)
 * @returns {Array<{ role: string, content: string }>} Messages in LLM order (user, assistant, user, ...)
 */
export function readLastPrivateExchanges(workspaceDir, jid, maxExchanges = DEFAULT_CHAT_HISTORY_EXCHANGES, sessionId) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return [];
  const n = resolveChatHistoryExchanges(maxExchanges);
  const sid = sessionId ?? getCurrentSession(String(jid).trim())?.sessionId;

  const perJidPath = resolvePrivateLogFilePath(workspaceDir, jid);
  if (!existsSync(perJidPath)) return [];
  try {
    const content = readFileSync(perJidPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    const rows = parsePrivateLogLines(lines, sid);
    return rowsToHistoryMessages(rows.slice(-n));
  } catch (_) {
    return [];
  }
}

/**
 * Read raw exchanges from the private log for a JID that fall within a time window.
 * Returns at most maxSampled items, evenly sampled across the window so the LLM
 * sees a spread rather than just the most-recent messages.
 *
 * @param {string} workspaceDir
 * @param {string} jid
 * @param {number} lookbackDays - How many days back to scan (default 7)
 * @param {number} maxSampled  - Max items to return after sampling (default 20)
 * @returns {Array<{ ts: number, user: string, assistant: string }>}
 */
export function readPrivateExchangesInWindow(workspaceDir, jid, lookbackDays = 7, maxSampled = 20) {
  if (!workspaceDir || typeof workspaceDir !== 'string' || !jid) return [];
  const cutoff = Date.now() - Math.max(1, lookbackDays) * 86400000;
  const perJidPath = resolvePrivateLogFilePath(workspaceDir, jid);
  let rows = [];
  if (existsSync(perJidPath)) {
    try {
      const lines = readFileSync(perJidPath, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (row && typeof row.ts === 'number' && row.ts >= cutoff && row.user && row.assistant) {
            rows.push({
              ts: row.ts,
              user: String(row.user).slice(0, 400),
              assistant: String(row.assistant).slice(0, 400),
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  if (!rows.length) return [];
  const cap = Math.max(1, maxSampled);
  if (rows.length <= cap) return rows;
  const step = rows.length / cap;
  return Array.from({ length: cap }, (_, i) => rows[Math.floor(i * step)]);
}

/**
 * @param {number} ts
 * @param {string} [tz]
 */
export function exchangeLocalDateString(ts, tz) {
  if (!ts) return '';
  const resolvedTz = tz || getResolvedTimezone();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolvedTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(ts));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * @param {string} content
 * @returns {Array<{ ts: number, user: string, assistant: string }>}
 */
export function parseJsonlExchanges(content) {
  const rows = [];
  for (const line of String(content || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row != null && (row.user != null || row.assistant != null)) {
        rows.push({
          ts: row.ts || 0,
          user: String(row.user ?? '').trim(),
          assistant: String(row.assistant ?? '').trim(),
        });
      }
    } catch (_) {}
  }
  return rows;
}

/**
 * @param {Array<{ ts?: number, user?: string, assistant?: string }>} exchanges
 */
export function formatExchangesAsText(exchanges) {
  return exchanges
    .map((ex) => {
      let block = '';
      if (ex.ts) {
        block += `[${new Date(ex.ts).toISOString().replace('T', ' ').slice(0, 19)}]\n`;
      }
      if (ex.source) block += `Log: ${ex.source}\n`;
      if (ex.user) block += `User: ${ex.user}\n`;
      if (ex.assistant) block += `Assistant: ${ex.assistant}\n`;
      return block.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * All calendar days that have chat-log entries in chat-log/private/*.jsonl.
 * @param {string} workspaceDir
 * @returns {Array<{ date: string, lastActivityMs: number }>}
 */
export function collectChatLogDateEntries(workspaceDir) {
  const lastTsByDate = new Map();

  function bump(dateStr, ts) {
    if (!DATE_ONLY_RE.test(dateStr)) return;
    const t = Number(ts) || 0;
    const cur = lastTsByDate.get(dateStr);
    if (cur == null || t > cur) lastTsByDate.set(dateStr, t);
  }

  const chatLogDir = getChatLogDir(workspaceDir);
  const privateDir = join(chatLogDir, PRIVATE_CHAT_DIR);
  if (!existsSync(privateDir) || !statSync(privateDir).isDirectory()) return [];
  for (const fileName of readdirSync(privateDir)) {
    if (!fileName.endsWith('.jsonl')) continue;
    try {
      const rows = parseJsonlExchanges(readFileSync(join(privateDir, fileName), 'utf8'));
      for (const row of rows) {
        const d = exchangeLocalDateString(row.ts);
        bump(d, row.ts);
      }
    } catch (_) {}
  }
  return [...lastTsByDate.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([date, lastActivityMs]) => ({ date, lastActivityMs }));
}

export function collectChatLogDates(workspaceDir) {
  return collectChatLogDateEntries(workspaceDir).map((entry) => entry.date);
}

/**
 * All exchanges on a calendar day from every chat-log/private/*.jsonl file.
 * @param {string} workspaceDir
 * @param {string} dateStr
 * @returns {Array<{ ts: number, user: string, assistant: string, source?: string }>}
 */
export function readChatLogDayExchanges(workspaceDir, dateStr) {
  if (!DATE_ONLY_RE.test(dateStr)) return [];
  const exchanges = [];
  const chatLogDir = getChatLogDir(workspaceDir);
  const privateDir = join(chatLogDir, PRIVATE_CHAT_DIR);
  if (!existsSync(privateDir) || !statSync(privateDir).isDirectory()) return [];
  for (const fileName of readdirSync(privateDir)) {
    if (!fileName.endsWith('.jsonl')) continue;
    const rel = `${CHAT_LOG_DIR}/${PRIVATE_CHAT_DIR}/${fileName}`;
    try {
      for (const row of parseJsonlExchanges(readFileSync(join(privateDir, fileName), 'utf8'))) {
        if (exchangeLocalDateString(row.ts) !== dateStr) continue;
        exchanges.push({ ...row, source: rel });
      }
    } catch (_) {}
  }
  exchanges.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return exchanges;
}

/**
 * Read chat-log exchanges for specific local calendar days (today/yesterday bootstrap).
 * Uses chat-log/private/<logJid>.jsonl when logJid is set; otherwise all private chats for each day.
 * @param {string} workspaceDir
 * @param {string[]} dateStrings - e.g. ['2026-05-28', '2026-05-29']
 * @param {{ logJid?: string, tz?: string }} [opts]
 * @returns {Array<{ date: string, relPath: string, exchanges: Array<{ ts: number, user: string, assistant: string }> }>}
 */
export function readChatLogsForLocalDates(workspaceDir, dateStrings, opts = {}) {
  if (!workspaceDir || !Array.isArray(dateStrings) || dateStrings.length === 0) return [];
  const tz = opts.tz;
  const logJid = opts.logJid != null ? String(opts.logJid).trim() : '';
  const out = [];

  if (logJid) {
    const relPath = privateLogRelPath(logJid);
    const filePath = resolvePrivateLogFilePath(workspaceDir, logJid);
    if (!existsSync(filePath)) return [];
    const dateSet = new Set(dateStrings);
    const byDate = new Map(dateStrings.map((d) => [d, []]));
    try {
      const rows = parseJsonlExchanges(readFileSync(filePath, 'utf8'));
      for (const row of rows) {
        const localDate = exchangeLocalDateString(row.ts, tz);
        if (!dateSet.has(localDate)) continue;
        const list = byDate.get(localDate) || [];
        list.push({ ...row, relPath });
        byDate.set(localDate, list);
      }
    } catch (_) {
      return [];
    }
    for (const dateStr of dateStrings) {
      const exchanges = (byDate.get(dateStr) || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (exchanges.length === 0) continue;
      out.push({ date: dateStr, relPath, exchanges });
    }
    return out;
  }

  for (const dateStr of dateStrings) {
    const exchanges = readChatLogDayExchanges(workspaceDir, dateStr);
    if (exchanges.length === 0) continue;
    out.push({
      date: dateStr,
      relPath: `${CHAT_LOG_DAY_PREFIX}${dateStr}`,
      exchanges,
    });
  }
  return out;
}

/**
 * Last exchange in a private chat log (optionally session-scoped).
 * @returns {{ path: string, lineNumber: number, row: object } | null}
 */
export function getLastPrivateExchangeLocation(workspaceDir, jid, sessionId) {
  if (!workspaceDir || !jid) return null;
  const perJidPath = resolvePrivateLogFilePath(workspaceDir, jid);
  if (!existsSync(perJidPath)) return null;
  const relPath = privateLogRelPath(jid);
  try {
    const lines = readFileSync(perJidPath, 'utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]);
      if (sessionId && row.sessionId !== sessionId) continue;
      return { path: relPath, lineNumber: i + 1, row };
    }
  } catch (_) {}
  return null;
}

/**
 * Move legacy chat-log/YYYY-MM-DD.jsonl files into chat-log/private/<jid>.jsonl.
 * @param {string} workspaceDir
 * @returns {{ files: number, lines: number }}
 */
export function migrateLegacyDatedChatLogs(workspaceDir) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return { files: 0, lines: 0 };
  const chatLogDir = getChatLogDir(workspaceDir);
  if (!existsSync(chatLogDir) || !statSync(chatLogDir).isDirectory()) return { files: 0, lines: 0 };
  const privateDir = join(chatLogDir, PRIVATE_CHAT_DIR);
  if (!existsSync(privateDir)) mkdirSync(privateDir, { recursive: true });

  let files = 0;
  let lines = 0;
  for (const name of readdirSync(chatLogDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const dateStr = name.replace(/\.jsonl$/, '');
    if (!DATE_ONLY_RE.test(dateStr)) continue;
    const legacyPath = join(chatLogDir, name);
    if (!statSync(legacyPath).isFile()) continue;
    try {
      const raw = readFileSync(legacyPath, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          const logJid = row.jid != null && String(row.jid).trim() !== ''
            ? String(row.jid).trim()
            : 'unknown';
          const dest = join(privateDir, logJidToFileBase(logJid) + '.jsonl');
          appendFileSync(dest, JSON.stringify({
            ts: row.ts || 0,
            jid: logJid === 'unknown' ? null : logJid,
            sessionId: row.sessionId != null ? String(row.sessionId) : undefined,
            user: String(row.user ?? '').trim(),
            assistant: String(row.assistant ?? '').trim(),
            ...(row.retrospective ? { retrospective: row.retrospective } : {}),
          }) + '\n', 'utf8');
          lines++;
        } catch (_) {}
      }
      unlinkSync(legacyPath);
      files++;
    } catch (_) {}
  }
  return { files, lines };
}

/**
 * Rename legacy mangled private chat log files to human-readable names
 * (e.g. 123_s_whatsapp_net.jsonl → whatsapp-123.jsonl, 456789.jsonl → telegram-456789.jsonl).
 * @param {string} workspaceDir
 * @param {{ onRenamed?: (oldRelPath: string, newRelPath: string) => void }} [opts]
 * @returns {{ renamed: number }}
 */
export function migratePrivateChatLogFileNames(workspaceDir, opts = {}) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return { renamed: 0 };
  const privateDir = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR);
  if (!existsSync(privateDir) || !statSync(privateDir).isDirectory()) return { renamed: 0 };

  let renamed = 0;
  for (const name of readdirSync(privateDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const oldPath = join(privateDir, name);
    try {
      if (!statSync(oldPath).isFile()) continue;
    } catch (_) {
      continue;
    }
    const oldBase = name.replace(/\.jsonl$/, '');
    const logJid = readLogJidFromPrivateFile(oldPath);
    const newBase = logJidToFileBase(logJid);
    if (newBase === oldBase) continue;
    const newPath = join(privateDir, newBase + '.jsonl');
    const oldRel = `${CHAT_LOG_DIR}/${PRIVATE_CHAT_DIR}/${oldBase}.jsonl`;
    const newRel = `${CHAT_LOG_DIR}/${PRIVATE_CHAT_DIR}/${newBase}.jsonl`;
    try {
      if (existsSync(newPath)) {
        const content = readFileSync(oldPath, 'utf8');
        if (content.trim()) appendFileSync(newPath, content, 'utf8');
        unlinkSync(oldPath);
      } else {
        renameSync(oldPath, newPath);
      }
      opts.onRenamed?.(oldRel, newRel);
      renamed++;
    } catch (_) {}
  }
  return { renamed };
}

/**
 * Merge fields into one JSONL exchange line (1-based lineNumber).
 */
export function patchExchangeRetrospective(workspaceDir, relativePath, lineNumber, patch) {
  if (!workspaceDir || !relativePath || !lineNumber || !patch) return false;
  const filePath = join(workspaceDir, relativePath);
  if (!existsSync(filePath)) return false;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    const idx = lineNumber - 1;
    if (idx < 0 || idx >= lines.length || !lines[idx].trim()) return false;
    const row = JSON.parse(lines[idx]);
    row.retrospective = { ...(row.retrospective || {}), ...patch };
    lines[idx] = JSON.stringify(row);
    const body = lines.join('\n');
    writeFileSync(filePath, body.endsWith('\n') ? body : body + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}
