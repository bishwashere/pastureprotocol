#!/usr/bin/env node
/**
 * Unit tests for LLM fallback delegation router (hybrid routing).
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

  const { getAgentWorkspaceDir } = await import('../../lib/paths.js');
  writeFileSync(
    join(getAgentWorkspaceDir('marketer'), 'SOUL.md'),
    'You are the marketing specialist. You own growth, analytics, SEO, content strategy, and brand positioning for products.',
    'utf8',
  );

  const {
    needsLlmDelegationRouter,
    parseDelegationRouterResponse,
    mergeLlmDelegationIntoContext,
    buildAgentRoutingProfile,
    MIN_LLM_DELEGATE_CONFIDENCE,
  } = await import('../../lib/delegation-llm-router.js');
  const { buildKeywordDelegationContext, buildDelegationContext } = await import('../../lib/agent-delegation-router.js');
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

  const keywordCtx = buildKeywordDelegationContext({
    agentId: 'main',
    userText: 'Check NextPostAI growth',
    availableSkillIds: ids,
  });
  assert(keywordCtx?.recommendation?.action === 'create-new', `expected create-new, got ${keywordCtx?.recommendation?.action}`);
  assert(
    needsLlmDelegationRouter(keywordCtx.teamCapability, keywordCtx.teamCapability.recommendation),
    'needs LLM for create-new',
  );

  const mockLlm = async () => JSON.stringify({
    action: 'delegate',
    targetAgentId: 'marketer',
    confidence: 0.91,
    reason: 'Growth checks are marketing and analytics work.',
  });

  const hybrid = await buildDelegationContext({
    agentId: 'main',
    userText: 'Check NextPostAI growth',
    availableSkillIds: ids,
    llmChat: mockLlm,
  });
  assert(hybrid?.recommendation?.action === 'delegate', `expected delegate, got ${hybrid?.recommendation?.action}`);
  assert(hybrid.recommendation.targetAgentId === 'marketer', `expected marketer, got ${hybrid.recommendation.targetAgentId}`);
  assert(hybrid.recommendation.routingMethod === 'llm', 'routingMethod llm');
  assert(hybrid.recommendation.confidence >= MIN_LLM_DELEGATE_CONFIDENCE, 'llm confidence');

  const merged = mergeLlmDelegationIntoContext(keywordCtx, {
    action: 'handle-in-main',
    targetAgentId: '',
    confidence: 0.55,
    reason: 'Coordinator should synthesize.',
    routingMethod: 'llm',
  });
  assert(merged.recommendation.llmAction === 'handle-in-main', 'llm meta on handle-in-main');

  process.env.PASTURE_LLM_DELEGATION_ROUTER = '0';
  const keywordOnly = await buildDelegationContext({
    agentId: 'main',
    userText: 'Check NextPostAI growth',
    availableSkillIds: ids,
    llmChat: mockLlm,
  });
  assert(keywordOnly?.recommendation?.action === 'create-new', 'disabled LLM keeps keyword action');

  console.log('| Test | Input | Output | Status |');
  console.log('| --- | --- | --- | --- |');
  console.log('| test-delegation-llm-router | Check NextPostAI growth + mock LLM | delegate → marketer | ✅ Pass |');
  console.log('| test-delegation-llm-router | LLM disabled env | create-new (keyword) | ✅ Pass |');
  console.log('\ndelegation-llm-router tests passed');
}

run().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
