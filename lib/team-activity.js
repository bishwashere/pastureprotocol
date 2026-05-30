import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { getTeamActivityLogPath } from './paths.js';

const MAX_READ_BYTES = 256 * 1024;
const MAX_RETURN_EVENTS = 200;

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 80;
  return Math.max(1, Math.min(MAX_RETURN_EVENTS, Math.floor(n)));
}

function trimForTail(text, maxBytes) {
  if (!text) return '';
  if (text.length <= maxBytes) return text;
  const start = text.length - maxBytes;
  const slice = text.slice(start);
  const nl = slice.indexOf('\n');
  return nl >= 0 ? slice.slice(nl + 1) : slice;
}

export function logTeamActivity(event = {}) {
  try {
    const logPath = getTeamActivityLogPath();
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const row = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      ts: now,
      type: typeof event.type === 'string' && event.type.trim() ? event.type.trim() : 'event',
      agentId: event.agentId != null ? String(event.agentId).trim() : '',
      targetAgentId: event.targetAgentId != null ? String(event.targetAgentId).trim() : '',
      skillId: event.skillId != null ? String(event.skillId).trim() : '',
      action: event.action != null ? String(event.action).trim() : '',
      status: event.status != null ? String(event.status).trim() : '',
      message: event.message != null ? String(event.message).trim() : '',
      depth: Number.isFinite(event.depth) ? Number(event.depth) : null,
      jid: event.jid != null ? String(event.jid).trim() : '',
    };
    appendFileSync(logPath, JSON.stringify(row) + '\n', 'utf8');
  } catch (_) {
    // Activity logging must never break agent execution.
  }
}

export function readTeamActivity({ since = 0, limit = 80 } = {}) {
  const logPath = getTeamActivityLogPath();
  if (!existsSync(logPath)) return [];
  const sinceTs = Number.isFinite(Number(since)) ? Number(since) : 0;
  const maxItems = clampLimit(limit);
  try {
    const raw = readFileSync(logPath, 'utf8');
    const tail = trimForTail(raw, MAX_READ_BYTES);
    const lines = tail.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch (_) {
        continue;
      }
      const ts = Number(row?.ts);
      if (!Number.isFinite(ts)) continue;
      if (ts <= sinceTs) break;
      out.push({
        id: row.id || `${ts}-${i}`,
        ts,
        type: row.type || 'event',
        agentId: row.agentId || '',
        targetAgentId: row.targetAgentId || '',
        skillId: row.skillId || '',
        action: row.action || '',
        status: row.status || '',
        message: row.message || '',
        depth: Number.isFinite(Number(row.depth)) ? Number(row.depth) : null,
        jid: row.jid || '',
      });
      if (out.length >= maxItems) break;
    }
    return out.reverse();
  } catch (_) {
    return [];
  }
}
