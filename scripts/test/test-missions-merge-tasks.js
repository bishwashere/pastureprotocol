#!/usr/bin/env node
import { mergeTaskTrees, createTasksFromTick } from '../../lib/context/missions.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const flat = [
  { id: 'sg-1', title: 'Define baseline', status: 'todo', progress: 0, assignee: 'marketer', tasks: [] },
  { id: 'sg-2', title: 'Instrument funnel', status: 'todo', progress: 0, assignee: 'marketer', tasks: [] },
  { id: 'sg-3', title: 'Audit signup flow', status: 'todo', progress: 0, assignee: 'marketer', tasks: [] },
  { id: 'sg-4', title: 'Landing page upgrade', status: 'todo', progress: 0, assignee: 'marketer', tasks: [] },
];

const nestedTick = [
  {
    id: 'research-phase',
    title: 'Research',
    status: 'doing',
    progress: 30,
    assignee: 'marketer',
    tasks: [
      { id: 'sg-2', title: 'Instrument funnel', status: 'doing', progress: 20, assignee: 'marketer', tasks: [] },
    ],
  },
];

const merged = mergeTaskTrees(flat, nestedTick);
assert(merged.length === 4, `expected 4 top-level tasks, got ${merged.length}`);
assert(merged[0].id === 'sg-1', 'sg-1 preserved');
assert(merged[1].status === 'doing', `sg-2 status patched: ${merged[1].status}`);
assert(merged[1].progress === 20, `sg-2 progress patched: ${merged[1].progress}`);

const createdBatch = createTasksFromTick(flat, [
  { title: 'Review competitor pricing pages', description: 'Capture 3 examples', assignee: 'marketer', priority: 2, dueInHours: 24 },
  { title: 'Draft activation survey', description: '5-question survey for new users', assignee: 'main', priority: 3, dueInHours: 48 },
  { title: 'Define baseline', description: 'duplicate title', assignee: 'marketer', priority: 1, dueInHours: 12 },
  { title: 'Too many four', description: 'should be dropped by max limit', assignee: 'main', priority: 5, dueInHours: 12 },
], { defaultAssignee: 'main', maxNew: 3 });

assert(createdBatch.created.length === 3, `expected 3 created tasks, got ${createdBatch.created.length}`);
assert(createdBatch.tasks.length === 7, `expected 7 tasks after insert, got ${createdBatch.tasks.length}`);
assert(createdBatch.created[0].assignee === 'marketer', 'assignee preserved on created task');
assert(createdBatch.created[0].dueInHours === 24, 'dueInHours preserved on created task');

console.log('missions merge-tasks tests passed');
