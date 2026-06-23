/**
 * LLM-based agent delegation router.
 *
 * `buildDelegationContext` calls this when there is no explicit agent mention
 * and no team-status short-circuit. The router decides "delegate to <id>" vs
 * "handle-in-main" based on the linked specialist profiles (id, title,
 * aliases, skills, soul excerpt) and the user's request.
 *
 * Per AGENTS.md, the entire decision lives in
 * `lib/agent/templates/delegation-router.md`. This file is just the
 * substrate: it builds the structured input, calls the MD prompt via
 * md-llm.js, and validates the structured output.
 */

import { runMdPrompt } from './md-llm.js';
import {
  getAgentTitle,
  getAgentAliases,
  readAgentMd,
  getAgentMessagingPolicy,
  listVisibleAgentIds,
} from './agent-config.js';
import { getEnabledSkillSummaries } from '../../skills/loader.js';

export const MIN_LLM_DELEGATE_CONFIDENCE = 0.7;
export const SOUL_EXCERPT_MAX = 280;

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
 * Validate and clamp the LLM router's structured output.
 * @param {object|null} parsed - JSON returned by md-llm.
 * @param {string[]} eligibleTargetIds
 */
export function parseDelegationRouterResponse(parsed, eligibleTargetIds) {
  if (!parsed || typeof parsed !== 'object') {
    return { action: 'handle-in-main', targetAgentId: '', confidence: 0, reason: 'Empty router response.' };
  }
  const allowed = new Set((eligibleTargetIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const actionRaw = String(parsed.action || '').trim().toLowerCase();
  const action = actionRaw === 'delegate' ? 'delegate' : 'handle-in-main';
  const targetAgentId = String(parsed.targetAgentId || parsed.agentId || '').trim();
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

  const specialists = eligibleTargetIds
    .map((id) => buildAgentRoutingProfile(id))
    .filter(Boolean);
  const callerTitle = getAgentTitle(callerAgentId) || callerAgentId;

  const parsed = await runMdPrompt({
    promptName: 'delegation-router',
    user: {
      coordinator: { agentId: callerAgentId, title: callerTitle },
      specialists,
      userText: userText.slice(0, 800),
      minDelegateConfidence: MIN_LLM_DELEGATE_CONFIDENCE,
    },
    agentId: callerAgentId,
    purpose: 'delegation_llm_router',
    llmChat: opts.llmChat,
  });

  if (!parsed) return null;
  const validated = parseDelegationRouterResponse(parsed, eligibleTargetIds);
  return {
    ...validated,
    routingMethod: 'llm',
    baseAction: evaluation?.recommendation?.action || '',
  };
}

/**
 * Merge LLM router result into the base delegation context.
 * @param {object} ctx - buildBaseDelegationContext output
 * @param {object} llmResult - planDelegationWithLlm output
 */
export function mergeLlmDelegationIntoContext(ctx, llmResult) {
  if (!ctx || !llmResult) return ctx;

  const baseAction = String(ctx.recommendation?.action || '').trim();
  const llmMeta = {
    routingMethod: llmResult.routingMethod || 'llm',
    baseAction,
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
