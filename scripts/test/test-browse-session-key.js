#!/usr/bin/env node
/**
 * Audit finding #13: browse session was keyed only by jid. Two agents in the
 * same group chat shared one Playwright tab — one agent's login or scroll
 * state silently bled into the other's turn.
 *
 * Contract: sessionKey now includes ctx.agentId. Same jid + different agentId
 * => different session.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const browse = readFileSync(join(root, 'lib/agent/executors/browse.js'), 'utf8');

const checks = [
  {
    name: 'sessionKey reads ctx.agentId',
    ok: /function sessionKey\([^)]*\)\s*\{[\s\S]{0,400}?ctx\?\.agentId/.test(browse),
  },
  {
    name: 'sessionKey composes jid + agentId when both present',
    ok: /\$\{jid\}\|\$\{agentId\}/.test(browse) || /\$\{jid\}\s*\+\s*['"]\|['"]\s*\+\s*\$\{agentId\}/.test(browse) || /jid\s*\+\s*['"]\|['"]\s*\+\s*agentId/.test(browse),
  },
  {
    name: 'sessionKey falls back gracefully when only jid present',
    ok: /if\s*\(jid\s*&&\s*agentId\)[\s\S]{0,200}?if\s*\(jid\)\s*return\s+jid/.test(browse),
  },
  {
    name: 'sessionKey keeps "default" for empty ctx',
    ok: /return\s+['"]default['"]/.test(browse),
  },
  {
    name: 'Comment cites audit finding #13',
    ok: /audit finding #13/i.test(browse),
  },
];

let failed = 0;
console.log('Browse session key contract\n');
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
