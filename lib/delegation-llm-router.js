/**
 * LLM fallback for agent delegation when keyword scoring is weak or ambiguous.
 * Keyword router runs first (fast); this module runs only on create-new / handle-in-main / adapt.
 */

import { chat as defaultLlmChat } from '../llm.js';
import { stripThinking } from './agent.js';
import {
  getAgentTitle,
  getAgentAliases,
  readAgentMd,
  getAgentMessagingPolicy,
  listVisibleAgentIds,
} from './agent-config.js';
import { getEnabledSkillSummaries } from '../skills/loader.js';

export const MIN_LLM_DELEGATE_CONFIDENCE = 0.7;
export const SOUL_EXCERPT_MAX = 280;

const ROUTER_SYSTEM =
  'You are a team task router. Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';

function summarizeText(text, max = SOUL_EXCERPT_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function llmDelegationEnabled() {
  const v = String(process.env.PASTURE_LLM_DELEGATION_ROUTER ?? '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/**
 * Build a compact agent profile for the LLM router prompt.
 */
export function buildAgentRoutingProfile(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  const title = String(getAgentTitle(id) || id).trim();
  const aliases = getAgentAliases(id);
  const soul = summarizeText(readAgentMd('SOUL.md', id));
  const skills = getEnabledSkillSummaries({ agentId: id })
    .slice(0, 14)
    .map((s) => s.id)
    .filter(Boolean);
  return {
    agentId: id,
    title,
    aliases,
    soul,
    skills,
  };
}

/**
 * @param {object} evaluation - output of evaluateTeamCapability
 * @param {object} keywordRecommendation - from pickRecommendation
 */
export function needsLlmDelegationRouter(evaluation, keywordRecommendation) {
  if (!evaluation || !keywordRecommendation) return false;
  if (keywordRecommendation.action === 'delegate') return false;
  const action = String(keywordRecommendation.action || '').trim();
  return action === 'create-new' || action === 'handle-in-main' || action === 'adapt';
}

/**
 * @param {string} raw
 * @param {string[]} eligibleTargetIds
 */
export function parseDelegationRouterResponse(raw, eligibleTargetIds) {
  const allowed = new Set((eligibleTargetIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  let cleaned = stripThinking(String(raw || ''))
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned);
  const actionRaw = String(parsed.action || '').trim().toLowerCase();
  const action = actionRaw === 'delegate' ? 'delegate' : 'handle-in-main';
  let targetAgentId = String(parsed.targetAgentId || parsed.agentId || '').trim();
  const confidenceNum = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceNum)
    ? Math.max(0, Math.min(1, confidenceNum))
    : 0;
  const reason = String(parsed.reason || '').trim();

  if (action === 'delegate') {
    if (!targetAgentId || !allowed.has(targetAgentId)) {
      return { action: 'handle-in-main', targetAgentId: '', confidence, reason: reason || 'Invalid delegate target.' };
    }
    if (confidence < MIN_LLM_DELEGATE_CONFIDENCE) {
      return {
        action: 'handle-in-main',
        targetAgentId: '',
        confidence,
        reason: reason || `Delegate confidence ${confidence} below threshold.`,
      };
    }
    return { action: 'delegate', targetAgentId, confidence, reason };
  }

  return { action: 'handle-in-main', targetAgentId: '', confidence, reason };
}

function formatProfileBlock(profile) {
  if (!profile) return '';
  const parts = [`- ${profile.agentId} (${profile.title || profile.agentId})`];
  if (profile.aliases?.length) parts.push(`aliases: ${profile.aliases.join(', ')}`);
  if (profile.skills?.length) parts.push(`skills: ${profile.skills.join(', ')}`);
  if (profile.soul) parts.push(`role: ${profile.soul}`);
  return parts.join('; ');
}

function formatKeywordScoreBlock(evaluation) {
  const agents = Array.isArray(evaluation?.agents) ? evaluation.agents : [];
  if (!agents.length) return '  (none)';
  return agents
    .slice(0, 6)
    .map((a) => `  - ${a.agentId}${a.title ? ` (${a.title})` : ''}: score ${Number(a.score || 0)} — ${a.reasoning || ''}`)
    .join('\n');
}

/**
 * @param {{
 *   agentId?: string,
 *   userText?: string,
 *   evaluation?: object,
 *   eligibleTargetIds?: string[],
 *   llmChat?: Function,
 * }} opts
 */
export async function planDelegationWithLlm(opts = {}) {
  if (!llmDelegationEnabled()) return null;

  const callerAgentId = String(opts.agentId || 'main').trim() || 'main';
  const userText = String(opts.userText || '').trim();
  const evaluation = opts.evaluation;
  const eligibleTargetIds = (opts.eligibleTargetIds || [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!userText || !evaluation || eligibleTargetIds.length === 0) return null;

  const profiles = eligibleTargetIds
    .map((id) => buildAgentRoutingProfile(id))
    .filter(Boolean);
  const callerTitle = getAgentTitle(callerAgentId) || callerAgentId;

  const userPrompt = [
    `Coordinator: ${callerAgentId} (${callerTitle}) — handles general synthesis when no specialist fits.`,
    '',
    'Linked specialists (delegate ONLY to one of these ids):',
    profiles.map(formatProfileBlock).join('\n') || '  (none)',
    '',
    `User request:\n${userText.slice(0, 800)}`,
    '',
    'Keyword pre-score (weak match — use semantic judgment):',
    formatKeywordScoreBlock(evaluation),
    '',
    'Return JSON only:',
    '{',
    '  "action": "delegate | handle-in-main",',
    '  "targetAgentId": "<specialist id or empty>",',
    '  "confidence": 0.0,',
    '  "reason": "<one sentence>"',
    '}',
    '',
    'Rules:',
    `- delegate only when a linked specialist is clearly the best fit (confidence >= ${MIN_LLM_DELEGATE_CONFIDENCE})`,
    '- targetAgentId must be exactly one of the linked specialist ids above',
    '- handle-in-main when the coordinator should answer (general, multi-domain, or unclear)',
  ].join('\n');

  const llmChat = typeof opts.llmChat === 'function' ? opts.llmChat : defaultLlmChat;

  try {
    const raw = await llmChat(
      [
        { role: 'system', content: ROUTER_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      { agentId: callerAgentId, purpose: 'delegation_llm_router' },
    );
    const parsed = parseDelegationRouterResponse(raw, eligibleTargetIds);
    return {
      ...parsed,
      routingMethod: 'llm',
      keywordAction: evaluation?.recommendation?.action || '',
    };
  } catch (err) {
    console.log('[delegation-llm-router] failed, keeping keyword recommendation:', err?.message || err);
    return null;
  }
}

/**
 * Merge LLM router result into keyword delegation context.
 * @param {object} ctx - buildKeywordDelegationContext output
 * @param {object} llmResult - planDelegationWithLlm output
 */
export function mergeLlmDelegationIntoContext(ctx, llmResult) {
  if (!ctx || !llmResult) return ctx;

  const keywordAction = String(ctx.recommendation?.action || '').trim();
  const llmMeta = {
    routingMethod: llmResult.routingMethod || 'llm',
    keywordAction,
    llmAction: llmResult.action,
    llmConfidence: Number(llmResult.confidence || 0),
    llmReason: String(llmResult.reason || '').trim(),
    llmTargetAgentId: String(llmResult.targetAgentId || '').trim(),
  };

  if (llmResult.action === 'delegate' && llmResult.targetAgentId) {
    const targetId = llmResult.targetAgentId;
    const targetRow = (ctx.teamCapability?.agents || []).find((a) => a.agentId === targetId) || {};
    return {
      ...ctx,
      recommendation: {
        mode: 'delegate',
        action: 'delegate',
        targetAgentId: targetId,
        score: Number(targetRow.score || 0),
        confidence: Number(llmResult.confidence || 0),
        matchedSkills: targetRow.matchedSkills || [],
        matchedConcepts: targetRow.matchedConcepts || [],
        blocked: false,
        reason: llmResult.reason || `LLM router selected ${targetId}.`,
        offerUpgrade: false,
        ...llmMeta,
      },
    };
  }

  return {
    ...ctx,
    recommendation: {
      ...(ctx.recommendation || {}),
      ...llmMeta,
    },
  };
}

/** Eligible specialist ids for a coordinator agent. */
export function getEligibleDelegationTargets(callerAgentId) {
  const agentId = String(callerAgentId || 'main').trim() || 'main';
  const policy = getAgentMessagingPolicy(agentId);
  const visible = new Set(listVisibleAgentIds());
  return (policy.allow || []).filter((id) => visible.has(id) && id !== agentId);
}

export function isLlmDelegationRouterEnabled() {
  return llmDelegationEnabled();
}
