import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getCuriosityMomentumStatePath } from './paths.js';
import {
  listGoals,
  getGoal,
  updateGoal,
  readGoalMemory,
  getGoalMemoryPath,
  appendGoalMemory,
  isGoalTickPausedByWait,
  isPartialWaitCondition,
  partitionSubgoalsByWait,
  normalizeWaitAppliesTo,
} from './goals.js';
import { formatUserFacingReply } from './user-facing-reply.js';

const MIN_CYCLE_MS = 2 * 60 * 60_000;
const MAX_CYCLE_MS = 4 * 60 * 60_000;
const DEFAULT_CYCLE_MS = 3 * 60 * 60_000;
const DEFAULT_IDLE_MS = 2 * 60 * 60_000;
const DEFAULT_MAX_PER_CYCLE = 1;

function nowMs() {
  return Date.now();
}

function summarize(text, maxLen = 280) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}...` : s;
}

function clampCycleMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_CYCLE_MS;
  return Math.max(MIN_CYCLE_MS, Math.min(MAX_CYCLE_MS, Math.floor(n)));
}

function readState() {
  const path = getCuriosityMomentumStatePath();
  try {
    if (!existsSync(path)) return { lastCycleAt: 0 };
    const parsed = JSON.parse(readFileSync(path, 'utf8') || '{}');
    return { lastCycleAt: Number(parsed.lastCycleAt) || 0 };
  } catch {
    return { lastCycleAt: 0 };
  }
}

function writeState(state) {
  const path = getCuriosityMomentumStatePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    lastCycleAt: Number(state.lastCycleAt) || 0,
  }, null, 2), 'utf8');
}

function formatSubgoalsForPrompt(subgoals, depth = 0) {
  if (!Array.isArray(subgoals) || !subgoals.length || depth > 5) return [];
  const lines = [];
  subgoals.forEach((sg) => {
    const indent = '  '.repeat(depth);
    const assignee = sg.assignee ? ` assignee=${sg.assignee}` : '';
    lines.push(`${indent}- [${sg.status}] ${sg.title} (${sg.progress}%) id=${sg.id || ''}${assignee}`);
    lines.push(...formatSubgoalsForPrompt(sg.subgoals || [], depth + 1));
  });
  return lines;
}

function formatWaitScopeForPrompt(waitCondition, subgoals) {
  if (!isPartialWaitCondition(waitCondition)) return '';
  const { blocked, actionable } = partitionSubgoalsByWait(subgoals, waitCondition);
  const waitAppliesTo = normalizeWaitAppliesTo(waitCondition.waitAppliesTo || waitCondition.scope, 'implementation');
  const blockedLines = blocked.slice(0, 8).map((s) => `- [BLOCKED] ${s.title} (${s.id})`);
  const actionableLines = actionable.slice(0, 8).map((s) => `- [OK] ${s.title} (${s.id})`);
  return [
    `Partial wait on ${waitAppliesTo}; suggest only actionable branches.`,
    blockedLines.length ? `Blocked:\n${blockedLines.join('\n')}` : '',
    actionableLines.length ? `Actionable:\n${actionableLines.join('\n')}` : 'Actionable: research, notes, read-only checks.',
  ].filter(Boolean).join('\n');
}

function maybeParseJsonFromText(text) {
  const s = formatUserFacingReply(text);
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

export function parseCuriositySuggestion(text) {
  const parsed = maybeParseJsonFromText(text) || {};
  const hasSafeNextStep = parsed.hasSafeNextStep === true
    || String(parsed.hasSafeNextStep || '').toLowerCase() === 'true';
  const suggestion = summarize(parsed.suggestion || parsed.summary || '', 320);
  const safeNextStep = summarize(parsed.safeNextStep || parsed.nextStep || '', 320);
  const rationale = summarize(parsed.rationale || parsed.reason || '', 320);
  const existingSubgoalId = String(parsed.existingSubgoalId || parsed.subgoalId || '').trim();
  return {
    hasSafeNextStep: hasSafeNextStep && !!(suggestion || safeNextStep),
    suggestion: suggestion || safeNextStep,
    safeNextStep: safeNextStep || suggestion,
    rationale,
    existingSubgoalId,
  };
}

export function buildCuriosityMomentumPrompt(goal, opts = {}) {
  const g = goal || {};
  const memoryPath = String(opts.memoryPath || getGoalMemoryPath(g.id)).trim();
  const goalMemory = String(opts.goalMemory || '').trim();
  const subgoalLines = formatSubgoalsForPrompt(g.subgoals || []);
  const waitScope = formatWaitScopeForPrompt(g.waitCondition, g.subgoals || []);
  const idleHours = Number(opts.idleHours) || 0;

  return [
    'You are running a lightweight IDLE SUGGESTION check for a background mission.',
    'This is NOT a goal tick. Do not execute work, create tasks, change progress, or pretend work happened.',
    'Purpose: if the mission has been quiet too long, suggest one safe tiny next step the goal tick engine could take later.',
    `Goal ID: ${g.id}`,
    `Goal title: ${g.title}`,
    `Objective: ${g.objective}`,
    `Progress: ${g.progress?.pct ?? 0}% (do not change this)`,
    idleHours ? `Mission idle for ~${idleHours.toFixed(1)}h since last activity.` : '',
    g.contextSnapshot ? `Context snapshot: ${g.contextSnapshot}` : '',
    g.lastActivity ? `Last activity: ${g.lastActivity}` : '',
    `Per-goal memory path: ${memoryPath}`,
    goalMemory ? `Per-goal memory (review first, avoid repeating recent work):\n${goalMemory}` : 'Per-goal memory: (empty)',
    subgoalLines.length ? `Current subgoals:\n${subgoalLines.join('\n')}` : 'Current subgoals: (none)',
    waitScope || '',
    '',
    'Strict rules:',
    '- Read-only reasoning only. Prefer suggesting an existing open subgoal over inventing new work.',
    '- A safe next step is tiny, reversible, and low risk (read repo, draft note, confirm config).',
    '- Do NOT deploy, spend money, delete data, change production, or create subgoals.',
    '- Do NOT bump progressPct or return createdSubgoals, initiatives, planSteps, or subgoals patches.',
    '- If nothing safe and useful to suggest, set hasSafeNextStep=false and leave suggestion empty.',
    '',
    'Return STRICT JSON only:',
    '{',
    '  "hasSafeNextStep": true,',
    '  "suggestion": "one-line suggestion for the owner or user",',
    '  "safeNextStep": "concrete tiny action the goal tick should take",',
    '  "rationale": "why this is safe and useful now",',
    '  "existingSubgoalId": "optional-existing-subgoal-id"',
    '}',
  ].filter(Boolean).join('\n');
}

export function applyCuriositySuggestion(goalId, parsed, opts = {}) {
  const id = String(goalId || '').trim();
  if (!id) throw new Error('goal id is required');
  const goal = getGoal(id);
  if (!goal) throw new Error(`Goal not found: ${id}`);

  const now = Number(opts.now) || nowMs();
  const idleHours = Number(opts.idleHours) || 0;
  const suggestion = parsed || {};

  if (!suggestion.hasSafeNextStep) {
    const activity = summarize('Idle check: no safe next step to suggest right now.', 280);
    appendGoalMemory(id, goal.title, [
      `Idle check (${idleHours ? `${idleHours.toFixed(1)}h idle` : 'quiet mission'}): no safe suggestion.`,
    ]);
    return updateGoal(id, {
      lastCuriosityAt: now,
      lastActivity: activity,
    });
  }

  const line = summarize(suggestion.suggestion || suggestion.safeNextStep, 220);
  const step = summarize(suggestion.safeNextStep, 220);
  const rationale = summarize(suggestion.rationale, 180);
  const subgoalRef = suggestion.existingSubgoalId
    ? ` (subgoal ${suggestion.existingSubgoalId})`
    : '';

  appendGoalMemory(id, goal.title, [
    `Idle suggestion${subgoalRef}: ${line}`,
    step && step !== line ? `Safe next step: ${step}` : '',
    rationale ? `Why: ${rationale}` : '',
  ].filter(Boolean));

  return updateGoal(id, {
    lastCuriosityAt: now,
    lastActivity: summarize(`Idle suggestion: ${line}`, 280),
  });
}

export function listCuriosityCandidateGoals(opts = {}) {
  const now = Number(opts.now) || nowMs();
  const idleMs = Math.max(30 * 60_000, Number(opts.idleMs) || DEFAULT_IDLE_MS);
  const excludeIds = new Set(
    (Array.isArray(opts.excludeGoalIds) ? opts.excludeGoalIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const goals = listGoals().goals || [];
  return goals
    .filter((g) => String(g.status || '').toLowerCase() === 'active')
    .filter((g) => !g.running)
    .filter((g) => !excludeIds.has(g.id))
    .filter((g) => !isGoalTickPausedByWait(g, now))
    .filter((g) => {
      const dueForRegularTick = (Number(g.nextRunAt) || 0) <= now;
      return !dueForRegularTick;
    })
    .filter((g) => {
      const lastTouch = Math.max(
        Number(g.lastRunAt) || 0,
        Number(g.lastCuriosityAt) || 0,
      );
      return lastTouch > 0 && now - lastTouch >= idleMs;
    })
    .sort((a, b) => {
      const aTouch = Math.max(Number(a.lastRunAt) || 0, Number(a.lastCuriosityAt) || 0);
      const bTouch = Math.max(Number(b.lastRunAt) || 0, Number(b.lastCuriosityAt) || 0);
      return aTouch - bTouch;
    });
}

export async function runCuriosityMomentumForGoal(goalId, opts = {}) {
  const id = String(goalId || '').trim();
  if (!id) throw new Error('goal id is required');
  const runGoalTurn = typeof opts.runGoalTurn === 'function' ? opts.runGoalTurn : null;
  if (!runGoalTurn) throw new Error('runGoalTurn is required');

  const before = getGoal(id);
  if (!before) throw new Error(`Goal not found: ${id}`);
  if (before.running) return { goal: before, skipped: 'already-running' };
  if (isGoalTickPausedByWait(before, nowMs())) return { goal: before, skipped: 'waiting' };

  const now = nowMs();
  const lastTouch = Math.max(Number(before.lastRunAt) || 0, Number(before.lastCuriosityAt) || 0);
  const idleHours = lastTouch ? (now - lastTouch) / 3600_000 : 0;
  const memoryPath = getGoalMemoryPath(before.id);
  const goalMemory = readGoalMemory(before.id, { maxChars: 8000 });
  const prompt = buildCuriosityMomentumPrompt(before, { memoryPath, goalMemory, idleHours });

  const turn = await runGoalTurn(before, prompt);
  const parsed = parseCuriositySuggestion(turn?.textToSend || '');
  const updated = applyCuriositySuggestion(id, parsed, { now, idleHours });

  return {
    goal: updated,
    suggestion: parsed,
    skipped: '',
    turn,
  };
}

/**
 * Lightweight idle layer: suggest a safe tiny next step when a mission has been quiet.
 * Does not run goal ticks, create subgoals, or change progress.
 */
export async function runCuriosityMomentumCycle(opts = {}) {
  const now = nowMs();
  const minIntervalMs = clampCycleMs(opts.minIntervalMs || DEFAULT_CYCLE_MS);
  const idleMs = Math.max(30 * 60_000, Number(opts.idleMs) || DEFAULT_IDLE_MS);
  const maxPerCycle = Math.max(1, Math.min(3, Number(opts.maxPerCycle) || DEFAULT_MAX_PER_CYCLE));
  const state = readState();

  if (!opts.force && now - Number(state.lastCycleAt || 0) < minIntervalMs) {
    return { skipped: 'interval', results: [], candidates: [] };
  }

  const candidates = listCuriosityCandidateGoals({
    now,
    idleMs,
    excludeGoalIds: opts.excludeGoalIds,
  });
  const results = [];

  for (const goal of candidates.slice(0, maxPerCycle)) {
    try {
      const result = await runCuriosityMomentumForGoal(goal.id, opts);
      const suggestion = result.suggestion || {};
      results.push({
        goalId: goal.id,
        title: goal.title,
        ownerAgentId: goal.ownerAgentId || '',
        skipped: result.skipped || '',
        error: result.error ? summarize(result.error.message || String(result.error), 180) : '',
        hasSafeNextStep: suggestion.hasSafeNextStep === true,
        suggestion: suggestion.suggestion || '',
        safeNextStep: suggestion.safeNextStep || '',
        rationale: suggestion.rationale || '',
        summary: result.goal?.lastActivity || '',
      });
    } catch (err) {
      results.push({
        goalId: goal.id,
        title: goal.title,
        ownerAgentId: goal.ownerAgentId || '',
        error: summarize(err?.message || String(err), 180),
        hasSafeNextStep: false,
        suggestion: '',
        safeNextStep: '',
        rationale: '',
      });
    }
  }

  writeState({ lastCycleAt: now });
  return { results, candidates: candidates.map((g) => ({ id: g.id, title: g.title })) };
}
