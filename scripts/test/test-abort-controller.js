#!/usr/bin/env node
/**
 * Audit finding #14: cancelBackgroundTask used to flip a JSON status field
 * only — the in-flight runAgentTurn kept running. Now an AbortController is
 * plumbed through ctx → runAgentTurn, which cooperatively exits at the next
 * round boundary. The aborted turn surfaces "Cancelled." to the user.
 *
 * The exhaustive in-process test would require running runAgentTurn with a
 * real LLM, so we use the textual contract pattern from earlier slices.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');
const bg = readFileSync(join(root, 'lib/agent/background-tasks.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

// agent.js
check(
  'runAgentTurn accepts abortSignal opt',
  /abortSignal\s*=\s*null,/.test(agent)
);
check(
  'wasCancelled flag is declared',
  /let\s+wasCancelled\s*=\s*false/.test(agent)
);
check(
  'abortSignal is checked at the top of each tool round',
  /for\s*\(let round[\s\S]{0,200}?abortSignal\s*&&\s*abortSignal\.aborted[\s\S]{0,80}?wasCancelled\s*=\s*true[\s\S]{0,40}?break/.test(agent)
);
check(
  'final-reply path surfaces "Cancelled." when wasCancelled',
  /wasCancelled[\s\S]{0,120}?textToSend\s*=\s*withPrefix\(['"]Cancelled\.['"]\)/.test(agent)
);
check(
  'turnStatus = "cancelled" when wasCancelled (not "ok"/"error")',
  /turnStatus\s*=\s*wasCancelled\s*\?\s*['"]cancelled['"]/.test(agent)
);
check(
  'agent.js cites audit finding #14',
  /audit\s+finding\s+#14/i.test(agent)
);

// background-tasks.js
check(
  'background-tasks declares abortControllers Map',
  /const\s+abortControllers\s*=\s*new\s+Map\(\)/.test(bg)
);
check(
  'spawnBackgroundTask creates an AbortController',
  /spawnBackgroundTask[\s\S]{0,3000}?const\s+controller\s*=\s*new\s+AbortController\(\)/.test(bg)
);
check(
  'spawnBackgroundTask stores controller keyed by taskId',
  /abortControllers\.set\(taskId,\s*controller\)/.test(bg)
);
check(
  'parentCtx is passed abortSignal: controller.signal',
  /abortSignal:\s*controller\.signal/.test(bg)
);
check(
  'cancelBackgroundTask calls controller.abort()',
  /cancelBackgroundTask[\s\S]{0,500}?controller\.abort\(\)/.test(bg)
);
check(
  'controller is cleaned up after task settles (finally)',
  /finally\([\s\S]{0,200}?abortControllers\.delete\(taskId\)/.test(bg)
);
check(
  'runBackgroundAgentTurn forwards abortSignal into runAgentTurn',
  /runAgentTurn\(\{[\s\S]{0,500}?abortSignal,?[\s\S]{0,40}?\}\)/.test(bg)
);
check(
  'background-tasks cites audit finding #14',
  /audit\s+finding\s+#14/i.test(bg)
);

console.log(`\n[abort-controller] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
