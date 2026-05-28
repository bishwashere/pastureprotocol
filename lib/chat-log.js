/**
 * Chat log: append each user/assistant exchange to workspace/chat-log/YYYY-MM-DD.jsonl.
 * Used so memory search can pull from conversation history ("Remember what we said yesterday?").
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { filterRowsForSession, getCurrentSession } from './chat-session.js';

const CHAT_LOG_DIR = 'chat-log';
const PRIVATE_CHAT_DIR = 'private';

/**
 * @param {string} workspaceDir
 * @returns {string} Absolute path to chat-log dir
 */
function getChatLogDir(workspaceDir) {
  return join(workspaceDir, CHAT_LOG_DIR);
}

/** Safe filename for jid (e.g. Telegram id or WhatsApp jid). */
function safeJidForFile(jid) {
  if (jid == null || String(jid).trim() === '') return 'unknown';
  return String(jid).trim().replace(/[^0-9a-zA-Z._-]/g, '_') || 'unknown';
}

/**
 * Append one exchange. When jid is present, appends to chat-log/private/<jid>.jsonl (one file per chat, so we can just tail last N). Otherwise appends to chat-log/YYYY-MM-DD.jsonl.
 * @param {string} workspaceDir
 * @param {{ user: string, assistant: string, timestampMs: number, jid?: string, sessionId?: string }} exchange
 * @returns {{ path: string, lineNumber: number }} Relative path and 1-based line number of this exchange
 */
export function appendExchange(workspaceDir, exchange) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('workspaceDir is required');
  }
  const { user, assistant, timestampMs, jid, sessionId } = exchange;
  const line = JSON.stringify({
    ts: timestampMs,
    jid: jid ?? null,
    sessionId: sessionId != null ? String(sessionId) : undefined,
    user: String(user ?? '').trim(),
    assistant: String(assistant ?? '').trim(),
  }) + '\n';

  if (jid != null && String(jid).trim() !== '') {
    const dir = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fileName = safeJidForFile(jid) + '.jsonl';
    const filePath = join(dir, fileName);
    appendFileSync(filePath, line, 'utf8');
    const content = readFileSync(filePath, 'utf8');
    const lineNumber = content.split('\n').filter((l) => l.trim()).length;
    return { path: CHAT_LOG_DIR + '/' + PRIVATE_CHAT_DIR + '/' + fileName, lineNumber };
  }

  const date = new Date(timestampMs);
  const dateStr =
    date.getFullYear() +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0');
  const dir = getChatLogDir(workspaceDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, dateStr + '.jsonl');
  appendFileSync(filePath, line, 'utf8');
  const content = readFileSync(filePath, 'utf8');
  const lineNumber = content.split('\n').filter((l) => l.trim()).length;
  return { path: CHAT_LOG_DIR + '/' + dateStr + '.jsonl', lineNumber };
}

/**
 * List private chat jids that have activity, sorted by last activity (newest first).
 * File names are safeJidForFile(jid), so we return the raw jid when we can (from last line of each file we don't store jid in filename). We return the file basename without .jsonl as the "jid" for Telegram (numeric); for WhatsApp the filename is mangled so callers may not use this for send. Used by Tide to find "most recent" chat when auto-detecting.
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
    const jid = name; // safeJidForFile(jid) produced this; for numeric Telegram ids it's the same
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
  const perJidPath = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR, safeJidForFile(jid) + '.jsonl');
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
export function readLastGroupExchanges(workspaceDir, groupJid, maxExchanges = 5, sessionId) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return [];
  const n = Math.max(1, Math.floor(Number(maxExchanges)) || 5);
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
 * Read the last N exchanges for a private/DM jid. Uses per-jid file when present (chat-log/private/<jid>.jsonl) and just takes the last N lines for context. Falls back to scanning date-based files if no per-jid file yet (e.g. old logs).
 * @param {string} workspaceDir
 * @param {string} jid - Chat id (e.g. Telegram chat id or WhatsApp jid)
 * @param {number} maxExchanges - Max number of user+assistant pairs to return (configurable; rough context is enough)
 * @returns {Array<{ role: string, content: string }>} Messages in LLM order (user, assistant, user, ...)
 */
export function readLastPrivateExchanges(workspaceDir, jid, maxExchanges = 5, sessionId) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return [];
  const n = Math.max(1, Math.floor(Number(maxExchanges)) || 5);
  const sid = sessionId ?? getCurrentSession(String(jid).trim())?.sessionId;

  const perJidPath = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR, safeJidForFile(jid) + '.jsonl');
  if (existsSync(perJidPath)) {
    try {
      const content = readFileSync(perJidPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      const rows = parsePrivateLogLines(lines, sid);
      return rowsToHistoryMessages(rows.slice(-n));
    } catch (_) {
      return [];
    }
  }

  const wantJid = jid == null ? null : String(jid).trim();
  const dir = getChatLogDir(workspaceDir);
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
          if (row == null || (row.user == null && row.assistant == null)) continue;
          const rowJid = row.jid == null ? null : String(row.jid).trim();
          if (rowJid !== wantJid) continue;
          all.push({
            ts: row.ts || 0,
            sessionId: row.sessionId,
            user: String(row.user ?? '').trim(),
            assistant: String(row.assistant ?? '').trim(),
          });
        } catch (_) {}
      }
    } catch (_) {}
  }
  const filtered = filterRowsForSession(
    all.map((row) => ({
      ts: row.ts || 0,
      sessionId: row.sessionId,
      user: row.user,
      assistant: row.assistant,
    })),
    sid
  );
  filtered.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return rowsToHistoryMessages(filtered.slice(-n));
}
