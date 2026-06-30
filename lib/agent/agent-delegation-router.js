import { evaluateTeamCapability } from './evaluate-team-capability.js';
import {
  getEligibleDelegationTargets,
  mergeLlmDelegationIntoContext,
  planDelegationWithLlm,
} from './delegation-llm-router.js';

export {
  normalizeText,
  looksLikeTaskRequest,
  detectExplicitTargetAgent,
} from './evaluate-team-capability.js';

export {
  buildAgentRoutingProfile,
  parseDelegationRouterResponse,
  planDelegationWithLlm,
  mergeLlmDelegationIntoContext,
  MIN_LLM_DELEGATE_CONFIDENCE,
  isLlmDelegationRouterEnabled,
} from './delegation-llm-router.js';

function mapDelegationContext(evaluation, agentId) {
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
        routingMethod: 'keyword',
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
          routingMethod: 'keyword',
        }
      : null,
  };
}

function looksLikeTeamStatusRequest(userText) {
  const t = String(userText || '').toLowerCase();
  return (
    /\bhow many agents\b/.test(t) ||
    /\brecent movements?\b/.test(t) ||
    /\blast (?:five|5) tasks?\b/.test(t) ||
    /\bneed(?:s)? of attention\b/.test(t) ||
    /\bwhat(?:'s| is) in attention\b/.test(t) ||
    (/\bcompleted work\b/.test(t) && /\battention|need|blocked|done\b/.test(t))
  );
}

function coordinatorOnlyContext(agentId, reason) {
  return {
    candidates: [],
    teamCapability: {
      request: reason,
      callerAgentId: agentId,
      agents: [],
      recommendation: {
        action: 'handle-in-main',
        targetAgentId: '',
        coordinatorConfidence: 1,
        reason,
      },
    },
    recommendation: {
      mode: 'coordinator',
      action: 'handle-in-main',
      targetAgentId: '',
      score: 0,
      confidence: 1,
      matchedSkills: [],
      matchedConcepts: ['team-status'],
      reason,
      offerUpgrade: false,
      routingMethod: 'team-status',
    },
  };
}

/**
 * Synchronous base delegation context: covers explicit agent mentions and the
 * coordinator-only short-circuit. Returns null when no team capability applies.
 *
 * No keyword-scoring engine — that was removed when the team capability check
 * was simplified. Anything past explicit mention falls through to the LLM
 * router via `buildDelegationContext`.
 */
export function buildBaseDelegationContext({
  agentId = 'main',
  userText = '',
  availableSkillIds = [],
} = {}) {
  const evaluation = evaluateTeamCapability({ agentId, userText, availableSkillIds });
  if (!evaluation) return null;
  return mapDelegationContext(evaluation, agentId);
}

/**
 * Pre-turn delegation context for turn router and optional forced agent-send.
 * Explicit agent mentions are handled deterministically; everything else goes to the LLM router.
 */
export async function buildDelegationContext(opts = {}) {
  const agentId = opts.agentId || 'main';
  if (looksLikeTeamStatusRequest(opts.userText || '')) {
    return coordinatorOnlyContext(agentId, 'Team status questions should be answered from the local team snapshot.');
  }
  const ctx = buildBaseDelegationContext(opts);
  if (!ctx?.teamCapability || !ctx.recommendation) return ctx;

  const rec = ctx.teamCapability.recommendation || {};
  if (rec.action === 'delegate' && rec.targetAgentId) return ctx;

  const eligibleTargetIds = getEligibleDelegationTargets(agentId);
  const llmResult = await planDelegationWithLlm({
    agentId,
    userText: opts.userText || '',
    evaluation: ctx.teamCapability,
    eligibleTargetIds,
    llmChat: opts.llmChat,
  });
  if (!llmResult) return ctx;

  return mergeLlmDelegationIntoContext(ctx, llmResult);
}

/** @deprecated Use `buildBaseDelegationContext` — alias kept for legacy tests. */
export const buildKeywordDelegationContext = buildBaseDelegationContext;
/** @deprecated Use `buildDelegationContext` — alias kept for legacy tests. */
export const buildDelegationContextSync = buildBaseDelegationContext;
