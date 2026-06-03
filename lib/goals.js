import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getGoalsStorePath } from './paths.js';
import { readTeamActivityWindow } from './team-activity.js';
import { createInitiatives } from './initiatives.js';
import { formatUserFacingReply } from './user-facing-reply.js';

const VALID_STATUS = new Set(['active', 'paused', 'completed', 'blocked']);
const VALID_SUBGOAL_STATUS = new Set(['todo', 'doing', 'done', 'blocked']);
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

function getGoalsDir() {
  return dirname(getGoalsStorePath());
}

function sanitizeGoalIdForPath(goalId) {
  return String(goalId || '').trim().replace(/[^0-9a-zA-Z\-_]/g, '_') || 'goal';
}

export function getGoalMemoryPath(goalId) {
  const safeId = sanitizeGoalIdForPath(goalId);
  return join(getGoalsDir(), safeId, 'memory.md');
}

function nowMs() {
  return Date.now();
}

function sanitizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return VALID_STATUS.has(s) ? s : 'active';
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
      const status = ['todo', 'doing', 'done', 'blocked'].includes(statusRaw) ? statusRaw : 'todo';
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

function normalizeSubgoalStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return VALID_SUBGOAL_STATUS.has(s) ? s : 'todo';
}

function normalizeSubgoals(subgoals, opts = {}) {
  if (!Array.isArray(subgoals)) return [];
  const depth = Number(opts.depth) || 0;
  if (depth > 5) return [];
  return subgoals
    .map((row, idx) => {
      if (!row || typeof row !== 'object') return null;
      const title = summarize(row.title || row.name || '', 180);
      if (!title) return null;
      const rawProgress = Number(row.progress);
      const progress = Number.isFinite(rawProgress)
        ? Math.max(0, Math.min(100, Math.round(rawProgress)))
        : 0;
      const id = String(row.id || `sg-${depth + 1}-${idx + 1}`).trim();
      const dependsOn = safeArray(row.depends_on || row.dependsOn || [], 20);
      return {
        id: id || `sg-${depth + 1}-${idx + 1}`,
        title,
        status: normalizeSubgoalStatus(row.status),
        progress,
        assignee: summarize(row.assignee || row.ownerAgentId || '', 80),
        depends_on: dependsOn,
        subgoals: normalizeSubgoals(row.subgoals || row.children || [], { depth: depth + 1 }),
      };
    })
    .filter(Boolean)
    .slice(0, 40);
}

function flattenSubgoals(list, out = []) {
  for (const sg of list || []) {
    if (!sg) continue;
    out.push(sg);
    flattenSubgoals(sg.subgoals, out);
  }
  return out;
}

/** Preserve mission task tree; goal ticks may only patch status/progress by id/title. */
export function mergeSubgoalTrees(existing, incoming) {
  const existingNorm = normalizeSubgoals(existing || []);
  if (!Array.isArray(incoming) || !incoming.length) return existingNorm;
  const incomingNorm = normalizeSubgoals(incoming);
  const flatIncoming = flattenSubgoals(incomingNorm);
  const byId = new Map(flatIncoming.filter((s) => s.id).map((s) => [s.id, s]));
  const byTitle = new Map(flatIncoming.map((s) => [String(s.title || '').trim().toLowerCase(), s]));

  function patchList(list) {
    return (list || []).map((sg) => {
      const match = byId.get(sg.id) || byTitle.get(String(sg.title || '').trim().toLowerCase());
      const next = match
        ? {
          ...sg,
          status: normalizeSubgoalStatus(match.status || sg.status),
          progress: Number.isFinite(Number(match.progress)) ? Math.max(0, Math.min(100, Math.round(Number(match.progress)))) : sg.progress,
          assignee: match.assignee || sg.assignee,
        }
        : { ...sg };
      if (Array.isArray(sg.subgoals) && sg.subgoals.length) {
        next.subgoals = patchList(sg.subgoals);
      }
      return next;
    });
  }

  const existingFlat = flattenSubgoals(existingNorm);
  const incomingIds = new Set(flatIncoming.map((s) => s.id));
  const overlap = existingFlat.filter((s) => incomingIds.has(s.id)).length;
  const looksLikeRestructure = existingFlat.length >= 4
    && incomingNorm.length <= 2
    && overlap === 0;

  if (looksLikeRestructure) return patchList(existingNorm);
  if (incomingNorm.length >= existingNorm.length && overlap > 0) return patchList(incomingNorm);
  return patchList(existingNorm);
}

function formatDecisionPrompt(question, options = [], recommendedIndex = 0) {
  const q = summarize(question, 280);
  const opts = (options || []).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 4);
  if (!opts.length) return q;
  const rec = opts[recommendedIndex] || opts[0];
  const numbered = opts.map((o, i) => `${i + 1}) ${o}`).join(' · ');
  return `${q} Recommend: ${rec}. Options: ${numbered}. Reply "use default" or a number.`;
}

function normalizeNeedsUserInput(text) {
  const raw = summarize(text, 280);
  if (!raw) return '';
  if (/recommend|reply|use default|options?:/i.test(raw)) return raw;
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
  return raw;
}

function formatSubgoalsForPrompt(subgoals, depth = 0) {
  if (!Array.isArray(subgoals) || !subgoals.length) return [];
  if (depth > 5) return [];
  const lines = [];
  subgoals.forEach((sg) => {
    const indent = '  '.repeat(depth);
    const deps = Array.isArray(sg.depends_on) && sg.depends_on.length
      ? ` depends_on=${sg.depends_on.join(',')}`
      : '';
    const assignee = sg.assignee ? ` assignee=${sg.assignee}` : '';
    lines.push(`${indent}- [${sg.status}] ${sg.title} (${sg.progress}%)${assignee}${deps}`);
    lines.push(...formatSubgoalsForPrompt(sg.subgoals || [], depth + 1));
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
  if (kind === 'manual') {
    const condition = summarize(wait.condition || wait.reason || '', 240);
    return {
      kind: 'manual',
      reason: condition || 'Manual release required',
      condition,
      sinceTs: Number(wait.sinceTs) || now,
    };
  }
  return null;
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
  return `Current wait condition: manual. Reason: ${waitCondition.reason || 'n/a'}`;
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
  return { waiting: true, satisfied: false, reason: summarize(waitCondition.reason || 'Manual condition pending', 180), nextCheckAt: now + 60_000 };
}

function normalizeGoal(goal = {}) {
  const id = String(goal.id || '').trim();
  const intervalMs = clampIntervalMs(goal.intervalMs);
  const status = sanitizeStatus(goal.status);
  const title = summarize(goal.title || goal.objective || 'Untitled goal', 120);
  const objective = summarize(goal.objective || goal.title || '', 4000);
  const ownerAgentId = String(goal.ownerAgentId || 'main').trim() || 'main';
  const running = !!goal.running;
  const progressIn = goal.progress && typeof goal.progress === 'object' ? goal.progress : {};
  const pctNum = Number(progressIn.pct);
  const pct = Number.isFinite(pctNum) ? Math.max(0, Math.min(100, Math.round(pctNum))) : 0;
  const progress = {
    pct,
    metrics: progressIn.metrics && typeof progressIn.metrics === 'object' ? progressIn.metrics : {},
    evidence: safeArray(progressIn.evidence, 20),
  };
  const currentPlan = {
    steps: normalizePlanSteps(goal.currentPlan?.steps || goal.planSteps || []),
  };
  const history = Array.isArray(goal.history) ? goal.history.slice(-60) : [];
  const subgoals = normalizeSubgoals(goal.subgoals || []);
  const waitCondition = normalizeWaitCondition(goal.waitCondition || goal.wait || null);
  const projectIdRaw = Number(goal.projectId);
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
    lastRunAt: Number(goal.lastRunAt) || 0,
    nextRunAt: Number(goal.nextRunAt) || 0,
    intervalMs,
    contextSnapshot: summarize(goal.contextSnapshot || '', 2000),
    memoryAnchors: safeArray(goal.memoryAnchors, 20),
    running,
    runningAgentId: running ? ownerAgentId : '',
    runningSince: running ? Number(goal.runningSince) || nowMs() : 0,
    lastActivity: summarize(goal.lastActivity || '', 280),
    blockedReason: summarize(goal.blockedReason || '', 280),
    needsUserInput: summarize(goal.needsUserInput || '', 280),
    subgoals,
    waitCondition,
    createdAt: Number(goal.createdAt) || nowMs(),
    updatedAt: Number(goal.updatedAt) || nowMs(),
    history,
  };
}

function readStore() {
  const path = getGoalsStorePath();
  try {
    if (!existsSync(path)) return { goals: [], updatedAt: 0 };
    const raw = readFileSync(path, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const goals = Array.isArray(parsed.goals) ? parsed.goals.map(normalizeGoal).filter((g) => g.id) : [];
    return {
      goals,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { goals: [], updatedAt: 0 };
  }
}

function writeStore(store) {
  const path = getGoalsStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = {
    goals: Array.isArray(store.goals) ? store.goals.map(normalizeGoal) : [],
    updatedAt: nowMs(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function randomId() {
  return `goal-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function listGoals() {
  const store = readStore();
  return { goals: store.goals.slice().sort((a, b) => b.updatedAt - a.updatedAt), updatedAt: store.updatedAt || 0 };
}

export function getGoal(goalId) {
  const id = String(goalId || '').trim();
  if (!id) return null;
  const store = readStore();
  return store.goals.find((g) => g.id === id) || null;
}

export function createGoal(input = {}) {
  const objective = summarize(input.objective || input.title || '', 4000);
  if (!objective) throw new Error('objective is required');
  const createdAt = nowMs();
  const intervalMs = clampIntervalMs(input.intervalMs);
  const goal = normalizeGoal({
    id: randomId(),
    title: input.title || objective,
    ownerAgentId: input.ownerAgentId || 'main',
    projectId: input.projectId != null ? Number(input.projectId) : null,
    status: input.status || 'active',
    objective,
    currentPlan: { steps: normalizePlanSteps(input.currentPlan?.steps || input.planSteps || []) },
    subgoals: normalizeSubgoals(input.subgoals || []),
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
    lastActivity: 'Goal created',
  });
  const store = readStore();
  store.goals.push(goal);
  writeStore(store);
  ensureGoalMemoryFile(goal.id, goal.title);
  return goal;
}

export function updateGoal(goalId, patch = {}) {
  const id = String(goalId || '').trim();
  if (!id) throw new Error('goal id is required');
  const store = readStore();
  const idx = store.goals.findIndex((g) => g.id === id);
  if (idx < 0) throw new Error(`Goal not found: ${id}`);
  const prev = store.goals[idx];
  const next = normalizeGoal({
    ...prev,
    ...patch,
    id,
    updatedAt: nowMs(),
  });
  store.goals[idx] = next;
  writeStore(store);
  return next;
}

export function listDueGoals(now = nowMs()) {
  const store = readStore();
  return store.goals
    .filter((g) => g.status === 'active')
    .filter((g) => !g.running)
    .filter((g) => {
      const waitEval = evaluateWaitCondition(g.waitCondition, { now });
      return !waitEval.waiting;
    })
    .filter((g) => (Number(g.nextRunAt) || 0) <= now)
    .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
}

function stripCowcodePrefix(text) {
  return formatUserFacingReply(text);
}

function maybeParseJsonFromText(text) {
  const s = stripCowcodePrefix(text);
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

export function readGoalMemory(goalId, opts = {}) {
  const path = getGoalMemoryPath(goalId);
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

function ensureGoalMemoryFile(goalId, title = '') {
  const path = getGoalMemoryPath(goalId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) {
    const heading = summarize(title || goalId, 120);
    const init = [
      `# Goal Memory: ${heading || goalId}`,
      '',
      'Persistent knowledge for this goal across autonomous ticks.',
      '',
    ].join('\n');
    writeFileSync(path, init, 'utf8');
  }
  return path;
}

function appendGoalMemory(goalId, title, lines) {
  const path = ensureGoalMemoryFile(goalId, title);
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

export function buildGoalTickPrompt(goal, opts = {}) {
  const g = normalizeGoal(goal);
  const memoryPath = String(opts.memoryPath || getGoalMemoryPath(g.id)).trim();
  const goalMemory = String(opts.goalMemory || '').trim();
  const steps = (g.currentPlan.steps || [])
    .map((s) => `- [${s.status}] ${s.title}`)
    .join('\n');
  const subgoalLines = formatSubgoalsForPrompt(g.subgoals || []);
  const subgoalsText = subgoalLines.length ? subgoalLines.join('\n') : '';
  const waitConditionText = formatWaitConditionForPrompt(g.waitCondition);
  return [
    'You are executing a persistent background goal tick.',
    `Goal ID: ${g.id}`,
    `Goal title: ${g.title}`,
    `Objective: ${g.objective}`,
    `Status: ${g.status}`,
    `Current progress: ${g.progress.pct}%`,
    g.blockedReason ? `Blocked reason: ${g.blockedReason}` : '',
    g.contextSnapshot ? `Context snapshot: ${g.contextSnapshot}` : '',
    g.memoryAnchors.length ? `Memory anchors:\n${g.memoryAnchors.map((a) => `- ${a}`).join('\n')}` : '',
    `Per-goal memory file path: ${memoryPath}`,
    goalMemory ? `Per-goal memory contents (review this first):\n${goalMemory}` : 'Per-goal memory contents: (empty)',
    steps ? `Current plan steps:\n${steps}` : '',
    subgoalsText ? `Current subgoals tree:\n${subgoalsText}` : '',
    waitConditionText || '',
    '',
    'Follow these mandatory sections in order:',
    '1) Review',
    '- Review current goal state (status/progress/plan/subgoals).',
    '- Review the per-goal memory file contents before taking action.',
    '',
    '2) Progress Evaluation',
    '- Quantitative: estimate progress % and measurable evidence.',
    '- Qualitative: what improved, what risk increased, and confidence.',
    '',
    '3) Next Action Selection',
    '- Pick the single highest-leverage next action for this tick.',
    '- Keep scope to one meaningful step.',
    '',
    '4) Delegation Check',
    '- Decide if delegation is needed for the next action.',
    '- Delegate only if it improves quality or speed.',
    '',
    '5) Reflection & Memory Update',
    '- Reflect on outcomes, decisions, learnings, user preferences, and failed attempts.',
    '- Return these fields so they can be appended to the goal memory file.',
    '',
    '6) User Input Check',
    '- If blocked or decision-sensitive, set userInputRequired=true and fill needsUserInput with a clear ask.',
    '- Always include 2–3 concrete options plus a recommended default (e.g. Recommend PostHog; options 1) GA4 2) Mixpanel; reply "use default").',
    '- Preserve existing subgoal IDs and tree shape from "Current subgoals tree". Update status/progress only — do not replace a flat task list with a new nested tree.',
    '',
    '7) Waiting / Watchers / Conditions',
    '- If work should pause until something happens, return a wait object.',
    '- Supported waits: time, team_activity, manual.',
    '- If no waiting is needed, set wait.kind to "none".',
    '',
    '8) Opportunity Detection',
    '- Detect opportunities, risks, improvements, experiments, and unanswered questions.',
    '- If the goal is entering waiting state, explicitly check adjacent work worth exploring.',
    '- Only include strong initiatives (high signal, confidence >= 0.6).',
    '',
    'Take one useful step now. You may use tools and delegate as needed.',
    'IMPORTANT: At the start of this tick, review the per-goal memory. At the end, return structured learnings/decisions so they can be appended to that memory file.',
    'Return STRICT JSON only (no prose) with this schema:',
    '{',
    '  "status": "active|paused|completed|blocked|error",',
    '  "summary": "what happened this tick",',
    '  "progressPct": 0,',
    '  "evidence": ["short evidence lines"],',
    '  "progressEvaluation": {"quantitative":"", "qualitative":""},',
    '  "currentStep": "what you are doing now",',
    '  "delegationCheck": {"needed": false, "targetAgentId":"", "reason":""},',
    '  "reflection": "short retrospective for memory",',
    '  "userInputRequired": false,',
    '  "needsUserInput": "",',
    '  "wait": {"kind":"none|time|team_activity|manual", "reason":"", "untilTs":0, "eventType":"", "messageIncludes":"", "agentId":"", "targetAgentId":"", "condition":""},',
    '  "initiatives": [{"title":"...", "type":"opportunity|risk|question|experiment|improvement|observation", "description":"...", "source":"goal_reflection|waiting_goal", "confidence":0.0, "relatedGoalIds":["goal-id"]}],',
    '  "blockedReason": "",',
    '  "nextRunInSec": 60,',
    '  "contextSnapshot": "",',
    '  "memoryAnchors": ["..."],',
    '  "learnings": ["key learnings from this tick"],',
    '  "decisions": ["decisions made"],',
    '  "userPreferences": ["new user preferences discovered"],',
    '  "failedAttempts": ["what did not work"],',
    '  "planSteps": [{"title":"...", "status":"todo|doing|done|blocked"}],',
    '  "subgoals": [',
    '    {',
    '      "id": "research-phase",',
    '      "title": "Research",',
    '      "status": "todo|doing|done|blocked",',
    '      "progress": 0,',
    '      "assignee": "optional agent id",',
    '      "depends_on": ["optional-subgoal-id"],',
    '      "subgoals": []',
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

export async function runGoalTick(goalId, opts = {}) {
  const id = String(goalId || '').trim();
  if (!id) throw new Error('goal id is required');
  const runGoalTurn = typeof opts.runGoalTurn === 'function' ? opts.runGoalTurn : null;
  if (!runGoalTurn) throw new Error('runGoalTurn is required');

  const current = getGoal(id);
  if (!current) throw new Error(`Goal not found: ${id}`);
  if (current.status !== 'active') return { goal: current, skipped: 'not-active' };
  if (current.running) return { goal: current, skipped: 'already-running' };

  const started = updateGoal(id, {
    running: true,
    runningSince: nowMs(),
    runningAgentId: current.ownerAgentId,
    lastActivity: `Tick started for ${current.ownerAgentId}`,
  });
  const memoryPath = ensureGoalMemoryFile(started.id, started.title);
  const goalMemory = readGoalMemory(started.id, { maxChars: 12_000 });
  const prompt = buildGoalTickPrompt(started, { memoryPath, goalMemory });

  try {
    const turn = await runGoalTurn(started, prompt);
    const text = stripCowcodePrefix(turn?.textToSend || '');
    const parsed = maybeParseJsonFromText(text) || {};
    const nextStatus = normalizeTickStatus(parsed.status || started.status);
    const progressPct = Number(parsed.progressPct);
    const nextRunInSec = Number(parsed.nextRunInSec);
    const intervalMs = clampIntervalMs(nextRunInSec > 0 ? nextRunInSec * 1000 : started.intervalMs);
    const nextSubgoals = Array.isArray(parsed.subgoals)
      ? mergeSubgoalTrees(started.subgoals || [], parsed.subgoals)
      : normalizeSubgoals(started.subgoals || []);
    const learnings = safeArray(parsed.learnings, 10);
    const decisions = safeArray(parsed.decisions, 10);
    const userPreferences = safeArray(parsed.userPreferences, 10);
    const failedAttempts = safeArray(parsed.failedAttempts, 10);
    const userInputRequired = parsed.userInputRequired === true || String(parsed.userInputRequired || '').toLowerCase() === 'true';
    const needsUserInputText = normalizeNeedsUserInput(parsed.needsUserInput || '');
    const hasWaitField = Object.prototype.hasOwnProperty.call(parsed, 'wait') || Object.prototype.hasOwnProperty.call(parsed, 'waitCondition');
    const parsedWaitCondition = normalizeWaitCondition(
      Object.prototype.hasOwnProperty.call(parsed, 'wait') ? parsed.wait : parsed.waitCondition,
      { now: nowMs() },
    );
    const nextWaitCondition = hasWaitField ? parsedWaitCondition : (started.waitCondition || null);
    const now = nowMs();
    const waitEval = evaluateWaitCondition(nextWaitCondition, { now });
    const updated = updateGoal(id, {
      status: nextStatus,
      progress: {
        pct: Number.isFinite(progressPct) ? progressPct : started.progress.pct,
        metrics: started.progress.metrics || {},
        evidence: safeArray(parsed.evidence, 20),
      },
      currentPlan: {
        steps: normalizePlanSteps(parsed.planSteps || started.currentPlan.steps || []),
      },
      subgoals: nextSubgoals,
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
      lastActivity: summarize(parsed.summary || text || 'Goal tick complete', 280),
      history: [
        ...(Array.isArray(started.history) ? started.history : []),
        {
          ts: now,
          status: nextStatus,
          summary: summarize(parsed.summary || text || 'Goal tick complete', 280),
          evidence: safeArray(parsed.evidence, 6),
          skillsCalled: Array.isArray(turn?.skillsCalled) ? turn.skillsCalled.slice(0, 8) : [],
        },
      ].slice(-60),
    });

    const memoryLines = [
      `Summary: ${summarize(parsed.summary || text || 'Goal tick complete', 260)}`,
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
      updated.subgoals && updated.subgoals.length
        ? `Subgoals: ${updated.subgoals.slice(0, 8).map((sg) => `${sg.title}(${sg.status}/${sg.progress}%)`).join(', ')}`
        : '',
      updated.blockedReason ? `Blocked reason: ${updated.blockedReason}` : '',
      updated.needsUserInput ? `Needs user input: ${updated.needsUserInput}` : '',
      updated.waitCondition ? `Wait condition: kind=${updated.waitCondition.kind} reason=${summarize(updated.waitCondition.reason || '', 160)}` : '',
    ].filter(Boolean);
    appendGoalMemory(updated.id, updated.title, memoryLines);

    const initiativeCandidates = Array.isArray(parsed.initiatives) ? parsed.initiatives : [];
    const initiativeResult = createInitiatives(initiativeCandidates, {
      source: parsedWaitCondition ? 'waiting_goal' : 'goal_reflection',
      createdBy: updated.ownerAgentId,
      relatedGoalIds: [updated.id],
      minConfidence: 0.6,
      maxPerBatch: 2,
    });
    if (initiativeResult.created.length || initiativeResult.merged.length) {
      const activity = [
        initiativeResult.created.length ? `initiatives created=${initiativeResult.created.length}` : '',
        initiativeResult.merged.length ? `merged=${initiativeResult.merged.length}` : '',
      ].filter(Boolean).join(', ');
      updateGoal(id, { lastActivity: summarize(`${updated.lastActivity} | ${activity}`, 280) });
    }

    return { goal: getGoal(id), createdSubgoals: [], turn, initiatives: initiativeResult };
  } catch (err) {
    const failed = updateGoal(id, {
      status: 'blocked',
      running: false,
      runningSince: 0,
      runningAgentId: '',
      lastRunAt: nowMs(),
      nextRunAt: nowMs() + current.intervalMs,
      blockedReason: summarize(err?.message || String(err), 280),
      lastActivity: `Tick failed: ${summarize(err?.message || String(err), 180)}`,
    });
    appendGoalMemory(failed.id, failed.title, [
      `Summary: Tick failed`,
      `Did not work: ${summarize(err?.message || String(err), 260)}`,
      `Status: ${failed.status}`,
    ]);
    return { goal: failed, error: err };
  }
}

export function processDueGoalsInStore(opts = {}) {
  const now = nowMs();
  const maxPerCycle = Math.max(1, Math.min(10, Number(opts.maxPerCycle) || 3));
  const store = readStore();
  const goals = Array.isArray(store.goals) ? store.goals.slice() : [];
  const needsActivityWindow = goals.some((g) => g?.waitCondition?.kind === 'team_activity');
  const events = needsActivityWindow ? readTeamActivityWindow({ maxBytes: 512 * 1024, maxEvents: 3000 }) : [];
  let changed = false;

  const normalized = goals.map((goal) => {
    const g = normalizeGoal(goal);
    if (g.status !== 'active' || g.running || !g.waitCondition) return g;
    const waitEval = evaluateWaitCondition(g.waitCondition, { now, events });
    if (waitEval.satisfied) {
      changed = true;
      return normalizeGoal({
        ...g,
        waitCondition: null,
        nextRunAt: Math.min(Number(g.nextRunAt) || now, now),
        lastActivity: summarize(`Wait satisfied: ${waitEval.reason || 'condition met'}`, 280),
      });
    }
    const desiredNextRunAt = Math.max(now + 5_000, Number(waitEval.nextCheckAt) || (now + g.intervalMs));
    if ((Number(g.nextRunAt) || 0) !== desiredNextRunAt || !String(g.lastActivity || '').startsWith('Waiting:')) {
      changed = true;
      return normalizeGoal({
        ...g,
        nextRunAt: desiredNextRunAt,
        lastActivity: summarize(`Waiting: ${waitEval.reason || 'condition pending'}`, 280),
      });
    }
    return g;
  });

  if (changed) {
    writeStore({ goals: normalized, updatedAt: store.updatedAt });
  }

  return normalized
    .filter((g) => g.status === 'active')
    .filter((g) => !g.running)
    .filter((g) => !g.waitCondition)
    .filter((g) => (Number(g.nextRunAt) || 0) <= now)
    .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))
    .slice(0, maxPerCycle);
}
