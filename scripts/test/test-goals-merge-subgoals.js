#!/usr/bin/env node
import { mergeSubgoalTrees } from '../../lib/goals.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const flat = [
  { id: 'sg-1', title: 'Define baseline', status: 'todo', progress: 0, assignee: 'marketer', subgoals: [] },
  { id: 'sg-2', title: 'Instrument funnel', status: 'todo', progress: 0, assignee: 'marketer', subgoals: [] },
  { id: 'sg-3', title: 'Audit signup flow', status: 'todo', progress: 0, assignee: 'marketer', subgoals: [] },
  { id: 'sg-4', title: 'Landing page upgrade', status: 'todo', progress: 0, assignee: 'marketer', subgoals: [] },
];

const nestedTick = [
  {
    id: 'research-phase',
    title: 'Research',
    status: 'doing',
    progress: 30,
    assignee: 'marketer',
    subgoals: [
      { id: 'sg-2', title: 'Instrument funnel', status: 'doing', progress: 20, assignee: 'marketer', subgoals: [] },
    ],
  },
];

const merged = mergeSubgoalTrees(flat, nestedTick);
assert(merged.length === 4, `expected 4 top-level tasks, got ${merged.length}`);
assert(merged[0].id === 'sg-1', 'sg-1 preserved');
assert(merged[1].status === 'doing', `sg-2 status patched: ${merged[1].status}`);
assert(merged[1].progress === 20, `sg-2 progress patched: ${merged[1].progress}`);

console.log('goals merge-subgoals tests passed');
