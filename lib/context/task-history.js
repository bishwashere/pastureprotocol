/**
 * Lightweight audit trail stored on each mission task (taskHistory[]).
 * Complements team activity logs with task-scoped, queryable events:
 * delegation, assignment, status changes, outcomes, assumption conversions.
 */

const MAX_TASK_HISTORY = 24;

function summarize(text, max = 320) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const TASK_HISTORY_KIND = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  DELEGATED: 'delegated',
  STATUS_CHANGED: 'status_changed',
  PROGRESS: 'progress_updated',
  REPLY: 'reply_received',
  ASSUMPTION: 'assumption_applied',
  BLOCKER_CONVERTED: 'blocker_converted',
  NOTE: 'note',
};

const VALID_KINDS = new Set(Object.values(TASK_HISTORY_KIND));

export function normalizeTaskHistoryEntry(entry = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const kindRaw = String(entry.kind || entry.type || TASK_HISTORY_KIND.NOTE).toLowerCase();
  const kind = VALID_KINDS.has(kindRaw) ? kindRaw : TASK_HISTORY_KIND.NOTE;
  const tsRaw = Number(entry.ts || entry.at);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : Date.now();
  const out = {
    ts,
    kind,
    actor: summarize(entry.actor || entry.agentId || entry.by || '', 80),
    target: summarize(entry.target || entry.assignee || entry.to || '', 80),
    fromStatus: summarize(entry.fromStatus || entry.from || '', 40),
    toStatus: summarize(entry.toStatus || entry.to || '', 40),
    outcome: summarize(entry.outcome || entry.summary || entry.note || '', 320),
    detail: summarize(entry.detail || '', 400),
  };
  if (!out.outcome && !out.detail && kind === TASK_HISTORY_KIND.NOTE) return null;
  return out;
}

export function normalizeTaskHistory(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => normalizeTaskHistoryEntry(row))
    .filter(Boolean)
    .slice(-MAX_TASK_HISTORY);
}

export function formatTaskHistoryLabel(entry = {}) {
  const row = normalizeTaskHistoryEntry(entry);
  if (!row) return '';
  const parts = [];
  if (row.kind === TASK_HISTORY_KIND.DELEGATED) {
    parts.push(row.actor && row.target ? `${row.actor} → ${row.target}` : 'Delegated');
  } else if (row.kind === TASK_HISTORY_KIND.ASSIGNED) {
    parts.push(row.target ? `Assigned to ${row.target}` : 'Assigned');
  } else if (row.kind === TASK_HISTORY_KIND.STATUS_CHANGED) {
    parts.push(row.fromStatus && row.toStatus
      ? `${row.fromStatus} → ${row.toStatus}`
      : (row.toStatus ? `Status: ${row.toStatus}` : 'Status updated'));
  } else if (row.kind === TASK_HISTORY_KIND.PROGRESS) {
    parts.push(row.outcome || 'Progress updated');
  } else if (row.kind === TASK_HISTORY_KIND.ASSUMPTION) {
    parts.push('Assumption applied');
  } else if (row.kind === TASK_HISTORY_KIND.BLOCKER_CONVERTED) {
    parts.push('Blocker converted to open work');
  } else if (row.kind === TASK_HISTORY_KIND.REPLY) {
    parts.push(row.actor ? `Reply from ${row.actor}` : 'Reply received');
  } else if (row.kind === TASK_HISTORY_KIND.CREATED) {
    parts.push('Created');
  } else {
    parts.push(row.outcome || row.kind.replace(/_/g, ' '));
  }
  if (row.outcome && !parts.includes(row.outcome) && row.kind !== TASK_HISTORY_KIND.PROGRESS) {
    parts.push(row.outcome);
  }
  return parts.filter(Boolean).join(' · ');
}

export function appendTaskHistory(task = {}, entry = {}, opts = {}) {
  if (!task || typeof task !== 'object') return task;
  const normalized = normalizeTaskHistoryEntry(entry);
  if (!normalized) return task;
  const max = Math.max(5, Math.min(MAX_TASK_HISTORY, Number(opts.max) || MAX_TASK_HISTORY));
  const prev = normalizeTaskHistory(task.taskHistory || task.task_history || []);
  const last = prev[prev.length - 1];
  if (last
    && last.kind === normalized.kind
    && last.outcome === normalized.outcome
    && last.toStatus === normalized.toStatus
    && Math.abs(last.ts - normalized.ts) < 3000) {
    return task;
  }
  return { ...task, taskHistory: [...prev, normalized].slice(-max) };
}

export function recordTaskPatchHistory(before = {}, after = {}, meta = {}) {
  const entries = [];
  const ts = Number(meta.ts) || Date.now();
  const actor = summarize(meta.actor || meta.agentId || after.assignee || before.assignee || '', 80);
  const prevStatus = String(before.status || '').toLowerCase();
  const newStatus = String(after.status || '').toLowerCase();
  if (newStatus && prevStatus && prevStatus !== newStatus) {
    entries.push({
      ts,
      kind: TASK_HISTORY_KIND.STATUS_CHANGED,
      actor,
      fromStatus: prevStatus,
      toStatus: newStatus,
      outcome: summarize(meta.outcome || meta.note || `Status ${prevStatus} → ${newStatus}`, 320),
    });
  }
  const prevAssignee = String(before.assignee || '').trim();
  const newAssignee = String(after.assignee || '').trim();
  if (newAssignee && prevAssignee !== newAssignee) {
    entries.push({
      ts,
      kind: meta.delegated ? TASK_HISTORY_KIND.DELEGATED : TASK_HISTORY_KIND.ASSIGNED,
      actor: summarize(meta.delegatedFrom || meta.actor || prevAssignee || '', 80),
      target: newAssignee,
      outcome: prevAssignee
        ? `Passed from ${prevAssignee} to ${newAssignee}`
        : `Assigned to ${newAssignee}`,
      detail: summarize(meta.detail || '', 400),
    });
  }
  const prevProgress = Number(before.progress);
  const newProgress = Number(after.progress);
  if (Number.isFinite(newProgress) && Number.isFinite(prevProgress)
    && newProgress !== prevProgress
    && Math.abs(newProgress - prevProgress) >= 5) {
    entries.push({
      ts,
      kind: TASK_HISTORY_KIND.PROGRESS,
      actor,
      outcome: `Progress ${prevProgress}% → ${newProgress}%`,
    });
  }
  if (meta.reply) {
    entries.push({
      ts,
      kind: TASK_HISTORY_KIND.REPLY,
      actor,
      outcome: summarize(meta.reply, 320),
      detail: summarize(meta.replyDetail || '', 400),
    });
  }
  if (meta.note && !meta.outcome) {
    entries.push({
      ts,
      kind: TASK_HISTORY_KIND.NOTE,
      actor,
      outcome: summarize(meta.note, 320),
    });
  }
  return entries;
}

export function applyTaskPatchHistory(before = {}, after = {}, meta = {}) {
  const entries = recordTaskPatchHistory(before, after, meta);
  let next = { ...after };
  entries.forEach((entry) => {
    next = appendTaskHistory(next, entry);
  });
  if (Array.isArray(meta.extraEntries)) {
    meta.extraEntries.forEach((entry) => {
      next = appendTaskHistory(next, entry);
    });
  }
  return next;
}

export function appendAssumptionHistory(task = {}, { assumptionRecord, blockerHistory } = {}) {
  const record = assumptionRecord || task.assumptionRecord;
  if (!record) return task;
  const ts = Number(record.appliedAt) || Date.now();
  let next = appendTaskHistory(task, {
    ts,
    kind: TASK_HISTORY_KIND.ASSUMPTION,
    outcome: summarize(record.summary || 'Assumption applied from live product', 320),
    detail: Array.isArray(record.collectedEvidence) ? record.collectedEvidence.slice(0, 3).join('; ') : '',
  });
  if (blockerHistory?.wasBlocker || task.blockerHistory?.wasBlocker) {
    const history = blockerHistory || task.blockerHistory;
    next = appendTaskHistory(next, {
      ts,
      kind: TASK_HISTORY_KIND.BLOCKER_CONVERTED,
      fromStatus: history.originalStatus || '',
      toStatus: String(task.status || 'todo'),
      outcome: `Was ${history.originalBlockerType || 'blocker'}: ${summarize(history.originalTitle || task.title, 120)}`,
      detail: summarize(record.summary || '', 320),
    });
  }
  return next;
}

export function createInitialTaskHistory(task = {}, meta = {}) {
  const ts = Number(task.createdAt || task.delegatedAt || meta.ts) || Date.now();
  if (task.source === 'delegation' || task.delegatedFrom) {
    return appendTaskHistory(task, {
      ts,
      kind: TASK_HISTORY_KIND.DELEGATED,
      actor: task.delegatedFrom || meta.actor || '',
      target: task.assignee || '',
      outcome: `Delegated "${summarize(task.title, 120)}"`,
      detail: summarize(task.expectedOutput || task.description || '', 400),
    });
  }
  return appendTaskHistory(task, {
    ts,
    kind: TASK_HISTORY_KIND.CREATED,
    actor: meta.actor || task.assignee || '',
    outcome: `Created "${summarize(task.title, 120)}"`,
  });
}

export function listTasksWithHistory(tasks = [], filter = {}) {
  const flat = [];
  function walk(list) {
    (list || []).forEach((task) => {
      if (!task) return;
      flat.push(task);
      walk(task.tasks);
    });
  }
  walk(tasks);
  return flat.filter((task) => {
    const history = normalizeTaskHistory(task.taskHistory || []);
    if (!history.length) return false;
    if (filter.kind) return history.some((row) => row.kind === filter.kind);
    return true;
  });
}

export function formatTaskHistoryForPrompt(task = {}) {
  const rows = normalizeTaskHistory(task.taskHistory || []);
  if (!rows.length) return '';
  return rows.slice(-6).map((row) => {
    const when = new Date(row.ts).toISOString();
    return `  · ${when} — ${formatTaskHistoryLabel(row)}`;
  }).join('\n');
}
