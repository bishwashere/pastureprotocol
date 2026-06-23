/**
 * Unit tests for dashboard test output parsing (dashboard/public/assets/js/test-output-parse.js).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseTestOutput, renderOutputResults } from '../../dashboard/public/assets/js/test-output-parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../../dashboard/public/index.html'), 'utf8');
if (!html.includes('assets/js/test-output-parse.js')) {
  console.error('FAIL index.html must load assets/js/test-output-parse.js');
  process.exit(1);
}
if (html.includes('function parseTestOutput(result)')) {
  console.error('FAIL index.html should not duplicate parseTestOutput (use test-output-parse.js)');
  process.exit(1);
}
if (!html.includes('id="test-run-skill"')) {
  console.error('FAIL index.html must have Run skill button (test-run-skill)');
  process.exit(1);
}
if (!html.includes('class="test-run-one"')) {
  console.error('FAIL index.html must have per-skill Run buttons in test sidebar');
  process.exit(1);
}

const cases = [
  {
    name: 'e2e-report INPUT/OUTPUT block',
    stdout: [
      'Skill: me. Initial state: 1 tests — all PENDING.',
      '',
      '✅ me: "What do you know about me?"',
      '  INPUT: What do you know about me?',
      '  OUTPUT: Test User lives in Austin and works on Pasture Protocol.',
      '',
      '--- Result ---',
      'Passed: 1, Failed: 0',
      '',
      '## E2E report: me',
      '',
      '| Test | Input | Output | Status |',
      '| --- | --- | --- | --- |',
      '| me: "What do you know about me?" | What do you know about me? | Test User lives in Austin | ✅ Pass |',
      '',
      '**me:** 1 passed, 0 failed, 0 skipped',
    ].join('\n'),
    expect: {
      entryCount: 1,
      hasInput: true,
      hasOutput: true,
      outputIncludes: 'Test User lives in Austin',
      pass: true,
    },
  },
  {
    name: 'e2e-report failure with DETAIL',
    stdout: [
      '❌ search: "Weather in Tokyo"',
      '  INPUT: Weather in Tokyo',
      '  OUTPUT: Sorry, I could not reach the weather API.',
      '  DETAIL: Judge: NO. Reply looks like failure-only',
      '',
      'Passed: 0, Failed: 1',
    ].join('\n'),
    expect: {
      entryCount: 1,
      hasInput: true,
      hasOutput: true,
      hasDetail: true,
      pass: false,
    },
  },
  {
    name: 'agent Scenario/Reply format',
    stdout: [
      '────────────────────────────────────────────────────────────',
      'Scenario: cron list',
      'Message: List my reminders',
      '────────────────────────────────────────────────────────────',
      'Reply: You have 2 reminders set.',
      '',
      'Done. Scenarios: 1 Failed: 0',
    ].join('\n'),
    expect: {
      entryCount: 1,
      hasOutput: true,
      outputIncludes: '2 reminders',
      pass: true,
    },
  },
  {
    name: 'tide --- Input --- / --- Output --- sections',
    stdout: [
      'Running one Tide cycle (run-tide.js)...',
      '',
      '--- Input ---',
      '{',
      '  "jid": "7656021862",',
      '  "historyMessages": []',
      '}',
      '',
      '--- Output ---',
      'textToSend: Still here if you need anything.',
      'elapsed: 12.3 s',
      '',
      'Tide test passed.',
    ].join('\n'),
    expect: {
      entryCount: 1,
      hasInput: true,
      hasOutput: true,
      outputIncludes: 'textToSend',
    },
  },
  {
    name: '[PASS]/[FAIL] unit test lines',
    stdout: [
      '[PASS] Agent team panel does not use overflow:auto',
      '[FAIL] Missing widget — expected id=foo',
      '',
      '1 check(s) failed.',
    ].join('\n'),
    expect: {
      entryCount: 2,
      pass: true,
      includesFailEntry: true,
    },
  },
  {
    name: 'raw stdout fallback when unstructured',
    stdout: 'Something unexpected happened\nline two',
    expect: {
      entryCount: 0,
      rawFallback: true,
      rawIncludes: 'unexpected',
    },
  },
];

let failed = 0;
const rows = [];

for (const c of cases) {
  const parsed = parseTestOutput({ stdout: c.stdout, stderr: '', exitCode: c.expect.pass === false ? 1 : 0, durationMs: 1000 });
  const exp = c.expect;
  let ok = true;
  const issues = [];

  if (exp.entryCount != null && parsed.entries.length !== exp.entryCount) {
    ok = false;
    issues.push('entryCount=' + parsed.entries.length + ' expected ' + exp.entryCount);
  }
  const first = parsed.entries[0] || {};
  if (exp.hasInput && !first.input) { ok = false; issues.push('missing input'); }
  if (exp.hasOutput && !(first.output || first.reply)) { ok = false; issues.push('missing output'); }
  if (exp.hasDetail && !first.judge) { ok = false; issues.push('missing detail'); }
  if (exp.outputIncludes && !(first.output || first.reply || '').includes(exp.outputIncludes)) {
    ok = false;
    issues.push('output missing "' + exp.outputIncludes + '"');
  }
  if (exp.pass != null && first.pass !== exp.pass) { ok = false; issues.push('pass=' + first.pass); }
  if (exp.includesFailEntry && !parsed.entries.some((e) => e.pass === false)) {
    ok = false;
    issues.push('no fail entry');
  }
  if (exp.rawFallback) {
    const html = renderOutputResults(parsed);
    if (!html.includes('test-output-pre')) { ok = false; issues.push('no raw pre fallback'); }
    if (exp.rawIncludes && !html.includes(exp.rawIncludes)) { ok = false; issues.push('raw missing text'); }
  }

  const status = ok ? '✅ Pass' : '❌ Fail';
  if (!ok) failed++;
  rows.push({ test: c.name, input: c.name, output: ok ? 'parsed OK' : issues.join('; '), status });
  console.log(status + ' ' + c.name + (issues.length ? ' — ' + issues.join('; ') : ''));
}

console.log('\n| Test | Input | Output | Status |');
console.log('| --- | --- | --- | --- |');
for (const r of rows) {
  console.log('| ' + r.test + ' | ' + r.input + ' | ' + r.output + ' | ' + r.status + ' |');
}

if (failed) {
  console.error('\n' + failed + ' test(s) failed.');
  process.exit(1);
}
console.log('\nAll test output parse checks passed.');
