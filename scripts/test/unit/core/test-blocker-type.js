#!/usr/bin/env node
import {
  BLOCKER_TYPES,
  ensureTaskBlockerFields,
  formatBlockerTaskTitle,
  hasBlockerTitlePrefix,
  inferBlockerType,
  normalizeBlockerType,
  resolveBlockerType,
  stripBlockerTitlePrefix,
} from '../../../../lib/context/tasks.js';
import { mergeTaskTrees } from '../../../../lib/context/missions.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(inferBlockerType('Provide Stripe API key', '') === BLOCKER_TYPES.NEED_ACCESS, 'access inferred from title');
assert(inferBlockerType('Confirm launch plan', '') === BLOCKER_TYPES.NEED_APPROVAL, 'approval inferred from title');
assert(normalizeBlockerType('need_access') === BLOCKER_TYPES.NEED_ACCESS, 'valid blocker type preserved');
assert(normalizeBlockerType('bogus') === '', 'invalid blocker type rejected');

assert(
  formatBlockerTaskTitle('Stripe read-only key', BLOCKER_TYPES.NEED_ACCESS) === 'Need access: Stripe read-only key',
  'formats blocker title with prefix',
);
assert(
  formatBlockerTaskTitle('Need access: Stripe read-only key', BLOCKER_TYPES.NEED_ACCESS) === 'Need access: Stripe read-only key',
  'blocker title prefix is idempotent',
);
assert(
  stripBlockerTitlePrefix('Need content: Upload brand assets') === 'Upload brand assets',
  'strips blocker title prefix',
);
assert(hasBlockerTitlePrefix('Need direction: Pick analytics tool'), 'detects blocker title prefix');

const ensured = ensureTaskBlockerFields({
  title: 'Provide PostHog access',
  status: 'blocked',
});
assert(ensured.blockerType === BLOCKER_TYPES.NEED_ACCESS, `blockerType set: ${ensured.blockerType}`);
assert(
  ensured.title === 'Need access: Provide PostHog access',
  `blocker title prefixed: ${ensured.title}`,
);

assert(
  resolveBlockerType({ title: 'Share MongoDB URI', blockerType: 'need_access' }) === BLOCKER_TYPES.NEED_ACCESS,
  'explicit blockerType wins',
);

const flat = [
  { id: 'sg-1', title: 'Provide PostHog access', status: 'todo', progress: 0, assignee: 'marketer', tasks: [] },
];

const tickUpdate = [
  {
    id: 'sg-1',
    title: 'Provide PostHog access',
    status: 'blocked',
    progress: 0,
    assignee: 'marketer',
    blockerType: 'need_access',
    tasks: [],
  },
];

const merged = mergeTaskTrees(flat, tickUpdate);
assert(merged[0].status === 'blocked', 'blocked status patched');
assert(merged[0].blockerType === BLOCKER_TYPES.NEED_ACCESS, `blockerType preserved after merge: ${merged[0].blockerType}`);
assert(
  merged[0].title === 'Need access: Provide PostHog access',
  `blocker title prefixed after merge: ${merged[0].title}`,
);

const inferredMerge = mergeTaskTrees(
  [{ id: 'sg-2', title: 'Upload brand assets', status: 'todo', progress: 0, tasks: [] }],
  [{ id: 'sg-2', title: 'Upload brand assets', status: 'blocked', progress: 0, tasks: [] }],
);
assert(inferredMerge[0].blockerType === BLOCKER_TYPES.NEED_CONTENT, `blockerType inferred on merge: ${inferredMerge[0].blockerType}`);
assert(
  inferredMerge[0].title === 'Need content: Upload brand assets',
  `blocker title inferred on merge: ${inferredMerge[0].title}`,
);

console.log('blocker-type tests passed');
