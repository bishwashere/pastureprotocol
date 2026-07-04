/**
 * Dashboard Projects tracker — lightweight catalog for agents.
 * Ongoing work, objectives, and tool use live in Missions (see missions-context.js).
 */

import { listProjects, parseProjectConnectors } from './projects-db.js';

const MAX_PROJECTS = 30;

function summarize(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function historyBlob(historyMessages) {
  return (historyMessages || [])
    .slice(-8)
    .map((m) => String(m?.content || ''))
    .join('\n')
    .toLowerCase();
}

export function isProjectDiscoveryRequest(userText) {
  const t = String(userText || '').toLowerCase();
  return (
    /\bfind\s+out\b/.test(t) ||
    /\bwhat\s+is\s+(this|it|that|the)\s*(project)?\b/.test(t) ||
    /\ball\s+about\b/.test(t) ||
    /\b(this|that|the)\s+project\b/.test(t)
  );
}

export function wantsProjectDetail(userText) {
  return isProjectDiscoveryRequest(userText) || /\b(this|that|the)\s+project\b/.test(String(userText || '').toLowerCase());
}

export function pickFocusedProject(projects, userText, historyMessages = []) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return null;
  const ut = String(userText || '').toLowerCase();
  const hist = historyBlob(historyMessages);

  const byName = list.filter((p) => {
    const n = String(p.name || '').trim().toLowerCase();
    return n && (ut.includes(n) || hist.includes(n));
  });
  if (byName.length) return byName[0];

  if (wantsProjectDetail(userText)) {
    const inHist = list.filter((p) => {
      const n = String(p.name || '').trim().toLowerCase();
      return n && hist.includes(n);
    });
    if (inHist.length === 1) return inHist[0];
    if (list.length === 1) return list[0];
  }

  if (isProjectDiscoveryRequest(userText) && list.length === 1) return list[0];
  return null;
}

export function resolveFocusedProjectForTurn({ userText = '', historyMessages = [] } = {}) {
  try {
    return pickFocusedProject(listProjects(), userText, historyMessages);
  } catch (_) {
    return null;
  }
}

export function getProjectTeamId(project) {
  return String(project?.team_id || project?.teamId || '').trim();
}

export function listProjectsForTeam(teamId) {
  const id = String(teamId || '').trim();
  if (!id) return [];
  try {
    return listProjects().filter((project) => getProjectTeamId(project) === id);
  } catch (_) {
    return [];
  }
}

export function buildProjectTeamGateReply({
  agentId = 'main',
  agentTeamId = '',
  focusedProject = null,
  focusedProjectTeamId = '',
} = {}) {
  const teamId = String(agentTeamId || '').trim();
  if (!teamId) {
    return `[Pasture] Multi-agent work is paused because agent "${agentId}" is not assigned to a team. Assign the agent to a team first.`;
  }
  const teamProjects = listProjectsForTeam(teamId);
  if (!teamProjects.length) {
    return `[Pasture] Multi-agent work is paused because team "${teamId}" does not have a project assigned yet. Assign a project to this team first.`;
  }
  if (focusedProject && !focusedProjectTeamId) {
    const name = String(focusedProject.name || focusedProject.id || 'this project').trim();
    return `[Pasture] Multi-agent work is paused because "${name}" is not assigned to a team. That is allowed, but team delegation only runs for projects assigned to this agent's team.`;
  }
  if (focusedProject && focusedProjectTeamId && focusedProjectTeamId !== teamId) {
    const name = String(focusedProject.name || focusedProject.id || 'this project').trim();
    return `[Pasture] Multi-agent work is paused because "${name}" is assigned to team "${focusedProjectTeamId}", but agent "${agentId}" belongs to team "${teamId}". Switch to an agent on that team or reassign the project.`;
  }
  const names = teamProjects.slice(0, 5).map((project) => String(project.name || '').trim()).filter(Boolean);
  const suffix = names.length ? ` Projects for this team: ${names.join(', ')}.` : '';
  return `[Pasture] Multi-agent work needs a project. Mention or select a project assigned to team "${teamId}" before delegating work.${suffix}`;
}

/** Format MongoDB collection hints as a compact bullet list for the system prompt. */
function formatMongoHints(collections) {
  if (!collections || typeof collections !== 'object') return '';
  const entries = Object.entries(collections).filter(([, v]) => v);
  if (!entries.length) return '';
  return entries
    .slice(0, 10)
    .map(([key, col]) => {
      // Keys are sometimes long descriptions; truncate after the first colon or 60 chars
      const shortKey = key.split(':')[0].trim().slice(0, 60);
      return `    - \`${col}\` — ${shortKey}`;
    })
    .join('\n');
}

export function formatProjectsForPrompt(projects) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) {
    return 'No projects in the dashboard Projects tracker yet (user can add them on the Projects page).';
  }
  return list.slice(0, MAX_PROJECTS).map((p, i) => {
    const name = String(p.name || 'Untitled').trim();
    const desc = summarize(p.description, 160);
    const url = String(p.url || '').trim();
    const setup = summarize(p.setup_notes, 120);
    let line = `${i + 1}. **${name}**`;
    if (desc) line += ` — ${desc}`;
    if (url) line += ` — ${url}`;
    if (setup) line += ` — setup: ${setup}`;

    // Connector hints — show MongoDB if configured so the agent reaches for the skill
    try {
      const connectors = parseProjectConnectors(p.connectors_json);
      if (connectors?.mongodb?.uri) {
        line += `\n   - MongoDB connector configured (use \`mongodb_project_health\` or \`mongodb_query\` for live data)`;
        const hints = formatMongoHints(connectors.mongodb.collections);
        if (hints) line += `\n   - Collections:\n${hints}`;
      }
    } catch (_) {}

    return line;
  }).join('\n');
}

export function formatProjectsProfileLine() {
  try {
    const projects = listProjects();
    if (!projects.length) return '';
    const names = projects.slice(0, 12).map((p) => {
      const name = String(p.name || 'Untitled').trim();
      const desc = summarize(p.description, 60);
      return desc ? `${name} (${desc})` : name;
    });
    const more = projects.length > 12 ? ` and ${projects.length - 12} more` : '';
    return `You have ${projects.length} project${projects.length === 1 ? '' : 's'} in the dashboard Projects tracker: ${names.join(', ')}${more}.`;
  } catch (_) {
    return '';
  }
}

/**
 * Short pointer when delegating — full work context comes from Missions block.
 */
export function enrichMessageWithProjectContext(userText, historyMessages = []) {
  const text = String(userText || '').trim();
  if (!text) return text;
  try {
    const projects = listProjects();
    // Enrich whenever a project name is explicitly mentioned, not only for "this project"-style queries.
    const focus = pickFocusedProject(projects, text, historyMessages);
    if (!focus) return text;
    const name = String(focus.name || '').trim();
    return `${text}\n\n[Projects tracker: "${name}". Answer from mission task data only — use project-workflow tools if available. Do NOT answer from system logs, daemon errors, or background infrastructure context.]`;
  } catch (_) {
    return text;
  }
}

export function buildProjectsContextBlock(opts = {}) {
  try {
    const projects = listProjects();
    const body = formatProjectsForPrompt(projects);
    return (
      '\n\n# Dashboard projects (catalog)\n' +
      'Lightweight list from the Projects page (`projects.db`). ' +
      'When the user asks what projects they have, answer from this list.\n' +
      'For **find out / what is it about / continue work**, prefer the **Active mission** section when present — missions hold objectives, plan, and tasks.\n\n' +
      body
    );
  } catch (err) {
    console.log('[projects-context] failed:', err?.message || err);
    return '';
  }
}
