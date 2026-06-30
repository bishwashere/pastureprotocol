#!/usr/bin/env node
/**
 * Audit finding #20: when post-write verification produces any output, the
 * agent must run a no-tools synthesis pass so the user-facing reply is
 * grounded in the actual disk state — not a stale "Done. Wrote N files"
 * from earlier in the loop that may contradict what's on disk.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');

const checks = [
  {
    name: 'verifyParts.length > 0 branch pushes the verification user message',
    ok: /verifyParts\.length\s*>\s*0[\s\S]{0,400}?role:\s*['"]user['"][\s\S]{0,200}?Verification \(actual files on disk/.test(agent),
  },
  {
    name: 'After pushing, a no-tools synthesis is unconditionally invoked',
    ok: /verifyParts\.length\s*>\s*0[\s\S]{0,800}?chatWithTools\(\s*messages,\s*\[\],\s*agentLlmOptions\(['"]agent_turn_post_write_synthesis['"]\)/.test(agent),
  },
  {
    name: 'Synthesis result replaces finalContent (not appends)',
    ok: /agent_turn_post_write_synthesis[\s\S]{0,400}?finalContent\s*=\s*reply/.test(agent),
  },
  {
    name: 'Comment cites audit finding #20',
    ok: /audit finding #20/i.test(agent),
  },
];

let failed = 0;
console.log('Post-write synthesis contract\n');
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
