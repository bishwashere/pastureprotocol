import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getTeamActivityLogPath } from '../util/paths.js';

const MAX_READ_BYTES = 256 * 1024;
const MAX_METRICS_READ_BYTES = 2 * 1024 * 1024;
const MAX_RETURN_EVENTS = 200;
const MAX_METRICS_EVENTS = 20000;

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

function normalizeActivityRow(row, fallbackId) {
  const ts = Number(row?.ts);
  if (!Number.isFinite(ts)) return null;
  const details = row?.details && typeof row.details === 'object' ? row.details : null;
  return {
    id: row.id || fallbackId,
    ts,
    type: row.type || 'event',
    agentId: row.agentId || '',
    targetAgentId: row.targetAgentId || '',
    skillId: row.skillId || '',
    action: row.action || '',
    status: row.status || '',
    message: row.message || '',
    title: row.title || (details && details.title) || '',
    depth: Number.isFinite(Number(row.depth)) ? Number(row.depth) : null,
    jid: row.jid || '',
    missionId: String(row.missionId || (details && details.missionId) || ''),
    details,
  };
}

export function readTeamActivityWindow({ maxBytes = MAX_METRICS_READ_BYTES, maxEvents = MAX_METRICS_EVENTS } = {}) {
  const logPath = getTeamActivityLogPath();
  if (!existsSync(logPath)) return [];
  const maxItems = Math.max(1, Math.min(MAX_METRICS_EVENTS, Math.floor(Number(maxEvents) || MAX_METRICS_EVENTS)));
  const byteLimit = Math.max(MAX_READ_BYTES, Math.min(MAX_METRICS_READ_BYTES, Math.floor(Number(maxBytes) || MAX_METRICS_READ_BYTES)));
  try {
    const raw = readFileSync(logPath, 'utf8');
    const tail = trimForTail(raw, byteLimit);
    const lines = tail.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch (_) {
        continue;
      }
      const normalized = normalizeActivityRow(row, `${i}`);
      if (!normalized) continue;
      out.push(normalized);
    }
    out.sort((a, b) => a.ts - b.ts);
    if (out.length > maxItems) return out.slice(-maxItems);
    return out;
  } catch (_) {
    return [];
  }
}

function normalizeDetails(details) {
  if (!details || typeof details !== 'object') return null;
  try {
    // Ensure details are JSON-safe and bounded.
    const raw = JSON.stringify(details);
    if (!raw || raw.length > 24 * 1024) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
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
      title: event.title != null ? String(event.title).trim() : '',
      depth: Number.isFinite(event.depth) ? Number(event.depth) : null,
      missionId: event.missionId != null ? String(event.missionId).trim() : '',
      jid: event.jid != null ? String(event.jid).trim() : '',
      details: normalizeDetails(event.details),
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
      const normalized = normalizeActivityRow(row, `${ts}-${i}`);
      if (!normalized) continue;
      out.push(normalized);
      if (out.length >= maxItems) break;
    }
    return out.reverse();
  } catch (_) {
    return [];
  }
}

/**
 * Remove all activity log entries that belong to a specific mission.
 * Used on mission delete for missions that have been tagged with missionId going forward.
 */
export function pruneTeamActivityForMission(missionId) {
  const id = String(missionId || '').trim();
  if (!id) return { kept: 0, pruned: 0 };
  const logPath = getTeamActivityLogPath();
  if (!existsSync(logPath)) return { kept: 0, pruned: 0 };
  try {
    const raw = readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const kept = [];
    let pruned = 0;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        const rowMissionId = String(row?.missionId || row?.details?.missionId || '');
        if (rowMissionId && rowMissionId === id) {
          pruned++;
        } else {
          kept.push(line);
        }
      } catch (_) {
        kept.push(line);
      }
    }
    if (pruned > 0) writeFileSync(logPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    return { kept: kept.length, pruned };
  } catch (_) {
    return { kept: 0, pruned: 0 };
  }
}

/**
 * Prune the team-activity log, keeping only entries from today onwards.
 * Called on mission delete so stale inbox/outbox history doesn't accumulate.
 */
export function pruneTeamActivityLogToToday() {
  const logPath = getTeamActivityLogPath();
  if (!existsSync(logPath)) return { kept: 0, pruned: 0 };
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = startOfToday.getTime();
  try {
    const raw = readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const kept = [];
    let pruned = 0;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (Number(row?.ts) >= cutoff) {
          kept.push(line);
        } else {
          pruned++;
        }
      } catch (_) {
        kept.push(line);
      }
    }
    writeFileSync(logPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    return { kept: kept.length, pruned };
  } catch (_) {
    return { kept: 0, pruned: 0 };
  }
}
