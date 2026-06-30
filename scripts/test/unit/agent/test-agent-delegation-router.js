#!/usr/bin/env node
/**
 * Tests for agent-delegation-router: input → system → check output.
 */

import { createTempStateDir } from '../../support/e2e-run.js';
import { setupAgentTeamFixture, patchAgentConfig } from '../../support/agent-team-fixture.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  await setupAgentTeamFixture(stateDir);

  const { getEnabledSkillIds } = await import('../../../../skills/loader.js');
  const { buildDelegationContext } = await import('../../../../lib/agent/agent-delegation-router.js');

  const availableSkillIds = getEnabledSkillIds({ agentId: 'main' });
  assert(availableSkillIds.includes('agent-send'), 'Expected main to have agent-send enabled');

  const greeting = await buildDelegationContext({
    agentId: 'main',
    userText: 'Hi',
    availableSkillIds,
  });
  assert(greeting === null, 'Expected no delegation for greeting');

  const marketing = await buildDelegationContext({
    agentId: 'main',
    userText: 'I need a weekly content calendar and newsletter plan for our product launch.',
    availableSkillIds,
  });
  assert(marketing, 'Expected delegation context for marketing request');
  assert(marketing.recommendation?.action, 'Expected recommendation action');

  await patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
  const alexNotLinked = await buildDelegationContext({
    agentId: 'main',
    userText: "Can you check with Alex if he's around?",
    availableSkillIds,
  });
  assert(
    alexNotLinked?.recommendation?.targetAgentId === 'alex' && alexNotLinked?.recommendation?.blocked === true,
    `Expected blocked explicit alex recommendation, got ${JSON.stringify(alexNotLinked?.recommendation || null)}`,
  );

  console.log('agent-delegation-router tests passed');
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
