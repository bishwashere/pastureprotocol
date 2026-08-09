#!/usr/bin/env node

import { runNamedFakeE2E } from '../fake-app-e2e.js';

for (const scenario of [
  'long-task-loop-guard-e2e',
  'long-task-error-loop-guard-e2e',
  'long-task-parallel-loop-guard-e2e',
  'long-task-hard-cap-e2e',
  'long-task-reviewed-finish-e2e',
  'long-task-checkpoint-failure-e2e',
]) {
  try {
    await runNamedFakeE2E(scenario);
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
}
