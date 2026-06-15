import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { getLegacyMissionsStorePath, getMissionsStorePath } from './paths.js';
import { readTeamActivityWindow } from './team-activity.js';
import { createSuggestedTasks, removeSuggestedTasksForMission } from './ai-suggested-tasks.js';
import { formatUserFacingReply } from './user-facing-reply.js';
import { TASK_LABELS, addTaskLabel, normalizeTaskLabels, resolveBlockerType } from './tasks.js';

const VALID_STATUS = new Set(['active', 'paused', 'completed', 'blocked']);
const VALID_TASK_STATUS = new Set([
  'open',
  'assigned',
  'in_progress',
  'waiting_user',
  'waiting_dependency',
  'blocked',
  'review_ready',
  'done',
  'rejected',
  // Legacy dashboard/project-workflow statuses remain valid.
  'todo',
  'doing',
]);
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MAX_CREATED_TASKS_PER_TICK = 3;

function getMissionsDir() {
  return dirname(getMissionsStorePath());
}

function sanitizeMissionIdForPath(missionId) {
  return String(missionId || '').trim().replace(/[^0-9a-zA-Z\-_]/g, '_') || 'mission';
}

/** Directory that contains all files for a specific mission (memory, config, tasks). */
export function getMissionDir(missionId) {
  const safeId = sanitizeMissionIdForPath(missionId);
  return join(getMissionsDir(), safeId);
}

/** Per-mission config file — mirrors the mission record from missions.json for standalone cleanup. */
export function getMissionConfigPath(missionId) {
  return join(getMissionDir(missionId), 'mission.json');
}

export function getMissionMemoryPath(missionId) {
  const safeId = sanitizeMissionIdForPath(missionId);
  return join(getMissionsDir(), safeId, 'memory.md');
}

function nowMs() {
  return Date.now();
}

function sanitizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return VALID_STATUS.has(s) ? s : 'active';
}

function slugPart(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return s || fallback;
}

function clampIntervalMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.floor(n)));
}

function summarize(text, maxLen = 240) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}...` : s;
}

function safeArray(input, max = 12) {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizePlanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step, i) => {
      if (typeof step === 'string') {
        const title = step.trim();
        if (!title) return null;
        return { id: `s${i + 1}`, title, status: 'todo' };
      }
      if (!step || typeof step !== 'object') return null;
      const title = String(step.title || step.name || '').trim();
      if (!title) return null;
      const statusRaw = String(step.status || 'todo').trim().toLowerCase();
      const status = VALID_TASK_STATUS.has(statusRaw) ? statusRaw : 'todo';
      const children = normalizePlanSteps(step.children || step.substeps || []);
      return {
        id: String(step.id || `s${i + 1}`).trim(),
        title,
        status,
        children,
      };
    })
    .filter(Boolean)
    .slice(0, 30);
}

function defaultProgress() {
  return { pct: 0, metrics: {}, evidence: [] };
}

function normalizeTaskStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return VALID_TASK_STATUS.has(s) ? s : 'todo';
}

function normalizeTasks(tasks, opts = {}) {
  if (!Array.isArray(tasks)) return [];
  const depth = Number(opts.depth) || 0;
  if (depth > 5) return [];
  const usedSlugs = new Set();
  return tasks
    .map((row, idx) => {
      if (!row || typeof row !== 'object') return null;
      const title = summarize(row.title || row.name || '', 180);
      if (!title) return null;
      const rawProgress = Number(row.progress);
      const progress = Number.isFinite(rawProgress)
        ? Math.max(0, Math.min(100, Math.round(rawProgress)))
        : 0;
      const id = String(row.id || `task-${depth + 1}-${idx + 1}`).trim();
      const baseSlug = String(row.slug || '').trim() || slugPart(title, `task-${depth + 1}-${idx + 1}`);
      let slug = baseSlug;
      let slugN = 2;
      while (usedSlugs.has(slug)) slug = `${baseSlug}-${slugN++}`;
      usedSlugs.add(slug);
      const dependsOn = safeArray(row.dependsOn || row.depends_on || [], 20);
      const description = summarize(row.description || row.objective || '', 400);
      const priorityRaw = Number(row.priority);
      const priority = Number.isFinite(priorityRaw) ? Math.max(1, Math.min(5, Math.round(priorityRaw))) : 0;
      const dueInHoursRaw = Number(row.dueInHours ?? row.due_in_hours);
      const dueInHours = Number.isFinite(dueInHoursRaw) && dueInHoursRaw > 0 ? Math.floor(dueInHoursRaw) : 0;
      const dueAtRaw = Number(row.dueAt ?? row.due_at);
      const dueAt = Number.isFinite(dueAtRaw) && dueAtRaw > 0
        ? Math.floor(dueAtRaw)
        : (dueInHours ? nowMs() + dueInHours * 3600_000 : 0);
      const expectedOutput = summarize(row.expectedOutput || row.expected_output || '', 400);
      const delegatedFrom = summarize(row.delegatedFrom || row.delegated_from || '', 80);
      const delegationId = summarize(row.delegationId || row.delegation_id || '', 80);
      const source = summarize(row.source || '', 40);
      const type = summarize(row.type || row.taskType || row.task_type || '', 40);
      const suggestedAgent = summarize(row.suggestedAgent || row.suggested_agent || '', 80);
      const routeReason = summarize(row.routeReason || row.route_reason || '', 240);
      const routeConfidenceRaw = Number(row.routeConfidence ?? row.route_confidence);
      const routeConfidence = Number.isFinite(routeConfidenceRaw)
        ? Math.max(0, Math.min(1, routeConfidenceRaw))
        : 0;
      const delegatedAtRaw = Number(row.delegatedAt ?? row.delegated_at);
      const delegatedAt = Number.isFinite(delegatedAtRaw) && delegatedAtRaw > 0
        ? Math.floor(delegatedAtRaw)
        : 0;
      const lastReplyAtRaw = Number(row.lastReplyAt ?? row.last_reply_at);
      const lastReplyAt = Number.isFinite(lastReplyAtRaw) && lastReplyAtRaw > 0
        ? Math.floor(lastReplyAtRaw)
        : 0;
      const reviewNotes = summarize(row.reviewNotes || row.review_notes || '', 400);
      const createdAtRaw = Number(row.createdAt ?? row.created_at);
      const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : 0;
      const startedAtRaw = Number(row.startedAt ?? row.started_at);
      const startedAt = Number.isFinite(startedAtRaw) && startedAtRaw > 0 ? Math.floor(startedAtRaw) : 0;
      const completedAtRaw = Number(row.completedAt ?? row.completed_at);
      const completedAt = Number.isFinite(completedAtRaw) && completedAtRaw > 0 ? Math.floor(completedAtRaw) : 0;
      const waitingSinceRaw = Number(row.waitingSince ?? row.waiting_since);
      const waitingSince = Number.isFinite(waitingSinceRaw) && waitingSinceRaw > 0 ? Math.floor(waitingSinceRaw) : 0;
      const status = normalizeTaskStatus(row.status);
      const out = {
        id: id || `task-${depth + 1}-${idx + 1}`,
        slug,
        title,
        status,
        progress,
        assignee: summarize(row.assignee || row.ownerAgentId || '', 80),
        dependsOn: dependsOn,
        labels: normalizeTaskLabels({ ...row, id, status, source }),
        tasks: normalizeTasks(row.tasks || row.subgoals || row.children || [], { depth: depth + 1 }),
      };
      if (description) out.description = description;
      if (expectedOutput) out.expectedOutput = expectedOutput;
      if (priority) out.priority = priority;
      if (dueInHours) out.dueInHours = dueInHours;
      if (dueAt) out.dueAt = dueAt;
      if (delegatedFrom) out.delegatedFrom = delegatedFrom;
      if (delegatedAt) out.delegatedAt = delegatedAt;
      if (delegationId) out.delegationId = delegationId;
      if (lastReplyAt) out.lastReplyAt = lastReplyAt;
      if (reviewNotes) out.reviewNotes = reviewNotes;
      if (source) out.source = source;
      if (type) out.type = type;
      if (suggestedAgent) out.suggestedAgent = suggestedAgent;
      if (routeReason) out.routeReason = routeReason;
      if (routeConfidence) out.routeConfidence = routeConfidence;
      if (createdAt) out.createdAt = createdAt;
      if (startedAt) out.startedAt = startedAt;
      if (completedAt) out.completedAt = completedAt;
      if (waitingSince) out.waitingSince = waitingSince;
      if (status === 'blocked' || out.labels.includes(TASK_LABELS.BLOCKER)) {
        const blockerType = resolveBlockerType({ ...row, ...out });
        if (blockerType) out.blockerType = blockerType;
      }
      return out;
    })
    .filter(Boolean)
    .slice(0, 40);
}

function flattenTasks(list, out = []) {
  for (const sg of list || []) {
    if (!sg) continue;
    out.push(sg);
    flattenTasks(sg.tasks, out);
  }
  return out;
}

/** Preserve mission task tree; mission ticks may only patch status/progress by id/title. */
export function mergeTaskTrees(existing, incoming) {
  const existingNorm = normalizeTasks(existing || []);
  if (!Array.isArray(incoming) || !incoming.length) return existingNorm;
  const incomingNorm = normalizeTasks(incoming);
  const flatIncoming = flattenTasks(incomingNorm);
  const byId = new Map(flatIncoming.filter((s) => s.id).map((s) => [s.id, s]));
  const bySlug = new Map(flatIncoming.filter((s) => s.slug).map((s) => [s.slug, s]));
  const byTitle = new Map(flatIncoming.map((s) => [String(s.title || '').trim().toLowerCase(), s]));

  function patchList(list) {
    const now = nowMs();
    return (list || []).map((sg) => {
      const match = byId.get(sg.id) || bySlug.get(sg.slug) || byTitle.get(String(sg.title || '').trim().toLowerCase());
      const prevStatus = String(sg.status || '').toLowerCase();
      const newStatus = match ? normalizeTaskStatus(match.status || sg.status) : prevStatus;
      const next = match
        ? {
          ...sg,
          status: newStatus,
          progress: Number.isFinite(Number(match.progress)) ? Math.max(0, Math.min(100, Math.round(Number(match.progress)))) : sg.progress,
          assignee: match.assignee || sg.assignee,
        }
        : { ...sg };
      if (newStatus === 'blocked' || (Array.isArray(next.labels) && next.labels.includes(TASK_LABELS.BLOCKER))) {
        const blockerType = resolveBlockerType({
          ...next,
          blockerType: match?.blockerType || next.blockerType,
          status: newStatus,
        });
        if (blockerType) next.blockerType = blockerType;
      }
      // Stamp lifecycle timestamps on status transitions.
      if (!next.createdAt) next.createdAt = now;
      if (newStatus === 'doing' && prevStatus !== 'doing' && !next.startedAt) next.startedAt = now;
      if (newStatus === 'done' && prevStatus !== 'done' && !next.completedAt) next.completedAt = now;
      if (newStatus === 'waiting_dependency' && prevStatus !== 'waiting_dependency' && !next.waitingSince) next.waitingSince = now;
      if (Array.isArray(sg.tasks) && sg.tasks.length) {
        next.tasks = patchList(sg.tasks);
      }
      return next;
    });
  }

  const existingFlat = flattenTasks(existingNorm);
  const incomingIds = new Set(flatIncoming.map((s) => s.id));
  const overlap = existingFlat.filter((s) => incomingIds.has(s.id)).length;
  const looksLikeRestructure = existingFlat.length >= 4
    && incomingNorm.length <= 2
    && overlap === 0;

  if (looksLikeRestructure) return patchList(existingNorm);
  if (incomingNorm.length >= existingNorm.length && overlap > 0) return patchList(incomingNorm);
  return patchList(existingNorm);
}

function normalizeCreatedTask(row, idx, opts = {}) {
  if (!row || typeof row !== 'object') return null;
  const title = summarize(row.title || row.name || '', 180);
  if (!title) return null;
  const description = summarize(row.description || row.objective || '', 400);
  const assignee = summarize(row.assignee || row.ownerAgentId || opts.defaultAssignee || '', 80);
  const priorityRaw = Number(row.priority);
  const priority = Number.isFinite(priorityRaw) ? Math.max(1, Math.min(5, Math.round(priorityRaw))) : 0;
  const dueInHoursRaw = Number(row.dueInHours ?? row.due_in_hours);
  const dueInHours = Number.isFinite(dueInHoursRaw) && dueInHoursRaw > 0 ? Math.floor(dueInHoursRaw) : 0;
  const dueAt = dueInHours ? nowMs() + dueInHours * 3600_000 : 0;
  const dependsOn = safeArray(row.dependsOn || row.depends_on || [], 20);
  let id = String(row.id || `task-new-${nowMs().toString(36)}-${idx + 1}`).trim() || `task-new-${idx + 1}`;
  const slug = String(row.slug || '').trim() || slugPart(title, `task-new-${idx + 1}`);
  const out = {
    id,
    slug,
    title,
    status: 'todo',
    progress: 0,
    assignee,
    dependsOn: dependsOn,
    labels: normalizeTaskLabels(row),
    tasks: [],
  };
  const expectedOutput = summarize(row.expectedOutput || row.expected_output || '', 200);
  if (description) out.description = description;
  if (expectedOutput) out.expectedOutput = expectedOutput;
  if (priority) out.priority = priority;
  if (dueInHours) out.dueInHours = dueInHours;
  if (dueAt) out.dueAt = dueAt;
  out.createdAt = nowMs();
  return out;
}

/** Insert brand-new tasks from a tick response without restructuring the existing tree. */
/**
 * Normalize a task title for duplicate detection: lowercase, strip punctuation,
 * collapse whitespace, and strip trailing plural 's'. This catches LLM variants
 * like "Research signup flows" vs "research signup flow" or "Research signup flows."
 */
function dedupTitleKey(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/s\b/g, ''); // strip trailing plurals per word
}

export function createTasksFromTick(existingTasks, createdRaw, opts = {}) {
  const maxNew = Math.max(1, Math.min(
    MAX_CREATED_TASKS_PER_TICK,
    Number(opts.maxNew) || MAX_CREATED_TASKS_PER_TICK,
  ));
  const existingNorm = normalizeTasks(existingTasks || []);
  const existingFlat = flattenTasks(existingNorm);
  const existingTitles = new Set(
    existingFlat.map((s) => String(s.title || '').trim().toLowerCase()).filter(Boolean),
  );
  // Also track normalized keys for fuzzy dedup against LLM title variations.
  const existingTitleKeys = new Set(
    existingFlat.map((s) => dedupTitleKey(s.title)).filter(Boolean),
  );
  const existingIds = new Set(
    existingFlat.map((s) => String(s.id || '').trim()).filter(Boolean),
  );
  const created = [];

  if (!Array.isArray(createdRaw) || !createdRaw.length) {
    return { tasks: existingNorm, created };
  }

  for (let i = 0; i < createdRaw.length && created.length < maxNew; i++) {
    const normalized = normalizeCreatedTask(createdRaw[i], i, opts);
    if (!normalized) continue;
    const titleKey = normalized.title.toLowerCase();
    if (existingTitles.has(titleKey)) continue;
    if (existingTitleKeys.has(dedupTitleKey(normalized.title))) continue;
    let id = normalized.id;
    while (existingIds.has(id)) {
      id = `${normalized.id}-${created.length + 1}`;
    }
    normalized.id = id;
    existingTitles.add(titleKey);
    existingTitleKeys.add(dedupTitleKey(normalized.title));
    existingIds.add(id);
    created.push(normalized);
  }

  if (!created.length) return { tasks: existingNorm, created };
  return { tasks: [...existingNorm, ...created], created };
}

function formatDecisionPrompt(question, options = [], recommendedIndex = 0) {
  const q = summarize(question, 280);
  const opts = (options || []).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 4);
  if (!opts.length) return q;
  const rec = opts[recommendedIndex] || opts[0];
  const lead = q.endsWith('.') ? q : `${q}.`;
  return [
    lead,
    `Recommend: ${rec}.`,
    'Options:',
    ...opts.map((o, i) => `${i + 1}) ${o}`),
    'Reply "use default" or a number.',
  ].join('\n');
}

/** Letter prompts (A/B/C) with no inline option text are unusable — often truncated glossary. */
function isOrphanedLetterPrompt(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  const asksForLetter = /\breply with (one )?(character|letter)\b/i.test(raw)
    || (/\b(recommended|pick|choose):\s*[A-E]\b/i.test(raw) && /\b[A-E]\s*,\s*[A-E]\b/.test(raw));
  if (!asksForLetter) return false;
  const hasOptionDefs = /\b[A-E]\s*=\s*\S/.test(raw)
    || /\b[A-E]\)\s+[A-Za-z0-9"']/.test(raw);
  const truncatedGlossary = /\b[A-E]\s*=/.test(raw) && raw.endsWith('...');
  return !hasOptionDefs || truncatedGlossary;
}

export function normalizeNeedsUserInput(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (isOrphanedLetterPrompt(raw)) return '';
  const summarized = summarize(raw, 480);
  if (!summarized) return '';
  if (/recommend|reply|use default|options?:/i.test(summarized)) return summarized;
  if (/posthog|ga4|mixpanel|analytics tool|analytics stack/i.test(raw)) {
    return formatDecisionPrompt(
      'Pick an analytics stack for funnel instrumentation.',
      [
        'PostHog (product analytics + funnels)',
        'GA4 (Google stack)',
        'Mixpanel (growth analytics)',
      ],
      0,
    );
  }
  return summarized;
}

function formatDelegatedTasksForPrompt(tasks) {
  const openDelegatedStatuses = new Set([
    'open',
    'assigned',
    'in_progress',
    'waiting_user',
    'waiting_dependency',
    'blocked',
    'review_ready',
    'todo',
    'doing',
  ]);
  const rows = flattenTasks(normalizeTasks(tasks || []))
    .filter((sg) => String(sg.source || '') === 'delegation')
    .filter((sg) => openDelegatedStatuses.has(String(sg.status || 'open').toLowerCase()));
  if (!rows.length) return '';
  return rows.map((sg) => {
    const due = sg.dueAt ? new Date(sg.dueAt).toISOString().slice(0, 16).replace('T', ' ') : '';
    return [
      `- [${sg.status}] ${sg.title} (${sg.progress}%) assignee=${sg.assignee || '?'}`,
      sg.delegationId ? `delegation=${sg.delegationId}` : '',
      due ? `due=${due}` : '',
      sg.expectedOutput ? `expected="${summarize(sg.expectedOutput, 80)}"` : '',
      sg.reviewNotes ? `review="${summarize(sg.reviewNotes, 80)}"` : '',
    ].filter(Boolean).join(' ');
  }).join('\n');
}

function formatTasksForPrompt(tasks, depth = 0) {
  if (!Array.isArray(tasks) || !tasks.length) return [];
  if (depth > 5) return [];
  const lines = [];
  tasks.forEach((sg) => {
    const indent = '  '.repeat(depth);
    const deps = Array.isArray(sg.dependsOn) && sg.dependsOn.length
      ? ` dependsOn=${sg.dependsOn.join(',')}`
      : '';
    const assignee = sg.assignee ? ` assignee=${sg.assignee}` : '';
    const delegation = sg.source === 'delegation'
      ? [
        sg.delegationId ? ` delegation=${sg.delegationId}` : '',
        sg.expectedOutput ? ` expected="${summarize(sg.expectedOutput, 60)}"` : '',
        sg.dueAt ? ` due=${new Date(sg.dueAt).toISOString().slice(0, 16)}` : '',
      ].join('')
      : '';
    lines.push(`${indent}- [${sg.status}] ${sg.title} (${sg.progress}%)${assignee}${delegation}${deps}`);
    lines.push(...formatTasksForPrompt(sg.tasks || [], depth + 1));
  });
  return lines;
}

function normalizeWaitCondition(wait, opts = {}) {
  if (!wait || typeof wait !== 'object') return null;
  const now = Number(opts.now) || nowMs();
  const kindRaw = String(wait.kind || wait.type || '').trim().toLowerCase();
  const kind = kindRaw === 'until_time' || kindRaw === 'timestamp' || kindRaw === 'until'
    ? 'time'
    : kindRaw === 'activity' || kindRaw === 'event'
      ? 'team_activity'
      : kindRaw === 'condition'
        ? 'manual'
        : kindRaw;
  if (!kind || kind === 'none') return null;
  if (kind === 'time') {
    const untilTs = Number(wait.untilTs ?? wait.until ?? wait.ts);
    if (!Number.isFinite(untilTs) || untilTs <= 0) return null;
    return {
      kind: 'time',
      reason: summarize(wait.reason || wait.condition || 'Waiting until a specific time', 240),
      untilTs: Math.floor(untilTs),
      sinceTs: Number(wait.sinceTs) || now,
    };
  }
  if (kind === 'team_activity') {
    const eventType = summarize(wait.eventType || wait.event || '', 80);
    const messageIncludes = summarize(wait.messageIncludes || wait.contains || wait.match || '', 160);
    const agentId = summarize(wait.agentId || '', 80);
    const targetAgentId = summarize(wait.targetAgentId || '', 80);
    const reason = summarize(wait.reason || wait.condition || 'Waiting for matching team activity', 240);
    if (!eventType && !messageIncludes && !agentId && !targetAgentId) return null;
    return {
      kind: 'team_activity',
      reason,
      sinceTs: Number(wait.sinceTs) || now,
      eventType,
      messageIncludes,
      agentId,
      targetAgentId,
    };
  }
  if (kind === 'manual' || kind === 'partial') {
    const condition = summarize(wait.condition || wait.reason || '', 240);
    const waitAppliesTo = normalizeWaitAppliesTo(wait.waitAppliesTo || wait.scope || wait.appliesTo, 'implementation');
    const blockedTaskIds = safeArray(wait.blockedTaskIds || wait.appliesToTaskIds || [], 20);
    return {
      kind: 'partial',
      scope: waitAppliesTo,
      waitAppliesTo,
      blockedTaskIds,
      reason: condition || 'Implementation blocked; research continues',
      condition,
      sinceTs: Number(wait.sinceTs) || now,
    };
  }
  return null;
}

const VALID_WAIT_APPLIES_TO = new Set(['implementation', 'research', 'deployment', 'instrumentation', 'all']);

export function normalizeWaitAppliesTo(value, fallback = 'implementation') {
  const raw = String(value || fallback).trim().toLowerCase();
  return VALID_WAIT_APPLIES_TO.has(raw) ? raw : fallback;
}

export function isPartialWaitCondition(waitCondition) {
  return String(waitCondition?.kind || '').toLowerCase() === 'partial';
}

function getWaitBlockedTaskIds(waitCondition) {
  if (!isPartialWaitCondition(waitCondition)) return [];
  return safeArray(waitCondition.blockedTaskIds || waitCondition.appliesToTaskIds || [], 20);
}

function classifyTaskScope(task) {
  const hay = `${task?.id || ''} ${task?.title || ''} ${task?.description || ''}`.toLowerCase();
  if (/research|explore|benchmark|competitor|audit|interview|survey|discover|review competitors/.test(hay)) return 'research';
  if (/instrument|tracking|analytics|posthog|ga4|mixpanel|pixel|funnel|telemetry|measurement/.test(hay)) return 'instrumentation';
  if (/deploy|release|launch|production|prod|go-live|ship/.test(hay)) return 'deployment';
  if (/implement|build|develop|integrate|setup|code|configure|stack-confirmation/.test(hay)) return 'implementation';
  return 'general';
}

function scopeBlockedByWaitAppliesTo(taskScope, waitAppliesTo) {
  if (waitAppliesTo === 'all') return true;
  if (waitAppliesTo === taskScope) return true;
  if (waitAppliesTo === 'implementation' && (taskScope === 'implementation' || taskScope === 'instrumentation' || taskScope === 'deployment')) {
    return true;
  }
  return false;
}

export function taskBlockedByWait(task, waitCondition) {
  if (!task || !isPartialWaitCondition(waitCondition)) return false;
  const blockedIds = getWaitBlockedTaskIds(waitCondition);
  // When explicit task IDs are provided they are the sole criterion — do not also
  // apply scope-based blocking, which would catch unrelated tasks whose titles
  // happen to contain words like "launch" or "deploy".
  if (blockedIds.length > 0) return blockedIds.includes(String(task.id || '').trim());
  const waitAppliesTo = normalizeWaitAppliesTo(waitCondition.waitAppliesTo || waitCondition.scope, 'implementation');
  return scopeBlockedByWaitAppliesTo(classifyTaskScope(task), waitAppliesTo);
}

/** Split tasks into wait-blocked vs still actionable during a partial/manual wait. */
export function partitionTasksByWait(tasks, waitCondition) {
  const flat = flattenTasks(normalizeTasks(tasks || []));
  const blocked = [];
  const actionable = [];
  flat.forEach((sg) => {
    if (taskBlockedByWait(sg, waitCondition)) blocked.push(sg);
    else if (String(sg.status || '').toLowerCase() !== 'done') actionable.push(sg);
  });
  return { blocked, actionable, hasActionableWork: actionable.length > 0 };
}

function applyWaitBlocksToTasks(tasks, waitCondition) {
  if (!isPartialWaitCondition(waitCondition)) return normalizeTasks(tasks || []);
  function walk(list) {
    return (list || []).map((sg) => {
      const next = { ...sg };
      const s = String(next.status || '').toLowerCase();
      if (taskBlockedByWait(sg, waitCondition) && s !== 'done' && s !== 'blocked') {
        // Tasks stalled by a partial wait are dependencies, not user-input blockers.
        // Use waiting_dependency so they surface as "open" (agent picks up later) not "blocked".
        next.status = 'waiting_dependency';
        if (!next.waitingSince) next.waitingSince = nowMs();
      }
      if (Array.isArray(next.tasks) && next.tasks.length) {
        next.tasks = walk(next.tasks);
      }
      return next;
    });
  }
  return walk(normalizeTasks(tasks || []));
}

function formatWaitScopeForPrompt(waitCondition, tasks) {
  if (!isPartialWaitCondition(waitCondition)) return '';
  const { blocked, actionable } = partitionTasksByWait(tasks, waitCondition);
  const waitAppliesTo = normalizeWaitAppliesTo(waitCondition.waitAppliesTo || waitCondition.scope, 'implementation');
  const blockedLines = blocked.slice(0, 10).map((s) => `- [BLOCKED BY WAIT] ${s.title} (${s.id})`);
  const actionableLines = actionable.slice(0, 10).map((s) => `- [OK THIS TICK] ${s.title} (${s.id})`);
  return [
    `Wait applies to: ${waitAppliesTo} only — mission ticks continue on other branches.`,
    blockedLines.length ? `Blocked branches:\n${blockedLines.join('\n')}` : '',
    actionableLines.length
      ? `Actionable branches:\n${actionableLines.join('\n')}`
      : 'Actionable branches: research, planning, createdTasks, suggestedTasks (parallel safe work).',
    'Continue parallel safe work during this wait. Do not idle the whole mission.',
  ].filter(Boolean).join('\n');
}

function formatWaitConditionForPrompt(waitCondition) {
  if (!waitCondition || typeof waitCondition !== 'object') return '';
  if (waitCondition.kind === 'time') {
    const dt = new Date(Number(waitCondition.untilTs) || 0).toISOString();
    return `Current wait condition: time until ${dt}. Reason: ${waitCondition.reason || 'n/a'}`;
  }
  if (waitCondition.kind === 'team_activity') {
    return [
      'Current wait condition: team activity match.',
      `- eventType: ${waitCondition.eventType || '(any)'}`,
      `- messageIncludes: ${waitCondition.messageIncludes || '(none)'}`,
      `- agentId: ${waitCondition.agentId || '(any)'}`,
      `- targetAgentId: ${waitCondition.targetAgentId || '(any)'}`,
      `- reason: ${waitCondition.reason || 'n/a'}`,
    ].join('\n');
  }
  if (waitCondition.kind === 'partial') {
    const waitAppliesTo = normalizeWaitAppliesTo(waitCondition.waitAppliesTo || waitCondition.scope, 'implementation');
    return `Current partial wait: ${waitAppliesTo} blocked; mission ticks continue on other work. Reason: ${waitCondition.reason || 'Implementation blocked; research continues'}`;
  }
  return '';
}

function matchesWaitActivityEvent(event, waitCondition) {
  if (!event || !waitCondition) return false;
  const type = String(event.type || '').trim();
  const message = String(event.message || '').trim().toLowerCase();
  if (waitCondition.eventType && type !== waitCondition.eventType) return false;
  if (waitCondition.messageIncludes && !message.includes(String(waitCondition.messageIncludes).toLowerCase())) return false;
  if (waitCondition.agentId && String(event.agentId || '') !== waitCondition.agentId) return false;
  if (waitCondition.targetAgentId && String(event.targetAgentId || '') !== waitCondition.targetAgentId) return false;
  return true;
}

function evaluateWaitCondition(waitCondition, opts = {}) {
  const now = Number(opts.now) || nowMs();
  if (!waitCondition || typeof waitCondition !== 'object') return { waiting: false, satisfied: false, reason: '', nextCheckAt: now };
  if (waitCondition.kind === 'time') {
    const untilTs = Number(waitCondition.untilTs) || 0;
    if (!untilTs || now >= untilTs) {
      return { waiting: false, satisfied: true, reason: summarize(waitCondition.reason || 'Time reached', 180), nextCheckAt: now };
    }
    return { waiting: true, satisfied: false, reason: summarize(waitCondition.reason || 'Waiting for scheduled time', 180), nextCheckAt: untilTs };
  }
  if (waitCondition.kind === 'team_activity') {
    const events = Array.isArray(opts.events) ? opts.events : [];
    const sinceTs = Number(waitCondition.sinceTs) || 0;
    const hit = events.find((event) => Number(event.ts) >= sinceTs && matchesWaitActivityEvent(event, waitCondition));
    if (hit) {
      return { waiting: false, satisfied: true, reason: summarize(waitCondition.reason || 'Watched activity observed', 180), nextCheckAt: now };
    }
    return { waiting: true, satisfied: false, reason: summarize(waitCondition.reason || 'Waiting for watched activity', 180), nextCheckAt: now + 30_000 };
  }
  if (waitCondition.kind === 'partial') {
    return {
      waiting: false,
      satisfied: false,
      reason: summarize(waitCondition.reason || 'Implementation blocked; research continues', 180),
      nextCheckAt: now,
    };
  }
  return { waiting: false, satisfied: false, reason: '', nextCheckAt: now };
}

export function isMissionTickPausedByWait(mission, now = nowMs()) {
  const waitEval = evaluateWaitCondition(mission?.waitCondition, { now });
  return !!waitEval.waiting;
}

function normalizeMission(mission = {}) {
  const id = String(mission.id || '').trim();
  const intervalMs = clampIntervalMs(mission.intervalMs);
  const status = sanitizeStatus(mission.status);
  const title = summarize(mission.title || mission.objective || 'Untitled mission', 120);
  const objective = summarize(mission.objective || mission.title || '', 4000);
  const ownerAgentId = String(mission.ownerAgentId || 'main').trim() || 'main';
  const running = !!mission.running;
  const progressIn = mission.progress && typeof mission.progress === 'object' ? mission.progress : {};
  const pctNum = Number(progressIn.pct);
  const pct = Number.isFinite(pctNum) ? Math.max(0, Math.min(100, Math.round(pctNum))) : 0;
  const progress = {
    pct,
    metrics: progressIn.metrics && typeof progressIn.metrics === 'object' ? progressIn.metrics : {},
    evidence: safeArray(progressIn.evidence, 20),
  };
  const currentPlan = {
    steps: normalizePlanSteps(mission.currentPlan?.steps || mission.planSteps || []),
  };
  const history = Array.isArray(mission.history) ? mission.history.slice(-60) : [];
  const tasks = normalizeTasks(mission.tasks || mission.subgoals || []);
  const waitCondition = normalizeWaitCondition(mission.waitCondition || mission.wait || null);
  const projectIdRaw = Number(mission.projectId);
  const projectId = Number.isFinite(projectIdRaw) && projectIdRaw > 0 ? Math.floor(projectIdRaw) : null;
  return {
    id,
    title,
    ownerAgentId,
    status,
    objective,
    projectId,
    currentPlan,
    progress: progress.evidence.length || pct || Object.keys(progress.metrics).length ? progress : defaultProgress(),
    lastRunAt: Number(mission.lastRunAt) || 0,
    lastCuriosityAt: Number(mission.lastCuriosityAt) || 0,
    nextRunAt: Number(mission.nextRunAt) || 0,
    intervalMs,
    contextSnapshot: summarize(mission.contextSnapshot || '', 2000),
    memoryAnchors: safeArray(mission.memoryAnchors, 20),
    running,
    runningAgentId: running ? ownerAgentId : '',
    runningSince: running ? Number(mission.runningSince) || nowMs() : 0,
    lastActivity: summarize(mission.lastActivity || '', 280),
    blockedReason: summarize(mission.blockedReason || '', 280),
    needsUserInput: summarize(mission.needsUserInput || '', 280),
    tasks,
    waitCondition,
    createdAt: Number(mission.createdAt) || nowMs(),
    updatedAt: Number(mission.updatedAt) || nowMs(),
    history,
  };
}

function readStore() {
  const path = getMissionsStorePath();
  try {
    const legacyPath = getLegacyMissionsStorePath();
    const activePath = existsSync(path) ? path : legacyPath;
    if (!existsSync(activePath)) return { missions: [], updatedAt: 0 };
    const raw = readFileSync(activePath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const rows = Array.isArray(parsed.missions) ? parsed.missions : (Array.isArray(parsed.goals) ? parsed.goals : []);
    const store = {
      missions: rows.map(normalizeMission).filter((g) => g.id),
      updatedAt: Number(parsed.updatedAt) || 0,
    };
    if (activePath === legacyPath && store.missions.length) writeStore(store);
    return store;
  } catch {
    return { missions: [], updatedAt: 0 };
  }
}

function writeStore(store) {
  const path = getMissionsStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const missions = Array.isArray(store.missions) ? store.missions.map(normalizeMission) : [];
  // Write per-mission config files so each mission folder is self-contained (easy cleanup).
  for (const mission of missions) {
    try {
      const missionDir = getMissionDir(mission.id);
      if (!existsSync(missionDir)) mkdirSync(missionDir, { recursive: true });
      writeFileSync(getMissionConfigPath(mission.id), JSON.stringify(mission, null, 2), 'utf8');
    } catch (_) {}
  }
  const payload = { missions, updatedAt: nowMs() };
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function randomId() {
  return `mission-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function listMissions() {
  const store = readStore();
  return { missions: store.missions.slice().sort((a, b) => b.updatedAt - a.updatedAt), updatedAt: store.updatedAt || 0 };
}

export function getMission(missionId) {
  const id = String(missionId || '').trim();
  if (!id) return null;
  const store = readStore();
  return store.missions.find((g) => g.id === id) || null;
}

export function createMission(input = {}) {
  const objective = summarize(input.objective || input.title || '', 4000);
  if (!objective) throw new Error('objective is required');
  const createdAt = nowMs();
  const intervalMs = clampIntervalMs(input.intervalMs);
  const mission = normalizeMission({
    id: randomId(),
    title: input.title || objective,
    ownerAgentId: input.ownerAgentId || 'main',
    projectId: input.projectId != null ? Number(input.projectId) : null,
    status: input.status || 'active',
    objective,
    currentPlan: { steps: normalizePlanSteps(input.currentPlan?.steps || input.planSteps || []) },
    tasks: normalizeTasks(input.tasks || input.subgoals || []),
    progress: input.progress || defaultProgress(),
    lastRunAt: 0,
    nextRunAt: createdAt + intervalMs,
    intervalMs,
    contextSnapshot: input.contextSnapshot || '',
    memoryAnchors: input.memoryAnchors || [],
    waitCondition: input.waitCondition || input.wait || null,
    running: false,
    createdAt,
    updatedAt: createdAt,
    lastActivity: 'Mission created',
  });
  const store = readStore();
  store.missions.push(mission);
  writeStore(store);
  ensureMissionMemoryFile(mission.id, mission.title);
  return mission;
}

export function updateMission(missionId, patch = {}) {
  const id = String(missionId || '').trim();
  if (!id) throw new Error('mission id is required');
  const store = readStore();
  const idx = store.missions.findIndex((g) => g.id === id);
  if (idx < 0) throw new Error(`Mission not found: ${id}`);
  const prev = store.missions[idx];
  const next = normalizeMission({
    ...prev,
    ...patch,
    id,
    updatedAt: nowMs(),
  });
  store.missions[idx] = next;
  writeStore(store);
  return next;
}

function flatCountTasks(tasks) {
  if (!Array.isArray(tasks)) return 0;
  let n = 0;
  for (const t of tasks) {
    n += 1 + flatCountTasks(t.tasks || []);
  }
  return n;
}

/**
 * Permanently delete a mission and everything stored under its subfolder.
 * Also scrubs ai-suggested-tasks that exclusively reference this mission.
 * The team-activity.jsonl inbox/outbox log is intentionally left intact.
 */
export function deleteMission(missionId) {
  const id = String(missionId || '').trim();
  if (!id) throw new Error('mission id is required');
  const store = readStore();
  const mission = store.missions.find((g) => g.id === id);
  if (!mission) throw new Error(`Mission not found: ${id}`);
  const tasksRemoved = flatCountTasks(mission.tasks);

  // A mission created before the per-ID subfolder migration won't have mission.json yet.
  const wasMigrated = existsSync(getMissionConfigPath(id));

  store.missions = store.missions.filter((g) => g.id !== id);
  writeStore(store);

  const missionDir = getMissionDir(id);
  if (existsSync(missionDir)) {
    try { rmSync(missionDir, { recursive: true, force: true }); } catch (_) {}
  }

  try { removeSuggestedTasksForMission(id); } catch (_) {}

  return { id, deleted: true, title: mission.title, tasksRemoved, wasMigrated };
}

/** After the user answers a dashboard prompt, reopen blocked branches so the next tick can proceed. */
function unblockTasksAfterUserResponse(tasks) {
  return normalizeTasks(tasks || []).map((sg) => {
    const status = String(sg.status || 'todo').toLowerCase();
    const next = {
      ...sg,
      status: status === 'blocked' ? 'todo' : sg.status,
      tasks: unblockTasksAfterUserResponse(sg.tasks || []),
    };
    return next;
  });
}

export function respondToMissionUserInput(missionId, responseText) {
  const id = String(missionId || '').trim();
  const text = summarize(String(responseText || '').trim(), 500);
  if (!id) throw new Error('mission id is required');
  if (!text) throw new Error('response is required');
  const prev = getMission(id);
  if (!prev) throw new Error(`Mission not found: ${id}`);
  const now = nowMs();
  appendMissionMemory(id, prev.title, [
    `User input received: ${text}`,
    'Wait cleared; blocked tasks reopened; mission tick scheduled',
  ]);
  return updateMission(id, {
    // Reactivate a blocked mission when the user provides the requested input.
    ...(prev.status === 'blocked' ? { status: 'active' } : {}),
    needsUserInput: '',
    waitCondition: null,
    blockedReason: '',
    tasks: unblockTasksAfterUserResponse(prev.tasks),
    nextRunAt: now,
    lastActivity: summarize(`User responded: ${text}`, 280),
  });
}

export function listDueMissions(now = nowMs()) {
  const store = readStore();
  return store.missions
    .filter((g) => g.status === 'active')
    .filter((g) => !g.running)
    .filter((g) => {
      const waitEval = evaluateWaitCondition(g.waitCondition, { now });
      return !waitEval.waiting;
    })
    .filter((g) => (Number(g.nextRunAt) || 0) <= now)
    .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
}

function stripPasturePrefix(text) {
  return formatUserFacingReply(text);
}

function maybeParseJsonFromText(text) {
  const s = stripPasturePrefix(text);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

export function readMissionMemory(missionId, opts = {}) {
  const path = getMissionMemoryPath(missionId);
  const maxChars = Math.max(200, Math.min(30_000, Math.floor(Number(opts.maxChars) || 12_000)));
  try {
    if (!existsSync(path)) return '';
    const raw = readFileSync(path, 'utf8');
    if (!raw) return '';
    return raw.length > maxChars ? `...${raw.slice(-maxChars)}` : raw;
  } catch {
    return '';
  }
}

function ensureMissionMemoryFile(missionId, title = '') {
  const path = getMissionMemoryPath(missionId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) {
    const heading = summarize(title || missionId, 120);
    const init = [
      `# Mission Memory: ${heading || missionId}`,
      '',
      'Persistent knowledge for this mission across autonomous ticks.',
      '',
    ].join('\n');
    writeFileSync(path, init, 'utf8');
  }
  return path;
}

export function appendMissionMemory(missionId, title, lines) {
  const path = ensureMissionMemoryFile(missionId, title);
  const safeLines = safeArray(Array.isArray(lines) ? lines : [lines], 50);
  if (!safeLines.length) return;
  const stamp = new Date().toISOString();
  const block = [
    '',
    `## ${stamp}`,
    ...safeLines.map((l) => `- ${l}`),
  ].join('\n');
  try {
    const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
    writeFileSync(path, `${prev}${block}\n`, 'utf8');
  } catch (_) {}
}

export function buildMissionTickPrompt(mission, opts = {}) {
  const g = normalizeMission(mission);
  const memoryPath = String(opts.memoryPath || getMissionMemoryPath(g.id)).trim();
  const missionMemory = String(opts.missionMemory || '').trim();
  const steps = (g.currentPlan.steps || [])
    .map((s) => `- [${s.status}] ${s.title}`)
    .join('\n');
  const taskLines = formatTasksForPrompt(g.tasks || []);
  const tasksText = taskLines.length ? taskLines.join('\n') : '';
  const delegatedTasksText = formatDelegatedTasksForPrompt(g.tasks || []);
  const waitConditionText = formatWaitConditionForPrompt(g.waitCondition);
  const waitScopeText = formatWaitScopeForPrompt(g.waitCondition, g.tasks);
  return [
    'You are executing a persistent background mission tick.',
    `Mission ID: ${g.id}`,
    `Mission title: ${g.title}`,
    `Objective: ${g.objective}`,
    `Status: ${g.status}`,
    `Current progress: ${g.progress.pct}%`,
    g.blockedReason ? `Blocked reason: ${g.blockedReason}` : '',
    g.contextSnapshot ? `Context snapshot: ${g.contextSnapshot}` : '',
    g.memoryAnchors.length ? `Memory anchors:\n${g.memoryAnchors.map((a) => `- ${a}`).join('\n')}` : '',
    missionMemory ? `Per-mission memory (pre-loaded — do NOT call memory:get, contents are already here):\n${missionMemory}` : 'Per-mission memory: (empty)',
    steps ? `Current plan steps:\n${steps}` : '',
    tasksText ? `Current tasks tree:\n${tasksText}` : '',
    delegatedTasksText ? `Open delegated assignments (track status/progress in tasks):\n${delegatedTasksText}` : '',
    waitConditionText || '',
    waitScopeText || '',
    '',
    'Follow these mandatory sections in order:',
    '1) Review',
    '- Review current mission state (status/progress/plan/tasks).',
    '- Review the per-mission memory contents already provided above (do not call memory:get — it is pre-loaded).',
    '',
    '2) Progress Evaluation',
    '- Quantitative: estimate progress % and measurable evidence.',
    '- Qualitative: what improved, what risk increased, and confidence.',
    '',
    '3) Next Action Selection',
    '- Pick the single highest-leverage next action for this tick.',
    '- During a partial/manual wait, choose work from actionable branches only; do not advance blocked branches.',
    '- Keep scope to one meaningful step.',
    '',
    '4) Delegation Check',
    '- Decide if delegation is needed for the next action.',
    '- Delegate only if it improves quality or speed.',
    '- When using agent-send, pass structured fields: taskTitle, expectedOutput, dueInHours, and target assignee.',
    '- agent-send creates persistent delegated tasks on this mission (source=delegation) with assignee, due date, and expected output.',
    '- Update delegated task status/progress in "tasks" when teammates reply; use review_ready only for delegated tasks where you (the lead) still need to verify the teammate output. Mark done as soon as the work product itself is complete — do not wait for user approval to call it done.',
    '',
    '5) Reflection & Memory Update',
    '- Reflect on outcomes, decisions, learnings, user preferences, and failed attempts.',
    '- Return these fields so they can be appended to the mission memory file.',
    '',
    '6) User Input Check',
    '- If a decision blocks implementation only (not the whole mission), set userInputRequired=true and fill needsUserInput with a clear ask.',
    '- Always include 2–3 concrete options plus a recommended default (e.g. Recommend PostHog; options 1) GA4 2) Mixpanel; reply "use default").',
    '- NEVER use letter-only prompts (e.g. "Reply A/B/C") without the full option definitions inline in needsUserInput. The user must see what each option means without reading mission memory.',
    '- Preserve existing task IDs and tree shape from "Current tasks tree". Update status/progress only in "tasks" — do not replace a flat task list with a new nested tree.',
    '- Put genuinely new tasks in "createdTasks" instead of reshaping "tasks".',
    '- Keep mission status "active" and continue research/planning ticks while waiting.',
    '- IMPORTANT: Only set a task status to "blocked" when it genuinely cannot proceed without user input or an external error/access fix.',
    '  Do NOT mark a task "blocked" just because it is not yet started or is waiting for another task — use "todo" or "waiting_dependency" instead.',
    '',
    '7) Waiting / Watchers / Conditions',
    '- If work should pause until something happens, return a wait object.',
    '- Supported waits: time, team_activity, partial (manual is treated as partial).',
    '- Use partial when user input or a dependency blocks only part of the mission.',
    '- Set wait.waitAppliesTo to the blocked area: implementation | research | deployment | instrumentation | all.',
    '- Optionally set wait.blockedTaskIds to explicit task ids blocked by the wait.',
    '- partial wait does NOT pause mission ticks; pair with needsUserInput for dashboard prompts.',
    '- While waiting, continue parallel safe work on non-blocked tasks, createdTasks, and suggestedTasks.',
    '- time and team_activity pause the ENTIRE mission until the condition is met — zero ticks fire until it resolves.',
    '- RULE: If ANY tasks are still in todo/doing/in_progress/review_ready status, you MUST use partial, NOT team_activity. team_activity is only correct when every remaining task is blocked/waiting_dependency.',
    '- If no waiting is needed, set wait.kind to "none".',
    '',
    '8) Opportunity Detection',
    '- Detect opportunities, risks, improvements, experiments, and unanswered questions.',
    '- If the mission is entering waiting state, explicitly check adjacent work worth exploring.',
    '- Only include strong suggestedTasks (high signal, confidence >= 0.6).',
    '- Suggested Tasks are proposals only — they land in proposed status for lead review; they do not become tasks until approved.',
    '',
    '9) Curiosity & Next Steps',
    '- After current work, create 1-3 specific new tasks if needed. Be proactive.',
    '- Use createdTasks for new work discovered this tick (research, validation, prep, follow-ups).',
    '- Each createdTask needs: title (short plain-English action phrase, not internal jargon), description (one sentence why it matters), expectedOutput (what the agent will produce), assignee (agent id), priority (1=highest, 5=lowest), dueInHours.',
    '- Max 3 createdTasks per tick. Skip duplicates of existing task titles.',
    '- Background curiosity checks may log idle suggestions when a mission is quiet; they do not create tasks or change progress.',
    '',
    'Take one useful step now. You may use tools and delegate as needed.',
    'IMPORTANT: At the start of this tick, review the per-mission memory. At the end, return structured learnings/decisions so they can be appended to that memory file.',
    'Return STRICT JSON only (no prose) with this schema:',
    '{',
    '  "status": "active|paused|completed|blocked|error",',
    '  "summary": "what happened this tick",',
    '  "progressPct": 0,',
    '  "evidence": ["short evidence lines"],',
    '  "progressEvaluation": {"quantitative":"", "qualitative":""},',
    '  "currentStep": "what you are doing now",',
    '  "delegationCheck": {"needed": false, "targetAgentId":"", "reason":"", "taskTitle":"", "expectedOutput":"", "dueInHours":48},',
    '  "reflection": "short retrospective for memory",',
    '  "userInputRequired": false,',
    '  "needsUserInput": "",',
    '  "wait": {"kind":"none|time|team_activity|partial|manual", "waitAppliesTo":"implementation|research|deployment|instrumentation|all", "blockedTaskIds":[], "reason":"", "untilTs":0, "eventType":"", "messageIncludes":"", "agentId":"", "targetAgentId":"", "condition":""},',
    '  "suggestedTasks": [{"title":"...", "type":"opportunity|risk|question|experiment|improvement|observation", "description":"...", "source":"mission_reflection|waiting_mission", "confidence":0.0, "relatedMissionIds":["mission-id"]}],',
    '  "blockedReason": "",',
    '  "nextRunInSec": 60,',
    '  "contextSnapshot": "",',
    '  "memoryAnchors": ["..."],',
    '  "learnings": ["key learnings from this tick"],',
    '  "decisions": ["decisions made"],',
    '  "userPreferences": ["new user preferences discovered"],',
    '  "failedAttempts": ["what did not work"],',
    '  "planSteps": [{"title":"...", "status":"open|assigned|in_progress|waiting_user|waiting_dependency|blocked|review_ready|done|rejected|todo|doing"}],',
    '  "tasks": [',
    '    {',
    '      "id": "research-phase",',
    '      "title": "Research",',
    '      "status": "todo|doing|in_progress|waiting_dependency|waiting_user|blocked|review_ready|done",',
    '      "blockerType": "need_direction|need_access|need_content|need_approval|system_error (required when status=blocked)",',
    '      "progress": 0,',
    '      "assignee": "optional agent id",',
    '      "dependsOn": ["optional-task-id"],',
    '      "tasks": []',
    '    }',
    '  ],',
    '  // Task status semantics — use the RIGHT status:',
    '  // "todo" / "open" — not started, any agent can pick it up. Never mark a task blocked just because it is incomplete.',
    '  // "doing" / "in_progress" — actively being worked on.',
    '  // "waiting_dependency" — cannot start yet because another task must finish first. Agent resumes it automatically; user does NOT need to act.',
    '  // "waiting_user" — ONLY when the task literally cannot proceed without user input: missing credentials, access, a hard decision gate. NOT for "the user might want to see this."',
    '  // "blocked" — ONLY for: missing external access/credentials, unresolvable errors, or a hard dependency outside the team\'s control. NOT for normal incomplete work or desire for approval.',
    '  //   When status is "blocked" you MUST also set "blockerType" to one of:',
    '  //     "need_direction"  — strategic/product decision only the owner can make.',
    '  //     "need_access"     — missing credentials, API keys, tool or data access.',
    '  //     "need_content"    — user must supply specific assets, copy, or data exports.',
    '  //     "need_approval"   — agent finished a draft/plan; needs sign-off before proceeding.',
    '  //     "system_error"    — rate-limit, quota, or infra failure; auto-retries — do NOT show to user.',
    '  // "review_ready" — ONLY for delegated tasks where the lead (you) still needs to verify the teammate\'s output before accepting. Do NOT use review_ready for your own work.',
    '  // "done" — the work product this task describes is complete. Mark done as soon as the output exists, regardless of whether the user has reviewed it.',
    '  //   If user review would be valuable, create a NEW task "Review [deliverable]" — do not freeze the completed task.',
    '  //   The ONLY reason a task stays undone is: the work itself is not finished, or a hard blocker (missing access, credentials, unresolvable error) prevents it.',
    '  "createdTasks": [',
    '    {',
    '      "title": "Check competitor signup flows",',
    '      "description": "Understand what friction competitors create so we can do better.",',
    '      "expectedOutput": "3 annotated screenshots with friction-point notes",',
    '      "assignee": "marketer",',
    '      "priority": 2,',
    '      "dueInHours": 24,',
    '      "dependsOn": []',
    '    }',
    '  ]',
    '}',
  ].filter(Boolean).join('\n');
}

function normalizeTickStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'error') return 'blocked';
  return sanitizeStatus(s || 'active');
}

export async function runMissionTick(missionId, opts = {}) {
  const id = String(missionId || '').trim();
  if (!id) throw new Error('mission id is required');
  const runMissionTurn = typeof opts.runMissionTurn === 'function' ? opts.runMissionTurn : null;
  if (!runMissionTurn) throw new Error('runMissionTurn is required');

  const current = getMission(id);
  if (!current) throw new Error(`Mission not found: ${id}`);
  if (current.status !== 'active') return { mission: current, skipped: 'not-active' };
  if (current.running) return { mission: current, skipped: 'already-running' };

  const started = updateMission(id, {
    running: true,
    runningSince: nowMs(),
    runningAgentId: current.ownerAgentId,
    lastActivity: `Tick started for ${current.ownerAgentId}`,
  });
  const memoryPath = ensureMissionMemoryFile(started.id, started.title);
  const missionMemory = readMissionMemory(started.id, { maxChars: 12_000 });
  const promptBuilder = typeof opts.promptBuilder === 'function' ? opts.promptBuilder : buildMissionTickPrompt;
  const prompt = promptBuilder(started, { memoryPath, missionMemory, mode: opts.mode || 'mission_tick' });

  try {
    const turn = await runMissionTurn(started, prompt);
    const text = stripPasturePrefix(turn?.textToSend || '');
    const parsed = maybeParseJsonFromText(text) || {};
    const nextStatus = normalizeTickStatus(parsed.status || started.status);
    const progressPct = Number(parsed.progressPct);
    const nextRunInSec = Number(parsed.nextRunInSec);
    const intervalMs = clampIntervalMs(nextRunInSec > 0 ? nextRunInSec * 1000 : started.intervalMs);
    const hasWaitField = Object.prototype.hasOwnProperty.call(parsed, 'wait') || Object.prototype.hasOwnProperty.call(parsed, 'waitCondition');
    const parsedWaitCondition = normalizeWaitCondition(
      Object.prototype.hasOwnProperty.call(parsed, 'wait') ? parsed.wait : parsed.waitCondition,
      { now: nowMs() },
    );
    let nextWaitCondition = hasWaitField ? parsedWaitCondition : (started.waitCondition || null);
    const patchedTasks = Array.isArray(parsed.tasks)
      ? mergeTaskTrees(started.tasks || [], parsed.tasks)
      : normalizeTasks(started.tasks || []);
    // Auto-downgrade team_activity → partial when actionable tasks still exist.
    // team_activity freezes the entire mission; if any tasks are still workable that
    // wastes the whole cycle. Demote to partial so unblocked branches keep ticking.
    if (nextWaitCondition?.kind === 'team_activity') {
      const ACTIONABLE = new Set(['todo', 'in_progress', 'doing', 'review_ready']);
      const flat = (tasks) => tasks.flatMap((t) => [t, ...(t.tasks?.length ? flat(t.tasks) : [])]);
      const allTasks = flat(patchedTasks);
      if (allTasks.some((t) => ACTIONABLE.has(t.status))) {
        const blockedTaskIds = allTasks
          .filter((t) => t.status === 'waiting_dependency' || t.status === 'blocked')
          .map((t) => t.id);
        nextWaitCondition = {
          kind: 'partial',
          scope: 'implementation',
          waitAppliesTo: 'implementation',
          blockedTaskIds,
          reason: nextWaitCondition.reason,
          condition: nextWaitCondition.reason,
          sinceTs: nextWaitCondition.sinceTs,
        };
      }
    }
    const waitScopedTasks = applyWaitBlocksToTasks(patchedTasks, nextWaitCondition);
    const createResult = createTasksFromTick(waitScopedTasks, parsed.createdTasks, {
      defaultAssignee: started.ownerAgentId,
      maxNew: Math.max(1, Math.min(MAX_CREATED_TASKS_PER_TICK, Number(opts.maxCreatedTasks) || MAX_CREATED_TASKS_PER_TICK)),
    });
    const nextTasks = applyWaitBlocksToTasks(createResult.tasks, nextWaitCondition);
    const createdTasks = createResult.created.map((sg) => ({
      id: sg.id,
      title: sg.title,
      description: sg.description || '',
      assignee: sg.assignee || started.ownerAgentId,
      ownerAgentId: sg.assignee || started.ownerAgentId,
      priority: sg.priority || 0,
      dueInHours: sg.dueInHours || 0,
    }));
    const learnings = safeArray(parsed.learnings, 10);
    const decisions = safeArray(parsed.decisions, 10);
    const userPreferences = safeArray(parsed.userPreferences, 10);
    const failedAttempts = safeArray(parsed.failedAttempts, 10);
    const userInputRequired = parsed.userInputRequired === true || String(parsed.userInputRequired || '').toLowerCase() === 'true';
    const needsUserInputText = normalizeNeedsUserInput(parsed.needsUserInput || '');
    const now = nowMs();
    const waitEval = evaluateWaitCondition(nextWaitCondition, { now });
    const updated = updateMission(id, {
      status: nextStatus,
      progress: {
        pct: Number.isFinite(progressPct) ? progressPct : started.progress.pct,
        metrics: started.progress.metrics || {},
        evidence: safeArray(parsed.evidence, 20),
      },
      currentPlan: {
        steps: normalizePlanSteps(parsed.planSteps || started.currentPlan.steps || []),
      },
      tasks: nextTasks,
      waitCondition: nextWaitCondition,
      contextSnapshot: summarize(parsed.contextSnapshot || parsed.summary || text || '', 2000),
      memoryAnchors: safeArray(parsed.memoryAnchors, 20),
      lastRunAt: now,
      nextRunAt: waitEval.waiting ? Math.max(now + 5_000, Number(waitEval.nextCheckAt) || (now + intervalMs)) : now + intervalMs,
      intervalMs,
      running: false,
      runningSince: 0,
      runningAgentId: '',
      blockedReason: summarize(parsed.blockedReason || '', 280),
      needsUserInput: needsUserInputText || (userInputRequired ? 'User input required to continue.' : ''),
      lastActivity: summarize(parsed.summary || text || 'Mission tick complete', 280),
      history: [
        ...(Array.isArray(started.history) ? started.history : []),
        {
          ts: now,
          status: nextStatus,
          summary: summarize(parsed.summary || text || 'Mission tick complete', 280),
          evidence: safeArray(parsed.evidence, 6),
          skillsCalled: Array.isArray(turn?.skillsCalled) ? turn.skillsCalled.slice(0, 8) : [],
        },
      ].slice(-60),
    });

    const memoryLines = [
      `Summary: ${summarize(parsed.summary || text || 'Mission tick complete', 260)}`,
      learnings.length ? `Learned: ${learnings.join(' | ')}` : '',
      decisions.length ? `Decisions: ${decisions.join(' | ')}` : '',
      userPreferences.length ? `User preferences: ${userPreferences.join(' | ')}` : '',
      failedAttempts.length ? `Did not work: ${failedAttempts.join(' | ')}` : '',
      Array.isArray(parsed.evidence) && parsed.evidence.length
        ? `Evidence: ${safeArray(parsed.evidence, 8).join(' | ')}`
        : '',
      `Status: ${updated.status} | Progress: ${updated.progress.pct}%`,
      parsed.progressEvaluation && typeof parsed.progressEvaluation === 'object'
        ? `Progress evaluation: qn=${summarize(parsed.progressEvaluation.quantitative || '', 120)} | ql=${summarize(parsed.progressEvaluation.qualitative || '', 120)}`
        : '',
      parsed.delegationCheck && typeof parsed.delegationCheck === 'object'
        ? `Delegation check: needed=${parsed.delegationCheck.needed === true ? 'yes' : 'no'} target=${summarize(parsed.delegationCheck.targetAgentId || '', 60)} reason=${summarize(parsed.delegationCheck.reason || '', 120)}`
        : '',
      parsed.reflection ? `Reflection: ${summarize(parsed.reflection, 180)}` : '',
      updated.currentPlan.steps && updated.currentPlan.steps.length
        ? `Plan snapshot: ${updated.currentPlan.steps.slice(0, 6).map((s) => `${s.title}(${s.status})`).join(', ')}`
        : '',
      updated.tasks && updated.tasks.length
        ? `Tasks: ${updated.tasks.slice(0, 8).map((sg) => `${sg.title}(${sg.status}/${sg.progress}%)`).join(', ')}`
        : '',
      createdTasks.length
        ? `New tasks: ${createdTasks.map((sg) => sg.title).join(', ')}`
        : '',
      updated.blockedReason ? `Blocked reason: ${updated.blockedReason}` : '',
      updated.needsUserInput ? `Needs user input: ${updated.needsUserInput}` : '',
      updated.waitCondition ? `Wait condition: kind=${updated.waitCondition.kind} reason=${summarize(updated.waitCondition.reason || '', 160)}` : '',
    ].filter(Boolean);
    appendMissionMemory(updated.id, updated.title, memoryLines);

    const suggestedTaskCandidates = Array.isArray(parsed.suggestedTasks) ? parsed.suggestedTasks : [];
    const suggestedTaskResult = createSuggestedTasks(suggestedTaskCandidates, {
      source: parsedWaitCondition ? 'waiting_mission' : 'mission_reflection',
      createdBy: updated.ownerAgentId,
      relatedMissionIds: [updated.id],
      minConfidence: 0.6,
      maxPerBatch: 2,
    });
    if (suggestedTaskResult.created.length || suggestedTaskResult.merged.length) {
      const activity = [
        suggestedTaskResult.created.length ? `proposals created=${suggestedTaskResult.created.length}` : '',
        suggestedTaskResult.merged.length ? `merged=${suggestedTaskResult.merged.length}` : '',
      ].filter(Boolean).join(', ');
      updateMission(id, { lastActivity: summarize(`${updated.lastActivity} | ${activity}`, 280) });
    }

    return { mission: getMission(id), createdTasks, turn, suggestedTasks: suggestedTaskResult };
  } catch (err) {
    const failed = updateMission(id, {
      status: 'blocked',
      running: false,
      runningSince: 0,
      runningAgentId: '',
      lastRunAt: nowMs(),
      nextRunAt: nowMs() + current.intervalMs,
      blockedReason: summarize(err?.message || String(err), 280),
      lastActivity: `Tick failed: ${summarize(err?.message || String(err), 180)}`,
    });
    appendMissionMemory(failed.id, failed.title, [
      `Summary: Tick failed`,
      `Did not work: ${summarize(err?.message || String(err), 260)}`,
      `Status: ${failed.status}`,
    ]);
    return { mission: failed, error: err };
  }
}

const STALE_RUNNING_THRESHOLD_MS = 10 * 60_000; // 10 min

/**
 * Recover missions stuck as running: true from a previous daemon crash or restart.
 * Any mission whose runningSince is older than STALE_RUNNING_THRESHOLD_MS is reset.
 */
export function recoverStaleMissions(now = nowMs()) {
  const store = readStore();
  let changed = false;
  for (const mission of store.missions) {
    if (!mission.running) continue;
    const elapsed = now - (Number(mission.runningSince) || 0);
    if (elapsed < STALE_RUNNING_THRESHOLD_MS) continue;
    const elapsedMin = Math.round(elapsed / 60_000);
    console.log(`[missions] Recovering stale mission "${mission.title}" (${mission.id}) — stuck running for ${elapsedMin} min`);
    mission.running = false;
    mission.runningSince = 0;
    mission.runningAgentId = '';
    mission.nextRunAt = now;
    mission.lastActivity = summarize(`Recovered from stale running state after ${elapsedMin} min`, 280);
    if (mission.status === 'blocked' && mission.blockedReason) {
      mission.status = 'active';
      mission.lastActivity = summarize(`Recovered from stale running+blocked state after ${elapsedMin} min; retrying`, 280);
    }
    changed = true;
  }
  if (changed) writeStore(store);
  return changed;
}

export function processDueMissionsInStore(opts = {}) {
  const now = nowMs();
  const maxPerCycle = Math.max(1, Math.min(10, Number(opts.maxPerCycle) || 3));
  const store = readStore();
  const missions = Array.isArray(store.missions) ? store.missions.slice() : [];
  const needsActivityWindow = missions.some((g) => g?.waitCondition?.kind === 'team_activity');
  const events = needsActivityWindow ? readTeamActivityWindow({ maxBytes: 512 * 1024, maxEvents: 3000 }) : [];
  let changed = false;

  const normalized = missions.map((mission) => {
    const g = normalizeMission(mission);
    if (g.status !== 'active' || g.running || !g.waitCondition) return g;
    if (isPartialWaitCondition(g.waitCondition)) return g;
    const waitEval = evaluateWaitCondition(g.waitCondition, { now, events });
    if (waitEval.satisfied) {
      changed = true;
      return normalizeMission({
        ...g,
        waitCondition: null,
        nextRunAt: Math.min(Number(g.nextRunAt) || now, now),
        lastActivity: summarize(`Wait satisfied: ${waitEval.reason || 'condition met'}`, 280),
      });
    }
    const desiredNextRunAt = Math.max(now + 5_000, Number(waitEval.nextCheckAt) || (now + g.intervalMs));
    if ((Number(g.nextRunAt) || 0) !== desiredNextRunAt || !String(g.lastActivity || '').startsWith('Waiting:')) {
      changed = true;
      return normalizeMission({
        ...g,
        nextRunAt: desiredNextRunAt,
        lastActivity: summarize(`Waiting: ${waitEval.reason || 'condition pending'}`, 280),
      });
    }
    return g;
  });

  if (changed) {
    writeStore({ missions: normalized, updatedAt: store.updatedAt });
  }

  return normalized
    .filter((g) => g.status === 'active')
    .filter((g) => !g.running)
    .filter((g) => {
      const waitEval = evaluateWaitCondition(g.waitCondition, { now });
      return !waitEval.waiting;
    })
    .filter((g) => (Number(g.nextRunAt) || 0) <= now)
    .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))
    .slice(0, maxPerCycle);
}
