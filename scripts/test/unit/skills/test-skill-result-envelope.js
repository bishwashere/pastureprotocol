#!/usr/bin/env node
/**
 * parseSkillResult must recognize every failure shape executors produce so
 * the agent's tool loop can't treat a failed skill as success.
 */

import { parseSkillResult } from '../../../../skills/executor.js';

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

const cases = [
  // Plain prose is success
  { input: 'wrote 3 lines.', expectOk: true },
  { input: '   ', expectOk: true },
  { input: '', expectOk: true },

  // Compact error JSON (legacy shape) — must be detected as failure
  { input: '{"error":"boom"}', expectOk: false, expectError: 'boom' },
  { input: '{"error":"file not found"}', expectOk: false, expectError: 'file not found' },

  // Pretty-printed error JSON — used by project-workflow / mongodb. Must be detected.
  { input: '{\n  "error": "permission denied"\n}', expectOk: false, expectError: 'permission denied' },
  { input: '  {\n  "error": "x"\n}\n', expectOk: false, expectError: 'x' },

  // ok:false envelope — must be detected even without a top-level error
  { input: '{"ok":false}', expectOk: false },
  { input: '{"ok":false,"error":"db timeout"}', expectOk: false, expectError: 'db timeout' },
  { input: '{"ok":false,"reason":"x"}', expectOk: false },

  // Non-error JSON is success
  { input: '{"path":"/tmp/x"}', expectOk: true },
  { input: '{"ok":true,"data":{"a":1}}', expectOk: true },
  { input: '[1,2,3]', expectOk: true },

  // Strings that contain the substring "error" but aren't JSON envelopes
  { input: 'Help: see error.log for details.', expectOk: true },
  { input: 'no errors found', expectOk: true },

  // Non-string input is treated as success (empty)
  { input: null, expectOk: true },
  { input: undefined, expectOk: true },
  { input: 42, expectOk: true },
];

for (const c of cases) {
  const got = parseSkillResult(c.input);
  const okMatches = got.ok === c.expectOk;
  const errMatches = c.expectError ? got.error === c.expectError : true;
  const desc = JSON.stringify(c.input);
  check(
    `${desc} -> ok=${c.expectOk}${c.expectError ? `, error=${c.expectError}` : ''}`,
    okMatches && errMatches,
    `got ${JSON.stringify(got)}`
  );
}

console.log(`\n[skill-result-envelope] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
