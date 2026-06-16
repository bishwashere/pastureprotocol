#!/usr/bin/env node
/**
 * Tests for delegation LLM router: input → system → check output.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { createTempStateDir } from './e2e-run.js';
import { setupAgentTeamFixture } from './agent-team-fixture.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const stateDir = createTempStateDir();
  await setupAgentTeamFixture(stateDir);
  process.env.PASTURE_LLM_DELEGATION_ROUTER = '1';

  const { getAgentWorkspaceDir } = await import('../../lib/util/paths.js');
  writeFileSync(
    join(getAgentWorkspaceDir('marketer'), 'SOUL.md'),
    'You are the marketing specialist. You own growth, analytics, SEO, content strategy, and brand positioning for products.',
    'utf8',
  );

  const { parseDelegationRouterResponse, buildAgentRoutingProfile } = await import('../../lib/agent/delegation-llm-router.js');
  const { buildDelegationContext } = await import('../../lib/agent/agent-delegation-router.js');
  const { getEnabledSkillIds } = await import('../../skills/loader.js');

  const ids = getEnabledSkillIds({ agentId: 'main' });

  const profile = buildAgentRoutingProfile('marketer');
  assert(profile && profile.agentId === 'marketer', 'profile agent id');
  assert(profile.soul.includes('growth'), 'profile includes SOUL excerpt');

  const parsed = parseDelegationRouterResponse(
    JSON.stringify({
      action: 'delegate',
      targetAgentId: 'marketer',
      confidence: 0.88,
      reason: 'Growth analysis is marketing work.',
    }),
    ['marketer', 'alex'],
  );
  assert(parsed.action === 'delegate' && parsed.targetAgentId === 'marketer', 'parse delegate');

  const lowConf = parseDelegationRouterResponse(
    JSON.stringify({ action: 'delegate', targetAgentId: 'marketer', confidence: 0.4, reason: 'maybe' }),
    ['marketer'],
  );
  assert(lowConf.action === 'handle-in-main', 'low confidence stays in main');

  const ctx = await buildDelegationContext({
    agentId: 'main',
    userText: 'Check NextPostAI growth',
    availableSkillIds: ids,
  });
  assert(ctx, 'Expected delegation context');
  assert(ctx.recommendation?.action, 'Expected recommendation action');

  console.log('delegation-llm-router tests passed');
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
