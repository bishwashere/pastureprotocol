#!/usr/bin/env node
import { mergeSubgoalTrees, createSubgoalsFromTick } from '../../lib/goals.js';

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

const createdBatch = createSubgoalsFromTick(flat, [
  { title: 'Review competitor pricing pages', description: 'Capture 3 examples', assignee: 'marketer', priority: 2, dueInHours: 24 },
  { title: 'Draft activation survey', description: '5-question survey for new users', assignee: 'main', priority: 3, dueInHours: 48 },
  { title: 'Define baseline', description: 'duplicate title', assignee: 'marketer', priority: 1, dueInHours: 12 },
  { title: 'Too many four', description: 'should be dropped by max limit', assignee: 'main', priority: 5, dueInHours: 12 },
], { defaultAssignee: 'main', maxNew: 3 });

assert(createdBatch.created.length === 3, `expected 3 created subgoals, got ${createdBatch.created.length}`);
assert(createdBatch.subgoals.length === 7, `expected 7 subgoals after insert, got ${createdBatch.subgoals.length}`);
assert(createdBatch.created[0].assignee === 'marketer', 'assignee preserved on created subgoal');
assert(createdBatch.created[0].dueInHours === 24, 'dueInHours preserved on created subgoal');

console.log('goals merge-subgoals tests passed');
