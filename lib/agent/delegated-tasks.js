/**
 * Persistent task assignment for agent-send delegations.
 * Creates tracked tasks on Missions with assignee, due date, and expected output.
 */

import { getMission, listMissions, updateMission } from '../context/missions.js';
import { resolveMissionForUserTurn } from '../context/missions-context.js';
import { normalizeBlockerType, resolveBlockerType, ensureTaskBlockerFields } from '../context/tasks.js';
import {
  applyTaskPatchHistory,
  createInitialTaskHistory,
} from '../context/task-history.js';

export const DELEGATED_TASK_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'waiting_user',
  'waiting_dependency',
  'blocked',
  'error',
  'review_ready',
  'done',
  'rejected',
];

const VALID_DELEGATED_TASK_STATUSES = new Set(DELEGATED_TASK_STATUSES);
const LEGACY_STATUS_ALIASES = {
  todo: 'open',
  doing: 'in_progress',
};

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

function normalizeDelegatedTaskStatus(status, fallback = 'open') {
  const s = String(status || '').trim().toLowerCase();
  const mapped = LEGACY_STATUS_ALIASES[s] || s;
  return VALID_DELEGATED_TASK_STATUSES.has(mapped) ? mapped : fallback;
}

function flattenTasks(list, out = []) {
  for (const sg of list || []) {
    if (!sg) continue;
    out.push(sg);
    flattenTasks(sg.tasks, out);
  }
  return out;
}

function patchTaskInTree(tasks, taskId, patch, meta = {}) {
  let found = false;
  const next = (tasks || []).map((sg) => {
    if (String(sg.id || '') === taskId || (sg.slug && sg.slug === taskId)) {
      found = true;
      const merged = applyTaskPatchHistory(sg, { ...sg, ...patch }, meta);
      return merged;
    }
    if (Array.isArray(sg.tasks) && sg.tasks.length) {
      const nested = patchTaskInTree(sg.tasks, taskId, patch, meta);
      if (nested.found) {
        found = true;
        return { ...sg, tasks: nested.tasks };
      }
    }
    return sg;
  });
  return { tasks: next, found };
}

export function newDelegationId() {
  return `del-${nowMs().toString(36)}-${randomSuffix()}`;
}

export function shouldPersistDelegatedTask(opts = {}) {
  const message = String(opts.message || opts.description || '').trim();
  const title = String(opts.title || opts.taskTitle || '').trim();
  const expectedOutput = String(opts.expectedOutput || opts.expected_output || '').trim();
  const combined = [title, message, expectedOutput].filter(Boolean).join('\n');
  if (!combined) return false;
  if (expectedOutput && message && summarize(expectedOutput, 500).toLowerCase() === summarize(message, 500).toLowerCase()) {
    return false;
  }
  if (expectedOutput) return true;
  return !!(title || message);
}

/**
 * Resolve the Mission a delegation should attach to.
 * @param {{ callerAgentId?: string, missionId?: string, message?: string, ctx?: object }} opts
 */
export function resolveMissionForDelegation(opts = {}) {
  const explicit = String(opts.missionId || opts.ctx?.missionId || '').trim();
  if (explicit) {
    const mission = getMission(explicit);
    if (mission && String(mission.status || 'active').toLowerCase() === 'active') return mission;
  }
  const message = String(opts.message || '').trim();
  if (!message) return null;
  return resolveMissionForUserTurn({
    userText: message,
    historyMessages: opts.ctx?.delegationHistoryMessages || opts.ctx?.historyMessages || [],
    agentId: opts.callerAgentId || 'main',
  });
}

/**
 * @param {object} opts
 * @returns {{ mission: object, task: object, delegationId: string } | null}
 */
export function createDelegatedTask(opts = {}) {
  const missionId = String(opts.missionId || '').trim();
  const assignee = String(opts.assignee || '').trim();
  const delegatedFrom = String(opts.delegatedFrom || '').trim();
  if (!missionId || !assignee) return null;

  const mission = getMission(missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);

  const delegationId = String(opts.delegationId || newDelegationId()).trim();
  const taskId = String(opts.taskId || `sg-${delegationId}`).trim();
  const message = String(opts.message || opts.description || '').trim();
  const title = summarize(opts.title || opts.taskTitle || message.split(/[.!?\n]/)[0] || 'Delegated task', 180);
  const description = summarize(opts.description || message, 400);
  const expectedOutput = summarize(opts.expectedOutput || opts.expected_output || '', 400);
  const dueInHoursRaw = Number(opts.dueInHours ?? opts.due_in_hours);
  const dueInHours = Number.isFinite(dueInHoursRaw) && dueInHoursRaw > 0
    ? Math.floor(dueInHoursRaw)
    : 48;
  const dueAt = nowMs() + dueInHours * 3600_000;

  const task = createInitialTaskHistory({
    id: taskId,
    title,
    status: 'assigned',
    progress: 0,
    assignee,
    dependsOn: [],
    tasks: [],
    description,
    expectedOutput,
    dueInHours,
    dueAt,
    delegatedFrom,
    delegatedAt: nowMs(),
    delegationId,
    lastReplyAt: 0,
    reviewNotes: '',
    source: 'delegation',
  }, { actor: delegatedFrom });

  const tasks = Array.isArray(mission.tasks) ? mission.tasks.slice() : [];
  tasks.push(task);
  const updatedMission = updateMission(missionId, {
    tasks,
    lastActivity: `Delegated "${title}" to ${assignee}`,
  });

  return { mission: updatedMission, task, delegationId };
}

export function updateDelegatedTaskProgress(opts = {}) {
  const missionId = String(opts.missionId || '').trim();
  const taskId = String(opts.taskId || '').trim();
  if (!missionId || !taskId) return null;

  const mission = getMission(missionId);
  if (!mission) return null;

  const status = normalizeDelegatedTaskStatus(opts.status, '');
  const patch = {};
  if (status) patch.status = status;
  const progressRaw = Number(opts.progress);
  if (Number.isFinite(progressRaw)) {
    patch.progress = Math.max(0, Math.min(100, Math.round(progressRaw)));
  }
  if (opts.reviewNotes != null) patch.reviewNotes = summarize(opts.reviewNotes, 400);
  const existing = flattenTasks(mission.tasks || []).find((s) => s.id === taskId);
  const explicitBlockerType = normalizeBlockerType(opts.blockerType);
  if (explicitBlockerType) {
    patch.blockerType = explicitBlockerType;
  } else if (status === 'blocked') {
    patch.blockerType = resolveBlockerType({
      ...existing,
      status: 'blocked',
      description: opts.note || existing?.description || '',
    });
  }
  if (status === 'blocked') {
    Object.assign(patch, ensureTaskBlockerFields({
      ...existing,
      ...patch,
      title: existing?.title || '',
      status: 'blocked',
    }));
  }
  if (opts.lastReplyAt != null) {
    const ts = Number(opts.lastReplyAt);
    if (Number.isFinite(ts) && ts > 0) patch.lastReplyAt = Math.floor(ts);
  }
  if (opts.note) {
    const note = summarize(opts.note, 200);
    patch.description = summarize(`${existing?.description || ''} [${note}]`, 400);
  }

  const { tasks, found } = patchTaskInTree(mission.tasks || [], taskId, patch, {
    ts: nowMs(),
    actor: opts.actor || existing?.assignee || '',
    note: opts.note || '',
    reply: opts.reply || '',
    replyDetail: opts.replyDetail || '',
    outcome: opts.outcome || '',
  });
  if (!found) return null;

  const activityByStatus = {
    assigned: 'assigned',
    in_progress: 'progress logged',
    waiting_user: 'waiting on user',
    waiting_dependency: 'waiting on dependency',
    blocked: 'blocked',
    review_ready: 'ready for review',
    done: 'completed',
    rejected: 'rejected',
    open: 'opened',
  };
  const activity = `Delegated task ${taskId} ${activityByStatus[status] || 'updated'}`;

  return updateMission(missionId, { tasks, lastActivity: activity });
}

function wordSet(text) {
  const stop = new Set(['with', 'each', 'this', 'that', 'from', 'have', 'will', 'should', 'would', 'could']);
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !stop.has(w)),
  );
}

function expectedOutputSatisfied(reply, expectedOutput) {
  const expected = String(expectedOutput || '').trim();
  const text = String(reply || '').trim();
  if (!expected || !text) return false;
  const replyLower = text.toLowerCase();
  const expectedWords = Array.from(wordSet(expected)).slice(0, 12);
  if (!expectedWords.length) return false;
  const hits = expectedWords.filter((w) => replyLower.includes(w)).length;
  const ratio = hits / expectedWords.length;
  const hasDeliveryLanguage = /\b(delivered|attached|included|completed|final|draft|plan|audit|report|summary|examples?|checklist|implementation)\b/i.test(text);
  const hasStructure = /(^|\n)\s*(#{1,4}\s+|[-*]\s+|\d+[.)]\s+)/.test(text);
  return ratio >= 0.5 && (hasDeliveryLanguage || hasStructure || text.length >= 500);
}

function classifyReplyStatus(reply, expectedOutput = '') {
  const text = String(reply || '').trim();
  if (!text) return { status: 'blocked', blockerType: 'need_direction', progress: 0, reason: 'empty reply' };

  // Rate-limits and infra failures — auto-retries, never surface to user as a blocker.
  if (/\b(rate.?limit|daily.?limit|llm.?limit|quota|resets at|try again in \d|request.?limit|api.?limit)\b/i.test(text)) {
    return { status: 'blocked', blockerType: 'system_error', progress: 0, reason: 'rate limit or quota — auto-retry; not user-actionable' };
  }

  // System/runtime errors should not prompt the user.
  if (/\b(playwright|chromium|binary|not installed|runtime is broken|ENOENT|spawn|cannot find module|segfault)\b/i.test(text) &&
      /\b(failed|error|broken|missing)\b/i.test(text)) {
    return { status: 'error', blockerType: 'system_error', progress: 0, reason: 'system runtime error — not a user-actionable blocker' };
  }

  if (/\b(need access|missing access|need credentials|needs credentials|api key|missing api|missing token|permission denied|unauthorized|403|401)\b/i.test(text)) {
    return { status: 'blocked', blockerType: 'need_access', progress: 25, reason: 'specialist needs access or credentials' };
  }
  if (/\b(blocked|cannot continue|can't continue|unable to continue|failed|error|timeout)\b/i.test(text)) {
    return { status: 'blocked', blockerType: 'need_direction', progress: 25, reason: 'specialist reported a blocker' };
  }
  if (/\b(waiting for|depends on|dependency)\b/i.test(text)) {
    return { status: 'waiting_dependency', progress: 35, reason: 'specialist is waiting on a dependency' };
  }
  if (/\b(need you|need user|please confirm|which option|choose|approval|approve|clarify|question for you)\b/i.test(text)) {
    return { status: 'waiting_user', progress: 35, reason: 'specialist needs user input' };
  }
  if (expectedOutputSatisfied(text, expectedOutput)) {
    return { status: 'review_ready', progress: 90, reason: 'reply appears to satisfy expected output' };
  }
  if (!expectedOutput && /\b(delivered|attached|included|final|draft|plan|report|checklist|summary)\b/i.test(text) && text.length >= 300) {
    return { status: 'review_ready', progress: 80, reason: 'reply looks like a reviewable artifact' };
  }
  return { status: 'in_progress', progress: 45, reason: 'reply logged as progress; expected output not verified' };
}

export function recordDelegatedTaskReply(delegatedTask, opts = {}) {
  if (!delegatedTask || typeof delegatedTask !== 'object') return null;
  const missionId = String(delegatedTask.missionId || '').trim();
  const taskId = String(delegatedTask.taskId || '').trim();
  if (!missionId || !taskId) return null;

  const replySummary = summarize(opts.replySummary || opts.reply || '', 400);
  const expectedOutput = delegatedTask.expectedOutput || opts.expectedOutput || '';
  const verdict = classifyReplyStatus(replySummary, expectedOutput);
  return updateDelegatedTaskProgress({
    missionId,
    taskId,
    status: opts.status || verdict.status,
    progress: opts.progress ?? verdict.progress,
    blockerType: verdict.blockerType,
    note: replySummary ? `Reply: ${replySummary}` : '',
    reply: replySummary,
    replyDetail: verdict.reason,
    actor: delegatedTask.assignee || opts.actor || '',
    reviewNotes: verdict.reason,
    lastReplyAt: nowMs(),
  });
}

export function completeDelegatedTask(delegatedTask, opts = {}) {
  if (!delegatedTask || typeof delegatedTask !== 'object') return null;
  const missionId = String(delegatedTask.missionId || '').trim();
  const taskId = String(delegatedTask.taskId || '').trim();
  if (!missionId || !taskId) return null;
  return updateDelegatedTaskProgress({
    missionId,
    taskId,
    status: opts.status || 'done',
    progress: opts.progress ?? 100,
    note: opts.note || opts.replySummary || '',
  });
}

export function failDelegatedTask(delegatedTask, message) {
  if (!delegatedTask || typeof delegatedTask !== 'object') return null;
  const note = summarize(message, 120);
  return updateDelegatedTaskProgress({
    missionId: delegatedTask.missionId,
    taskId: delegatedTask.taskId,
    status: 'blocked',
    progress: delegatedTask.progress || 0,
    blockerType: resolveBlockerType({ title: delegatedTask.title, description: note }),
    note,
  });
}

/** Open delegated tasks assigned to an agent across active missions. */
export function listDelegatedTasksForAgent(agentId, opts = {}) {
  const id = String(agentId || '').trim();
  if (!id) return [];
  const includeDone = opts.includeDone === true;
  const openStatuses = new Set(['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_dependency', 'blocked', 'review_ready', 'todo', 'doing']);
  let missions = [];
  try {
    missions = (listMissions().missions || []).filter((g) => String(g.status || 'active').toLowerCase() === 'active');
  } catch (_) {
    return [];
  }

  const rows = [];
  for (const mission of missions) {
    for (const sg of flattenTasks(mission.tasks || [])) {
      if (String(sg.source || '') !== 'delegation') continue;
      if (String(sg.assignee || '').trim() !== id) continue;
      if (!includeDone && !openStatuses.has(String(sg.status || 'todo').toLowerCase())) continue;
      rows.push({
        missionId: mission.id,
        missionTitle: mission.title || mission.objective || mission.id,
        taskId: sg.id,
        title: sg.title,
        description: sg.description || '',
        expectedOutput: sg.expectedOutput || '',
        status: sg.status || 'todo',
        progress: sg.progress || 0,
        reviewNotes: sg.reviewNotes || '',
        lastReplyAt: sg.lastReplyAt || 0,
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

export function listDelegatedTasksForMission(missionId, opts = {}) {
  const id = String(missionId || '').trim();
  if (!id) return [];
  const mission = getMission(id);
  if (!mission) return [];
  const includeDone = opts.includeDone === true;
  const openStatuses = new Set(['open', 'assigned', 'in_progress', 'waiting_user', 'waiting_dependency', 'blocked', 'review_ready', 'todo', 'doing']);
  return flattenTasks(mission.tasks || [])
    .filter((sg) => String(sg.source || '') === 'delegation')
    .filter((sg) => includeDone || openStatuses.has(String(sg.status || 'todo').toLowerCase()))
    .map((sg) => ({
      missionId: mission.id,
      missionTitle: mission.title || mission.objective || mission.id,
      taskId: sg.id,
      title: sg.title,
      description: sg.description || '',
      expectedOutput: sg.expectedOutput || '',
      status: sg.status || 'todo',
      progress: sg.progress || 0,
      reviewNotes: sg.reviewNotes || '',
      lastReplyAt: sg.lastReplyAt || 0,
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
  const rows = listDelegatedTasksForAgent(agentId);
  if (!rows.length) return '';

  const lines = [
    '',
    '# Assigned delegated tasks (persistent)',
    'These tasks were assigned via agent-send and are tracked on the mission mission.',
    'Reply with progress or a reviewable artifact. A reply does not mark the task done; done requires acceptance or verification.',
  ];
  rows.slice(0, 6).forEach((row, idx) => {
    const due = formatDueLabel(row.dueAt);
    lines.push(
      `${idx + 1}. **${row.title}** (mission: ${row.missionTitle}, task id: ${row.taskId})`,
      `   Status: ${row.status} | Progress: ${row.progress}%${due ? ` | Due: ${due} UTC` : ''}`,
    );
    if (row.expectedOutput) lines.push(`   Expected output: ${row.expectedOutput}`);
    if (row.description) lines.push(`   Task: ${summarize(row.description, 240)}`);
    if (row.reviewNotes) lines.push(`   Review notes: ${summarize(row.reviewNotes, 160)}`);
    if (row.delegatedFrom) lines.push(`   Assigned by: ${row.delegatedFrom}`);
  });
  return lines.join('\n');
}

/** Prompt section listing open delegated tasks on a mission (for mission ticks). */
export function formatDelegatedTasksForMissionPrompt(missionId) {
  const rows = listDelegatedTasksForMission(missionId);
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
