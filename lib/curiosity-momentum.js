import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getCuriosityMomentumStatePath } from './paths.js';

const __curDir = dirname(fileURLToPath(import.meta.url));
const CURIOSITY_SYSTEM = readFileSync(join(__curDir, 'templates', 'curiosity-momentum-prompt.md'), 'utf8').trim();
import {
  listMissions,
  getMission,
  updateMission,
  readMissionMemory,
  getMissionMemoryPath,
  appendMissionMemory,
  isMissionTickPausedByWait,
  isPartialWaitCondition,
  partitionTasksByWait,
  normalizeWaitAppliesTo,
} from './missions.js';
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

function formatTasksForPrompt(tasks, depth = 0) {
  if (!Array.isArray(tasks) || !tasks.length || depth > 5) return [];
  const lines = [];
  tasks.forEach((sg) => {
    const indent = '  '.repeat(depth);
    const assignee = sg.assignee ? ` assignee=${sg.assignee}` : '';
    lines.push(`${indent}- [${sg.status}] ${sg.title} (${sg.progress}%) id=${sg.id || ''}${assignee}`);
    lines.push(...formatTasksForPrompt(sg.tasks || [], depth + 1));
  });
  return lines;
}

function formatWaitScopeForPrompt(waitCondition, tasks) {
  if (!isPartialWaitCondition(waitCondition)) return '';
  const { blocked, actionable } = partitionTasksByWait(tasks, waitCondition);
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
  const existingTaskId = String(parsed.existingTaskId || parsed.taskId || '').trim();
  return {
    hasSafeNextStep: hasSafeNextStep && !!(suggestion || safeNextStep),
    suggestion: suggestion || safeNextStep,
    safeNextStep: safeNextStep || suggestion,
    rationale,
    existingTaskId,
  };
}

export function buildCuriosityMomentumPrompt(mission, opts = {}) {
  const g = mission || {};
  const memoryPath = String(opts.memoryPath || getMissionMemoryPath(g.id)).trim();
  const missionMemory = String(opts.missionMemory || '').trim();
  const taskLines = formatTasksForPrompt(g.tasks || []);
  const waitScope = formatWaitScopeForPrompt(g.waitCondition, g.tasks || []);
  const idleHours = Number(opts.idleHours) || 0;

  return [
    CURIOSITY_SYSTEM,
    '',
    `Mission ID: ${g.id}`,
    `Mission title: ${g.title}`,
    `Objective: ${g.objective}`,
    `Progress: ${g.progress?.pct ?? 0}% (do not change this)`,
    idleHours ? `Mission idle for ~${idleHours.toFixed(1)}h since last activity.` : '',
    g.contextSnapshot ? `Context snapshot: ${g.contextSnapshot}` : '',
    g.lastActivity ? `Last activity: ${g.lastActivity}` : '',
    `Per-mission memory path: ${memoryPath}`,
    missionMemory ? `Per-mission memory (review first, avoid repeating recent work):\n${missionMemory}` : 'Per-mission memory: (empty)',
    taskLines.length ? `Current tasks:\n${taskLines.join('\n')}` : 'Current tasks: (none)',
    waitScope || '',
  ].filter(Boolean).join('\n');
}

export function applyCuriositySuggestion(missionId, parsed, opts = {}) {
  const id = String(missionId || '').trim();
  if (!id) throw new Error('mission id is required');
  const mission = getMission(id);
  if (!mission) throw new Error(`Mission not found: ${id}`);

  const now = Number(opts.now) || nowMs();
  const idleHours = Number(opts.idleHours) || 0;
  const suggestion = parsed || {};

  if (!suggestion.hasSafeNextStep) {
    const activity = summarize('Idle check: no safe next step to suggest right now.', 280);
    appendMissionMemory(id, mission.title, [
      `Idle check (${idleHours ? `${idleHours.toFixed(1)}h idle` : 'quiet mission'}): no safe suggestion.`,
    ]);
    return updateMission(id, {
      lastCuriosityAt: now,
      lastActivity: activity,
    });
  }

  const line = summarize(suggestion.suggestion || suggestion.safeNextStep, 220);
  const step = summarize(suggestion.safeNextStep, 220);
  const rationale = summarize(suggestion.rationale, 180);
  const taskRef = suggestion.existingTaskId
    ? ` (task ${suggestion.existingTaskId})`
    : '';

  appendMissionMemory(id, mission.title, [
    `Idle suggestion${taskRef}: ${line}`,
    step && step !== line ? `Safe next step: ${step}` : '',
    rationale ? `Why: ${rationale}` : '',
  ].filter(Boolean));

  return updateMission(id, {
    lastCuriosityAt: now,
    lastActivity: summarize(`Idle suggestion: ${line}`, 280),
  });
}

export function listCuriosityCandidateMissions(opts = {}) {
  const now = Number(opts.now) || nowMs();
  const idleMs = Math.max(30 * 60_000, Number(opts.idleMs) || DEFAULT_IDLE_MS);
  const excludeIds = new Set(
    (Array.isArray(opts.excludeMissionIds) ? opts.excludeMissionIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const missions = listMissions().missions || [];
  return missions
    .filter((g) => String(g.status || '').toLowerCase() === 'active')
    .filter((g) => !g.running)
    .filter((g) => !excludeIds.has(g.id))
    .filter((g) => !isMissionTickPausedByWait(g, now))
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

export async function runCuriosityMomentumForMission(missionId, opts = {}) {
  const id = String(missionId || '').trim();
  if (!id) throw new Error('mission id is required');
  const runMissionTurn = typeof opts.runMissionTurn === 'function' ? opts.runMissionTurn : null;
  if (!runMissionTurn) throw new Error('runMissionTurn is required');

  const before = getMission(id);
  if (!before) throw new Error(`Mission not found: ${id}`);
  if (before.running) return { mission: before, skipped: 'already-running' };
  if (isMissionTickPausedByWait(before, nowMs())) return { mission: before, skipped: 'waiting' };

  const now = nowMs();
  const lastTouch = Math.max(Number(before.lastRunAt) || 0, Number(before.lastCuriosityAt) || 0);
  const idleHours = lastTouch ? (now - lastTouch) / 3600_000 : 0;
  const memoryPath = getMissionMemoryPath(before.id);
  const missionMemory = readMissionMemory(before.id, { maxChars: 8000 });
  const prompt = buildCuriosityMomentumPrompt(before, { memoryPath, missionMemory, idleHours });

  const turn = await runMissionTurn(before, prompt);
  const parsed = parseCuriositySuggestion(turn?.textToSend || '');
  const updated = applyCuriositySuggestion(id, parsed, { now, idleHours });

  return {
    mission: updated,
    suggestion: parsed,
    skipped: '',
    turn,
  };
}

/**
 * Lightweight idle layer: suggest a safe tiny next step when a mission has been quiet.
 * Does not run mission ticks, create tasks, or change progress.
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

  const candidates = listCuriosityCandidateMissions({
    now,
    idleMs,
    excludeMissionIds: opts.excludeMissionIds,
  });
  const results = [];

  for (const mission of candidates.slice(0, maxPerCycle)) {
    try {
      const result = await runCuriosityMomentumForMission(mission.id, opts);
      const suggestion = result.suggestion || {};
      results.push({
        missionId: mission.id,
        title: mission.title,
        ownerAgentId: mission.ownerAgentId || '',
        skipped: result.skipped || '',
        error: result.error ? summarize(result.error.message || String(result.error), 180) : '',
        hasSafeNextStep: suggestion.hasSafeNextStep === true,
        suggestion: suggestion.suggestion || '',
        safeNextStep: suggestion.safeNextStep || '',
        rationale: suggestion.rationale || '',
        summary: result.mission?.lastActivity || '',
      });
    } catch (err) {
      results.push({
        missionId: mission.id,
        title: mission.title,
        ownerAgentId: mission.ownerAgentId || '',
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
