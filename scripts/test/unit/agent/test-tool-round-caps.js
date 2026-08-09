#!/usr/bin/env node
/**
 * Tool-loop budgets must:
 *   1. Be configurable via env vars (PASTURE_MAX_TOOL_ROUNDS, etc.)
 *   2. Be exposed via TOOL_LOOP_LIMITS for callers / tests.
 *   3. Keep short/general turns finite while checkpointed runs earn reviewed
 *      grants up to hard round and wall-clock ceilings.
 *   4. Preserve explicit user-facing and telemetry outcomes for either stop.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
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
  'MAX_TOOL_ROUNDS_WORKLOG uses envInt with fallback 30',
  /MAX_TOOL_ROUNDS_WORKLOG\s*=\s*envInt\(['"]PASTURE_MAX_TOOL_ROUNDS_WORKLOG['"],\s*30\)/.test(agent)
);
check(
  'adaptive grant size defaults to 30',
  /LONG_RUN_GRANT_ROUNDS\s*=\s*envInt\(['"]PASTURE_LONG_RUN_GRANT_ROUNDS['"],\s*30\)/.test(agent)
);
check(
  'hard long-run round ceiling defaults to 1000',
  /LONG_RUN_MAX_TOOL_ROUNDS\s*=\s*envInt\(['"]PASTURE_LONG_RUN_MAX_TOOL_ROUNDS['"],\s*1_000\)/.test(agent)
);
check(
  'hard long-run wall clock defaults to six hours',
  /LONG_RUN_MAX_RUNTIME_MS\s*=\s*envInt\(['"]PASTURE_LONG_RUN_MAX_RUNTIME_MS['"],\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1_000\)/.test(agent)
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
const mod = await import('../../../../lib/agent/agent.js');
check('exports TOOL_LOOP_LIMITS', mod && mod.TOOL_LOOP_LIMITS && typeof mod.TOOL_LOOP_LIMITS === 'object');
check('TOOL_LOOP_LIMITS is frozen', Object.isFrozen(mod.TOOL_LOOP_LIMITS));
check('TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS === 3', mod.TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS === 3);
check('TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS_WRITE === 10', mod.TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS_WRITE === 10);
check('TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS_WORKLOG === 30', mod.TOOL_LOOP_LIMITS.MAX_TOOL_ROUNDS_WORKLOG === 30);
check('TOOL_LOOP_LIMITS.LONG_RUN_GRANT_ROUNDS === 30', mod.TOOL_LOOP_LIMITS.LONG_RUN_GRANT_ROUNDS === 30);
check('TOOL_LOOP_LIMITS.LONG_RUN_MAX_TOOL_ROUNDS === 1000', mod.TOOL_LOOP_LIMITS.LONG_RUN_MAX_TOOL_ROUNDS === 1000);
check('TOOL_LOOP_LIMITS.LONG_RUN_MAX_RUNTIME_MS === 6h', mod.TOOL_LOOP_LIMITS.LONG_RUN_MAX_RUNTIME_MS === 21_600_000);

// 3. Exact loop bound, initial extended budget, and exhaustion fallback.
check(
  'zero configured rounds are treated as exhausted',
  /let\s+roundsExhausted\s*=\s*useTools\s*&&\s*toolRoundLimit\s*===\s*0/.test(agent)
);
check(
  'tool loop uses an exact less-than bound (no off-by-one round)',
  /for\s*\(let\s+round\s*=\s*0;\s*round\s*<\s*toolRoundLimit;\s*round\+\+\)/.test(agent)
);
check(
  'required write or execute workflow selects extended budget before round zero',
  /toolRequirements\.usesExtendedBudget\s*\?\s*MAX_TOOL_ROUNDS_WRITE\s*:\s*MAX_TOOL_ROUNDS/.test(agent)
);
check(
  'worklog workflow selects the bounded initial long-run grant before round zero',
  /let toolRoundLimit = worklogRequired\s*\?\s*initialLongRunRounds/.test(agent)
);
check(
  'configured hard ceiling is not silently raised by short-task budgets',
  /const longRunHardRounds\s*=\s*LONG_RUN_MAX_TOOL_ROUNDS/.test(agent)
  && /const initialLongRunRounds\s*=\s*Math\.min\([\s\S]{0,180}?longRunHardRounds/.test(agent)
);
check(
  'grant boundaries use the MD-backed continuation decision',
  /reviewLongRunBoundary[\s\S]{0,2500}?decideLongRunContinuation\(/.test(agent)
);
check(
  'approved progress extends the controller and mutable loop limit',
  /longRunController\.grant\([\s\S]{0,500}?toolRoundLimit = Math\.max\(toolRoundLimit, grant\.roundLimit\)/.test(agent)
);
check(
  'hard controller stops are distinct from ordinary round exhaustion',
  /setLongRunStop\(/.test(agent) && /type:\s*['"]long_run_safety_stop['"]/.test(agent)
);
check(
  'roundsExhausted is set when the exact bound is reached',
  /round\s*\+\s*1\s*>=\s*toolRoundLimit[\s\S]{0,220}?roundsExhausted\s*=\s*true/.test(agent)
);
check(
  'ordinary fixed-cap path still surfaces "ran out of tool rounds" instead of "Done. Anything else?"',
  /roundsExhausted[\s\S]{0,700}?I ran out of tool rounds/.test(agent)
);
check(
  'long-run safety synthesis takes priority over generic incomplete/cap copy',
  /else if \(longRunStop\)[\s\S]{0,500}?replySource = 'long-run-safety-stop'/.test(agent)
);
check(
  'safety stop disables the completeness retry path',
  /if \([\s\S]{0,180}?!worklogRequired[\s\S]{0,180}?!longRunFinished[\s\S]{0,180}?!longRunStop/.test(agent)
);
check(
  'safety stop disables post-write synthesis after the main loop',
  (agent.match(/if \(!longRunStop && !requirementsIncomplete && !wasCancelled\) await synthesizeAfterPersistentWrites\(\);/g) || []).length === 1
  && /if \(!requirementsIncomplete && !wasCancelled && !longRunStop\) \{\s*await synthesizeAfterPersistentWrites\(\);/.test(agent)
);
check(
  'remaining calls in the same parallel batch are skipped after a safety stop',
  /for \(const tc of toolCalls\) \{[\s\S]{0,600}?if \(!executionPreflight\(\)\)[\s\S]{0,200}?appendSkippedToolResponse\(tc\)/.test(agent)
  && /Tool call skipped because runtime execution stopped safely/.test(agent)
);
check(
  'every main-loop tool execution has an immediate controller preflight',
  /if \(!executionPreflight\(\)\) \{\s*appendSkippedToolResponse\(tc\);\s*continue;\s*\}\s*console\.log\('\[agent\] skill called:'/.test(agent)
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
  'turnStatus = "error" on long-run safety stop or ordinary exhaustion',
  /turnStatus\s*=[\s\S]{0,260}?longRunStop\s*\|\|\s*lastRoundHadToolError\s*\|\|\s*roundsExhausted\s*\|\|\s*requirementsIncomplete\s*\?\s*['"]error['"]\s*:\s*['"]ok['"]/.test(agent)
);
check(
  'safety-stopped turn cannot report requirements satisfied',
  /requirementsSatisfied:\s*!requirementsIncomplete\s*&&\s*!longRunStop/.test(agent)
);
check(
  'safety-stopped worklog finalizes as blocked instead of completed',
  /const worklogFinalStatus\s*=[\s\S]{0,220}?longRunStop[\s\S]{0,80}?['"]blocked['"]/.test(agent)
  && /finalizeTaskWorklog\([\s\S]{0,120}?status:\s*worklogFinalStatus/.test(agent)
);

console.log(`\n[tool-round-caps] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
