/**
 * Inject active Goals into chat turns when the user's message relates to ongoing work.
 * Projects tracker is a lightweight catalog; Goals hold objectives, plan, and subgoals.
 */

import { listGoals } from './goals.js';
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
    /\bcontinue\b.*\b(goal|work|task)\b/.test(t) ||
    /\bwork\s+on\b/.test(t) ||
    /\bstatus\b.*\b(goal|project)\b/.test(t)
  );
}

function goalMatchesText(goal, blob) {
  if (!goal || !blob) return false;
  const title = String(goal.title || '').trim().toLowerCase();
  const objective = String(goal.objective || '').trim().toLowerCase();
  if (title.length >= 3 && blob.includes(title)) return true;
  if (objective.length >= 8 && blob.includes(objective.slice(0, Math.min(40, objective.length)))) return true;
  const words = title.split(/\s+/).filter((w) => w.length >= 4);
  if (words.length && words.every((w) => blob.includes(w))) return true;
  return false;
}

function projectForGoal(goal, projects) {
  const blob = `${goal.title} ${goal.objective}`.toLowerCase();
  return (projects || []).find((p) => {
    const n = String(p.name || '').trim().toLowerCase();
    return n.length >= 3 && blob.includes(n);
  }) || null;
}

/**
 * Pick the Goal the user's message is about (if any).
 * @param {{ userText?: string, historyMessages?: Array, agentId?: string }} opts
 */
export function resolveGoalForUserTurn(opts = {}) {
  const userText = opts.userText || '';
  const historyMessages = opts.historyMessages || [];
  const agentId = String(opts.agentId || 'main').trim() || 'main';
  const blob = combinedUserContext(userText, historyMessages);

  let goals = [];
  let projects = [];
  try {
    goals = listGoals().goals || [];
    projects = listProjects();
  } catch (_) {
    return null;
  }

  const active = goals.filter((g) => String(g.status || 'active').toLowerCase() === 'active');
  if (!active.length) return null;

  const focusedProject = pickFocusedProject(projects, userText, historyMessages);
  if (focusedProject) {
    const pname = String(focusedProject.name || '').trim().toLowerCase();
    const byProject = active.filter((g) => {
      const gBlob = `${g.title} ${g.objective}`.toLowerCase();
      return pname && (gBlob.includes(pname) || pname.includes(String(g.title || '').trim().toLowerCase()));
    });
    if (byProject.length) {
      byProject.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
      return byProject[0];
    }
  }

  const byMention = active.filter((g) => goalMatchesText(g, blob));
  if (byMention.length) {
    byMention.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return byMention[0];
  }

  if (isWorkOrDiscoveryRequest(userText)) {
    const owned = active.filter((g) => String(g.ownerAgentId || '').trim() === agentId);
    const running = owned.find((g) => !!g.running);
    if (running) return running;
    if (owned.length === 1) return owned[0];
    if (active.length === 1) return active[0];
  }

  return null;
}

function formatPlanSteps(goal) {
  const steps = goal?.currentPlan?.steps || [];
  if (!steps.length) return '';
  return steps
    .slice(0, 12)
    .map((s) => `- [${s.status || 'todo'}] ${s.title}`)
    .join('\n');
}

function formatSubgoalsBrief(subgoals, depth = 0) {
  if (!Array.isArray(subgoals) || depth > 3) return '';
  return subgoals
    .slice(0, 10)
    .map((sg) => {
      const indent = '  '.repeat(depth);
      const line = `${indent}- [${sg.status || 'todo'}] ${sg.title}`;
      const kids = formatSubgoalsBrief(sg.subgoals, depth + 1);
      return kids ? `${line}\n${kids}` : line;
    })
    .join('\n');
}

/**
 * System prompt block for the Goal tied to this user message.
 */
export function buildGoalsContextBlock(opts = {}) {
  try {
    const goal = resolveGoalForUserTurn(opts);
    if (!goal) return '';

    const projects = listProjects();
    const project = projectForGoal(goal, projects);
    const projectUrl = project?.url ? String(project.url).trim() : '';
    const steps = formatPlanSteps(goal);
    const subgoals = formatSubgoalsBrief(goal.subgoals || []);
    const workRequest = isWorkOrDiscoveryRequest(opts.userText || '');

    const lines = [
      '\n\n# Active goal (persistent work)',
      `When the user asks to find out, learn about, or continue **this** work, they mean Goal **${goal.title || goal.id}** — not a generic repo/path quiz.`,
      `Goal ID: ${goal.id}`,
      `Owner: ${goal.ownerAgentId || 'main'}`,
      `Status: ${goal.status} | Progress: ${goal.progress?.pct ?? 0}%`,
      `Objective: ${goal.objective || goal.title || ''}`,
    ];
    if (project) {
      lines.push(`Related Projects tracker entry: **${project.name}**${projectUrl ? ` (${projectUrl})` : ''}`);
    }
    if (goal.lastActivity) lines.push(`Last activity: ${goal.lastActivity}`);
    if (steps) lines.push(`Plan steps:\n${steps}`);
    if (subgoals) lines.push(`Subgoals:\n${subgoals}`);
    if (workRequest) {
      lines.push(
        '',
        '**How to handle this message:**',
        '- Treat this as continuing the goal above — use tools as needed, then reply with **one coherent summary** (not a per-tool report).',
        '- Lead with findings; do not open with tool failures or empty memory/GitHub checks.',
        '- Only ask the user to confirm after you state what you found; you may run the goal on the next autonomous tick.',
      );
    }
    return lines.join('\n');
  } catch (err) {
    console.log('[goals-context] failed:', err?.message || err);
    return '';
  }
}

/** Label for agent context currentGoal field. */
export function goalLabelForAgentContext(goal) {
  if (!goal) return '';
  return summarize(goal.title || goal.objective, 120);
}

const RESEARCH_SKILL_IDS = ['browse', 'github', 'memory', 'go-read', 'read', 'search'];

/**
 * Intent-planner hint when the user wants discovery/work and a Goal matches.
 * Replaces project-specific intent overrides.
 */
export function getGoalsDiscoveryIntentHint(userText, historyMessages, enabledSkillIds, agentId = 'main') {
  if (!isWorkOrDiscoveryRequest(userText)) return null;
  const goal = resolveGoalForUserTurn({ userText, historyMessages, agentId });
  if (!goal) return null;
  const skills = (enabledSkillIds || []).filter((id) => RESEARCH_SKILL_IDS.includes(id));
  if (!skills.length) return null;
  const title = String(goal.title || goal.objective || goal.id).trim();
  return {
    mode: 'tool',
    skills,
    plan: `Continue goal "${title}": use tools, then one coherent user-facing summary (no per-tool failure sections).`,
    answer_style: 'normal',
  };
}
