/**
 * Bridge natural conversation → dashboard projects, missions (goals), and progress logs.
 */

import {
  listProjects,
  getProject,
  getProjectGraph,
  createUpdate,
  createProject,
  updateProject,
} from './projects-db.js';
import {
  createGoal,
  updateGoal,
  getGoal,
  listGoals,
} from './goals.js';
import { pickFocusedProject } from './projects-context.js';
import { resolveGoalForUserTurn } from './goals-context.js';
import { isNonTaskMessage } from './evaluate-team-capability.js';
import {
  registerPendingFromPlanPreview,
  registerPendingFromSetupPreview,
  clearPendingForProject,
} from './project-workflow-pending.js';

function summarize(text, max = 280) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((t, i) => {
      if (typeof t === 'string') {
        const title = t.trim();
        return title ? { id: `sg-${i + 1}`, title, status: 'todo', progress: 0, assignee: '' } : null;
      }
      if (!t || typeof t !== 'object') return null;
      const title = summarize(t.title || t.name || '', 180);
      if (!title) return null;
      const status = String(t.status || 'todo').trim().toLowerCase();
      return {
        id: String(t.id || `sg-${i + 1}`).trim() || `sg-${i + 1}`,
        title,
        status: ['todo', 'doing', 'done', 'blocked'].includes(status) ? status : 'todo',
        progress: Number(t.progress) || 0,
        assignee: summarize(t.assignee || '', 80),
      };
    })
    .filter(Boolean)
    .slice(0, 25);
}

const APPROVAL_PHRASE_RE = /\b(yes|yeah|yep|approve[d]?|go ahead|create it|looks good|ship it|sounds good|confirmed|confirm|proceed|do it|ok(?:ay)?(?:\s+to\s+(?:create|proceed|apply))?|use default)\b/i;
const WORK_REQUEST_RE = /\b(increase|improve|reduce|fix|check|work on|setup|help me|what should|grow|boost)\b/i;

/** True only when the user explicitly approves creating/updating dashboard missions or projects. */
export function hasExplicitUserApproval(userText, historyMessages = []) {
  const text = String(userText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasApproval = APPROVAL_PHRASE_RE.test(lower);
  const looksLikeWorkRequest = WORK_REQUEST_RE.test(lower) && lower.length > 18;
  if (looksLikeWorkRequest && !hasApproval) return false;
  if (hasApproval && text.length <= 140) return true;
  if (hasApproval && /\b(mission|plan|tasks|setup|project|create)\b/i.test(lower)) return true;
  const recent = (historyMessages || []).slice(-4);
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (msg?.role !== 'user') continue;
    const u = String(msg.content || '').trim().toLowerCase();
    if (APPROVAL_PHRASE_RE.test(u) && u.length <= 120) return true;
    break;
  }
  return false;
}

function verifyWriteApproval(input = {}, opts = {}) {
  if (opts.approvedVia === 'dashboard' || input.approvedVia === 'dashboard') {
    return { ok: true };
  }
  if (!input.userApproved) {
    return {
      ok: false,
      needsApproval: true,
      error: 'User approval required. Present the preview first, then call again with userApproved: true after they confirm.',
    };
  }
  const userText = String(
    opts.userText || input.userText || opts.ctx?._originalUserText || '',
  ).trim();
  const historyMessages = opts.historyMessages || input.historyMessages || [];
  if (!hasExplicitUserApproval(userText, historyMessages)) {
    return {
      ok: false,
      needsApproval: true,
      awaitingUserApproval: true,
      error: 'No explicit user approval in this conversation turn. Use propose_plan (or propose_setup), show the preview, and wait for the user to reply yes before applying.',
      askUser: 'Should I create this on the dashboard? Reply **yes** to confirm, or tell me what to change first.',
    };
  }
  return { ok: true };
}

export function formatTasksForDisplay(tasks) {
  return normalizeTasks(tasks).map((t, i) => ({
    index: i + 1,
    id: t.id,
    title: t.title,
    status: t.status,
  }));
}

export function formatDecisionPrompt(question, options = [], recommendedIndex = 0) {
  const q = summarize(question, 280);
  const opts = (options || []).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 4);
  if (!opts.length) return q;
  const rec = opts[recommendedIndex] || opts[0];
  const numbered = opts.map((o, i) => `${i + 1}) ${o}`).join(' · ');
  return `${q} **Recommend:** ${rec}. **Options:** ${numbered}. Reply **use default** or a number.`;
}

export const PROJECT_SETUP_FIELDS = [
  {
    field: 'name',
    required: true,
    ask: 'What should this project be called on the dashboard?',
  },
  {
    field: 'description',
    required: true,
    ask: 'What is this project about? (one or two sentences)',
  },
  {
    field: 'url',
    required: false,
    ask: 'Project URL, repo, or site? (optional)',
  },
  {
    field: 'setup_notes',
    required: false,
    ask: 'Any setup the team should know — MongoDB connection string, API base URL, env vars, deployment host, credentials location, etc. (optional)',
  },
];

function formatExistingProjects(projects) {
  return (projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    description: summarize(p.description, 100),
    url: String(p.url || '').trim(),
    hasSetupNotes: !!String(p.setup_notes || '').trim(),
  }));
}

function formatProjectUpdates(updates, limit = 25) {
  return (updates || [])
    .filter((u) => u && u.branch_id == null)
    .slice()
    .sort((a, b) => {
      const bTs = Number(b.created_at || b.createdAt || b.id || 0);
      const aTs = Number(a.created_at || a.createdAt || a.id || 0);
      return bTs - aTs;
    })
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 25)))
    .map((u) => ({
      id: u.id,
      project_id: u.project_id,
      text: summarize(u.text || '', 1200),
      created_at: u.created_at || u.createdAt || '',
    }));
}

function goalSubgoalsAsWorkItems(goal) {
  return (goal?.subgoals || []).map((sg) => ({
    id: sg.id,
    title: sg.title,
    status: sg.status,
    progress: sg.progress,
    assignee: sg.assignee || goal.ownerAgentId || '',
    source: 'mission_subgoal',
    goalId: goal.id,
    projectId: goal.projectId || null,
  }));
}

function updatesAsWorkItems(updates, project) {
  return formatProjectUpdates(updates).map((u) => ({
    id: `update-${u.id}`,
    title: summarize(u.text, 180),
    status: 'done',
    progress: 100,
    assignee: '',
    source: 'project_update',
    projectId: project ? Number(project.id) : Number(u.project_id) || null,
    updateId: u.id,
    created_at: u.created_at,
  }));
}

export function extractProjectNameHint(userText) {
  const text = String(userText || '').trim();
  if (!text) return '';
  const patterns = [
    /\bwork\s+on\s+(?:the\s+)?(?:project\s+)?["']?([A-Za-z0-9][\w\s\-./]{1,48})["']?/i,
    /\b(?:project|app|site)\s+["']?([A-Za-z0-9][\w\s\-./]{1,48})["']?/i,
    /\bfor\s+["']?([A-Za-z0-9][\w\s\-./]{1,48})["']?/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = m[1].replace(/\s+(project|app|please|now)$/i, '').trim();
      if (name.length >= 2) return summarize(name, 80);
    }
  }
  return '';
}

function matchProjectsByRef(ref) {
  const raw = ref != null ? String(ref).trim() : '';
  if (!raw) return { type: 'none' };
  const projects = listProjects();
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) {
    const byId = projects.find((p) => Number(p.id) === asNum);
    if (byId) return { type: 'found', project: byId };
  }
  const lower = raw.toLowerCase();
  const exact = projects.find((p) => String(p.name || '').trim().toLowerCase() === lower);
  if (exact) return { type: 'found', project: exact };
  const partial = projects.filter((p) => {
    const n = String(p.name || '').trim().toLowerCase();
    return n && (n.includes(lower) || lower.includes(n));
  });
  if (partial.length === 1) return { type: 'found', project: partial[0] };
  if (partial.length > 1) return { type: 'ambiguous', candidates: partial, query: raw };
  return { type: 'not_found', query: raw };
}

export function lookupProjectRef(ref, opts = {}) {
  const existingProjects = formatExistingProjects(listProjects());
  const match = matchProjectsByRef(ref);
  if (match.type === 'found') {
    return { status: 'found', project: match.project, existingProjects };
  }
  if (match.type === 'ambiguous') {
    return {
      status: 'ambiguous',
      query: match.query,
      candidates: formatExistingProjects(match.candidates),
      existingProjects,
      ask: 'Which configured project did you mean? Pick one from the list or clarify the name.',
    };
  }
  const suggestedName = match.query || extractProjectNameHint(opts.userText || '');
  return {
    status: 'not_configured',
    needsSetup: true,
    suggestedName,
    existingProjects,
    setupFields: PROJECT_SETUP_FIELDS,
    ask: 'This project is not in the dashboard catalog yet. Ask the user for name, description, and any setup details (URL, MongoDB, env) before creating it.',
    note: 'Call propose_setup to preview, then apply_setup with userApproved: true after the user confirms.',
  };
}

export function resolveProjectRef(ref) {
  const lookup = lookupProjectRef(ref);
  return lookup.status === 'found' ? lookup.project : null;
}

export function listConfiguredProjects() {
  return formatExistingProjects(listProjects());
}

function normalizeSetupInput(input = {}) {
  return {
    name: summarize(input.name || input.projectName || '', 120),
    description: summarize(input.description || '', 2000),
    url: String(input.url || '').trim(),
    setup_notes: String(input.setup_notes || input.setupNotes || input.connections || '').trim(),
  };
}

export function proposeProjectSetup(input = {}) {
  const setup = normalizeSetupInput(input);
  if (!setup.name) {
    return { ok: false, error: 'name required', setupFields: PROJECT_SETUP_FIELDS };
  }
  if (!setup.description) {
    return { ok: false, error: 'description required', setupFields: PROJECT_SETUP_FIELDS };
  }
  const conflict = resolveProjectRef(setup.name);
  if (conflict) {
    return {
      ok: false,
      error: `Project "${conflict.name}" already exists (id ${conflict.id}). Use health_check or update_project instead.`,
      existingProject: { id: conflict.id, name: conflict.name },
    };
  }
  const preview = {
    ok: true,
    preview: true,
    project: setup,
    note: 'Show this to the user and ask them to confirm. Then call apply_setup with userApproved: true.',
    askUser: 'Approve to add this project to the dashboard?',
  };
  registerPendingFromSetupPreview(preview, { agentId: input.ownerAgentId || 'main' });
  return preview;
}

export function applyProjectSetup(input = {}, opts = {}) {
  const approval = verifyWriteApproval(input, opts);
  if (!approval.ok) return approval;
  const preview = proposeProjectSetup(input);
  if (!preview.ok) return preview;
  const setup = preview.project;
  const project = createProject({
    name: setup.name,
    description: setup.description,
    url: setup.url,
    setup_notes: setup.setup_notes,
  });
  let update = null;
  try {
    const intro = summarize(
      `Project configured: ${setup.description}${setup.setup_notes ? ` | Setup: ${setup.setup_notes.slice(0, 200)}` : ''}`,
      2000,
    );
    update = createUpdate({ project_id: Number(project.id), text: intro });
  } catch (_) {}
  return finalizeApplyProjectSetup(project, update);
}

function finalizeApplyProjectSetup(project, update) {
  clearPendingForProject(project.name, 'project_setup');
  return {
    ok: true,
    project,
    update,
    health: healthCheckProject(project),
    note: 'Project is now in the dashboard catalog. Continue with health_check and propose_plan if needed.',
  };
}

export function updateProjectDetails(input = {}) {
  const project = resolveProjectRef(input.project || input.projectId || input.projectName);
  if (!project) {
    return { ok: false, ...lookupProjectRef(input.project || input.projectId || input.projectName, { userText: input.userText }) };
  }
  const patch = {};
  if (input.name != null) patch.name = summarize(input.name, 120);
  if (input.description != null) patch.description = summarize(input.description, 2000);
  if (input.url != null) patch.url = String(input.url || '').trim();
  if (input.setup_notes != null || input.setupNotes != null) {
    patch.setup_notes = String(input.setup_notes || input.setupNotes || '').trim();
  }
  if (!Object.keys(patch).length) {
    return { ok: false, error: 'Nothing to update — pass description, url, and/or setup_notes' };
  }
  const nextName = patch.name || project.name;
  if (!nextName) return { ok: false, error: 'name cannot be empty' };
  const updated = updateProject(Number(project.id), {
    name: nextName,
    description: patch.description !== undefined ? patch.description : project.description,
    url: patch.url !== undefined ? patch.url : project.url,
    setup_notes: patch.setup_notes !== undefined ? patch.setup_notes : (project.setup_notes || ''),
  });
  return { ok: true, project: updated, health: healthCheckProject(updated) };
}

export function healthCheckProject(project) {
  const p = project || null;
  if (!p) return { ok: false, error: 'Project not found', missing: [] };
  let graph = { updates: [], branches: [] };
  try {
    graph = getProjectGraph(Number(p.id)) || graph;
  } catch (_) {}
  const mainUpdates = (graph.updates || []).filter((u) => u.branch_id == null);
  const missing = [];
  if (!String(p.url || '').trim()) {
    missing.push({
      field: 'url',
      severity: 'recommended',
      ask: 'What is the project URL, repo, or site?',
    });
  }
  if (!String(p.description || '').trim()) {
    missing.push({
      field: 'description',
      severity: 'required',
      ask: 'What is this project about in one or two sentences?',
    });
  }
  if (!String(p.setup_notes || '').trim()) {
    missing.push({
      field: 'setup_notes',
      severity: 'recommended',
      ask: 'Any setup details the team should know? (MongoDB URI, API URL, env vars, deployment host, etc.)',
    });
  }
  if (!mainUpdates.length) {
    missing.push({
      field: 'progress',
      severity: 'info',
      ask: 'No progress logged on the dashboard yet — should I add an initial status update?',
    });
  }
  const linkedGoals = (listGoals().goals || []).filter(
    (g) => Number(g.projectId) === Number(p.id) && String(g.status || 'active') === 'active',
  );
  if (!linkedGoals.length) {
    missing.push({
      field: 'mission',
      severity: 'recommended',
      ask: 'There is no active mission linked to this project — should I propose tasks and create one after you approve?',
    });
  }
  return {
    ok: missing.every((m) => m.severity === 'info'),
    project: p,
    missing,
    updateCount: mainUpdates.length,
    recentUpdates: formatProjectUpdates(mainUpdates),
    linkedGoalCount: linkedGoals.length,
    latestUpdate: mainUpdates.length ? summarize(mainUpdates[mainUpdates.length - 1].text, 200) : '',
    hasSetupNotes: !!String(p.setup_notes || '').trim(),
  };
}

export function healthCheckProjectRef(ref, opts = {}) {
  const lookup = lookupProjectRef(ref, opts);
  if (lookup.status === 'found') {
    return { ...healthCheckProject(lookup.project), lookup };
  }
  return {
    ok: false,
    needsSetup: lookup.status === 'not_configured',
    ambiguous: lookup.status === 'ambiguous',
    lookup,
    missing: lookup.setupFields || [],
    ask: lookup.ask,
    existingProjects: lookup.existingProjects || [],
  };
}

export function projectWorkflowStatus(opts = {}) {
  const project = opts.projectId != null
    ? resolveProjectRef(String(opts.projectId))
    : resolveProjectRef(opts.project || opts.projectName || '');
  const goal = opts.goalId
    ? getGoal(String(opts.goalId))
    : resolveGoalForUserTurn({
      userText: opts.userText || '',
      historyMessages: opts.historyMessages || [],
      agentId: opts.agentId || 'main',
    });

  const out = { project: null, goal: null, health: null, tasks: [], updates: [], workItems: [] };
  if (project) {
    out.project = {
      id: project.id,
      name: project.name,
      url: project.url || '',
      description: summarize(project.description, 200),
    };
    out.health = healthCheckProject(project);
    out.updates = out.health.recentUpdates || [];
    out.workItems.push(...updatesAsWorkItems(out.updates, project));
  }
  if (goal) {
    out.goal = {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      progressPct: goal.progress?.pct ?? 0,
      ownerAgentId: goal.ownerAgentId,
      projectId: goal.projectId || null,
    };
    out.tasks = goalSubgoalsAsWorkItems(goal);
    out.workItems.unshift(...out.tasks);
  }
  return out;
}

export function proposeProjectPlan(input = {}) {
  const lookup = lookupProjectRef(input.project || input.projectId || input.projectName, { userText: input.userText });
  if (lookup.status !== 'found') {
    return {
      ok: false,
      error: lookup.status === 'not_configured'
        ? 'Project not configured on the dashboard yet.'
        : 'Project not found or ambiguous.',
      ...lookup,
    };
  }
  const project = lookup.project;
  const health = healthCheckProject(project);
  const tasks = normalizeTasks(input.tasks || input.subgoals || []);
  const planSteps = normalizeTasks(input.planSteps || input.steps || []).map((s) => s.title);
  const title = summarize(input.title || `Work on ${project.name}`, 120);
  const objective = summarize(
    input.objective || input.summary || `Advance ${project.name}: ${project.description || 'ongoing work'}`,
    400,
  );
  const result = {
    ok: true,
    preview: true,
    project: { id: project.id, name: project.name },
    mission: { title, objective, ownerAgentId: input.ownerAgentId || 'main' },
    tasks,
    tasksForDisplay: formatTasksForDisplay(tasks),
    planSteps,
    health,
    note: 'Show tasksForDisplay to the user and ask for approval. Do NOT call apply_plan until they reply yes.',
    askUser: 'Should I create this mission and these tasks on the dashboard? Reply **yes** to confirm.',
  };
  registerPendingFromPlanPreview(result, { agentId: input.ownerAgentId || 'main' });
  return result;
}

export function applyProjectPlan(input = {}, opts = {}) {
  const approval = verifyWriteApproval(input, opts);
  if (!approval.ok) return approval;
  const project = resolveProjectRef(input.project || input.projectId || input.projectName);
  if (!project) return { ok: false, error: 'Project not found' };

  const existingGoalId = String(input.goalId || '').trim();
  const tasks = normalizeTasks(input.tasks || input.subgoals || []);
  const planSteps = normalizeTasks(input.planSteps || input.steps || []).map((s) => ({ title: s.title, status: 'todo' }));

  if (existingGoalId) {
    const prev = getGoal(existingGoalId);
    if (!prev) return { ok: false, error: `Goal not found: ${existingGoalId}` };
    const mergedSubgoals = tasks.length ? tasks : prev.subgoals;
    const goal = updateGoal(existingGoalId, {
      projectId: Number(project.id),
      subgoals: mergedSubgoals,
      lastActivity: summarize(input.note || `Tasks updated for ${project.name}`, 280),
    });
    return { ok: true, goal, project: { id: project.id, name: project.name } };
  }

  const title = summarize(input.title || `Mission: ${project.name}`, 120);
  const objective = summarize(
    input.objective || `Structured work for ${project.name}`,
    4000,
  );
  const goal = createGoal({
    title,
    objective,
    ownerAgentId: input.ownerAgentId || 'main',
    projectId: Number(project.id),
    subgoals: tasks,
    currentPlan: planSteps.length ? { steps: planSteps } : undefined,
    lastActivity: `Mission created for ${project.name}`,
  });
  clearPendingForProject(project.name, 'mission_plan');
  return { ok: true, goal, project: { id: project.id, name: project.name } };
}

export function updateProjectTaskStatus(input = {}) {
  const goalId = String(input.goalId || '').trim();
  if (!goalId) return { ok: false, error: 'goalId required' };
  const goal = getGoal(goalId);
  if (!goal) return { ok: false, error: `Goal not found: ${goalId}` };

  const targetId = String(input.subgoalId || input.taskId || '').trim();
  const targetTitle = summarize(input.title || input.taskTitle || '', 180).toLowerCase();
  const nextStatus = String(input.status || '').trim().toLowerCase();
  const validStatus = ['todo', 'doing', 'done', 'blocked'];
  if (!validStatus.includes(nextStatus)) {
    return { ok: false, error: 'status must be todo, doing, done, or blocked' };
  }

  let updated = false;
  function patchSubgoals(list) {
    if (!Array.isArray(list)) return list;
    return list.map((sg) => {
      const match = (targetId && sg.id === targetId)
        || (targetTitle && String(sg.title || '').trim().toLowerCase() === targetTitle);
      if (match) {
        updated = true;
        const progress = nextStatus === 'done' ? 100 : (Number(input.progress) || sg.progress || 0);
        return { ...sg, status: nextStatus, progress };
      }
      if (Array.isArray(sg.subgoals) && sg.subgoals.length) {
        return { ...sg, subgoals: patchSubgoals(sg.subgoals) };
      }
      return sg;
    });
  }

  const subgoals = patchSubgoals(goal.subgoals || []);
  if (!updated) return { ok: false, error: 'Task not found on mission' };
  const next = updateGoal(goalId, {
    subgoals,
    lastActivity: summarize(input.note || `Task → ${nextStatus}`, 280),
  });
  return { ok: true, goal: next };
}

export function logProjectProgress(input = {}) {
  const text = summarize(input.text || input.summary || input.message || '', 2000);
  if (!text) return { ok: false, error: 'text required' };

  const project = resolveProjectRef(input.project || input.projectId || input.projectName);
  const goalId = String(input.goalId || '').trim();
  let update = null;

  if (project) {
    update = createUpdate({
      project_id: Number(project.id),
      text,
    });
  }

  let goal = null;
  if (goalId) {
    goal = updateGoal(goalId, { lastActivity: text });
  } else if (project) {
    const linked = (listGoals().goals || []).find(
      (g) => Number(g.projectId) === Number(project.id) && String(g.status) === 'active',
    );
    if (linked) goal = updateGoal(linked.id, { lastActivity: text });
  }

  return {
    ok: true,
    project: project ? { id: project.id, name: project.name } : null,
    goal: goal ? { id: goal.id, title: goal.title } : null,
    update,
  };
}

export function isProjectWorkflowTurn(userText) {
  const t = String(userText || '').toLowerCase();
  if (!t || isNonTaskMessage(userText)) return false;
  return (
    /\bwork\s+on\b/.test(t) ||
    /\bproject\b/.test(t) ||
    /\bmission\b/.test(t) ||
    /\btask(s)?\b/.test(t) ||
    /\btrack(ing)?\b/.test(t) ||
    /\bprogress\b/.test(t) ||
    /\bstatus\b/.test(t) ||
    /\bnextpostai\b/.test(t)
  );
}

export function buildProjectWorkflowContextBlock(opts = {}) {
  const userText = opts.userText || '';
  if (!isProjectWorkflowTurn(userText)) return '';
  const configured = listConfiguredProjects();
  const catalogLine = configured.length
    ? `Configured projects: ${configured.map((p) => p.name).join(', ')}.`
    : 'No projects configured yet — user must register one before missions/tasks.';
  return (
    '\n\n# Project workflow (conversation → dashboard)\n' +
    'The user is talking about project work. Bridge natural language to the dashboard:\n' +
    `0. **Catalog check** — ${catalogLine} If the project they mention is **not** in this list, stop and ask for **name**, **description**, and optional **setup** (URL, MongoDB, env). Use \`project_workflow_propose_setup\` then \`project_workflow_apply_setup\` with \`userApproved: true\` — do not create missions until the project exists.\n` +
    '1. **Health check** — call `project_workflow_health_check` for configured projects. Ask for anything missing (description, URL, setup notes, mission).\n' +
    '2. **Analyze & propose** — use `project_workflow_propose_plan` with suggested tasks; present **tasksForDisplay** clearly and ask for yes/no approval.\n' +
    '3. **Approval gate** — NEVER call `apply_plan` because the user stated a goal alone (e.g. "increase sign ups"). Wait for explicit **yes / go ahead / create it**. The tool will reject apply without approval in the user message.\n' +
    '4. **Apply** — only after yes: `project_workflow_apply_plan` with `userApproved: true`.\n' +
    '5. **Track progress** — use `project_workflow_log_progress` after meaningful steps; use `project_workflow_update_task` when a task status changes.\n' +
    '6. **Decisions** — when blocked on a choice (analytics tool, stack, etc.), give 2–3 options plus a recommended default; offer "use default" instead of open-ended stalls.\n' +
    '7. **Status** — use `project_workflow_status` or `project_workflow_list_projects` when the user asks what is configured.\n' +
    'Dashboard views: **Projects** (catalog + update chain), **Missions** (goals + subgoals), **Tasks/Cards** (completed turns + live agent cards).\n'
  );
}

export function syncTurnToProjectWork(opts = {}) {
  const userText = String(opts.userText || '').trim();
  if (!userText || isNonTaskMessage(userText)) return null;
  if (/^\[Retry with (tools|search)\]/i.test(userText)) return null;
  if (!isProjectWorkflowTurn(userText)) return null;

  const agentId = String(opts.agentId || 'main').trim() || 'main';
  const historyMessages = opts.historyMessages || [];
  const summary = summarize(opts.summary || opts.textToSend || '', 400);
  if (!summary) return null;

  const project = pickFocusedProject(listProjects(), userText, historyMessages);
  const goal = resolveGoalForUserTurn({ userText, historyMessages, agentId })
    || (project
      ? (listGoals().goals || []).find(
        (g) => Number(g.projectId) === Number(project.id) && String(g.status) === 'active',
      )
      : null);

  if (!project && !goal) return null;

  const line = summarize(
    `[${agentId}] ${summary}`,
    2000,
  );

  let update = null;
  if (project) {
    try {
      update = createUpdate({ project_id: Number(project.id), text: line });
    } catch (_) {}
  }
  if (goal) {
    try {
      updateGoal(goal.id, { lastActivity: summarize(summary, 280) });
    } catch (_) {}
  }

  return {
    projectId: project ? Number(project.id) : null,
    goalId: goal ? goal.id : null,
    updateId: update?.id || null,
  };
}
