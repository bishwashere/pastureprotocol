#!/usr/bin/env node
/**
 * spawnWithTimeout must always settle: success, non-zero exit, missing
 * binary, and runaway-process timeout. The timeout case is the whole point
 * of finding #12 — a stuck OAuth refresh used to hang the agent's tool loop
 * indefinitely.
 */

import {
  spawnWithTimeout,
  runCliAsExecutor,
  DEFAULT_SPAWN_TIMEOUT_MS,
} from '../../lib/agent/executors/spawn-with-timeout.js';

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

check('DEFAULT_SPAWN_TIMEOUT_MS is 30s', DEFAULT_SPAWN_TIMEOUT_MS === 30_000);

const okResult = await spawnWithTimeout('node', ['-e', 'process.stdout.write("hello")'], {
  timeoutMs: 5000,
});
check(
  'success: ok=true with stdout',
  okResult.ok === true && okResult.stdout === 'hello' && okResult.timedOut === false,
  JSON.stringify(okResult)
);

const failResult = await spawnWithTimeout('node', ['-e', 'process.stderr.write("bad"); process.exit(2)'], {
  timeoutMs: 5000,
});
check(
  'non-zero exit: ok=false with code=2 and stderr',
  failResult.ok === false && failResult.code === 2 && failResult.stderr === 'bad' && failResult.timedOut === false,
  JSON.stringify(failResult)
);

const t0 = Date.now();
const timeoutResult = await spawnWithTimeout(
  'node',
  ['-e', 'setInterval(() => {}, 1000)'],
  { timeoutMs: 200 }
);
const elapsed = Date.now() - t0;
check(
  'runaway: timedOut=true, ok=false, killed under 1s',
  timeoutResult.ok === false && timeoutResult.timedOut === true && elapsed < 1500,
  `elapsed=${elapsed}ms, result=${JSON.stringify(timeoutResult)}`
);
check(
  'runaway: error message mentions timeout',
  typeof timeoutResult.error === 'string' && /timed out/i.test(timeoutResult.error),
  timeoutResult.error
);

const noCmdResult = await spawnWithTimeout('this-binary-does-not-exist-xyz', [], { timeoutMs: 2000 });
check(
  'missing binary: ok=false with error message',
  noCmdResult.ok === false && typeof noCmdResult.error === 'string' && noCmdResult.error.length > 0,
  JSON.stringify(noCmdResult)
);

// runCliAsExecutor convenience wrapper
const execOk = await runCliAsExecutor('node', ['-e', 'process.stdout.write("ok")'], { timeoutMs: 5000 });
check(
  'runCliAsExecutor: success returns plain stdout',
  execOk === 'ok',
  execOk
);

const execFail = await runCliAsExecutor('node', ['-e', 'process.stderr.write("nope"); process.exit(1)'], { timeoutMs: 5000 });
let execFailParsed = null;
try {
  execFailParsed = JSON.parse(execFail);
} catch {
  execFailParsed = null;
}
check(
  'runCliAsExecutor: non-zero exit returns {"error": ...} JSON',
  execFailParsed && typeof execFailParsed.error === 'string' && execFailParsed.error.includes('nope'),
  execFail
);

const execTimeout = await runCliAsExecutor(
  'node',
  ['-e', 'setInterval(() => {}, 1000)'],
  { timeoutMs: 200 }
);
let execTimeoutParsed = null;
try {
  execTimeoutParsed = JSON.parse(execTimeout);
} catch {
  execTimeoutParsed = null;
}
check(
  'runCliAsExecutor: timeout returns {"error":"...timed out..."}',
  execTimeoutParsed && typeof execTimeoutParsed.error === 'string' && /timed out/i.test(execTimeoutParsed.error),
  execTimeout
);

console.log(`\n[spawn-with-timeout] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
