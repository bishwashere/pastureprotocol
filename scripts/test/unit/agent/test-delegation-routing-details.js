#!/usr/bin/env node
/**
 * Tests for delegation-routing-details: input → system → check output.
 */

import { createTempStateDir } from '../../support/e2e-run.js';
import { setupAgentTeamFixture } from '../../support/agent-team-fixture.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  await setupAgentTeamFixture(stateDir);

  const { getEnabledSkillIds } = await import('../../../../skills/loader.js');
  const { buildDelegationContext } = await import('../../../../lib/agent/agent-delegation-router.js');
  const { buildDelegationDecisionDetails } = await import('../../../../lib/agent/delegation-routing-details.js');

  const ids = getEnabledSkillIds({ agentId: 'main' });

  const ctx = await buildDelegationContext({
    agentId: 'main',
    userText: "What's our company tagline for marketing materials?",
    availableSkillIds: ids,
  });
  assert(ctx, 'expected delegation context');
  const details = buildDelegationDecisionDetails(ctx);
  assert(details && details.reason, 'reason present');
  assert(typeof details.action === 'string', 'action is string');

  console.log('delegation-routing-details tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
