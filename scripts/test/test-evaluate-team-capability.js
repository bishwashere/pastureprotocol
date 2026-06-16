#!/usr/bin/env node
/**
 * Tests for evaluate-team-capability: input → system → check output.
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
  const { evaluateTeamCapability, isNonTaskMessage } = await import('../../lib/agent/evaluate-team-capability.js');

  const ids = getEnabledSkillIds({ agentId: 'main' });

  assert(isNonTaskMessage('hi'), 'hi is non-task');
  assert(isNonTaskMessage('thanks'), 'thanks is non-task');
  assert(!isNonTaskMessage('fix the nginx error'), 'fix is a task');

  const casual = evaluateTeamCapability({
    agentId: 'main',
    userText: 'hi',
    availableSkillIds: ids,
  });
  assert(casual === null, 'Casual message returns null');

  const result = evaluateTeamCapability({
    agentId: 'main',
    userText: "What's our company tagline for marketing materials?",
    availableSkillIds: ids,
  });
  assert(result, 'Task request returns a result');
  assert(result.callerAgentId === 'main', 'Caller is main');
  assert(Array.isArray(result.agents), 'Agents is an array');
  assert(result.recommendation?.action, 'Has recommendation action');

  await patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
  const alexExplicit = evaluateTeamCapability({
    agentId: 'main',
    userText: "Can you check with Alex if he's around?",
    availableSkillIds: getEnabledSkillIds({ agentId: 'main' }),
  });
  assert(
    alexExplicit?.recommendation?.action === 'delegate' && alexExplicit.recommendation.blocked === true,
    'Explicit mention of unlinked agent is blocked',
  );

  console.log('evaluate-team-capability tests passed');
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
