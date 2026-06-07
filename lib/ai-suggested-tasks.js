import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getAiSuggestedTasksStorePath, getLegacyAiSuggestedTasksStorePath } from './paths.js';
import { readTeamActivityWindow } from './team-activity.js';

const VALID_TYPES = new Set(['opportunity', 'risk', 'question', 'experiment', 'improvement', 'observation']);
const VALID_STATUS = new Set(['proposed', 'open', 'accepted', 'rejected', 'completed']);
const MIN_CONFIDENCE = 0.6;
const MAX_AI_SUGGESTED_TASKS_PER_TICK = 2;
const MAX_AI_SUGGESTED_TASKS_PER_DAY = 20;
const AUTO_PROMOTE_MIN_CONFIDENCE = 0.7;
const MAX_AUTO_PROMOTIONS_PER_MISSION_PER_DAY = 3;
const MIN_AUTO_PROMOTE_AGE_MS = 30 * 60_000;
const AUTO_PROMOTE_INTERVAL_MS = 45 * 60_000;

function nowMs() {
  return Date.now();
}

function summarize(text, maxLen = 320) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}...` : s;
}

function randomId() {
  return `init-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function normalizeType(type) {
  const t = String(type || '').trim().toLowerCase();
  return VALID_TYPES.has(t) ? t : 'observation';
}

function normalizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'open') return 'proposed';
  return VALID_STATUS.has(s) ? s : 'proposed';
}

export function isSuggestedTaskAwaitingApproval(suggestedTask) {
  const status = normalizeStatus(suggestedTask?.status);
  if (status !== 'proposed') return false;
  return true;
}

function safeArray(values, max = 20) {
  if (!Array.isArray(values)) return [];
  return values.map((v) => String(v || '').trim()).filter(Boolean).slice(0, max);
}

function normalizeSuggestedTask(row = {}) {
  const id = String(row.id || '').trim();
  return {
    id: id || randomId(),
    title: summarize(row.title || 'Untitled suggestedTask', 140),
    type: normalizeType(row.type),
    description: summarize(row.description || '', 2500),
    source: summarize(row.source || 'mission_reflection', 120),
    confidence: normalizeConfidence(row.confidence),
    status: normalizeStatus(row.status),
    createdBy: summarize(row.createdBy || 'main', 80) || 'main',
    relatedMissionIds: safeArray(row.relatedMissionIds, 40),
    activity: safeArray(row.activity, 60),
    specialistReviews: safeArray(row.specialistReviews, 30),
    createdAt: Number(row.createdAt) || nowMs(),
    updatedAt: Number(row.updatedAt) || nowMs(),
  };
}

function readStore() {
  const path = getAiSuggestedTasksStorePath();
  try {
    const legacyPath = getLegacyAiSuggestedTasksStorePath();
    const activePath = existsSync(path) ? path : legacyPath;
    if (!existsSync(activePath)) return { suggestedTasks: [], updatedAt: 0, analysis: { lastTeamScanAt: 0, autoPromoteLastRunAt: 0 } };
    const parsed = JSON.parse(readFileSync(activePath, 'utf8') || '{}');
    const rows = Array.isArray(parsed.suggestedTasks) ? parsed.suggestedTasks : (Array.isArray(parsed.initiatives) ? parsed.initiatives : []);
    const store = {
      suggestedTasks: rows.map(normalizeSuggestedTask),
      updatedAt: Number(parsed.updatedAt) || 0,
      analysis: parsed.analysis && typeof parsed.analysis === 'object'
        ? {
          lastTeamScanAt: Number(parsed.analysis.lastTeamScanAt) || 0,
          autoPromoteLastRunAt: Number(parsed.analysis.autoPromoteLastRunAt) || 0,
        }
        : { lastTeamScanAt: 0, autoPromoteLastRunAt: 0 },
    };
    if (activePath === legacyPath && store.suggestedTasks.length) writeStore(store);
    return store;
  } catch {
    return { suggestedTasks: [], updatedAt: 0, analysis: { lastTeamScanAt: 0, autoPromoteLastRunAt: 0 } };
  }
}

function writeStore(store) {
  const path = getAiSuggestedTasksStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = {
    suggestedTasks: Array.isArray(store.suggestedTasks) ? store.suggestedTasks.map(normalizeSuggestedTask) : [],
    updatedAt: nowMs(),
    analysis: store.analysis && typeof store.analysis === 'object'
      ? {
        lastTeamScanAt: Number(store.analysis.lastTeamScanAt) || 0,
        autoPromoteLastRunAt: Number(store.analysis.autoPromoteLastRunAt) || 0,
      }
      : { lastTeamScanAt: 0, autoPromoteLastRunAt: 0 },
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function dedupeKey(init) {
  const title = String(init.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${normalizeType(init.type)}::${title}`;
}

function countSuggestedTasksToday(rows, now = nowMs()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return rows.filter((r) => Number(r.createdAt) >= start.getTime()).length;
}

/**
 * Remove suggested tasks that exclusively reference the given mission.
 * Tasks that also reference other missions are preserved (mission link is removed instead).
 */
export function removeSuggestedTasksForMission(missionId) {
  const id = String(missionId || '').trim();
  if (!id) return { removed: 0 };
  const store = readStore();
  const before = store.suggestedTasks.length;
  store.suggestedTasks = store.suggestedTasks
    .map((t) => {
      const ids = Array.isArray(t.relatedMissionIds) ? t.relatedMissionIds : [];
      if (!ids.includes(id)) return t;
      const remaining = ids.filter((mid) => mid !== id);
      if (remaining.length > 0) return { ...t, relatedMissionIds: remaining };
      return null;
    })
    .filter(Boolean);
  const removed = before - store.suggestedTasks.length;
  if (removed > 0) writeStore(store);
  return { removed };
}

export function listSuggestedTasks() {
  const store = readStore();
  return {
    suggestedTasks: store.suggestedTasks.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    updatedAt: store.updatedAt || 0,
  };
}

export function getSuggestedTask(suggestedTaskId) {
  const id = String(suggestedTaskId || '').trim();
  if (!id) return null;
  return readStore().suggestedTasks.find((i) => i.id === id) || null;
}

export function updateSuggestedTask(suggestedTaskId, patch = {}) {
  const id = String(suggestedTaskId || '').trim();
  if (!id) throw new Error('suggestedTask id is required');
  const store = readStore();
  const idx = store.suggestedTasks.findIndex((i) => i.id === id);
  if (idx < 0) throw new Error(`SuggestedTask not found: ${id}`);
  const prev = store.suggestedTasks[idx];
  const next = normalizeSuggestedTask({
    ...prev,
    ...patch,
    id,
    updatedAt: nowMs(),
    relatedMissionIds: Array.isArray(patch.relatedMissionIds)
      ? Array.from(new Set([...prev.relatedMissionIds, ...safeArray(patch.relatedMissionIds, 40)]))
      : prev.relatedMissionIds,
    activity: Array.isArray(patch.activity)
      ? Array.from(new Set([...prev.activity, ...safeArray(patch.activity, 60)])).slice(-60)
      : prev.activity,
    specialistReviews: Array.isArray(patch.specialistReviews)
      ? Array.from(new Set([...prev.specialistReviews, ...safeArray(patch.specialistReviews, 30)])).slice(-30)
      : prev.specialistReviews,
  });
  store.suggestedTasks[idx] = next;
  writeStore(store);
  return next;
}

export function createSuggestedTasks(candidates = [], opts = {}) {
  const source = summarize(opts.source || 'mission_reflection', 120);
  const createdBy = summarize(opts.createdBy || 'main', 80) || 'main';
  const relatedMissionIds = safeArray(opts.relatedMissionIds, 20);
  const maxPerBatch = Math.max(1, Math.min(10, Number(opts.maxPerBatch) || MAX_AI_SUGGESTED_TASKS_PER_TICK));
  const threshold = Math.max(0, Math.min(1, Number(opts.minConfidence) || MIN_CONFIDENCE));
  const now = nowMs();
  const store = readStore();
  const all = Array.isArray(store.suggestedTasks) ? store.suggestedTasks.slice() : [];
  const todayCount = countSuggestedTasksToday(all, now);
  if (todayCount >= MAX_AI_SUGGESTED_TASKS_PER_DAY) return { created: [], merged: [], discarded: ['daily_limit'] };

  const openByKey = new Map();
  all.forEach((row) => {
    const status = normalizeStatus(row.status);
    if (status === 'proposed' || status === 'accepted') openByKey.set(dedupeKey(row), row);
  });

  const created = [];
  const merged = [];
  const discarded = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    if (created.length >= maxPerBatch) break;
    const conf = normalizeConfidence(raw && raw.confidence);
    if (conf < threshold) {
      discarded.push('low_confidence');
      continue;
    }
    const normalized = normalizeSuggestedTask({
      ...raw,
      source: raw?.source || source,
      createdBy: raw?.createdBy || createdBy,
      relatedMissionIds: [
        ...safeArray(raw?.relatedMissionIds, 20),
        ...relatedMissionIds,
      ],
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
      activity: [`Proposed from ${source}`],
    });
    if (!normalized.title) {
      discarded.push('missing_title');
      continue;
    }
    const key = dedupeKey(normalized);
    const existing = openByKey.get(key);
    if (existing) {
      const patched = updateSuggestedTask(existing.id, {
        confidence: Math.max(existing.confidence, normalized.confidence),
        relatedMissionIds: normalized.relatedMissionIds,
        activity: [`Merged duplicate from ${source}`],
      });
      merged.push(patched);
      continue;
    }
    all.push(normalized);
    openByKey.set(key, normalized);
    created.push(normalized);
  }
  if (created.length) writeStore({ ...store, suggestedTasks: all });
  return { created, merged, discarded };
}

export function analyzeTeamActivityForSuggestedTasks(opts = {}) {
  const now = nowMs();
  const minIntervalMs = Math.max(30 * 60_000, Number(opts.minIntervalMs) || (3 * 60 * 60_000));
  const store = readStore();
  if (now - Number(store.analysis?.lastTeamScanAt || 0) < minIntervalMs) {
    return { skipped: 'interval', created: [], merged: [] };
  }
  const events = readTeamActivityWindow({ maxBytes: 1024 * 1024, maxEvents: 8000 });
  const since = now - (6 * 60 * 60_000);
  const recent = events.filter((e) => Number(e.ts) >= since);
  const blocked = recent.filter((e) => e.type === 'mission_tick_error' || e.type === 'delegation_error' || e.type === 'skill_error');
  const byMessage = new Map();
  blocked.forEach((e) => {
    const key = summarize(e.message || e.type, 120).toLowerCase();
    byMessage.set(key, (byMessage.get(key) || 0) + 1);
  });
  const repeated = Array.from(byMessage.entries()).filter(([, count]) => count >= 3).slice(0, 4);
  const candidates = repeated.map(([msg, count]) => ({
    title: `Reduce repeated failure: ${msg.slice(0, 50)}`,
    type: 'improvement',
    description: `Detected ${count} repeated failures in recent team activity. Consider shared mitigation.`,
    confidence: Math.min(0.95, 0.65 + (count * 0.05)),
    source: 'team_activity_analysis',
  }));
  const result = createSuggestedTasks(candidates, {
    source: 'team_activity_analysis',
    createdBy: 'main',
    minConfidence: 0.6,
    maxPerBatch: 3,
  });
  writeStore({
    ...readStore(),
    analysis: {
      ...(readStore().analysis || {}),
      lastTeamScanAt: now,
    },
  });
  return result;
}

function countAutoPromotionsForMissionToday(missionId, rows, now = nowMs()) {
  const gid = String(missionId || '').trim();
  if (!gid) return 0;
  const marker = `Auto-promoted to task in ${gid}`;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (Number(row.updatedAt) < startMs) return false;
    return (row.activity || []).some((line) => String(line).includes(marker));
  }).length;
}

function resolveActiveRelatedMissionId(suggestedTask, getMission) {
  const ids = Array.isArray(suggestedTask?.relatedMissionIds) ? suggestedTask.relatedMissionIds : [];
  for (const rawId of ids) {
    const missionId = String(rawId || '').trim();
    if (!missionId) continue;
    const mission = getMission(missionId);
    if (mission && String(mission.status || '').toLowerCase() === 'active') return missionId;
  }
  return '';
}

/** Promote an approved suggestedTask to a task on an existing mission (manual approval only). */
export async function promoteSuggestedTaskToTask(suggestedTask, missionId, opts = {}) {
  const { getMission, updateMission } = await import('./missions.js');
  const init = suggestedTask?.id ? suggestedTask : getSuggestedTask(String(suggestedTask || '').trim());
  const targetMissionId = String(missionId || '').trim();
  if (!init) throw new Error('SuggestedTask not found');
  if (!targetMissionId) throw new Error('missionId is required');

  const status = normalizeStatus(init.status);
  if (status === 'rejected') throw new Error('Cannot promote a rejected suggestedTask');
  if (status === 'completed') throw new Error('Cannot promote a completed suggestedTask');

  const mission = getMission(targetMissionId);
  if (!mission) throw new Error('Mission not found');

  const taskId = `init-${init.id}`;
  const tasks = Array.isArray(mission.tasks) ? mission.tasks.slice() : [];
  if (tasks.some((sg) => String(sg.id || '') === taskId)) {
    return { suggestedTask: init, mission, taskId, skipped: 'already_promoted' };
  }

  const nextTask = {
    id: taskId,
    title: init.title,
    status: 'todo',
    progress: 0,
    assignee: init.createdBy || mission.ownerAgentId || '',
    dependsOn: [],
    tasks: [],
  };
  if (init.description) nextTask.description = init.description;

  tasks.push(nextTask);
  const updatedMission = updateMission(mission.id, { tasks });
  const activityLine = opts.auto
    ? `Auto-promoted to task in ${mission.id}`
    : `Approved and added to mission ${mission.id}`;
  const updatedSuggestedTask = updateSuggestedTask(init.id, {
    status: 'accepted',
    relatedMissionIds: [mission.id],
    activity: [activityLine],
  });
  return { suggestedTask: updatedSuggestedTask, mission: updatedMission, taskId };
}

/**
 * Promote high-confidence proposed suggestedTasks to tasks on related active missions.
 * Disabled by default — suggestedTasks stay as proposals until a lead approves them.
 * Pass `{ enabled: true }` only when auto-promotion is explicitly desired.
 */
export async function autoPromoteSuggestedTasks(opts = {}) {
  if (opts.enabled !== true) {
    return { skipped: 'disabled', promoted: [], skippedItems: [] };
  }

  const now = nowMs();
  const minIntervalMs = Math.max(
    30 * 60_000,
    Math.min(60 * 60_000, Number(opts.minIntervalMs) || AUTO_PROMOTE_INTERVAL_MS),
  );
  const minAgeMs = Math.max(5 * 60_000, Number(opts.minAgeMs) || MIN_AUTO_PROMOTE_AGE_MS);
  const minConfidence = Math.max(
    AUTO_PROMOTE_MIN_CONFIDENCE,
    Number(opts.minConfidence) || AUTO_PROMOTE_MIN_CONFIDENCE,
  );
  const maxPerMissionPerDay = Math.max(
    1,
    Math.min(10, Number(opts.maxPerMissionPerDay) || MAX_AUTO_PROMOTIONS_PER_MISSION_PER_DAY),
  );

  const store = readStore();
  if (!opts.force && now - Number(store.analysis?.autoPromoteLastRunAt || 0) < minIntervalMs) {
    return { skipped: 'interval', promoted: [], skippedItems: [] };
  }

  const { getMission } = await import('./missions.js');
  const all = Array.isArray(store.suggestedTasks) ? store.suggestedTasks.slice() : [];
  const eligible = all
    .filter((init) => normalizeStatus(init.status) === 'proposed')
    .filter((init) => init.confidence >= minConfidence)
    .filter((init) => now - Number(init.createdAt) >= minAgeMs)
    .filter((init) => Array.isArray(init.relatedMissionIds) && init.relatedMissionIds.length > 0)
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);

  const promoted = [];
  const skippedItems = [];
  const batchCounts = new Map();
  const baselineCounts = new Map();

  for (const init of eligible) {
    const missionId = resolveActiveRelatedMissionId(init, getMission);
    if (!missionId) {
      skippedItems.push({ suggestedTaskId: init.id, reason: 'no_active_mission' });
      continue;
    }
    if (!baselineCounts.has(missionId)) {
      baselineCounts.set(missionId, countAutoPromotionsForMissionToday(missionId, all, now));
    }

    const baseline = Number(baselineCounts.get(missionId) || 0);
    const batchCount = Number(batchCounts.get(missionId) || 0);
    if (baseline + batchCount >= maxPerMissionPerDay) {
      skippedItems.push({ suggestedTaskId: init.id, missionId, reason: 'daily_limit' });
      continue;
    }

    try {
      const result = await promoteSuggestedTaskToTask(init, missionId, { auto: true });
      if (result.skipped) {
        skippedItems.push({ suggestedTaskId: init.id, missionId, reason: result.skipped });
        continue;
      }
      promoted.push({
        suggestedTaskId: init.id,
        missionId,
        taskId: result.taskId,
        title: init.title,
        confidence: init.confidence,
        createdBy: init.createdBy,
      });
      batchCounts.set(missionId, batchCount + 1);
      const idx = all.findIndex((row) => row.id === init.id);
      if (idx >= 0) all[idx] = result.suggestedTask;
    } catch (err) {
      skippedItems.push({
        suggestedTaskId: init.id,
        missionId,
        reason: summarize(err?.message || String(err), 120),
      });
    }
  }

  writeStore({
    ...readStore(),
    analysis: {
      ...(readStore().analysis || {}),
      autoPromoteLastRunAt: now,
    },
  });

  return { promoted, skippedItems };
}
