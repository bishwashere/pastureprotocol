export const TASK_LABELS = {
  AI_SUGGESTED: 'AI suggested',
  BLOCKER: 'blocker',
  DELEGATED: 'delegated',
};

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
