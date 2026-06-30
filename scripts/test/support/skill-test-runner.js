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

let _reportRows = [];
let _reportSuite = '';

function fallbackStartReport(suiteName) {
  _reportSuite = suiteName;
  _reportRows = [];
}

function fallbackRecordCase(row) {
  _reportRows.push({
    name: row.name,
    input: row.input || '',
    output: row.output || '',
    status: row.status,
    detail: row.detail || '',
  });
  const icon = row.status === 'pass' ? '✅' : row.status === 'skip' ? '⏭️' : '❌';
  console.log(`\n${icon} ${row.name}`);
  if (row.input) console.log('  INPUT:', row.input);
  if (row.output) console.log('  OUTPUT:', clipReply(row.output));
  if (row.detail && row.status === 'fail') console.log('  DETAIL:', row.detail);
}

function fallbackEndReport() {
  console.log(`\n## E2E report: ${_reportSuite}\n`);
  console.log('| Test | Input | Output | Status |');
  console.log('| --- | --- | --- | --- |');
  for (const r of _reportRows) {
    const status = r.status === 'pass' ? '✅ Pass' : r.status === 'skip' ? '⏭️ Skip' : '❌ Fail';
    const detail = r.detail ? ` — ${String(r.detail).slice(0, 120)}` : '';
    console.log(`| ${r.name} | ${r.input} | ${clipReply(r.output)} | ${status}${detail} |`);
  }
  const passed = _reportRows.filter((r) => r.status === 'pass').length;
  const failed = _reportRows.filter((r) => r.status === 'fail').length;
  const skipped = _reportRows.filter((r) => r.status === 'skip').length;
  console.log(`\n**${_reportSuite}:** ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
}

const reportApi = await import('./e2e-report.js').catch(() => null);
const startReport = reportApi?.startReport || fallbackStartReport;
const endReport = reportApi?.endReport || fallbackEndReport;
const recordCase = reportApi?.recordCase || fallbackRecordCase;

/**
 * @param {string} skillName - e.g. 'cron', 'browser', 'memory'
 * @param {object[]} tests
 * @param {{ timeoutPerTest?: number, installRoot?: string }} [opts]
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runSkillTests(skillName, tests, opts = {}) {
  const total = tests.length;
  startReport(skillName);
  console.log(`Skill: ${skillName}. Initial state: ${total} tests — all PENDING.\n`);
  for (const t of tests) {
    console.log(`  [PENDING] ${t.name}${formatExpectModeLabel(t.expectMode)}`);
  }
  console.log('\nRunning tests (passing ones will be marked SUCCESS)...\n');

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const inputText = t.input ?? t.name;
    try {
      const result = await t.run();
      if (t.expectMode === ExpectMode.ACTUAL) {
        assertActualResult(result, t);
      }
      passed++;
      const reply = result && (typeof result === 'string' ? result : result.reply);
      const skillsCalled = result && typeof result === 'object' && Array.isArray(result.skillsCalled) ? result.skillsCalled : [];
      const outputText = [
        reply ? clipReply(reply) : '',
        skillsCalled.length ? `(skills: ${skillsCalled.join(', ')})` : '',
      ].filter(Boolean).join(' ');
      recordCase({
        name: t.name,
        input: inputText,
        output: outputText,
        status: 'pass',
      });
      console.log(`  [SUCCESS] ${t.name}${formatExpectModeLabel(t.expectMode)}`);
    } catch (err) {
      failed++;
      const reply = err && err.reply;
      const skillsCalled = err && Array.isArray(err.skillsCalled) ? err.skillsCalled : [];
      const outputText = [
        reply ? clipReply(reply) : '',
        skillsCalled.length ? `(skills: ${skillsCalled.join(', ')})` : '',
      ].filter(Boolean).join(' ');
      const msg = (err && err.message) || String(err);
      recordCase({
        name: t.name,
        input: inputText,
        output: outputText || msg,
        status: 'fail',
        detail: msg,
      });
      console.log(`  [FAILED] ${t.name} — ${msg.slice(0, 200)}${msg.length > 200 ? '…' : ''}`);
    }
  }

  console.log('\n--- Result ---');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  endReport();
  return { passed, failed };
}

function clipReply(reply) {
  const s = String(reply ?? '').trim();
  return s.length > 500 ? s.slice(0, 500) + '…' : s;
}
