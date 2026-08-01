#!/usr/bin/env node

import { runNamedFakeE2E } from '../fake-app-e2e.js';

try {
  await runNamedFakeE2E('write-exec-fork-e2e');
  await runNamedFakeE2E('write-exec-fork-e2e');
  await runNamedFakeE2E('required-steps-unavailable-e2e');
  await runNamedFakeE2E('node-script-fork-e2e');
  console.log('write-exec fork runtime passed twice in isolated state directories');
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
