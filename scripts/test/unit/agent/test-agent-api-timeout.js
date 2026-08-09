#!/usr/bin/env node
/**
 * The Agent API must not abandon a still-running turn when its optional
 * request deadline expires. The server is a process entry point, so importing
 * it would start a listener; verify the wiring contract textually instead.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = readFileSync(join(root, 'scripts/agent-api-server.js'), 'utf8');
const apiTurn = readFileSync(join(root, 'lib/agent/api-chat-turn.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, ok) {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed += 1;
  } else {
    console.log(`[FAIL] ${name}`);
    failed += 1;
  }
}

check(
  'Agent API timeout defaults to disabled',
  /REQUEST_TIMEOUT_MS\s*=\s*Number\.isFinite\([\s\S]{0,240}?configuredRequestTimeoutMs\s*>\s*0[\s\S]{0,160}?:\s*0\s*;/.test(server),
);
check(
  'deadline helper creates and aborts an AbortController only for a positive timeout',
  /runTurnWithDeadline[\s\S]{0,300}?timeoutMs\s*>\s*0\s*\?\s*new\s+AbortController\(\)[\s\S]{0,300}?controller\.abort\(\)/.test(server),
);
check(
  'deadline helper awaits cooperative turn completion',
  /const\s+turn\s*=\s*await\s+runTurn\(controller\?\.signal\s*\|\|\s*null\)/.test(server),
);
check(
  'deadline timer is always cleared',
  /finally\s*\{[\s\S]{0,120}?clearTimeout\(timer\)/.test(server),
);
check(
  'old orphan-producing Promise.race path is absent',
  !/Promise\.race|function\s+timeoutTurn/.test(server),
);
check(
  'server forwards its deadline signal to the API turn',
  /runTurnWithDeadline\([\s\S]{0,500}?runAgentApiChatTurn\(\{[\s\S]{0,260}?abortSignal,/.test(server),
);
check(
  'successful deadline expiry is marked in the API log',
  /type:\s*turn\.timedOut\s*\?\s*['"]timeout_response['"]\s*:\s*['"]response['"]/.test(server),
);
check(
  'runAgentApiChatTurn accepts abortSignal',
  /export\s+async\s+function\s+runAgentApiChatTurn\(\{[\s\S]{0,260}?abortSignal\s*=\s*null,/.test(apiTurn),
);
check(
  'runAgentApiChatTurn forwards abortSignal into runAgentTurn',
  /runAgentTurn\(\{[\s\S]{0,500}?abortSignal,?[\s\S]{0,20}?\}\)/.test(apiTurn),
);

console.log(`\n[agent-api-timeout] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
