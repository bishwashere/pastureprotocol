/**
 * Evaluate team capability — ranked agent relevance + routing recommendation.
 */

import { evaluateTeamCapability } from '../evaluate-team-capability.js';

/**
 * @param {object} ctx - { agentId }
 * @param {{ request?: string }} args
 */
export async function executeEvaluateTeamCapability(ctx, args) {
  const callerAgentId = String(ctx?.agentId || 'main').trim() || 'main';
  const request = String(args?.request || args?.topic || args?.userText || '').trim();
  if (!request) {
    return JSON.stringify({ error: 'request is required (the user message or topic to evaluate).' });
  }

  const { getEnabledSkillIds } = await import('../../skills/loader.js');
  const availableSkillIds = getEnabledSkillIds({ agentId: callerAgentId });
  const evaluation = evaluateTeamCapability({
    agentId: callerAgentId,
    userText: request,
    availableSkillIds,
  });

  if (!evaluation) {
    return JSON.stringify({
      error: 'Team capability evaluation unavailable (no team links, not a task request, or agent-send not enabled).',
      recommendation: { action: 'handle-in-main', reason: 'Handle directly — no team routing context.' },
    });
  }

  return JSON.stringify(evaluation);
}
