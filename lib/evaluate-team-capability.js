import {
  getAgentMessagingPolicy,
  getAgentTitle,
  getAgentAliases,
  listVisibleAgentIds,
  resolveAgentReference,
} from './agent-config.js';
import { getEnabledSkillSummaries } from '../skills/loader.js';
import { isProjectMetaInquiry } from './task-intent.js';

const NON_TASK_MESSAGES = new Set([
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank you',
  'ok',
  'okay',
  'cool',
  'great',
]);
const ROUTING_STOP_TOKENS = new Set([
  'the',
  'this',
  'thi',
  'that',
  'with',
  'from',
  'your',
  'you',
  'our',
  'for',
  'and',
  'but',
  'want',
  'get',
  'got',
  'can',
  'could',
  'would',
  'should',
  'need',
  'have',
  'has',
  'had',
  'are',
  'there',
  'what',
  'whats',
  'why',
  'how',
  'when',
]);

export const MIN_DELEGATE_SCORE = 10;
export const MIN_DELEGATE_CONFIDENCE = 0.3;
export const GENERALIST_BASE_SCORE = 12;
export const ADAPT_MIN_SCORE = 5;

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  return normalizeText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ROUTING_STOP_TOKENS.has(stemToken(token)));
}

function stemToken(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/(ing|ers|er|ed|tion|s)$/g, '')
    .trim();
}

function hasFuzzyTokenMatch(token, textNorm) {
  const t = stemToken(token);
  if (!t || t.length < 4) return false;
  if (textNorm.includes(t)) return true;
  const words = textNorm.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const sw = stemToken(w);
    if (!sw) continue;
    const minLen = Math.min(sw.length, t.length);
    if (minLen >= 5 && sw.slice(0, minLen) === t.slice(0, minLen)) return true;
    if (minLen >= 5 && (sw.startsWith(t.slice(0, 5)) || t.startsWith(sw.slice(0, 5)))) return true;
  }
  return false;
}

export function normalizeConceptToken(token) {
  const t = stemToken(token);
  if (!t) return '';
  if (t.startsWith('market')) return 'marketing';
  if (t.startsWith('brand')) return 'branding';
  if (t.startsWith('camp')) return 'campaigns';
  if (t.startsWith('blog')) return 'blogging';
  if (t.startsWith('fit') || t.startsWith('workout') || t.startsWith('gym')) return 'fitness';
  if (t.startsWith('nutri') || t.startsWith('diet')) return 'nutrition';
  if (ROUTING_STOP_TOKENS.has(t)) return '';
  return t;
}

export function looksLikeTaskRequest(userText) {
  const text = normalizeText(userText);
  if (!text) return false;
  if (NON_TASK_MESSAGES.has(text)) return false;
  if (isProjectMetaInquiry(userText)) return false;
  if (text.length <= 16 && NON_TASK_MESSAGES.has(text.replace(/[!?.,]/g, '').trim())) return false;
  return true;
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

export function detectExplicitTargetAgent(userText, callerAgentId, visibleAgentIds) {
  const textNorm = normalizeText(userText);
  if (!textNorm) return '';
  const tokenSet = new Set(tokenize(textNorm));

  for (const token of tokenSet) {
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

export function scoreAgentForMessage({ userText, tokens, agentId }) {
  const messageNorm = normalizeText(userText);
  const title = String(getAgentTitle(agentId) || '').trim();
  const titleNorm = normalizeText(title);
  const idNorm = normalizeText(agentId);
  const aliasNorms = getAgentAliases(agentId).map((a) => normalizeText(a)).filter(Boolean);
  const summaries = getEnabledSkillSummaries({ agentId });
  let score = 0;
  const matchedSkills = [];
  const reasons = [];
  const matchedConcepts = [];

  for (const token of tokens) {
    if (idNorm && idNorm.includes(token)) {
      score += 6;
      reasons.push(`token "${token}" matched agent id`);
      const c = normalizeConceptToken(token);
      if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
    }
    if (idNorm && hasFuzzyTokenMatch(token, idNorm)) {
      score += 5;
      reasons.push(`token "${token}" fuzzily matched agent id`);
      const c = normalizeConceptToken(token);
      if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
    }
    if (titleNorm && titleNorm.includes(token)) {
      score += 6;
      reasons.push(`token "${token}" matched agent title`);
      const c = normalizeConceptToken(token);
      if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
    }
    if (titleNorm && hasFuzzyTokenMatch(token, titleNorm)) {
      score += 5;
      reasons.push(`token "${token}" fuzzily matched agent title`);
      const c = normalizeConceptToken(token);
      if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
    }
    for (const aliasNorm of aliasNorms) {
      if (aliasNorm.includes(token)) {
        score += 5;
        reasons.push(`token "${token}" matched agent alias`);
        const c = normalizeConceptToken(token);
        if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
      } else if (hasFuzzyTokenMatch(token, aliasNorm)) {
        score += 5;
        reasons.push(`token "${token}" fuzzily matched agent alias`);
        const c = normalizeConceptToken(token);
        if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
      }
    }
  }

  for (const summary of summaries) {
    const skillId = normalizeText(summary?.id || '');
    const desc = normalizeText(summary?.description || '');
    if (!skillId) continue;
    const skillWords = skillId.split(/[-_]/).filter((w) => w.length >= 3);
    let skillScore = 0;

    if (messageNorm.includes(skillId)) {
      skillScore += 10;
      const c = normalizeConceptToken(skillId);
      if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
    }
    for (const token of tokens) {
      if (skillWords.includes(token)) {
        skillScore += 4;
        const c = normalizeConceptToken(token);
        if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
      } else if (desc.includes(token)) {
        skillScore += 2;
        const c = normalizeConceptToken(token);
        if (c && !matchedConcepts.includes(c)) matchedConcepts.push(c);
      }
    }
    if (skillScore > 0) {
      score += skillScore;
      if (!matchedSkills.includes(summary.id)) matchedSkills.push(summary.id);
    }
  }

  return {
    agentId,
    title,
    score,
    matchedSkills: matchedSkills.slice(0, 8),
    matchedConcepts: matchedConcepts.slice(0, 8),
    reasons: reasons.slice(0, 6),
  };
}

function scoreCallerAsGeneralist({ userText, tokens, agentId, callerAgentId }) {
  if (agentId !== callerAgentId) return null;
  if (!looksLikeTaskRequest(userText)) {
    return {
      agentId,
      title: getAgentTitle(agentId) || agentId,
      score: 0,
      matchedSkills: [],
      matchedConcepts: [],
      reasons: ['Simple chat — coordinator does not need routing.'],
      role: 'coordinator',
    };
  }
  let score = GENERALIST_BASE_SCORE;
  const reasons = ['Generalist coordinator can handle this or offer a specialist upgrade.'];
  if (tokens.length >= 4) {
    score += 2;
    reasons.push('Multi-topic request favors coordinator synthesis.');
  }
  return {
    agentId,
    title: getAgentTitle(agentId) || agentId,
    score,
    matchedSkills: [],
    matchedConcepts: [],
    reasons,
    role: 'coordinator',
  };
}

export function withConfidence(ranked) {
  if (!Array.isArray(ranked) || ranked.length === 0) return [];
  const positive = ranked.map((c) => ({ ...c, score: Number(c.score || 0) }));
  const total = positive.reduce((acc, c) => acc + Math.max(0, c.score), 0);
  if (total <= 0) {
    const even = 1 / positive.length;
    return positive.map((c) => ({ ...c, confidence: Number(even.toFixed(4)) }));
  }
  return positive.map((c) => ({
    ...c,
    confidence: Number((Math.max(0, c.score) / total).toFixed(4)),
  }));
}

function buildSpecialistReason(best) {
  const concepts = Array.isArray(best?.matchedConcepts) ? best.matchedConcepts.filter(Boolean) : [];
  if (concepts.length > 0) {
    return `Request contains ${concepts.slice(0, 3).join(', ')} concepts.`;
  }
  const skills = Array.isArray(best?.matchedSkills) ? best.matchedSkills.filter(Boolean) : [];
  if (skills.length > 0) {
    return `Best specialization match on skills: ${skills.slice(0, 3).join(', ')}.`;
  }
  return 'Best specialization match by profile.';
}

function inferSuggestedDomain(userText, tokens) {
  const concepts = tokens.map(normalizeConceptToken).filter(Boolean);
  const unique = [...new Set(concepts)].filter((c) => !['what', 'this', 'that', 'with', 'from', 'your'].includes(c));
  if (unique.length > 0) return unique.slice(0, 2).join(' / ');
  const trimmed = String(userText || '').trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

function pickRecommendation({
  callerAgentId,
  callerRank,
  bestSpecialist,
  explicitTarget,
  eligibleTargets,
  userText,
  tokens,
}) {
  if (explicitTarget && !eligibleTargets.includes(explicitTarget)) {
    return {
      action: 'delegate',
      targetAgentId: explicitTarget,
      blocked: true,
      reason: `User explicitly requested ${explicitTarget}, but it is not linked from ${callerAgentId}.`,
      offerUpgrade: false,
    };
  }
  if (explicitTarget && eligibleTargets.includes(explicitTarget)) {
    return {
      action: 'delegate',
      targetAgentId: explicitTarget,
      reason: `User explicitly requested ${explicitTarget}.`,
      offerUpgrade: false,
    };
  }

  const callerScore = Number(callerRank?.score || 0);
  const specialistScore = Number(bestSpecialist?.score || 0);
  const specialistConfidence = Number(bestSpecialist?.confidence || 0);
  const specialistHasDomainMatch =
    (bestSpecialist?.matchedSkills?.length || 0) > 0
    || (bestSpecialist?.matchedConcepts?.length || 0) > 0;

  if (
    bestSpecialist
    && specialistScore >= MIN_DELEGATE_SCORE
    && specialistConfidence >= MIN_DELEGATE_CONFIDENCE
    && (specialistHasDomainMatch || specialistScore > callerScore)
  ) {
    return {
      action: 'delegate',
      targetAgentId: bestSpecialist.agentId,
      reason: buildSpecialistReason(bestSpecialist),
      offerUpgrade: false,
    };
  }

  if (bestSpecialist && specialistScore >= ADAPT_MIN_SCORE && specialistScore < MIN_DELEGATE_SCORE) {
    return {
      action: 'adapt',
      targetAgentId: bestSpecialist.agentId,
      reason: `${getAgentTitle(bestSpecialist.agentId) || bestSpecialist.agentId} is a partial match — consider adapting their skills or delegating with caveats.`,
      offerUpgrade: true,
      suggestedDomain: inferSuggestedDomain(userText, tokens),
    };
  }

  if (looksLikeTaskRequest(userText) && specialistScore < ADAPT_MIN_SCORE) {
    return {
      action: 'create-new',
      reason: 'No linked teammate strongly matches this domain.',
      offerUpgrade: true,
      suggestedDomain: inferSuggestedDomain(userText, tokens),
    };
  }

  return {
    action: 'handle-in-main',
    reason: 'No strong specialist — handle as coordinator.',
    offerUpgrade: looksLikeTaskRequest(userText),
    suggestedDomain: looksLikeTaskRequest(userText) ? inferSuggestedDomain(userText, tokens) : '',
  };
}

/**
 * Evaluate which team member (including the caller/coordinator) best fits a user request.
 *
 * @returns {{
 *   request: string,
 *   callerAgentId: string,
 *   agents: Array<object>,
 *   recommendation: object,
 * } | null}
 */
export function evaluateTeamCapability({
  agentId = 'main',
  userText = '',
  availableSkillIds = [],
  minDelegateScore = MIN_DELEGATE_SCORE,
} = {}) {
  if (!Array.isArray(availableSkillIds) || !availableSkillIds.includes('agent-send')) return null;
  if (!looksLikeTaskRequest(userText)) return null;

  const policy = getAgentMessagingPolicy(agentId);
  if (!Array.isArray(policy.allow) || policy.allow.length === 0) return null;

  const visible = new Set(listVisibleAgentIds());
  const eligibleTargets = policy.allow.filter((id) => visible.has(id) && id !== agentId);
  if (eligibleTargets.length === 0) return null;

  const visibleTargets = listVisibleAgentIds().filter((id) => id !== agentId);
  const explicitTarget = detectExplicitTargetAgent(userText, agentId, visibleTargets);
  const tokens = tokenize(userText);

  const scored = [
    scoreCallerAsGeneralist({ userText, tokens, agentId, callerAgentId: agentId }),
    ...eligibleTargets.map((targetId) => ({
      ...scoreAgentForMessage({ userText, tokens, agentId: targetId }),
      role: 'specialist',
      linked: true,
    })),
  ].filter(Boolean);

  const ranked = withConfidence(scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedSkills?.length !== a.matchedSkills?.length) {
      return (b.matchedSkills?.length || 0) - (a.matchedSkills?.length || 0);
    }
    return a.agentId.localeCompare(b.agentId);
  }));

  const callerRank = ranked.find((r) => r.agentId === agentId) || null;
  const specialists = ranked.filter((r) => r.agentId !== agentId);
  const bestSpecialist = specialists[0] || null;

  const recommendation = pickRecommendation({
    callerAgentId: agentId,
    callerRank,
    bestSpecialist,
    explicitTarget,
    eligibleTargets,
    userText,
    tokens,
  });

  // Apply runtime min score override for delegate threshold checks in router.
  if (
    recommendation.action === 'delegate'
    && !recommendation.blocked
    && bestSpecialist
    && bestSpecialist.score < minDelegateScore
  ) {
    recommendation.action = 'adapt';
    recommendation.reason = `${getAgentTitle(bestSpecialist.agentId) || bestSpecialist.agentId} matched below delegate threshold.`;
    recommendation.offerUpgrade = true;
    delete recommendation.targetAgentId;
  }

  const agents = ranked.map((r) => ({
    agentId: r.agentId,
    title: r.title || r.agentId,
    role: r.role || (r.agentId === agentId ? 'coordinator' : 'specialist'),
    linked: r.agentId === agentId || eligibleTargets.includes(r.agentId),
    score: r.score,
    confidence: r.confidence,
    confidencePct: `${Math.round(Number(r.confidence || 0) * 100)}%`,
    matchedSkills: r.matchedSkills || [],
    matchedConcepts: r.matchedConcepts || [],
    reasoning: (r.reasons || []).join('; ') || 'No strong keyword/skill overlap.',
  }));

  return {
    request: String(userText || '').trim(),
    callerAgentId: agentId,
    agents,
    recommendation: {
      ...recommendation,
      coordinatorConfidence: callerRank ? Number(callerRank.confidence || 0) : 0,
      topSpecialistId: bestSpecialist?.agentId || '',
      topSpecialistConfidence: bestSpecialist ? Number(bestSpecialist.confidence || 0) : 0,
    },
  };
}
