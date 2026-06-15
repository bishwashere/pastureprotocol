#!/usr/bin/env node
import {
  BLOCKER_TYPES,
  inferBlockerType,
  normalizeBlockerType,
  resolveBlockerType,
} from '../../lib/tasks.js';
import { mergeTaskTrees } from '../../lib/missions.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(inferBlockerType('Provide Stripe API key', '') === BLOCKER_TYPES.NEED_ACCESS, 'access inferred from title');
assert(inferBlockerType('Confirm launch plan', '') === BLOCKER_TYPES.NEED_APPROVAL, 'approval inferred from title');
assert(normalizeBlockerType('need_access') === BLOCKER_TYPES.NEED_ACCESS, 'valid blocker type preserved');
assert(normalizeBlockerType('bogus') === '', 'invalid blocker type rejected');

assert(
  resolveBlockerType({ title: 'Share MongoDB URI', blockerType: 'need_access' }) === BLOCKER_TYPES.NEED_ACCESS,
  'explicit blockerType wins',
);
assert(
  resolveBlockerType({ title: 'Provide analytics export', status: 'blocked' }) === BLOCKER_TYPES.NEED_ACCESS,
  'blockerType inferred when missing',
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

const inferredMerge = mergeTaskTrees(
  [{ id: 'sg-2', title: 'Upload brand assets', status: 'todo', progress: 0, tasks: [] }],
  [{ id: 'sg-2', title: 'Upload brand assets', status: 'blocked', progress: 0, tasks: [] }],
);
assert(inferredMerge[0].blockerType === BLOCKER_TYPES.NEED_CONTENT, `blockerType inferred on merge: ${inferredMerge[0].blockerType}`);

console.log('blocker-type tests passed');
