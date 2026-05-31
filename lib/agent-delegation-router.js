import { evaluateTeamCapability } from './evaluate-team-capability.js';

export {
  normalizeText,
  tokenize,
  normalizeConceptToken,
  looksLikeTaskRequest,
  detectExplicitTargetAgent,
  scoreAgentForMessage,
  withConfidence,
} from './evaluate-team-capability.js';

/**
 * Pre-turn delegation context for intent planner and optional forced agent-send.
 * Uses evaluateTeamCapability for scoring; only auto-delegates on strong specialist match.
 */
export function buildDelegationContext({
  agentId = 'main',
  userText = '',
  availableSkillIds = [],
  minScore = 10,
} = {}) {
  const evaluation = evaluateTeamCapability({
    agentId,
    userText,
    availableSkillIds,
    minDelegateScore: minScore,
  });
  if (!evaluation) return null;

  const { agents, recommendation } = evaluation;
  const candidates = agents
    .filter((a) => a.agentId !== agentId)
    .map((a) => ({
      agentId: a.agentId,
      title: a.title,
      score: a.score,
      confidence: a.confidence,
      matchedSkills: a.matchedSkills,
      matchedConcepts: a.matchedConcepts,
      reasoning: a.reasoning || '',
    }));

  if (recommendation?.action === 'delegate' && recommendation.targetAgentId) {
    const target = agents.find((a) => a.agentId === recommendation.targetAgentId) || {};
    return {
      candidates,
      teamCapability: evaluation,
      recommendation: {
        mode: 'delegate',
        action: 'delegate',
        targetAgentId: recommendation.targetAgentId,
        score: Number(target.score || 0),
        confidence: Number(target.confidence || 0),
        matchedSkills: target.matchedSkills || [],
        matchedConcepts: target.matchedConcepts || [],
        blocked: !!recommendation.blocked,
        reason: recommendation.reason || '',
        offerUpgrade: !!recommendation.offerUpgrade,
      },
    };
  }

  return {
    candidates,
    teamCapability: evaluation,
    recommendation: recommendation
      ? {
          mode: 'coordinator',
          action: recommendation.action,
          targetAgentId: recommendation.targetAgentId || '',
          score: 0,
          confidence: Number(recommendation.coordinatorConfidence || 0),
          matchedSkills: [],
          matchedConcepts: [],
          reason: recommendation.reason || '',
          offerUpgrade: !!recommendation.offerUpgrade,
          suggestedDomain: recommendation.suggestedDomain || '',
        }
      : null,
  };
}
