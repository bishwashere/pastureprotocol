#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCompletedTasksDisplay() {
  const code = readFileSync(
    join(__dirname, '../../dashboard/public/assets/js/completed-tasks-display.js'),
    'utf8',
  );
  const sandbox = { globalThis: {} };
  sandbox.globalThis.window = sandbox.globalThis;
  // eslint-disable-next-line no-new-func
  new Function('globalThis', code + '\nreturn globalThis.pastureCompletedTasks;')(sandbox.globalThis);
  return sandbox.globalThis.pastureCompletedTasks;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const api = loadCompletedTasksDisplay();
const { consolidateCompletedTasks, normalizeCompletedTaskPrompt } = api;

assert(
  normalizeCompletedTaskPrompt('[Retry with tools] The user asked: "Check NextPostAI growth". Use available tools.') === 'check nextpostai growth',
  'normalize retry prompt',
);

const t0 = Date.now() - 120000;
const merged = consolidateCompletedTasks([
  {
    id: '1',
    agentId: 'main',
    ts: t0,
    prompt: 'Check NextPostAI growth',
    summary: 'Handled in 1200ms using 0 skills.',
    skillCount: 0,
  },
  {
    id: '2',
    agentId: 'main',
    ts: t0 + 90000,
    prompt: 'Check NextPostAI growth',
    summary: 'Handled in 18920ms using 4 skills.',
    skillCount: 4,
  },
]);

assert(merged.length === 1, `expected 1 consolidated task, got ${merged.length}`);
assert(merged[0].skillCount === 4, `expected 4 skills, got ${merged[0].skillCount}`);
assert(merged[0].prompt === 'Check NextPostAI growth', 'keeps user prompt');
assert(merged[0].ts === t0 + 90000, 'uses latest timestamp');

const separate = consolidateCompletedTasks([
  {
    id: '1',
    agentId: 'main',
    ts: t0,
    prompt: 'Check NextPostAI growth',
    summary: 'Handled in 1200ms using 0 skills.',
    skillCount: 0,
  },
  {
    id: '2',
    agentId: 'main',
    ts: t0 + 2 * 60 * 60 * 1000,
    prompt: 'Check NextPostAI growth',
    summary: 'Handled in 8000ms using 2 skills.',
    skillCount: 2,
  },
]);

assert(separate.length === 2, 'tasks far apart stay separate');

console.log('completed-tasks-consolidate tests passed');
