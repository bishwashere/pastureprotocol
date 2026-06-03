import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getCuriosityMomentumStatePath } from './paths.js';
import {
  listGoals,
  getGoal,
  updateGoal,
  runGoalTick,
  readGoalMemory,
  getGoalMemoryPath,
  isGoalTickPausedByWait,
  isPartialWaitCondition,
  partitionSubgoalsByWait,
  normalizeWaitAppliesTo,
} from './goals.js';

const MIN_CYCLE_MS = 2 * 60 * 60_000;
const MAX_CYCLE_MS = 4 * 60 * 60_000;
const DEFAULT_CYCLE_MS = 3 * 60 * 60_000;
const DEFAULT_IDLE_MS = 2 * 60 * 60_000;
const DEFAULT_MAX_PER_CYCLE = 2;
const MAX_CREATED_SUBGOALS = 2;

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
    lines.push(`${indent}- [${sg.status}] ${sg.title} (${sg.progress}%)${assignee}`);
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
    `Partial wait on ${waitAppliesTo}; work only actionable branches.`,
    blockedLines.length ? `Blocked:\n${blockedLines.join('\n')}` : '',
    actionableLines.length ? `Actionable:\n${actionableLines.join('\n')}` : 'Actionable: research, notes, small experiments.',
  ].filter(Boolean).join('\n');
}

export function buildCuriosityMomentumPrompt(goal, opts = {}) {
  const g = goal || {};
  const memoryPath = String(opts.memoryPath || getGoalMemoryPath(g.id)).trim();
  const goalMemory = String(opts.goalMemory || '').trim();
  const subgoalLines = formatSubgoalsForPrompt(g.subgoals || []);
  const waitScope = formatWaitScopeForPrompt(g.waitCondition, g.subgoals || []);
  const idleHours = Number(opts.idleHours) || 0;

  return [
    'You are running a lightweight CURIOSITY & MOMENTUM pass for a background mission.',
    'Purpose: keep gentle progress alive during quiet periods — not a full production goal tick.',
    `Goal ID: ${g.id}`,
    `Goal title: ${g.title}`,
    `Objective: ${g.objective}`,
    `Progress: ${g.progress?.pct ?? 0}%`,
    idleHours ? `Mission idle for ~${idleHours.toFixed(1)}h since last activity.` : '',
    g.contextSnapshot ? `Context snapshot: ${g.contextSnapshot}` : '',
    `Per-goal memory path: ${memoryPath}`,
    goalMemory ? `Per-goal memory (review first, avoid repeating recent work):\n${goalMemory}` : 'Per-goal memory: (empty)',
    subgoalLines.length ? `Current subgoals:\n${subgoalLines.join('\n')}` : 'Current subgoals: (none)',
    waitScope || '',
    '',
    'Curiosity rules (strict):',
    '- Pick ONE small, safe, reversible next action: research, competitor scan, draft note, data check, tiny experiment.',
    '- Prefer createdSubgoals (max 2) for new low-effort work (<2h each). Examples: "Scan 3 competitor signup flows", "Draft survey questions".',
    '- You may nudge progress on ONE existing actionable subgoal if obvious and low risk.',
    '- Do NOT deploy, spend money, delete data, or change production config.',
    '- Set userInputRequired=true ONLY for high-stakes decisions (production deploy, budget spend, legal/compliance, irreversible changes).',
    '- For minor decisions use partial wait + needsUserInput; never pause the whole mission.',
    '- Keep status "active". Do not set blocked unless truly stuck on an error.',
    '- Return the same STRICT JSON schema as a goal tick (status, summary, progressPct, createdSubgoals, subgoals patches, initiatives, wait, etc.).',
    '',
    'Return STRICT JSON only.',
    '{',
    '  "status": "active",',
    '  "summary": "what small curiosity step you took or planned",',
    '  "progressPct": 0,',
    '  "evidence": ["short evidence lines"],',
    '  "userInputRequired": false,',
    '  "needsUserInput": "",',
    '  "wait": {"kind":"none|partial", "waitAppliesTo":"implementation", "reason":"", "blockedSubgoalIds":[]},',
    '  "createdSubgoals": [{"title":"...", "description":"...", "assignee":"agent-id", "priority":3, "dueInHours":2}],',
    '  "subgoals": [{"id":"existing-id", "status":"doing", "progress": 15}],',
    '  "initiatives": [],',
    '  "nextRunInSec": 300',
    '}',
  ].filter(Boolean).join('\n');
}

export function listCuriosityCandidateGoals(opts = {}) {
  const now = Number(opts.now) || nowMs();
  const idleMs = Math.max(30 * 60_000, Number(opts.idleMs) || DEFAULT_IDLE_MS);
  const goals = listGoals().goals || [];
  return goals
    .filter((g) => String(g.status || '').toLowerCase() === 'active')
    .filter((g) => !g.running)
    .filter((g) => !isGoalTickPausedByWait(g, now))
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
  const now = nowMs();
  const lastTouch = Math.max(Number(before.lastRunAt) || 0, Number(before.lastCuriosityAt) || 0);
  const idleHours = lastTouch ? (now - lastTouch) / 3600_000 : 0;

  const result = await runGoalTick(id, {
    runGoalTurn,
    promptBuilder: (goal, promptOpts) => buildCuriosityMomentumPrompt(goal, {
      ...promptOpts,
      idleHours,
    }),
    maxCreatedSubgoals: Math.max(1, Math.min(MAX_CREATED_SUBGOALS, Number(opts.maxCreatedSubgoals) || MAX_CREATED_SUBGOALS)),
    mode: 'curiosity_momentum',
  });

  if (result.skipped || result.error) return result;

  const summary = summarize(result.goal?.lastActivity || 'Curiosity momentum pass complete', 220);
  const updated = updateGoal(id, {
    lastCuriosityAt: now,
    lastActivity: summarize(`Curiosity momentum: ${summary}`, 280),
  });
  return { ...result, goal: updated };
}

/**
 * Periodic curiosity layer: nudge idle active missions with small safe work.
 * Runs every 2-4 hours (default 3h), max 2 missions per cycle.
 */
export async function runCuriosityMomentumCycle(opts = {}) {
  const now = nowMs();
  const minIntervalMs = clampCycleMs(opts.minIntervalMs || DEFAULT_CYCLE_MS);
  const idleMs = Math.max(30 * 60_000, Number(opts.idleMs) || DEFAULT_IDLE_MS);
  const maxPerCycle = Math.max(1, Math.min(5, Number(opts.maxPerCycle) || DEFAULT_MAX_PER_CYCLE));
  const state = readState();

  if (!opts.force && now - Number(state.lastCycleAt || 0) < minIntervalMs) {
    return { skipped: 'interval', results: [], candidates: [] };
  }

  const candidates = listCuriosityCandidateGoals({ now, idleMs });
  const results = [];

  for (const goal of candidates.slice(0, maxPerCycle)) {
    try {
      const result = await runCuriosityMomentumForGoal(goal.id, opts);
      results.push({
        goalId: goal.id,
        title: goal.title,
        skipped: result.skipped || '',
        error: result.error ? summarize(result.error.message || String(result.error), 180) : '',
        createdSubgoals: Array.isArray(result.createdSubgoals) ? result.createdSubgoals : [],
        summary: result.goal?.lastActivity || '',
      });
    } catch (err) {
      results.push({
        goalId: goal.id,
        title: goal.title,
        error: summarize(err?.message || String(err), 180),
        createdSubgoals: [],
      });
    }
  }

  writeState({ lastCycleAt: now });
  return { results, candidates: candidates.map((g) => ({ id: g.id, title: g.title })) };
}
