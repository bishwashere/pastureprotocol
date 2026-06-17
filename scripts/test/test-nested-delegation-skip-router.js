#!/usr/bin/env node
/**
 * Audit finding #25: every nested `agent-send` used to make the target
 * specialist re-run the delegation-router LLM call to "decide who handles
 * this" — but the parent had already decided. That doubled (or worse)
 * latency on multi-hop delegation.
 *
 * Now agent-send passes `skipDelegationRouter: true` to the nested runner,
 * and runInternalAgentTurn honors it by not calling buildDelegationContext.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const internal = readFileSync(join(root, 'lib/agent/internal-agent-turn.js'), 'utf8');
const agentSend = readFileSync(join(root, 'lib/agent/executors/agent-send.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`[PASS] ${name}`); passed++; }
  else { console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`); failed++; }
}

check(
  'agent-send passes skipDelegationRouter: true on nested call',
  /runner\(\{[\s\S]{0,800}?skipDelegationRouter:\s*true/.test(agentSend)
);
check(
  'runInternalAgentTurn accepts skipDelegationRouter opt',
  /runInternalAgentTurn\(\{[\s\S]{0,400}?skipDelegationRouter\s*=\s*false,?[\s\S]{0,40}?\}\)/.test(internal)
);
check(
  'runInternalAgentTurn skips buildDelegationContext when flag is true',
  /skipDelegationRouter[\s\S]{0,200}?\?\s*null[\s\S]{0,200}?:\s*await\s+buildDelegationContext/.test(internal)
);
check(
  'runInternalAgentTurn cites audit finding #25',
  /audit\s+finding\s+#25/i.test(internal)
);

console.log(`\n[nested-delegation-skip-router] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
