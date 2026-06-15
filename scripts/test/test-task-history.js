#!/usr/bin/env node
import {
  appendAssumptionHistory,
  applyTaskPatchHistory,
  createInitialTaskHistory,
  formatTaskHistoryLabel,
  normalizeTaskHistory,
  TASK_HISTORY_KIND,
} from '../../lib/task-history.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const delegated = createInitialTaskHistory({
  id: 'sg-1',
  title: 'Audit signup flow',
  status: 'assigned',
  assignee: 'marketer',
  delegatedFrom: 'main',
  source: 'delegation',
  expectedOutput: 'Signup audit report',
}, { actor: 'main' });
assert(Array.isArray(delegated.taskHistory) && delegated.taskHistory.length === 1, 'delegation creates history');
assert(delegated.taskHistory[0].kind === TASK_HISTORY_KIND.DELEGATED, 'delegated kind');

const updated = applyTaskPatchHistory(delegated, {
  ...delegated,
  status: 'in_progress',
  progress: 40,
}, {
  actor: 'marketer',
  ts: Date.now(),
});
assert(updated.taskHistory.length >= 2, 'status/progress patch adds history');
assert(
  updated.taskHistory.some((row) => row.kind === TASK_HISTORY_KIND.STATUS_CHANGED),
  'status change recorded',
);

const withAssumption = appendAssumptionHistory({
  id: 'sg-2',
  title: 'Need direction: Define MVP',
  status: 'todo',
  blockerHistory: {
    wasBlocker: true,
    originalBlockerType: 'need_direction',
    originalTitle: 'Need direction: Define MVP',
    originalStatus: 'in_progress',
  },
  assumptionRecord: {
    status: 'applied',
    appliedAt: Date.now(),
    summary: 'MVP inferred from live product',
    collectedEvidence: ['Play button on homepage'],
    assumptions: [{ item: 'Online chess play', confidence: 0.9 }],
  },
});
assert(
  withAssumption.taskHistory.some((row) => row.kind === TASK_HISTORY_KIND.BLOCKER_CONVERTED),
  'blocker conversion in task history',
);
assert(
  withAssumption.taskHistory.some((row) => row.kind === TASK_HISTORY_KIND.ASSUMPTION),
  'assumption in task history',
);

const label = formatTaskHistoryLabel({
  kind: 'delegated',
  actor: 'main',
  target: 'marketer',
  outcome: 'Delegated "Audit signup flow"',
});
assert(label.includes('main') && label.includes('marketer'), `label: ${label}`);

assert(normalizeTaskHistory([{ kind: 'note', outcome: 'test' }, null, { kind: 'bogus' }]).length >= 1, 'normalize filters');

console.log('task-history tests passed');
