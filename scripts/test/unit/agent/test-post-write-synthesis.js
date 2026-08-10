#!/usr/bin/env node
/**
 * Audit finding #20: filesystem/GitHub mutation turns must run through a
 * persistence-grounded no-tools synthesis pass before the user-facing reply,
 * not reuse a stale "Done. Wrote N files" claim.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');

const checks = [
  {
    name: 'go-write verification targets parse real paths instead of flags',
    ok: agent.includes('function collectWriteVerificationTargets') &&
      agent.includes("action === 'cp' || action === 'mv' || action === 'rsync'") &&
      agent.includes('args[args.length - 1]') &&
      agent.includes("action === 'rm'") &&
      agent.includes("add(path, 'absent')") &&
      agent.includes("action === 'mkdir' || action === 'touch'"),
  },
  {
    name: 'round-level persistence verification is injected before the next LLM answer',
    ok: /pendingWriteVerificationTargets\.size\s*>\s*0[\s\S]{0,240}?buildFilesystemPersistenceVerification\(ctx,\s*pendingWriteVerificationTargets\)[\s\S]{0,300}?role:\s*['"]user['"][\s\S]{0,120}?content:\s*verificationContent/.test(agent),
  },
  {
    name: 'final persistence synthesis uses final reply policy and no tools',
    ok: /synthesizeAfterPersistentWrites[\s\S]{0,900}?chatWithTools\(\s*withFinalReplyPolicy\(messages\),\s*\[\],\s*agentLlmOptions\(['"]agent_turn_post_write_synthesis['"]\)/.test(agent),
  },
  {
    name: 'Synthesis result replaces finalContent (not appends)',
    ok: /agent_turn_post_write_synthesis[\s\S]{0,400}?finalContent\s*=\s*reply/.test(agent),
  },
  {
    name: 'Completeness retry writes get a second persistence synthesis',
    ok: (agent.match(/await synthesizeAfterPersistentWrites\(\);/g) || []).length >= 2 &&
      agent.includes('Completeness retries can perform writes after the first post-write'),
  },
  {
    name: 'Verification prompt forbids completion without persisted evidence',
    ok: agent.includes('Filesystem persistence verification (actual state after write operations)') &&
      agent.includes('do not say the task is complete') &&
      agent.includes('redo the change and verify again') &&
      agent.includes('change was not verified'),
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
