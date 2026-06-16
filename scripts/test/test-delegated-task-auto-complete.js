#!/usr/bin/env node
/**
 * Contract: when an agent-send call returns a delegated task in
 * 'review_ready' state and the coordinator's turn finishes successfully,
 * runAgentTurn must call completeDelegatedTask so the task transitions
 * past 'review_ready' instead of leaking forever (audit finding #18).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');

const checks = [
  {
    name: 'agent.js imports completeDelegatedTask',
    ok: /import\s+\{\s*completeDelegatedTask\s*\}\s+from\s+['"]\.\/delegated-tasks\.js['"]/.test(agent),
  },
  {
    name: 'agent.js declares reviewReadyDelegations buffer',
    ok: /const\s+reviewReadyDelegations\s*=\s*\[\]/.test(agent),
  },
  {
    name: 'agent-send branch detects delegatedTaskStatus === "review_ready"',
    ok: /skillId\s*===\s*['"]agent-send['"][\s\S]{0,800}?delegatedTaskStatus\s*===\s*['"]review_ready['"]/.test(agent),
  },
  {
    name: 'review_ready entries are pushed with replySummary',
    ok: /reviewReadyDelegations\.push\(\s*\{[\s\S]{0,200}?delegatedTask:[\s\S]{0,200}?replySummary/.test(agent),
  },
  {
    name: 'auto-complete only fires on successful turns (turnStatus === "ok")',
    ok: /turnStatus\s*===\s*['"]ok['"][\s\S]{0,200}?reviewReadyDelegations\.length\s*>\s*0/.test(agent),
  },
  {
    name: 'completeDelegatedTask is called in the auto-complete loop',
    ok: /reviewReadyDelegations[\s\S]{0,400}?completeDelegatedTask\(/.test(agent),
  },
  {
    name: 'auto-complete failure is logged but never throws',
    ok: /completeDelegatedTask[\s\S]{0,300}?catch[\s\S]{0,200}?delegated-tasks.*auto-complete failed/.test(agent),
  },
];

let failed = 0;
console.log('Delegated-task auto-complete contract\n');
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
