#!/usr/bin/env node
/**
 * Unit tests for specialization-aware pre-routing to agent-send.
 */

import { createTempStateDir } from './e2e-run.js';
import { setupAgentTeamFixture, patchAgentConfig } from './agent-team-fixture.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  await setupAgentTeamFixture(stateDir);

  const { getEnabledSkillIds } = await import('../../skills/loader.js');
  const { buildDelegationContext } = await import('../../lib/agent-delegation-router.js');

  const availableSkillIds = getEnabledSkillIds({ agentId: 'main' });
  assert(availableSkillIds.includes('agent-send'), 'Expected main to have agent-send enabled');

  const marketing = await buildDelegationContext({
    agentId: 'main',
    userText: 'I need a weekly content calendar and newsletter plan for our product launch.',
    availableSkillIds,
  });
  assert(marketing?.recommendation?.targetAgentId === 'marketer', `Expected marketer recommendation, got ${marketing?.recommendation?.targetAgentId || 'none'}`);
  assert(typeof marketing?.recommendation?.confidence === 'number', 'Expected confidence score on recommendation');
  assert(
    (marketing?.recommendation?.reason || '').toLowerCase().includes('request contains'),
    `Expected natural-language reason, got: ${marketing?.recommendation?.reason || 'none'}`,
  );
  assert(Array.isArray(marketing?.candidates) && marketing.candidates.length >= 1, 'Expected ranked candidate list');

  const engineering = await buildDelegationContext({
    agentId: 'main',
    userText: 'Can you investigate why our GitHub CI check is failing and propose a fix?',
    availableSkillIds,
  });
  assert(engineering?.recommendation?.targetAgentId === 'alex', `Expected alex recommendation, got ${engineering?.recommendation?.targetAgentId || 'none'}`);

  const greeting = await buildDelegationContext({
    agentId: 'main',
    userText: 'Hi',
    availableSkillIds,
  });
  assert(greeting === null, 'Expected no delegation recommendation for greeting');

  const taskCount = await buildDelegationContext({
    agentId: 'main',
    userText: 'How many tasks or todos are there with agents?',
    availableSkillIds,
  });
  assert(taskCount === null, 'Expected no agent-send recommendation for tracker status questions');

  const marketingTypo = await buildDelegationContext({
    agentId: 'main',
    userText: 'what can be 3 blog ideas for marketting nextpostai.com',
    availableSkillIds,
  });
  assert(
    marketingTypo?.recommendation?.targetAgentId === 'marketer',
    `Expected marketer recommendation for marketing typo, got ${marketingTypo?.recommendation?.targetAgentId || 'none'}`,
  );

  await patchAgentConfig('marketer', { title: 'Chloe' });
  const afterRename = await buildDelegationContext({
    agentId: 'main',
    userText: "What's our company tagline for marketing materials?",
    availableSkillIds,
  });
  assert(
    afterRename?.recommendation?.targetAgentId === 'marketer',
    `Expected marketer after title rename to Chloe, got ${afterRename?.recommendation?.targetAgentId || 'none'} (score=${afterRename?.candidates?.[0]?.score})`,
  );

  await patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
  const backendNotLinkedNatural = await buildDelegationContext({
    agentId: 'main',
    userText: 'Can you investigate why our GitHub CI check is failing and propose a fix?',
    availableSkillIds,
  });
  assert(
    backendNotLinkedNatural?.recommendation?.targetAgentId !== 'alex',
    `Expected no alex recommendation when backend agent is not linked, got ${JSON.stringify(backendNotLinkedNatural?.recommendation || null)}`,
  );

  // Unit contract only: explicit agent name when target exists but is not linked.
  const alexNotLinkedExplicit = await buildDelegationContext({
    agentId: 'main',
    userText: "Can you check with Alex if he's around?",
    availableSkillIds,
  });
  assert(
    alexNotLinkedExplicit?.recommendation?.targetAgentId === 'alex' && alexNotLinkedExplicit?.recommendation?.blocked === true,
    `Expected blocked explicit alex recommendation, got ${JSON.stringify(alexNotLinkedExplicit?.recommendation || null)}`,
  );

  console.log('agent-delegation-router tests passed');
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

