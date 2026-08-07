#!/usr/bin/env node

import { runNamedFakeE2E } from '../fake-app-e2e.js';

try {
  await runNamedFakeE2E('long-task-worklog-e2e');
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
