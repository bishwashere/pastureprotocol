export const TASK_LABELS = {
  AI_SUGGESTED: 'AI suggested',
  BLOCKER: 'blocker',
  DELEGATED: 'delegated',
};

/**
 * Machine-readable sub-type for blocked tasks.
 *
 * need_direction  – A strategic/product decision only the owner can make.
 * need_access     – Missing credentials, API keys, tool or data access.
 * need_content    – User must supply specific assets, copy, or data exports.
 * need_approval   – Agent finished a draft/plan; needs sign-off before proceeding.
 * system_error    – Rate-limit, quota, or infrastructure failure — auto-retries;
 *                   NEVER shown to the user as an actionable blocker.
 */
export const BLOCKER_TYPES = {
  NEED_DIRECTION: 'need_direction',
  NEED_ACCESS: 'need_access',
  NEED_CONTENT: 'need_content',
  NEED_APPROVAL: 'need_approval',
  SYSTEM_ERROR: 'system_error',
};

/** Human-readable prefix displayed in task titles for each blocker type. */
export const BLOCKER_TYPE_PREFIX = {
  need_direction: 'Need direction',
  need_access: 'Need access',
  need_content: 'Need content',
  need_approval: 'Need approval',
  system_error: 'System error',
};

/**
 * Infer a blockerType from a task title + description when the field is absent.
 * Returns one of the BLOCKER_TYPES values, defaulting to need_direction.
 */
export function inferBlockerType(title = '', description = '') {
  const hay = (title + ' ' + description).toLowerCase();
  if (/\b(rate.?limit|quota|llm.?limit|daily.?limit|resets at|try again in|api.?limit|request.?limit|ENOENT|spawn|segfault|binary|not installed|runtime.?broken|cannot find module|playwright|chromium)\b/.test(hay)) {
    return BLOCKER_TYPES.SYSTEM_ERROR;
  }
  if (/\b(access|credential|api.?key|token|oauth|secret|password|uri|url|database|warehouse|crm|analytics|billing|stripe|hubspot|salesforce|posthog|ga4|mixpanel|shopify|export|share.*data|read.?only|permission)\b/.test(hay)) {
    return BLOCKER_TYPES.NEED_ACCESS;
  }
  if (/\b(provide|supply|upload|send.*file|brand|logo|copy|asset|content|archive|feedback|transcript|recording|export|notes|interview|survey|media)\b/.test(hay)) {
    return BLOCKER_TYPES.NEED_CONTENT;
  }
  if (/\b(approve|approval|review|sign.?off|confirm.*plan|confirm.*draft|verify.*draft|proceed after|before.*launch)\b/.test(hay)) {
    return BLOCKER_TYPES.NEED_APPROVAL;
  }
  return BLOCKER_TYPES.NEED_DIRECTION;
}

const VALID_BLOCKER_TYPES = new Set(Object.values(BLOCKER_TYPES));

/** Return a valid blockerType slug, or empty string when invalid/absent. */
export function normalizeBlockerType(value) {
  const s = String(value || '').trim().toLowerCase();
  return VALID_BLOCKER_TYPES.has(s) ? s : '';
}

/** Resolve blockerType from explicit field or infer from title/description. */
export function resolveBlockerType(task = {}) {
  const explicit = normalizeBlockerType(task.blockerType);
  if (explicit) return explicit;
  const title = task.title || task.name || '';
  const description = task.description || task.expectedOutput || task.expected_output || '';
  return inferBlockerType(title, description);
}

/** Ensure blocked tasks always carry a blockerType. */
export function ensureTaskBlockerFields(task = {}) {
  if (!task || typeof task !== 'object') return task;
  const status = String(task.status || '').toLowerCase();
  const labels = Array.isArray(task.labels) ? task.labels.map((l) => String(l).toLowerCase()) : [];
  const isBlocked = status === 'blocked' || labels.includes(TASK_LABELS.BLOCKER.toLowerCase());
  if (!isBlocked) return task;
  const blockerType = resolveBlockerType(task);
  return blockerType === task.blockerType ? task : { ...task, blockerType };
}

function cleanLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeTaskLabels(input = {}) {
  const labels = [];
  const add = (label) => {
    const clean = cleanLabel(label);
    if (clean && !labels.includes(clean)) labels.push(clean);
  };

  if (Array.isArray(input.labels)) input.labels.forEach(add);
  const source = String(input.source || '').trim().toLowerCase();
  const id = String(input.id || '').trim().toLowerCase();
  const status = String(input.status || '').trim().toLowerCase();

  if (source === 'delegation' || input.delegationId || input.delegatedFrom) add(TASK_LABELS.DELEGATED);
  if (source === 'ai_suggested' || source === 'suggestedtask' || id.startsWith('init-')) add(TASK_LABELS.AI_SUGGESTED);
  if (status === 'blocked' || input.blocked === true) add(TASK_LABELS.BLOCKER);

  return labels;
}

export function addTaskLabel(task = {}, label) {
  return {
    ...task,
    labels: normalizeTaskLabels({ ...task, labels: [...(Array.isArray(task.labels) ? task.labels : []), label] }),
  };
}
