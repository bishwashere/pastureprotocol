#!/usr/bin/env node
/**
 * Contract: delegated agents receive the user-channel history (same cap as main).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const agentSend = readFileSync(join(root, 'lib/agent/executors/agent-send.js'), 'utf8');
const internalTurn = readFileSync(join(root, 'lib/agent/internal-agent-turn.js'), 'utf8');
const indexJs = readFileSync(join(root, 'index.js'), 'utf8');

const checks = [
  {
    name: 'agent-send passes sharedHistoryMessages to internal runner',
    ok: agentSend.includes('sharedHistoryMessages: delegationHistory.length ? delegationHistory : null'),
  },
  {
    name: 'internal turn resolves user history before pair history',
    ok: internalTurn.includes('resolveSharedTurnHistory(sharedHistoryMessages, pairHistoryMessages)'),
  },
  {
    name: 'user chat sets delegationHistoryMessages on ctx',
    ok: indexJs.includes('ctx.delegationHistoryMessages = historyMessages'),
  },
  {
    name: 'agent-send passes channelContext to internal runner',
    ok: agentSend.includes('channelContext: ctx?.channelContext'),
  },
  {
    name: 'internal turn adds pair history as extra system block',
    ok: internalTurn.includes('buildPairHistoryContextBlock(pairHistoryMessages, callerAgentId)'),
  },
  {
    name: 'internal turn uses channel session bootstrap when delegating',
    ok: internalTurn.includes('channelCtx?.sessionBootstrap'),
  },
  {
    name: 'internal turn includes team prompt block like main',
    ok: internalTurn.includes('buildAgentTeamPromptBlock(agentId)'),
  },
];

let failed = 0;
console.log('Shared delegation history contract\n');
for (const c of checks) {
  process.stdout.write(`  ${c.name} … `);
  if (c.ok) {
    console.log('✅');
  } else {
    console.log('❌');
    failed++;
  }
}

console.log('\n| Test | Status |');
console.log('| --- | --- |');
for (const c of checks) {
  console.log(`| ${c.name} | ${c.ok ? '✅ Pass' : '❌ Fail'} |`);
}

process.exit(failed ? 1 : 0);
