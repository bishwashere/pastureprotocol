/**
 * Shared runner for skill E2E tests: initial state is FAILED for all tests;
 * each test that passes is marked SUCCESS; failures stay FAILED.
 *
 * Usage:
 *   const tests = [ { name: 'List my reminders', run: async () => { ... } }, ... ];
 *   const { passed, failed } = await runSkillTests('cron', tests);
 *   process.exit(failed > 0 ? 1 : 0);
 *
 * Optional per test (see E2E_EXPECT.md):
 *   expectMode: 'behavior' | 'actual'  — default behavior (judge only)
 *   skill: 'search'                    — required skill call for actual
 *   actualChecks: { replyIncludesAny, fileExists, fileContains }
 *   stateDir                           — for file checks
 */

import { assertActualResult, ExpectMode, formatExpectModeLabel } from './e2e-expect.js';

/**
 * @param {string} skillName - e.g. 'cron', 'browser', 'memory'
 * @param {object[]} tests
 * @param {{ timeoutPerTest?: number, installRoot?: string }} [opts]
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runSkillTests(skillName, tests, opts = {}) {
  const total = tests.length;
  console.log(`Skill: ${skillName}. Initial state: ${total} tests — all FAILED.\n`);
  for (const t of tests) {
    console.log(`  [FAILED] ${t.name}${formatExpectModeLabel(t.expectMode)}`);
  }
  console.log('\nRunning tests (passing ones will be marked SUCCESS)...\n');

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      const result = await t.run();
      if (t.expectMode === ExpectMode.ACTUAL) {
        assertActualResult(result, t);
      }
      passed++;
      const reply = result && (typeof result === 'string' ? result : result.reply);
      const skillsCalled = result && typeof result === 'object' && Array.isArray(result.skillsCalled) ? result.skillsCalled : [];
      if (skillsCalled.length) console.log(`  Skills called: ${skillsCalled.join(', ')}`);
      if (reply) console.log(`  Reply: ${reply.slice(0, 500)}`);
      console.log(`  [SUCCESS] ${t.name}${formatExpectModeLabel(t.expectMode)}`);
    } catch (err) {
      failed++;
      const reply = err && err.reply;
      const skillsCalled = err && Array.isArray(err.skillsCalled) ? err.skillsCalled : [];
      if (skillsCalled.length) console.log(`  Skills called: ${skillsCalled.join(', ')}`);
      if (reply) console.log(`  Reply: ${reply.slice(0, 500)}`);
      const msg = (err && err.message) || String(err);
      console.log(`  [FAILED] ${t.name} — ${msg.slice(0, 200)}${msg.length > 200 ? '…' : ''}`);
    }
  }

  console.log('\n--- Result ---');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}
