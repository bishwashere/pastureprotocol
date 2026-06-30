#!/usr/bin/env node
/**
 * Contract: when validateToolCalls keeps failing past MAX_TOOL_CALL_RETRIES,
 * runAgentTurn must NOT execute the invalid batch. It must clear toolCalls,
 * set lastToolError, mark the round as a tool error, and let the final-reply
 * path surface a friendly message — not push garbage tool messages and waste
 * another round of LLM calls.
 *
 * This test is intentionally textual (matches the convention used by
 * test-shared-delegation-history.js) since runAgentTurn's tool loop is too
 * tightly coupled to the LLM client to dependency-inject easily.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');

const checks = [
  {
    name: 'Exhausted retries set lastRoundHadToolError = true',
    ok:
      /toolCallRetries\s*>=\s*MAX_TOOL_CALL_RETRIES[\s\S]{0,1200}?lastRoundHadToolError\s*=\s*true/.test(agent),
  },
  {
    name: 'Exhausted retries set a friendly lastToolError message',
    ok:
      /toolCallRetries\s*>=\s*MAX_TOOL_CALL_RETRIES[\s\S]{0,1200}?lastToolError\s*=\s*['"][^'"]*invalid arguments/i.test(agent),
  },
  {
    name: 'Exhausted retries null out toolCalls so the outer loop exits cleanly',
    ok:
      /toolCallRetries\s*>=\s*MAX_TOOL_CALL_RETRIES[\s\S]{0,1200}?toolCalls\s*=\s*null/.test(agent),
  },
  {
    name: 'Comment explains why we drop the invalid batch (regression guard)',
    ok:
      /Retry budget exhausted with still-invalid tool calls/i.test(agent),
  },
  {
    name: 'Final-reply path surfaces lastToolError when the round had a tool error',
    ok:
      /lastRoundHadToolError\s*&&\s*lastToolError[\s\S]{0,200}?toUserMessage\(lastToolError\)/.test(agent),
  },
  {
    name: 'lastToolError is initialized in the turn body',
    ok: /let\s+lastToolError\s*=\s*null/.test(agent),
  },
];

let failed = 0;
console.log('Tool-call retry exhaustion contract\n');
for (const c of checks) {
  process.stdout.write(`  ${c.name} … `);
  if (c.ok) {
    console.log('PASS');
  } else {
    console.log('FAIL');
    failed++;
  }
}

console.log('\n| Test | Status |');
console.log('| --- | --- |');
for (const c of checks) {
  console.log(`| ${c.name} | ${c.ok ? 'Pass' : 'Fail'} |`);
}

process.exit(failed ? 1 : 0);
