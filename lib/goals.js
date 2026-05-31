import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getGoalsStorePath } from './paths.js';

const VALID_STATUS = new Set(['active', 'paused', 'completed', 'blocked']);
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

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
  return {
    id,
    title,
    ownerAgentId,
    status,
    objective,
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
    status: input.status || 'active',
    objective,
    currentPlan: { steps: normalizePlanSteps(input.currentPlan?.steps || input.planSteps || []) },
    progress: input.progress || defaultProgress(),
    lastRunAt: 0,
    nextRunAt: createdAt + intervalMs,
    intervalMs,
    contextSnapshot: input.contextSnapshot || '',
    memoryAnchors: input.memoryAnchors || [],
    running: false,
    createdAt,
    updatedAt: createdAt,
    lastActivity: 'Goal created',
  });
  const store = readStore();
  store.goals.push(goal);
  writeStore(store);
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
    .filter((g) => (Number(g.nextRunAt) || 0) <= now)
    .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
}

function stripCowcodePrefix(text) {
  return String(text || '').replace(/^\[CowCode\]\s*/i, '').trim();
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

export function buildGoalTickPrompt(goal) {
  const g = normalizeGoal(goal);
  const steps = (g.currentPlan.steps || [])
    .map((s) => `- [${s.status}] ${s.title}`)
    .join('\n');
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
    steps ? `Current plan steps:\n${steps}` : '',
    '',
    'Take one useful step now. You may use tools and delegate as needed.',
    'Return STRICT JSON only (no prose) with this schema:',
    '{',
    '  "status": "active|paused|completed|blocked|error",',
    '  "summary": "what happened this tick",',
    '  "progressPct": 0,',
    '  "evidence": ["short evidence lines"],',
    '  "currentStep": "what you are doing now",',
    '  "needsUserInput": "",',
    '  "blockedReason": "",',
    '  "nextRunInSec": 60,',
    '  "contextSnapshot": "",',
    '  "memoryAnchors": ["..."],',
    '  "planSteps": [{"title":"...", "status":"todo|doing|done|blocked"}],',
    '  "subgoals": [{"title":"...", "objective":"...", "ownerAgentId":"main"}]',
    '}',
  ].filter(Boolean).join('\n');
}

function normalizeTickStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'error') return 'blocked';
  return sanitizeStatus(s || 'active');
}

function toSubgoalDrafts(subgoals, fallbackOwner) {
  if (!Array.isArray(subgoals)) return [];
  return subgoals
    .map((sg) => {
      if (!sg || typeof sg !== 'object') return null;
      const objective = summarize(sg.objective || sg.title || '', 1500);
      if (!objective) return null;
      return {
        title: summarize(sg.title || objective, 120),
        objective,
        ownerAgentId: String(sg.ownerAgentId || fallbackOwner || 'main').trim() || 'main',
      };
    })
    .filter(Boolean)
    .slice(0, 6);
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
  const prompt = buildGoalTickPrompt(started);

  try {
    const turn = await runGoalTurn(started, prompt);
    const text = stripCowcodePrefix(turn?.textToSend || '');
    const parsed = maybeParseJsonFromText(text) || {};
    const nextStatus = normalizeTickStatus(parsed.status || started.status);
    const progressPct = Number(parsed.progressPct);
    const nextRunInSec = Number(parsed.nextRunInSec);
    const intervalMs = clampIntervalMs(nextRunInSec > 0 ? nextRunInSec * 1000 : started.intervalMs);
    const subgoalDrafts = toSubgoalDrafts(parsed.subgoals, started.ownerAgentId);
    const now = nowMs();
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
      contextSnapshot: summarize(parsed.contextSnapshot || parsed.summary || text || '', 2000),
      memoryAnchors: safeArray(parsed.memoryAnchors, 20),
      lastRunAt: now,
      nextRunAt: now + intervalMs,
      intervalMs,
      running: false,
      runningSince: 0,
      runningAgentId: '',
      blockedReason: summarize(parsed.blockedReason || '', 280),
      needsUserInput: summarize(parsed.needsUserInput || '', 280),
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

    const createdSubgoals = [];
    for (const draft of subgoalDrafts) {
      try {
        const child = createGoal({
          ...draft,
          status: 'active',
          contextSnapshot: `Subgoal created by ${updated.id}`,
          memoryAnchors: [`parent=${updated.id}`],
        });
        createdSubgoals.push(child);
      } catch (_) {}
    }

    return { goal: updated, createdSubgoals, turn };
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
    return { goal: failed, error: err };
  }
}

export function processDueGoalsInStore(opts = {}) {
  const now = nowMs();
  const due = listDueGoals(now).slice(0, Math.max(1, Math.min(10, Number(opts.maxPerCycle) || 3)));
  return due;
}
