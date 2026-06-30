#!/usr/bin/env node
/**
 * Contract: when evaluateTeamCapability returns
 * { recommendation: { action: 'delegate', blocked: true } } (i.e. user
 * explicitly mentioned an agent they aren't linked to), neither index.js
 * nor internal-agent-turn.js should build presetDelegationPlan and force
 * an agent-send call. The coordinator must answer instead.
 *
 * Textual contract test (matches the convention of
 * test-shared-delegation-history.js / test-tool-call-retry-exhaustion.js)
 * because runAgentTurn / index dispatch is too tightly coupled to a real
 * LLM client to dependency-inject easily.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const indexJs = readFileSync(join(root, 'index.js'), 'utf8');
const internalTurn = readFileSync(join(root, 'lib/agent/internal-agent-turn.js'), 'utf8');

const checks = [
  {
    name: 'index.js: presetDelegationPlan gated on !delegationBlocked',
    ok: /presetDelegationPlan\s*=[\s\S]{0,200}?!delegationBlocked/.test(indexJs),
  },
  {
    name: 'index.js: extracts delegationBlocked from recommendation.blocked',
    ok: /const\s+delegationBlocked\s*=\s*!!delegationContext\?\.recommendation\?\.blocked/.test(indexJs),
  },
  {
    name: 'index.js: blocked-explicit case is logged with status=blocked',
    ok: /delegationBlocked[\s\S]{0,400}?status:\s*['"]blocked['"]/.test(indexJs),
  },
  {
    name: 'internal-agent-turn.js: presetDelegationPlan gated on !recommendation.blocked',
    ok: /presetDelegationPlan\s*=[\s\S]{0,300}?!delegationContext\?\.recommendation\?\.blocked/.test(internalTurn),
  },
  {
    name: 'index.js: comment explains why blocked targets are skipped',
    ok: /not linked from this[\s\S]{0,80}caller[\s\S]{0,120}wastes/i.test(indexJs)
      || /forced agent-send would just fail at the[\s\S]{0,40}policy check/i.test(indexJs)
      || /just wastes an LLM call/i.test(indexJs),
  },
  {
    name: 'internal-agent-turn.js: comment explains why blocked targets are skipped',
    ok: /forced agent-send would just fail at the\s*\/\/\s*policy check/i.test(internalTurn)
      || /policy check[\s\S]{0,80}wasting the LLM round/i.test(internalTurn)
      || /isn't linked from this[\s\S]{0,80}caller/i.test(internalTurn),
  },
];

let failed = 0;
console.log('Blocked-delegation gate contract\n');
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
