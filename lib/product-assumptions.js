/**
 * Blockers are always created and stay documented. Assumption is a separate LAST
 * phase: inspect a live product URL, record collected evidence, apply assumptions
 * to matching blockers, and keep the audit trail on each task (assumptionRecord).
 */

import { listProjects } from './projects-db.js';
import {
  BLOCKER_TYPES,
  resolveBlockerType,
  stripBlockerTitlePrefix,
} from './tasks.js';

const PRODUCT_SPEC_RE = /\b(product spec|mvp|feature set|ruleset|gameplay|core features?|product definition|define the product|what .+ is|clarify what|platform|target users?)\b/i;

export const ASSUMPTION_STATUS = {
  PENDING: 'pending',
  APPLIED: 'applied',
  FAILED: 'failed',
};

function summarize(text, max = 400) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function isLiveProductUrl(url = '') {
  const u = String(url || '').trim();
  return /^https?:\/\//i.test(u);
}

export function resolveProjectContextForMission(mission = {}) {
  let project = null;
  try {
    const projects = listProjects();
    const pid = Number(mission?.projectId);
    if (Number.isFinite(pid) && pid > 0) {
      project = projects.find((p) => Number(p.id) === pid) || null;
    }
    if (!project) {
      const blob = `${mission.title || ''} ${mission.objective || ''}`.toLowerCase();
      project = projects.find((p) => {
        const n = String(p.name || '').trim().toLowerCase();
        return n.length >= 3 && blob.includes(n);
      }) || null;
    }
  } catch (_) {
    project = null;
  }
  const projectUrl = String(project?.url || '').trim();
  return {
    project,
    projectUrl,
    projectName: String(project?.name || '').trim(),
    projectDescription: String(project?.description || '').trim(),
    hasLiveProduct: isLiveProductUrl(projectUrl),
  };
}

export function isProductSpecDirectionBlocker(task = {}) {
  if (resolveBlockerType(task) !== BLOCKER_TYPES.NEED_DIRECTION) return false;
  const title = stripBlockerTitlePrefix(task.title || task.name || '');
  const hay = `${title} ${task.description || ''} ${task.expectedOutput || task.expected_output || ''}`;
  return PRODUCT_SPEC_RE.test(hay);
}

export function canAssumeFromLiveProduct(task = {}, projectContext = {}) {
  const url = String(projectContext.projectUrl || '').trim();
  if (!isLiveProductUrl(url)) return false;
  return isProductSpecDirectionBlocker(task);
}

export function flattenMissionTasks(tasks = []) {
  const out = [];
  function walk(list) {
    (list || []).forEach((task) => {
      if (!task || typeof task !== 'object') return;
      out.push(task);
      walk(task.tasks);
    });
  }
  walk(tasks);
  return out;
}

export function getTaskAssumptionRecord(task = {}) {
  const raw = task.assumptionRecord;
  return raw && typeof raw === 'object' ? raw : null;
}

export function hasAppliedAssumption(task = {}) {
  const record = getTaskAssumptionRecord(task);
  return String(record?.status || '').toLowerCase() === ASSUMPTION_STATUS.APPLIED;
}

export function normalizeAssumptionRecord(input = {}, defaults = {}) {
  if (!input || typeof input !== 'object') return null;
  const statusRaw = String(input.status || defaults.status || ASSUMPTION_STATUS.APPLIED).toLowerCase();
  const status = [ASSUMPTION_STATUS.PENDING, ASSUMPTION_STATUS.APPLIED, ASSUMPTION_STATUS.FAILED].includes(statusRaw)
    ? statusRaw
    : ASSUMPTION_STATUS.APPLIED;
  const collectedEvidence = Array.isArray(input.collectedEvidence)
    ? input.collectedEvidence.map((line) => summarize(line, 240)).filter(Boolean).slice(0, 12)
    : [];
  const assumptions = Array.isArray(input.assumptions)
    ? input.assumptions.map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = summarize(row.item || row.title || row.text || '', 240);
      if (!item) return null;
      const out = { item };
      const rationale = summarize(row.rationale || row.reason || '', 320);
      if (rationale) out.rationale = rationale;
      const confidence = Number(row.confidence);
      if (Number.isFinite(confidence)) out.confidence = Math.max(0, Math.min(1, confidence));
      return out;
    }).filter(Boolean).slice(0, 20)
    : [];
  const summary = summarize(input.summary || input.assumedAnswer || '', 600);
  const sourceUrl = summarize(input.sourceUrl || defaults.sourceUrl || '', 240);
  const method = summarize(input.method || defaults.method || 'live_product_browse', 80);
  const appliedAtRaw = Number(input.appliedAt || defaults.appliedAt || Date.now());
  const appliedAt = Number.isFinite(appliedAtRaw) && appliedAtRaw > 0 ? Math.floor(appliedAtRaw) : Date.now();
  if (!summary && !assumptions.length && !collectedEvidence.length) return null;
  return {
    status,
    appliedAt,
    sourceUrl,
    method,
    summary,
    collectedEvidence,
    assumptions,
  };
}

export function listAssumableBlockerTasks(tasks = [], projectContext = {}) {
  if (!projectContext.hasLiveProduct && !isLiveProductUrl(projectContext.projectUrl)) return [];
  return flattenMissionTasks(tasks).filter((task) => canAssumeFromLiveProduct(task, projectContext));
}

export function listAssumptionPendingBlockers(tasks = [], projectContext = {}) {
  return listAssumableBlockerTasks(tasks, projectContext).filter((task) => !hasAppliedAssumption(task));
}

/** Blocker candidates stay visible even when assumption phase can resolve them. */
export function isBlockerCandidateTask(task = {}) {
  if (!task || typeof task !== 'object') return false;
  const status = String(task.status || '').toLowerCase();
  if (status === 'done') return false;
  if (resolveBlockerType(task) === BLOCKER_TYPES.SYSTEM_ERROR) return false;
  if (status === 'blocked') return true;
  if (status === 'waiting_user') return true;
  const bt = resolveBlockerType(task);
  return bt === BLOCKER_TYPES.NEED_DIRECTION
    || bt === BLOCKER_TYPES.NEED_ACCESS
    || bt === BLOCKER_TYPES.NEED_CONTENT
    || bt === BLOCKER_TYPES.NEED_APPROVAL;
}

export function summarizeAssumptionForDisplay(task = {}) {
  const record = getTaskAssumptionRecord(task);
  if (!record) return '';
  if (String(record.status || '').toLowerCase() !== ASSUMPTION_STATUS.APPLIED) {
    return 'assumption pending';
  }
  const parts = [];
  if (record.sourceUrl) parts.push(`from ${record.sourceUrl}`);
  if (record.summary) parts.push(record.summary);
  else if (Array.isArray(record.assumptions) && record.assumptions.length) {
    parts.push(`${record.assumptions.length} assumed item(s)`);
  }
  if (Array.isArray(record.collectedEvidence) && record.collectedEvidence.length) {
    parts.push(`evidence: ${record.collectedEvidence.slice(0, 2).join('; ')}`);
  }
  return parts.join(' · ');
}

export function formatMissionBlockersForPrompt(mission = {}, projectContext = null) {
  const ctx = projectContext || resolveProjectContextForMission(mission);
  const blockers = flattenMissionTasks(mission.tasks || []).filter(isBlockerCandidateTask);
  if (!blockers.length) return 'Blockers: none.';
  const lines = blockers.map((task) => {
    const title = String(task.title || '').trim();
    const bt = resolveBlockerType(task);
    const status = String(task.status || 'todo').toLowerCase();
    const assumption = summarizeAssumptionForDisplay(task);
    const pending = canAssumeFromLiveProduct(task, ctx) && !hasAppliedAssumption(task);
    const tags = [];
    if (assumption) tags.push(`assumption: ${assumption}`);
    else if (pending) tags.push('assumption phase: pending (live product may resolve)');
    tags.push(`status: ${status}`);
    tags.push(`type: ${bt}`);
    return `- ${title} (${task.id || 'no-id'}) — ${tags.join(' | ')}`;
  });
  return `Blockers (${blockers.length} — always list these when asked; assumptions do not erase them):\n${lines.join('\n')}`;
}

export function applyAssumptionUpdates(tasks = [], updates = [], projectContext = {}) {
  if (!Array.isArray(tasks) || !tasks.length || !Array.isArray(updates) || !updates.length) {
    return tasks;
  }
  const byId = new Map();
  updates.forEach((row) => {
    const id = String(row?.taskId || row?.id || '').trim();
    if (id) byId.set(id, row);
  });
  if (!byId.size) return tasks;

  function walk(list) {
    return (list || []).map((task) => {
      const next = { ...task };
      const upd = byId.get(String(task.id || '').trim());
      if (upd) {
        const record = normalizeAssumptionRecord(upd.assumptionRecord || upd, {
          sourceUrl: projectContext.projectUrl,
          appliedAt: Date.now(),
          status: ASSUMPTION_STATUS.APPLIED,
        });
        if (record) next.assumptionRecord = record;
        if (upd.description) next.description = summarize(upd.description, 400);
        if (upd.expectedOutput || upd.expected_output) {
          next.expectedOutput = summarize(upd.expectedOutput || upd.expected_output, 400);
        }
        if (upd.status) next.status = String(upd.status).trim().toLowerCase();
        if (Number.isFinite(Number(upd.progress))) {
          next.progress = Math.max(0, Math.min(100, Math.round(Number(upd.progress))));
        }
      }
      if (Array.isArray(next.tasks) && next.tasks.length) next.tasks = walk(next.tasks);
      return next;
    });
  }

  return walk(tasks);
}

export function formatAssumptionPhasePromptBlock(mission = {}, projectContext = {}, pendingTasks = []) {
  const ctx = projectContext?.hasLiveProduct
    ? projectContext
    : resolveProjectContextForMission(mission);
  const tasks = pendingTasks?.length
    ? pendingTasks
    : listAssumptionPendingBlockers(mission.tasks || [], ctx);
  if (!ctx.hasLiveProduct || !tasks.length) return '';

  const taskLines = tasks.slice(0, 6).map((t) => {
    const title = stripBlockerTitlePrefix(t.title || 'Untitled task');
    const id = String(t.id || '').trim();
    return `- ${title}${id ? ` (${id})` : ''}`;
  });

  return [
    '',
    '10) Assumption phase (LAST — run after sections 1-9)',
    '- Blockers already exist in the task tree and MUST stay documented. Never delete or skip creating them.',
    '- This phase inspects the live product and tries to resolve eligible product-spec blockers with evidence-backed assumptions.',
    `- Live product URL: ${ctx.projectUrl}`,
    'Eligible blockers (assumption still pending):',
    taskLines.join('\n'),
    '',
    'Required for each eligible blocker you can resolve this tick:',
    '1. Browse/read the live URL and record collectedEvidence (concrete observations, page names, flows, visible features).',
    '2. Return assumptionUpdates with taskId, assumptionRecord { status:"applied", sourceUrl, method, collectedEvidence[], assumptions[{item,rationale,confidence}], summary }.',
    '3. Keep the original blocker title/blockerType on the task — assumptions augment the blocker; they do not remove it.',
    '4. Optionally advance task status/progress/description after applying the assumption.',
    '5. Append a short assumption audit line to learnings/decisions for mission memory.',
    '6. If evidence is insufficient, leave the blocker unchanged — do not fabricate assumptions.',
  ].join('\n');
}

/** @deprecated use formatAssumptionPhasePromptBlock */
export function formatLiveProductAssumptionPromptBlock(mission, projectContext, assumableTasks) {
  return formatAssumptionPhasePromptBlock(mission, projectContext, assumableTasks);
}

export function countAssumptionPhaseSummary(tasks = [], projectContext = {}) {
  const assumable = listAssumableBlockerTasks(tasks, projectContext);
  const pending = assumable.filter((task) => !hasAppliedAssumption(task));
  const applied = assumable.filter((task) => hasAppliedAssumption(task));
  return {
    assumable: assumable.length,
    pending: pending.length,
    applied: applied.length,
  };
}
