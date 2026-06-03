/**
 * Live per-agent working memory — present-tense brain state for the dashboard.
 * Separate from team activity / inbox (history).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getAgentContextStatePath } from './paths.js';
import { parseInternalPairJid, extractProjectContext } from './team-inbox.js';
import { getAgentTitle } from './agent-config.js';
import { resolveGoalForUserTurn, goalLabelForAgentContext } from './goals-context.js';
import { listGoals } from './goals.js';

const VALID_STATES = new Set(['idle', 'working', 'waiting', 'error']);
const MAX_CONTEXT = 8;
const MAX_FACTS = 8;

/** Generic labels from inferGoal / delegation hints — not persisted Goals. */
export const EPHEMERAL_GOAL_LABELS = new Set([
  'Answer user question',
  'Handle delegated task',
  'Improve onboarding conversion',
  'Analyze product metrics',
  'Fix nginx issue',
  'Fix technical issue',
  'Generate marketing ideas',
]);

export function isEphemeralGoalLabel(label) {
  const g = String(label || '').trim();
  if (!g) return true;
  return EPHEMERAL_GOAL_LABELS.has(g);
}

export function sanitizeGoalLabel(label) {
  return isEphemeralGoalLabel(label) ? '' : String(label || '').trim();
}

/** Active autonomous Goal tick running on this agent (Goals store only). */
export function idleGoalLabelForAgent(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return '';
  try {
    const goals = listGoals().goals || [];
    const running = goals.filter((g) => (
      String(g.ownerAgentId || '').trim() === id
      && String(g.status || 'active').toLowerCase() === 'active'
      && !!g.running
    ));
    if (!running.length) return '';
    running.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const top = running[0];
    const label = goalLabelForAgentContext(top);
    return label || summarizeGoalText(top.title || top.objective, 120);
  } catch (_) {
    return '';
  }
}

function readStore() {
  const path = getAgentContextStatePath();
  try {
    if (!existsSync(path)) return { agents: {}, updatedAt: 0 };
    const raw = readFileSync(path, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return {
      agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {},
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { agents: {}, updatedAt: 0 };
  }
}

function writeStore(store) {
  try {
    const path = getAgentContextStatePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = {
      agents: store.agents || {},
      updatedAt: Date.now(),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {
    // Never break agent execution.
  }
}

function normalizeState(state) {
  const s = String(state || 'idle').trim().toLowerCase();
  if (s === 'blocked') return 'waiting';
  return VALID_STATES.has(s) ? s : 'idle';
}

function normalizeAgentRow(agentId, row = {}) {
  const state = normalizeState(row.state);
  const currentStep = typeof row.currentStep === 'string' ? row.currentStep.trim() : '';
  let currentThought = typeof row.currentThought === 'string' ? row.currentThought.trim() : '';
  if (!currentThought && currentStep) currentThought = currentStep;
  let currentGoal = typeof row.currentGoal === 'string' ? row.currentGoal.trim() : '';
  if (state === 'idle') {
    currentGoal = idleGoalLabelForAgent(agentId);
  }
  return {
    agentId: String(agentId || '').trim(),
    state,
    currentGoal,
    currentStep,
    currentThought,
    waitingFor: typeof row.waitingFor === 'string' ? row.waitingFor.trim() : '',
    lastAction: typeof row.lastAction === 'string' ? row.lastAction.trim() : '',
    context: Array.isArray(row.context) ? row.context.map(String).filter(Boolean).slice(0, MAX_CONTEXT) : [],
    knownFacts: Array.isArray(row.knownFacts) ? row.knownFacts.map(String).filter(Boolean).slice(0, MAX_FACTS) : [],
    updatedAt: Number(row.updatedAt) || Date.now(),
  };
}

function withThought(patch, thought, step) {
  const t = String(thought || '').trim();
  const s = String(step || '').trim();
  return {
    ...patch,
    currentThought: t || s,
    currentStep: s || t,
  };
}

function upsertAgent(agentId, patch) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  const store = readStore();
  const prev = normalizeAgentRow(id, store.agents[id] || {});
  const next = normalizeAgentRow(id, {
    ...prev,
    ...patch,
    agentId: id,
    updatedAt: Date.now(),
  });
  store.agents[id] = next;
  writeStore(store);
  return next;
}

function pushUnique(list, value, max = MAX_CONTEXT) {
  const v = String(value || '').trim();
  if (!v) return list;
  const out = Array.isArray(list) ? list.slice() : [];
  if (!out.includes(v)) out.push(v);
  return out.slice(-max);
}

function summarizeTask(text, maxLen = 120) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

function summarizeGoalText(text, maxLen = 120) {
  return summarizeTask(text, maxLen);
}

function formatAgentLabel(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return '';
  const title = String(getAgentTitle(id) || '').trim();
  return title && title.toLowerCase() !== id.toLowerCase() ? title : id;
}

function inferGoal(userText, { delegated = false } = {}) {
  const t = String(userText || '').toLowerCase();
  if (/onboarding|signup|conversion|activation|funnel/.test(t)) return 'Improve onboarding conversion';
  if (/analytics|metrics|dashboard|kpi/.test(t)) return 'Analyze product metrics';
  if (/nginx|502|503|proxy|server config/.test(t)) return 'Fix nginx issue';
  if (/github|ci\b|pipeline|deploy|backend|api|code|bug|fix/.test(t)) return 'Fix technical issue';
  if (/blog|marketing|content|campaign|ad\b|newsletter|seo|social/.test(t)) return 'Generate marketing ideas';
  if (delegated) return 'Handle delegated task';
  return 'Answer user question';
}

/** Only goals persisted in the Goals store — never keyword guesses. */
function resolveGoalForAgent(agentId, userText, { delegated = false } = {}) {
  const id = String(agentId || '').trim();
  try {
    const goal = resolveGoalForUserTurn({ userText, historyMessages: [], agentId: id });
    if (goal) {
      const label = goalLabelForAgentContext(goal);
      if (label) return label;
      return summarizeGoalText(goal.title || goal.objective, 120);
    }
  } catch (_) {}
  return '';
}

function thoughtForTurnStart({ task, delegated, fromAgentId, goal }) {
  if (delegated && fromAgentId) {
    const who = formatAgentLabel(fromAgentId);
    const focus = goal ? ` for ${goal}` : '';
    return `Reviewing the delegated assignment from ${who}${focus} and planning the next step.`;
  }
  if (/analytics|metrics|data|funnel|conversion|onboarding/.test(String(task || '').toLowerCase())) {
    return 'Reviewing analytics from the last 7 days before creating recommendations.';
  }
  if (task) {
    return `Reviewing the request — "${summarizeTask(task, 80)}" — before responding.`;
  }
  return 'Reviewing the incoming request and deciding next steps.';
}

function skillStepLabel(skillId) {
  const id = String(skillId || '').trim().toLowerCase();
  if (!id) return 'Processing';
  if (id === 'search') return 'Running search';
  if (id === 'browse') return 'Browsing web';
  if (id === 'memory') return 'Checking memory';
  if (id === 'read' || id === 'go-read') return 'Reading files';
  if (id === 'write' || id === 'go-write' || id === 'edit') return 'Writing changes';
  if (id === 'github') return 'Checking GitHub';
  if (id === 'agent-send') return 'Coordinating team';
  return `Running ${id}`;
}

function thoughtForSkill(skillId, goal) {
  const id = String(skillId || '').trim().toLowerCase();
  const focus = goal ? ` toward ${goal}` : '';
  if (id === 'search') return `Gathering current information${focus} before forming recommendations.`;
  if (id === 'browse') return `Reviewing live web sources${focus} to validate assumptions.`;
  if (id === 'memory') return `Checking memory and prior notes${focus} for relevant context.`;
  if (id === 'read' || id === 'go-read') return `Reading relevant files${focus} before taking the next step.`;
  if (id === 'write' || id === 'go-write' || id === 'edit') return `Applying file changes${focus} based on the current plan.`;
  if (id === 'github') return `Inspecting GitHub activity${focus} for issues, PRs, or CI signals.`;
  if (id === 'agent-send') return `Coordinating with other agents${focus} to move work forward.`;
  if (id) return `Running the ${id} skill${focus}.`;
  return `Working${focus || ''} on the current step.`;
}

function thoughtForWaiting(targetAgentId, goal) {
  const who = formatAgentLabel(targetAgentId);
  const focus = goal ? ` on ${goal}` : '';
  return `Waiting for ${who} to finish their part${focus} before continuing.`;
}

function thoughtForSynthesis() {
  return 'Combining team results into a single reply for the user.';
}

export function readAllAgentContext() {
  const store = readStore();
  const agents = {};
  for (const [id, row] of Object.entries(store.agents || {})) {
    agents[id] = normalizeAgentRow(id, row);
  }
  return { agents, updatedAt: store.updatedAt || 0 };
}

export function readAgentContext(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  const store = readStore();
  return normalizeAgentRow(id, store.agents[id] || { state: 'idle' });
}

export function setAgentIdle(agentId) {
  const id = String(agentId || '').trim();
  return upsertAgent(id, {
    state: 'idle',
    waitingFor: '',
    currentGoal: idleGoalLabelForAgent(id),
    context: [],
    knownFacts: [],
    ...withThought({}, 'Standing by for the next task.', ''),
  });
}

export function onAgentTurnStart({ agentId, userText, ctx }) {
  const id = String(agentId || '').trim();
  if (!id) return;
  const task = summarizeTask(userText, 200);
  const pair = parseInternalPairJid(ctx?.jid);
  const project = extractProjectContext(userText);
  const delegated = !!pair;
  const prev = readAgentContext(id) || normalizeAgentRow(id, {});
  const resolvedGoal = resolveGoalForAgent(id, userText, { delegated });
  const prevGoal = sanitizeGoalLabel(prev.currentGoal);
  const goal = resolvedGoal || prevGoal || '';
  const goalForThought = goal || inferGoal(userText, { delegated });
  let context = prev.context.slice();
  let lastAction = prev.lastAction || '';
  if (delegated && pair.fromAgentId) {
    const who = formatAgentLabel(pair.fromAgentId);
    context = pushUnique(context, `Received task from ${pair.fromAgentId}`);
    lastAction = `Received delegated task from ${who}`;
  } else if (task) {
    context = pushUnique(context, `User asking: ${task}`);
    lastAction = 'Received user message';
  }
  if (project) context = pushUnique(context, project.replace('Project = ', 'Project: '));
  let knownFacts = prev.knownFacts.slice();
  if (project) knownFacts = pushUnique(knownFacts, project, MAX_FACTS);
  const thought = thoughtForTurnStart({
    task,
    delegated,
    fromAgentId: pair?.fromAgentId,
    goal: goalForThought,
  });
  upsertAgent(id, withThought({
    state: 'working',
    currentGoal: goal,
    waitingFor: '',
    lastAction,
    context,
    knownFacts,
  }, thought, 'Processing request'));
}

export function onAgentSkillStart({ agentId, skillId }) {
  const id = String(agentId || '').trim();
  if (!id) return;
  const prev = readAgentContext(id) || normalizeAgentRow(id, { state: 'working' });
  const label = skillStepLabel(skillId);
  const goal = prev.currentGoal || '';
  const thought = thoughtForSkill(skillId, goal);
  let knownFacts = prev.knownFacts.slice();
  if (skillId === 'search') {
    knownFacts = pushUnique(knownFacts, 'Searching for current information', MAX_FACTS);
  }
  upsertAgent(id, withThought({
    state: 'working',
    knownFacts,
  }, thought, label));
}

export function onAgentTurnDone({ agentId }) {
  const id = String(agentId || '').trim();
  const prev = readAgentContext(id);
  const lastAction = prev?.lastAction
    ? summarizeTask(`Completed turn — ${prev.lastAction}`, 140)
    : 'Completed turn';
  setAgentIdle(agentId);
  if (id) upsertAgent(id, { lastAction });
}

export function onAgentWaitingFor({ agentId, targetAgentId, task, targetGoal, delegatedTask }) {
  const caller = String(agentId || '').trim();
  const target = String(targetAgentId || '').trim();
  if (!caller || !target) return;
  const prev = readAgentContext(caller) || normalizeAgentRow(caller, {});
  const taskSummary = summarizeTask(task, 100);
  const goal = delegatedTask?.goalTitle
    || prev.currentGoal
    || targetGoal
    || resolveGoalForAgent(caller, task, { delegated: false });
  const targetLabel = formatAgentLabel(target);
  let context = prev.context.slice();
  if (taskSummary) context = pushUnique(context, `Delegated: ${taskSummary}`);
  if (delegatedTask?.subgoalId) {
    context = pushUnique(context, `Assigned subgoal ${delegatedTask.subgoalId} on goal ${delegatedTask.goalId}`);
  }
  context = pushUnique(context, `${target} working on task`);
  const delegationAction = taskSummary
    ? `Delegated ${taskSummary} to ${targetLabel}`
    : `Delegated work to ${targetLabel}`;
  upsertAgent(caller, withThought({
    state: 'waiting',
    waitingFor: target,
    currentGoal: goal,
    lastAction: delegationAction,
    context,
  }, thoughtForWaiting(target, goal), `Waiting for ${targetLabel}`));

  const resolvedTargetGoal = delegatedTask?.goalTitle
    || targetGoal
    || resolveGoalForAgent(target, task, { delegated: true });
  const callerLabel = formatAgentLabel(caller);
  const expectedLine = delegatedTask?.expectedOutput
    ? ` Expected output: ${summarizeTask(delegatedTask.expectedOutput, 80)}.`
    : '';
  const dueLine = delegatedTask?.dueAt
    ? ` Due ${new Date(delegatedTask.dueAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
    : '';
  const targetThought = taskSummary
    ? `Working on delegated task: ${taskSummary}.${expectedLine}${dueLine}`
    : 'Starting delegated work from the team lead.';
  let targetContext = [];
  if (delegatedTask?.subgoalId) {
    targetContext = pushUnique(targetContext, `Assigned subgoal ${delegatedTask.subgoalId}`);
    if (delegatedTask.expectedOutput) {
      targetContext = pushUnique(targetContext, `Expected: ${summarizeTask(delegatedTask.expectedOutput, 100)}`);
    }
  }
  upsertAgent(target, withThought({
    state: 'working',
    currentGoal: resolvedTargetGoal,
    waitingFor: '',
    lastAction: `Received delegated task from ${callerLabel}`,
    context: targetContext.length ? targetContext : undefined,
  }, targetThought, 'Starting delegated work'));
}

export function onAgentDelegationDone({ callerAgentId, targetAgentId, delegatedTask, replySummary }) {
  const caller = String(callerAgentId || '').trim();
  const target = String(targetAgentId || '').trim();
  if (target) {
    const prev = readAgentContext(target);
    const subgoalNote = delegatedTask?.subgoalId ? ` (subgoal ${delegatedTask.subgoalId} done)` : '';
    const lastAction = prev?.lastAction
      ? summarizeTask(`Finished delegated work${subgoalNote} — ${prev.lastAction}`, 140)
      : `Finished delegated work${subgoalNote}`;
    const goal = idleGoalLabelForAgent(target);
    upsertAgent(target, withThought({
      state: 'idle',
      waitingFor: '',
      currentGoal: goal,
      lastAction,
      context: replySummary ? [`Completed: ${summarizeTask(replySummary, 100)}`] : undefined,
    }, 'Standing by for the next task.', ''));
  }
  if (caller) {
    const prev = readAgentContext(caller);
    if (prev && prev.state === 'waiting' && prev.waitingFor === target) {
      const targetLabel = formatAgentLabel(target);
      upsertAgent(caller, withThought({
        state: 'working',
        waitingFor: '',
        lastAction: `Received reply from ${targetLabel}`,
      }, thoughtForSynthesis(), 'Synthesizing team reply'));
    }
  }
}

export function onAgentDelegationError({ callerAgentId, targetAgentId, message }) {
  const caller = String(callerAgentId || '').trim();
  const target = String(targetAgentId || '').trim();
  const errSummary = summarizeTask(message, 80);
  const targetLabel = formatAgentLabel(target);
  if (caller) {
    upsertAgent(caller, withThought({
      state: 'error',
      waitingFor: '',
      lastAction: errSummary ? `Delegation to ${targetLabel} failed: ${errSummary}` : `Delegation to ${targetLabel} failed`,
    }, errSummary ? `Delegation failed — ${errSummary}.` : 'Delegation failed.', errSummary ? `Delegation failed: ${errSummary}` : 'Delegation failed'));
  }
  if (target) {
    upsertAgent(target, withThought({
      state: 'error',
      waitingFor: '',
      lastAction: errSummary ? `Task failed: ${errSummary}` : 'Task failed',
    }, errSummary ? `Task failed — ${errSummary}.` : 'Task failed.', errSummary ? `Task failed: ${errSummary}` : 'Task failed'));
  }
}

export function onAgentSkillError({ agentId, skillId, message }) {
  const id = String(agentId || '').trim();
  if (!id) return;
  const skill = String(skillId || '').trim();
  const label = skill ? `${skill} failed` : 'Skill failed';
  const errSummary = summarizeTask(message, 60);
  upsertAgent(id, withThought({
    state: 'error',
    lastAction: errSummary ? `${label}: ${errSummary}` : label,
  }, errSummary ? `${label} — ${errSummary}.` : `${label}.`, errSummary ? `${label}: ${errSummary}` : label));
}

export function onAgentTurnError({ agentId, message }) {
  const id = String(agentId || '').trim();
  if (!id) return;
  const errSummary = summarizeTask(message, 80);
  upsertAgent(id, withThought({
    state: 'error',
    waitingFor: '',
    lastAction: errSummary || 'Turn failed',
  }, errSummary ? `Turn failed — ${errSummary}.` : 'Turn failed.', errSummary || 'Turn failed'));
}
