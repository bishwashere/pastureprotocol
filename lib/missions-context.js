/**
 * Inject active Missions into chat turns when the user's message relates to ongoing work.
 * Projects tracker is a lightweight catalog; Missions hold objectives, plan, and tasks.
 */

import { listMissions } from './missions.js';
import { listProjects } from './projects-db.js';
import { pickFocusedProject } from './projects-context.js';

function summarize(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function historyBlob(historyMessages) {
  return (historyMessages || [])
    .slice(-8)
    .map((m) => String(m?.content || ''))
    .join('\n');
}

function combinedUserContext(userText, historyMessages) {
  return `${String(userText || '')}\n${historyBlob(historyMessages)}`.toLowerCase();
}

/** User is asking to learn, investigate, or continue work — not a casual chat. */
export function isWorkOrDiscoveryRequest(userText) {
  const t = String(userText || '').toLowerCase();
  return (
    /\bfind\s+out\b/.test(t) ||
    /\blook\s+into\b/.test(t) ||
    /\blearn\s+(more\s+)?about\b/.test(t) ||
    /\btell\s+me\s+(more\s+)?about\b/.test(t) ||
    /\bwhat\s+is\s+(this|it|that|the)\b/.test(t) ||
    /\bwhat(?:'s| is)\s+.+\s+about\b/.test(t) ||
    /\ball\s+about\b/.test(t) ||
    /\b(this|that|the)\s+project\b/.test(t) ||
    /\bcontinue\b.*\b(mission|work|task)\b/.test(t) ||
    /\bwork\s+on\b/.test(t) ||
    /\bstatus\b.*\b(mission|project)\b/.test(t)
  );
}

function missionMatchesText(mission, blob) {
  if (!mission || !blob) return false;
  const title = String(mission.title || '').trim().toLowerCase();
  const objective = String(mission.objective || '').trim().toLowerCase();
  if (title.length >= 3 && blob.includes(title)) return true;
  if (objective.length >= 8 && blob.includes(objective.slice(0, Math.min(40, objective.length)))) return true;
  const words = title.split(/\s+/).filter((w) => w.length >= 4);
  if (words.length && words.every((w) => blob.includes(w))) return true;
  return false;
}

function projectForMission(mission, projects) {
  const pid = Number(mission?.projectId);
  if (Number.isFinite(pid) && pid > 0) {
    const direct = (projects || []).find((p) => Number(p.id) === pid);
    if (direct) return direct;
  }
  const blob = `${mission.title} ${mission.objective}`.toLowerCase();
  return (projects || []).find((p) => {
    const n = String(p.name || '').trim().toLowerCase();
    return n.length >= 3 && blob.includes(n);
  }) || null;
}

/**
 * Pick the Mission the user's message is about (if any).
 *
 * Resolution order — same data the dashboard UI sees (listMissions),
 * no status filtering when the user mentions a mission/project by name:
 *  1. Explicit name/project match against ALL missions (the UI shows all of them).
 *  2. Vague "continue work" fallback — only non-completed missions.
 * @param {{ userText?: string, historyMessages?: Array, agentId?: string }} opts
 */
export function resolveMissionForUserTurn(opts = {}) {
  const userText = opts.userText || '';
  const historyMessages = opts.historyMessages || [];
  const agentId = String(opts.agentId || 'main').trim() || 'main';
  const blob = combinedUserContext(userText, historyMessages);

  let missions = [];
  let projects = [];
  try {
    missions = listMissions().missions || [];
    projects = listProjects();
  } catch (_) {
    return null;
  }
  if (!missions.length) return null;

  const mostRecent = (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);

  // 1. User mentions a project name → match against ALL missions (same as UI).
  const focusedProject = pickFocusedProject(projects, userText, historyMessages);
  if (focusedProject) {
    const pname = String(focusedProject.name || '').trim().toLowerCase();
    const byProject = missions.filter((g) => {
      const gBlob = `${g.title} ${g.objective}`.toLowerCase();
      return pname && (gBlob.includes(pname) || pname.includes(String(g.title || '').trim().toLowerCase()));
    });
    if (byProject.length) {
      byProject.sort(mostRecent);
      return byProject[0];
    }
  }

  // 2. User mentions a mission title/objective → match against ALL missions.
  const byMention = missions.filter((g) => missionMatchesText(g, blob));
  if (byMention.length) {
    byMention.sort(mostRecent);
    return byMention[0];
  }

  // 3. Vague work/discovery request — fall back to non-completed missions only.
  if (isWorkOrDiscoveryRequest(userText)) {
    const nonCompleted = missions.filter((g) => String(g.status || 'active').toLowerCase() !== 'completed');
    if (!nonCompleted.length) return null;
    const owned = nonCompleted.filter((g) => String(g.ownerAgentId || '').trim() === agentId);
    const running = owned.find((g) => !!g.running);
    if (running) return running;
    if (owned.length === 1) return owned[0];
    if (nonCompleted.length === 1) return nonCompleted[0];
  }

  return null;
}

function formatPlanSteps(mission) {
  const steps = mission?.currentPlan?.steps || [];
  if (!steps.length) return '';
  return steps
    .slice(0, 12)
    .map((s) => `- [${s.status || 'todo'}] ${s.title}`)
    .join('\n');
}

function formatTasksBrief(tasks, depth = 0) {
  if (!Array.isArray(tasks) || depth > 3) return '';
  return tasks
    .slice(0, 10)
    .map((sg) => {
      const indent = '  '.repeat(depth);
      const assignee = sg.assignee ? ` (assignee: ${sg.assignee})` : '';
      const line = `${indent}- [${sg.status || 'todo'}] ${sg.title}${assignee}`;
      const kids = formatTasksBrief(sg.tasks, depth + 1);
      return kids ? `${line}\n${kids}` : line;
    })
    .join('\n');
}

function countTasksByStatus(tasks) {
  const counts = {};
  function walk(list) {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      const s = String(t.status || 'todo').toLowerCase();
      counts[s] = (counts[s] || 0) + 1;
      walk(t.tasks);
    }
  }
  walk(tasks);
  return counts;
}

function formatTaskStatusSummary(tasks) {
  const counts = countTasksByStatus(tasks);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return '';
  const parts = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([status, count]) => `${status}: ${count}`);
  return `Total tasks: ${total} — ${parts.join(', ')}`;
}

/**
 * System prompt block for the Mission tied to this user message.
 */
export function buildMissionsContextBlock(opts = {}) {
  try {
    const mission = resolveMissionForUserTurn(opts);
    if (!mission) return '';

    const projects = listProjects();
    const project = projectForMission(mission, projects);
    const projectUrl = project?.url ? String(project.url).trim() : '';
    const steps = formatPlanSteps(mission);
    const tasks = formatTasksBrief(mission.tasks || []);
    const workRequest = isWorkOrDiscoveryRequest(opts.userText || '');

    const statusLabel = String(mission.status || 'active').toLowerCase();
    const lines = [
      `\n\n# Mission: ${mission.title || mission.id} (${statusLabel})`,
      `When the user asks about **${mission.title || mission.id}**, answer from this data — the same data the dashboard shows.`,
      `Mission ID: ${mission.id}`,
      `Owner: ${mission.ownerAgentId || 'main'}`,
      `Status: ${mission.status} | Progress: ${mission.progress?.pct ?? 0}%`,
      `Objective: ${mission.objective || mission.title || ''}`,
    ];
    if (project) {
      lines.push(`Related Projects tracker entry: **${project.name}**${projectUrl ? ` (${projectUrl})` : ''}`);
    }
    if (mission.lastActivity) lines.push(`Last activity: ${mission.lastActivity}`);
    if (steps) lines.push(`Plan steps:\n${steps}`);
    const statusSummary = formatTaskStatusSummary(mission.tasks || []);
    if (statusSummary) lines.push(statusSummary);
    if (tasks) lines.push(`Tasks:\n${tasks}`);
    if (workRequest) {
      lines.push(
        '',
        '**How to handle this message:**',
        '- Treat this as continuing the mission above — use tools for the next plan step or task, not idle clarification.',
        '- Use the related project URL when relevant; ask the user to confirm only after you report what you found.',
        '- You may run the mission on the next autonomous tick; for chat, answer from what you learn now.',
      );
    }
    return lines.join('\n');
  } catch (err) {
    console.log('[missions-context] failed:', err?.message || err);
    return '';
  }
}

/** Label for agent context currentMission field. */
export function missionLabelForAgentContext(mission) {
  if (!mission) return '';
  return summarize(mission.title || mission.objective, 120);
}

const RESEARCH_SKILL_IDS = ['browse', 'github', 'memory', 'go-read', 'read', 'search'];

/**
 * Intent-planner hint when the user wants discovery/work and a Mission matches.
 * Replaces project-specific intent overrides.
 */
export function getMissionsDiscoveryIntentHint(userText, historyMessages, enabledSkillIds, agentId = 'main') {
  if (!isWorkOrDiscoveryRequest(userText)) return null;
  const mission = resolveMissionForUserTurn({ userText, historyMessages, agentId });
  if (!mission) return null;
  const skills = (enabledSkillIds || []).filter((id) => RESEARCH_SKILL_IDS.includes(id));
  if (!skills.length) return null;
  const title = String(mission.title || mission.objective || mission.id).trim();
  return {
    mode: 'tool',
    skills,
    plan: `Continue mission "${title}": use tools to advance the mission before asking the user to pick repo/path/source.`,
    answer_style: 'normal',
  };
}
