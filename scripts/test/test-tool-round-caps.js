#!/usr/bin/env node
/**
 * Tool-loop round caps must:
 *   1. Be configurable via env vars (PASTURE_MAX_TOOL_ROUNDS, etc.)
 *   2. Be exposed via TOOL_LOOP_LIMITS for callers / tests.
 *   3. Cause runAgentTurn to surface "ran out of rounds" to the user
 *      (not the bogus "Done. Anything else?") when exhausted.
 *   4. Emit a tool_round_cap_hit team-activity entry when exhausted.
 *   5. Mark turnStatus as "error" when exhausted (so the dashboard
 *      shows real failure state, not idle).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');

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

// 1. Env-var override hook.
check(
  'envInt helper reads PASTURE_MAX_TOOL_ROUNDS env var',
  /function envInt\(name, fallback\)[\s\S]{0,400}?process\.env\[name\]/.test(agent)
);
check(
  'MAX_TOOL_ROUNDS uses envInt with fallback 3',
  /MAX_TOOL_ROUNDS\s*=\s*envInt\(['"]PASTURE_MAX_TOOL_ROUNDS['"],\s*3\)/.test(agent)
);
check(
  'MAX_TOOL_ROUNDS_WRITE uses envInt with fallback 10',
  /MAX_TOOL_ROUNDS_WRITE\s*=\s*envInt\(['"]PASTURE_MAX_TOOL_ROUNDS_WRITE['"],\s*10\)/.test(agent)
);
check(
  'MAX_TOOL_CALL_RETRIES uses envInt with fallback 3',
  /MAX_TOOL_CALL_RETRIES\s*=\s*envInt\(['"]PASTURE_MAX_TOOL_CALL_RETRIES['"],\s*3\)/.test(agent)
);
check(
  'MAX_COMPLETENESS_RETRIES uses envInt with fallback 2',
  /MAX_COMPLETENESS_RETRIES\s*=\s*envInt\(['"]PASTURE_MAX_COMPLETENESS_RETRIES['"],\s*2\)/.test(agent)
);

// 2. Public TOOL_LOOP_LIMITS export.
const mod = await import('../../lib/agent/agent.js');
check('exports TOOL_LOOP_LIMITS', mod && mod.TOOL_LOOP_LIMITS && typeof mod.TOOL_LOOP_LIMITS === 'object');
check('TOOL_LOOP_LIMITS is frozen', Object.isFrozen(mod.TOOL_LOOP_LIMITS));
check('TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS === 3', mod.TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS === 3);
check('TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS_WRITE === 10', mod.TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS_WRITE === 10);

// 3. roundsExhausted flag is declared, set on last iteration end-of-body, surfaced to user.
check(
  'roundsExhausted flag declared',
  /let\s+roundsExhausted\s*=\s*false/.test(agent)
);
check(
  'roundsExhausted set at end-of-body on last allowed round',
  /round\s*===\s*\(hadWriteOp\s*\?\s*MAX_TOOL_ROUNDS_WRITE\s*:\s*MAX_TOOL_ROUNDS\)\s*\)\s*\{\s*roundsExhausted\s*=\s*true/.test(agent)
);
check(
  'final-reply path surfaces "ran out of tool rounds" instead of "Done. Anything else?"',
  /roundsExhausted[\s\S]{0,300}?I ran out of tool rounds/.test(agent)
);

// 4. Metric emitted.
check(
  'tool_round_cap_hit team-activity entry emitted on exhaustion',
  /type:\s*['"]tool_round_cap_hit['"]/.test(agent)
);

// 5. turnStatus marked error when exhausted.
// Now wrapped with cancellation handling (audit finding #14): turnStatus is
// 'cancelled' when wasCancelled, otherwise 'error' on tool error or rounds
// exhausted, otherwise 'ok'. Verify the inner ternary still includes
// roundsExhausted in the error branch.
check(
  'turnStatus = "error" when roundsExhausted',
  /turnStatus\s*=[\s\S]{0,200}?lastRoundHadToolError\s*\|\|\s*roundsExhausted\s*\?\s*['"]error['"]\s*:\s*['"]ok['"]/.test(agent)
);

console.log(`\n[tool-round-caps] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
