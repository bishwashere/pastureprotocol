/**
 * Per-agent historical metrics derived from team activity log.
 */

import { parseInternalPairJid } from './team-inbox.js';
import { readTeamActivityWindow } from './team-activity.js';

const METRICS_SKILL_EXCLUDE = new Set(['agent-send']);

function startOfTodayMs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function abbreviateLastActivity(event) {
  const type = String(event?.type || '');
  if (type === 'delegation_start' || type === 'delegation_done' || type === 'delegation_decision') {
    return 'deleg';
  }
  if (type === 'turn_done') return 'done';
  if (type === 'skill_done' || type === 'skill_start') {
    const sid = String(event.skillId || '').trim().toLowerCase();
    if (!sid) return 'skill';
    if (sid === 'memory') return 'mem';
    if (sid === 'browse') return 'brow';
    if (sid === 'agent-send') return 'deleg';
    if (sid.length <= 4) return sid;
    return sid.slice(0, 4);
  }
  if (type === 'skill_error' || type === 'delegation_error') return 'err';
  if (type === 'turn_start') return 'task';
  return '';
}

function parseDurationMs(message) {
  const m = String(message || '').match(/Handled in (\d+)ms/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function formatDurationSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0s';
  const sec = Math.round(n / 100) / 10;
  return sec % 1 === 0 ? `${sec.toFixed(0)}s` : `${sec.toFixed(1)}s`;
}

function isReceivedFromOthers(event, agentId) {
  const inbox = event.details && event.details.inbox;
  if (inbox && inbox.kind === 'received_from') return true;
  const pair = parseInternalPairJid(event.jid);
  return !!(pair && pair.toAgentId === agentId && pair.fromAgentId && pair.fromAgentId !== agentId);
}

export function computeAgentMetrics(agentId, events) {
  const id = String(agentId || '').trim();
  const skillCounts = {};
  const openTurns = [];
  const durations = [];
  let tasksHandled = 0;
  let delegatedOut = 0;
  let receivedFromOthers = 0;
  let tasksToday = 0;
  let lastActivity = '';
  let lastActivityTs = 0;
  const todayStart = startOfTodayMs();

  for (const event of events || []) {
    const type = String(event.type || '');
    const aid = String(event.agentId || '').trim();
    const ts = Number(event.ts) || 0;

    if (aid === id) {
      const label = abbreviateLastActivity(event);
      if (label && ts >= lastActivityTs) {
        lastActivity = label;
        lastActivityTs = ts;
      }
    }

    if (type === 'turn_start') {
      openTurns.push({ agentId: aid, ts: event.ts });
      if (aid === id && isReceivedFromOthers(event, id)) receivedFromOthers++;
    }

    if (type === 'turn_done' && aid === id) {
      tasksHandled++;
      if (ts >= todayStart) tasksToday++;
      const parsed = parseDurationMs(event.message);
      if (parsed != null) {
        durations.push(parsed);
      } else {
        for (let i = openTurns.length - 1; i >= 0; i--) {
          if (openTurns[i].agentId === id) {
            const delta = Number(event.ts) - Number(openTurns[i].ts);
            if (Number.isFinite(delta) && delta >= 0) durations.push(delta);
            openTurns.splice(i, 1);
            break;
          }
        }
      }
    }

    if (type === 'delegation_start' && aid === id) delegatedOut++;

    if (type === 'skill_done' && aid === id) {
      const sid = String(event.skillId || '').trim();
      if (sid && !METRICS_SKILL_EXCLUDE.has(sid)) {
        skillCounts[sid] = (skillCounts[sid] || 0) + 1;
      }
    }
  }

  const averageExecutionMs = durations.length
    ? Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length)
    : 0;

  const mostUsedSkills = Object.entries(skillCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([skillId, count]) => ({ skillId, count }));

  return {
    agentId: id,
    tasksHandled,
    delegatedOut,
    receivedFromOthers,
    tasksToday,
    lastActivity,
    averageExecutionMs,
    averageExecutionSec: formatDurationSec(averageExecutionMs),
    mostUsedSkills,
    sampleTurns: durations.length,
  };
}

export function computeAllAgentMetrics(events, agentIds = []) {
  const ids = new Set((agentIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  for (const event of events || []) {
    if (event.agentId) ids.add(String(event.agentId).trim());
    if (event.targetAgentId) ids.add(String(event.targetAgentId).trim());
  }
  const agents = {};
  for (const id of ids) {
    agents[id] = computeAgentMetrics(id, events);
  }
  return { agents, eventCount: (events || []).length };
}

export function readAgentMetrics({ agentId, agentIds = [], since, until } = {}) {
  let events = readTeamActivityWindow();
  const sinceMs = Number(since);
  const untilMs = Number(until);
  if (Number.isFinite(sinceMs) || Number.isFinite(untilMs)) {
    events = events.filter((event) => {
      const ts = Number(event.ts) || 0;
      if (Number.isFinite(sinceMs) && ts < sinceMs) return false;
      if (Number.isFinite(untilMs) && ts > untilMs) return false;
      return true;
    });
  }
  const all = computeAllAgentMetrics(events, agentIds);
  const id = String(agentId || '').trim();
  if (!id) return { ...all, updatedAt: Date.now() };
  return {
    agent: all.agents[id] || computeAgentMetrics(id, events),
    agents: all.agents,
    eventCount: all.eventCount,
    updatedAt: Date.now(),
  };
}
