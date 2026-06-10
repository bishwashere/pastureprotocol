/**
 * Thin utilities for message classification — no keyword scoring engine.
 * Delegation routing is handled entirely by the LLM router in delegation-llm-router.js.
 */

import {
  getAgentTitle,
  listVisibleAgentIds,
  resolveAgentReference,
  getAgentMessagingPolicy,
} from './agent-config.js';

const NON_TASK_MESSAGES = new Set([
  'hi', 'hello', 'hey', 'thanks', 'thank you',
  'ok', 'okay', 'cool', 'great',
]);

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Greetings and other messages that must not trigger tools, search, or research-style replies. */
export function isNonTaskMessage(userText) {
  const text = normalizeText(userText);
  if (!text) return true;
  if (NON_TASK_MESSAGES.has(text)) return true;
  const stripped = text.replace(/[!?.,:;]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (NON_TASK_MESSAGES.has(stripped)) return true;
  if (text.length <= 28 && /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|good morning|good evening|howdy|yo)([\s,!?.]|$)/.test(text)) {
    return true;
  }
  return false;
}

export function looksLikeTaskRequest(userText) {
  return !isNonTaskMessage(userText);
}

export function detectExplicitTargetAgent(userText, callerAgentId, visibleAgentIds) {
  const textNorm = normalizeText(userText);
  if (!textNorm) return '';
  for (const token of textNorm.split(/\s+/)) {
    const resolved = resolveAgentReference(token);
    if (resolved && resolved !== callerAgentId && visibleAgentIds.includes(resolved)) return resolved;
  }
  for (const agentId of visibleAgentIds) {
    if (agentId === callerAgentId) continue;
    if (textNorm.includes(agentId.toLowerCase())) return agentId;
    const title = normalizeText(getAgentTitle(agentId));
    if (title && textNorm.includes(title)) return agentId;
  }
  return '';
}

/**
 * Lightweight team capability check — just detects explicit agent mentions
 * and returns a minimal context for the LLM router to work with.
 */
export function evaluateTeamCapability({
  agentId = 'main',
  userText = '',
  availableSkillIds = [],
} = {}) {
  if (!Array.isArray(availableSkillIds) || !availableSkillIds.includes('agent-send')) return null;
  if (isNonTaskMessage(userText)) return null;

  const policy = getAgentMessagingPolicy(agentId);
  if (!Array.isArray(policy.allow) || policy.allow.length === 0) return null;

  const visible = new Set(listVisibleAgentIds());
  const eligibleTargets = policy.allow.filter((id) => visible.has(id) && id !== agentId);
  if (eligibleTargets.length === 0) return null;

  const visibleTargets = listVisibleAgentIds().filter((id) => id !== agentId);
  const explicitTarget = detectExplicitTargetAgent(userText, agentId, visibleTargets);

  if (explicitTarget) {
    const blocked = !eligibleTargets.includes(explicitTarget);
    return {
      request: String(userText || '').trim(),
      callerAgentId: agentId,
      agents: [{
        agentId: explicitTarget,
        title: getAgentTitle(explicitTarget) || explicitTarget,
        role: 'specialist',
        linked: !blocked,
        score: 0,
        confidence: 1,
        confidencePct: '100%',
        matchedSkills: [],
        matchedConcepts: [],
        reasoning: `User explicitly mentioned ${explicitTarget}.`,
      }],
      recommendation: {
        action: blocked ? 'delegate' : 'delegate',
        targetAgentId: explicitTarget,
        blocked,
        reason: blocked
          ? `User explicitly requested ${explicitTarget}, but it is not linked from ${agentId}.`
          : `User explicitly requested ${explicitTarget}.`,
        coordinatorConfidence: 0,
        topSpecialistId: explicitTarget,
        topSpecialistConfidence: 1,
      },
    };
  }

  return {
    request: String(userText || '').trim(),
    callerAgentId: agentId,
    agents: eligibleTargets.map((id) => ({
      agentId: id,
      title: getAgentTitle(id) || id,
      role: 'specialist',
      linked: true,
      score: 0,
      confidence: 0,
      confidencePct: '0%',
      matchedSkills: [],
      matchedConcepts: [],
      reasoning: '',
    })),
    recommendation: {
      action: 'handle-in-main',
      reason: 'No explicit agent mention — defer to LLM router.',
      coordinatorConfidence: 0,
      topSpecialistId: '',
      topSpecialistConfidence: 0,
    },
  };
}
