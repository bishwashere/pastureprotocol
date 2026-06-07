#!/usr/bin/env node
/**
 * Unit tests for evaluate-team-capability scoring and recommendations.
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
  const { evaluateTeamCapability } = await import('../../lib/evaluate-team-capability.js');
  const { buildDelegationContext } = await import('../../lib/agent-delegation-router.js');
  const { executeEvaluateTeamCapability } = await import('../../lib/executors/evaluate-team-capability.js');
  const { agentSendEnabledForAgent } = await import('../../lib/agent-config.js');

  const ids = getEnabledSkillIds({ agentId: 'main' });
  assert(ids.includes('agent-send'), 'Expected agent-send on main with team links');
  assert(ids.includes('evaluate-team-capability'), 'Expected evaluate-team-capability on main with team links');
  assert(agentSendEnabledForAgent('main'), 'agentSendEnabledForAgent main');

  const marketing = evaluateTeamCapability({
    agentId: 'main',
    userText: "What's our company tagline for marketing materials?",
    availableSkillIds: ids,
  });
  assert(marketing?.recommendation?.action === 'delegate', `Expected delegate for marketing, got ${marketing?.recommendation?.action}`);
  assert(marketing.recommendation.targetAgentId === 'marketer', `Expected marketer, got ${marketing?.recommendation?.targetAgentId}`);

  const fitness = evaluateTeamCapability({
    agentId: 'main',
    userText: 'I want to get in shape this summer',
    availableSkillIds: ids,
  });
  assert(
    fitness?.recommendation?.action === 'create-new' || fitness?.recommendation?.action === 'handle-in-main',
    `Expected create-new or handle-in-main for fitness, got ${fitness?.recommendation?.action}`,
  );
  const mainRank = fitness.agents.find((a) => a.agentId === 'main');
  assert(mainRank && Number(mainRank.confidence) > 0.5, `Expected main to lead fitness ranking, got ${mainRank?.confidencePct}`);
  assert(fitness.recommendation.offerUpgrade === true, 'Expected upgrade offer for unmatched domain');

  const ctx = await buildDelegationContext({
    agentId: 'main',
    userText: 'I want to get in shape this summer',
    availableSkillIds: ids,
  });
  assert(ctx?.teamCapability, 'Expected teamCapability on delegation context');
  assert(!ctx?.recommendation?.targetAgentId, 'Fitness should not auto-select delegate target');

  const metaStatus = evaluateTeamCapability({
    agentId: 'main',
    userText: 'How many tasks or todos are there with agents?',
    availableSkillIds: ids,
  });
  assert(metaStatus === null, 'Tracker status questions should not auto-route to a teammate');

  const toolRaw = await executeEvaluateTeamCapability({ agentId: 'main' }, { request: 'I want to get in shape this summer' });
  const toolOut = JSON.parse(toolRaw);
  assert(Array.isArray(toolOut.agents) && toolOut.agents.length >= 2, 'Tool should return ranked agents');
  assert(toolOut.recommendation?.action, 'Tool should return recommendation action');

  await patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
  const alexExplicit = evaluateTeamCapability({
    agentId: 'main',
    userText: "Can you check with Alex if he's around?",
    availableSkillIds: getEnabledSkillIds({ agentId: 'main' }),
  });
  assert(
    alexExplicit?.recommendation?.action === 'delegate' && alexExplicit.recommendation.blocked === true,
    `Expected blocked explicit alex delegate, got ${JSON.stringify(alexExplicit?.recommendation)}`,
  );

  console.log('evaluate-team-capability tests passed');
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
