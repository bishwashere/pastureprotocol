/**
 * Persistent task assignment for agent-send delegations.
 * Creates tracked subgoals on Goals with assignee, due date, and expected output.
 */

import { getGoal, listGoals, updateGoal } from './goals.js';
import { resolveGoalForUserTurn } from './goals-context.js';

function nowMs() {
  return Date.now();
}

function summarize(text, maxLen = 320) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 7);
}

function flattenSubgoals(list, out = []) {
  for (const sg of list || []) {
    if (!sg) continue;
    out.push(sg);
    flattenSubgoals(sg.subgoals, out);
  }
  return out;
}

function patchSubgoalInTree(subgoals, subgoalId, patch) {
  let found = false;
  const next = (subgoals || []).map((sg) => {
    if (String(sg.id || '') === subgoalId) {
      found = true;
      return { ...sg, ...patch };
    }
    if (Array.isArray(sg.subgoals) && sg.subgoals.length) {
      const nested = patchSubgoalInTree(sg.subgoals, subgoalId, patch);
      if (nested.found) {
        found = true;
        return { ...sg, subgoals: nested.subgoals };
      }
    }
    return sg;
  });
  return { subgoals: next, found };
}

export function newDelegationId() {
  return `del-${nowMs().toString(36)}-${randomSuffix()}`;
}

/**
 * Resolve the Goal a delegation should attach to.
 * @param {{ callerAgentId?: string, goalId?: string, message?: string, ctx?: object }} opts
 */
export function resolveGoalForDelegation(opts = {}) {
  const explicit = String(opts.goalId || opts.ctx?.goalId || '').trim();
  if (explicit) {
    const goal = getGoal(explicit);
    if (goal && String(goal.status || 'active').toLowerCase() === 'active') return goal;
  }
  const message = String(opts.message || '').trim();
  if (!message) return null;
  return resolveGoalForUserTurn({
    userText: message,
    historyMessages: opts.ctx?.delegationHistoryMessages || opts.ctx?.historyMessages || [],
    agentId: opts.callerAgentId || 'main',
  });
}

/**
 * @param {object} opts
 * @returns {{ goal: object, subgoal: object, delegationId: string } | null}
 */
export function createDelegatedSubgoal(opts = {}) {
  const goalId = String(opts.goalId || '').trim();
  const assignee = String(opts.assignee || '').trim();
  const delegatedFrom = String(opts.delegatedFrom || '').trim();
  if (!goalId || !assignee) return null;

  const goal = getGoal(goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);

  const delegationId = String(opts.delegationId || newDelegationId()).trim();
  const subgoalId = String(opts.subgoalId || `sg-${delegationId}`).trim();
  const message = String(opts.message || opts.description || '').trim();
  const title = summarize(opts.title || opts.taskTitle || message.split(/[.!?\n]/)[0] || 'Delegated task', 180);
  const description = summarize(opts.description || message, 400);
  const expectedOutput = summarize(opts.expectedOutput || opts.expected_output || '', 400);
  const dueInHoursRaw = Number(opts.dueInHours ?? opts.due_in_hours);
  const dueInHours = Number.isFinite(dueInHoursRaw) && dueInHoursRaw > 0
    ? Math.floor(dueInHoursRaw)
    : 48;
  const dueAt = nowMs() + dueInHours * 3600_000;

  const subgoal = {
    id: subgoalId,
    title,
    status: 'doing',
    progress: 0,
    assignee,
    depends_on: [],
    subgoals: [],
    description,
    expectedOutput,
    dueInHours,
    dueAt,
    delegatedFrom,
    delegatedAt: nowMs(),
    delegationId,
    source: 'delegation',
  };

  const subgoals = Array.isArray(goal.subgoals) ? goal.subgoals.slice() : [];
  subgoals.push(subgoal);
  const updatedGoal = updateGoal(goalId, {
    subgoals,
    lastActivity: `Delegated "${title}" to ${assignee}`,
  });

  return { goal: updatedGoal, subgoal, delegationId };
}

export function updateDelegatedSubgoalProgress(opts = {}) {
  const goalId = String(opts.goalId || '').trim();
  const subgoalId = String(opts.subgoalId || '').trim();
  if (!goalId || !subgoalId) return null;

  const goal = getGoal(goalId);
  if (!goal) return null;

  const status = String(opts.status || '').trim().toLowerCase();
  const patch = {};
  if (['todo', 'doing', 'done', 'blocked'].includes(status)) patch.status = status;
  const progressRaw = Number(opts.progress);
  if (Number.isFinite(progressRaw)) {
    patch.progress = Math.max(0, Math.min(100, Math.round(progressRaw)));
  }
  if (opts.note) {
    const note = summarize(opts.note, 200);
    patch.description = summarize(`${goal.subgoals?.find?.((s) => s.id === subgoalId)?.description || ''} [${note}]`, 400);
  }

  const { subgoals, found } = patchSubgoalInTree(goal.subgoals || [], subgoalId, patch);
  if (!found) return null;

  const activity = status === 'done'
    ? `Delegated subgoal ${subgoalId} completed`
    : status === 'blocked'
      ? `Delegated subgoal ${subgoalId} blocked`
      : `Delegated subgoal ${subgoalId} updated`;

  return updateGoal(goalId, { subgoals, lastActivity: activity });
}

export function completeDelegatedSubgoal(delegatedTask, opts = {}) {
  if (!delegatedTask || typeof delegatedTask !== 'object') return null;
  const goalId = String(delegatedTask.goalId || '').trim();
  const subgoalId = String(delegatedTask.subgoalId || '').trim();
  if (!goalId || !subgoalId) return null;
  return updateDelegatedSubgoalProgress({
    goalId,
    subgoalId,
    status: opts.status || 'done',
    progress: opts.progress ?? 100,
    note: opts.note || opts.replySummary || '',
  });
}

export function failDelegatedSubgoal(delegatedTask, message) {
  if (!delegatedTask || typeof delegatedTask !== 'object') return null;
  return updateDelegatedSubgoalProgress({
    goalId: delegatedTask.goalId,
    subgoalId: delegatedTask.subgoalId,
    status: 'blocked',
    progress: delegatedTask.progress || 0,
    note: summarize(message, 120),
  });
}

/** Open delegated subgoals assigned to an agent across active goals. */
export function listDelegatedSubgoalsForAgent(agentId, opts = {}) {
  const id = String(agentId || '').trim();
  if (!id) return [];
  const includeDone = opts.includeDone === true;
  const openStatuses = new Set(['todo', 'doing', 'blocked']);
  let goals = [];
  try {
    goals = (listGoals().goals || []).filter((g) => String(g.status || 'active').toLowerCase() === 'active');
  } catch (_) {
    return [];
  }

  const rows = [];
  for (const goal of goals) {
    for (const sg of flattenSubgoals(goal.subgoals || [])) {
      if (String(sg.source || '') !== 'delegation') continue;
      if (String(sg.assignee || '').trim() !== id) continue;
      if (!includeDone && !openStatuses.has(String(sg.status || 'todo').toLowerCase())) continue;
      rows.push({
        goalId: goal.id,
        goalTitle: goal.title || goal.objective || goal.id,
        subgoalId: sg.id,
        title: sg.title,
        description: sg.description || '',
        expectedOutput: sg.expectedOutput || '',
        status: sg.status || 'todo',
        progress: sg.progress || 0,
        dueAt: sg.dueAt || 0,
        delegatedFrom: sg.delegatedFrom || '',
        delegationId: sg.delegationId || '',
        delegatedAt: sg.delegatedAt || 0,
      });
    }
  }
  rows.sort((a, b) => (Number(b.delegatedAt) || 0) - (Number(a.delegatedAt) || 0));
  return rows;
}

export function listDelegatedSubgoalsForGoal(goalId, opts = {}) {
  const id = String(goalId || '').trim();
  if (!id) return [];
  const goal = getGoal(id);
  if (!goal) return [];
  const includeDone = opts.includeDone === true;
  const openStatuses = new Set(['todo', 'doing', 'blocked']);
  return flattenSubgoals(goal.subgoals || [])
    .filter((sg) => String(sg.source || '') === 'delegation')
    .filter((sg) => includeDone || openStatuses.has(String(sg.status || 'todo').toLowerCase()))
    .map((sg) => ({
      goalId: goal.id,
      goalTitle: goal.title || goal.objective || goal.id,
      subgoalId: sg.id,
      title: sg.title,
      description: sg.description || '',
      expectedOutput: sg.expectedOutput || '',
      status: sg.status || 'todo',
      progress: sg.progress || 0,
      dueAt: sg.dueAt || 0,
      assignee: sg.assignee || '',
      delegatedFrom: sg.delegatedFrom || '',
      delegationId: sg.delegationId || '',
      delegatedAt: sg.delegatedAt || 0,
    }));
}

function formatDueLabel(dueAt) {
  const ts = Number(dueAt);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  try {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  } catch (_) {
    return '';
  }
}

/** System prompt block for an agent with open delegated assignments. */
export function buildDelegatedTasksContextBlock(agentId) {
  const rows = listDelegatedSubgoalsForAgent(agentId);
  if (!rows.length) return '';

  const lines = [
    '',
    '# Assigned delegated tasks (persistent)',
    'These subgoals were assigned via agent-send and are tracked on the mission goal.',
    'Complete the work in your reply; status updates when the delegator receives your answer.',
  ];
  rows.slice(0, 6).forEach((row, idx) => {
    const due = formatDueLabel(row.dueAt);
    lines.push(
      `${idx + 1}. **${row.title}** (goal: ${row.goalTitle}, subgoal id: ${row.subgoalId})`,
      `   Status: ${row.status} | Progress: ${row.progress}%${due ? ` | Due: ${due} UTC` : ''}`,
    );
    if (row.expectedOutput) lines.push(`   Expected output: ${row.expectedOutput}`);
    if (row.description) lines.push(`   Task: ${summarize(row.description, 240)}`);
    if (row.delegatedFrom) lines.push(`   Assigned by: ${row.delegatedFrom}`);
  });
  return lines.join('\n');
}

/** Prompt section listing open delegated subgoals on a goal (for goal ticks). */
export function formatDelegatedSubgoalsForGoalPrompt(goalId) {
  const rows = listDelegatedSubgoalsForGoal(goalId);
  if (!rows.length) return '';
  return rows.map((row) => {
    const due = formatDueLabel(row.dueAt);
    const parts = [
      `- [${row.status}] ${row.title} (${row.progress}%) assignee=${row.assignee}`,
      row.delegationId ? `delegation=${row.delegationId}` : '',
      due ? `due=${due}` : '',
      row.expectedOutput ? `expected="${summarize(row.expectedOutput, 80)}"` : '',
    ].filter(Boolean);
    return parts.join(' ');
  }).join('\n');
}
