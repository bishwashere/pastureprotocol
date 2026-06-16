/**
 * Internal agent-to-agent turn runner (tier 2: local, with persistent pair history).
 *
 * Runs one full agent turn for a target agent WITHOUT sending to any channel
 * (WhatsApp/Telegram). This is the "silent" sibling of scripts/chat-dashboard.js:
 * same pipeline (config -> enabled skills -> intent plan -> skill context ->
 * system prompt -> runAgentTurn) but returns text to the caller instead of a chat.
 *
 * Conversation history between two agents is persisted in the TARGET agent's
 * workspace, keyed by the caller, so repeated delegations are stateful
 * (PM <-> backend remembers prior exchanges). Disable with persistHistory: false.
 *
 * Recursion is guarded by depth + callChain, which the agent-send executor
 * increments on each hop. ctx.runInternalAgent is injected so nested delegation
 * works without a circular import (executor reads it off ctx).
 */

import { getCronStorePath, getAgentWorkspaceDir } from '../util/paths.js';
import { runAgentTurn } from './agent.js';
import { getSkillContext, getEnabledSkillIds, getEnabledSkillSummaries } from '../../skills/loader.js';
import { executeSkill } from '../../skills/executor.js';
import { planIntent, intentPlanToSystemBlock, buildCasualChatIntentPlan } from './intent-planner.js';
import { isNonTaskMessage } from './evaluate-team-capability.js';
import { buildDelegationContext } from './agent-delegation-router.js';
import { buildOneOnOneSystemPrompt } from './system-prompt.js';
import { buildSessionBootstrapContext } from './session-bootstrap.js';
import { resolveSharedTurnHistory, buildPairHistoryContextBlock } from '../context/conversation-context.js';
import { buildProjectsContextBlock, enrichMessageWithProjectContext } from '../context/projects-context.js';
import { buildMissionsContextBlock, getMissionsDiscoveryIntentHint } from '../context/missions-context.js';
import { buildDelegatedTasksContextBlock } from './delegated-tasks.js';
import { buildProjectWorkflowContextBlock } from '../context/project-workflow.js';
import { getGithubSourceIntentHint } from '../context/github-context.js';
import { formatUserFacingReply } from './user-facing-reply.js';
import { ensureMainAgentInitialized, loadAgentConfig, DEFAULT_AGENT_ID, buildAgentTeamPromptBlock } from './agent-config.js';
import { ensureChatSession } from '../context/chat-session.js';
import { appendExchange, readLastPrivateExchanges, DEFAULT_CHAT_HISTORY_EXCHANGES } from '../context/chat-log.js';
import { getMemoryConfig } from '../context/memory-config.js';
import { buildRetrospectiveContextBlock } from './retrospective.js';

const DEFAULT_PAIR_HISTORY_EXCHANGES = DEFAULT_CHAT_HISTORY_EXCHANGES;

const noop = () => {};

/** Stable per-pair key for session + chat-log file (stored in target's workspace). */
function pairLogKey(callerAgentId, targetAgentId) {
  return `internal:${callerAgentId}->${targetAgentId}`;
}

/**
 * Run one silent turn for another agent and return its reply.
 *
 * @param {object} opts
 * @param {string} opts.targetAgentId - Agent that should handle the message.
 * @param {string} opts.userText - The delegated task/question.
 * @param {string} [opts.callerAgentId] - Agent doing the delegating (for history + chain).
 * @param {number} [opts.depth] - Current recursion depth (0 = top-level human turn).
 * @param {string[]} [opts.callChain] - Agent ids already in this chain (loop guard).
 * @param {boolean} [opts.persistHistory] - Persist the pair conversation (default true).
 * @param {Array<{ role: string, content: string }>} [opts.sharedHistoryMessages] - User-channel history shared across agents.
 * @param {{ logJid?: string, workspaceDir?: string, sessionBootstrap?: string }} [opts.channelContext] - Same bootstrap channel as the user chat.
 * @returns {Promise<{ textToSend: string, skillsCalled: string[], agentId: string }>}
 */
export async function runInternalAgentTurn({
  targetAgentId,
  userText,
  callerAgentId = DEFAULT_AGENT_ID,
  depth = 1,
  callChain = [],
  persistHistory = true,
  sharedHistoryMessages = null,
  channelContext = null,
  missionId = '',
}) {
  ensureMainAgentInitialized();
  const agentId = String(targetAgentId || '').trim();
  if (!agentId) throw new Error('targetAgentId is required');
  const text = String(userText || '').trim();
  if (!text) throw new Error('userText is required');

  loadAgentConfig(agentId);
  const workspaceDir = getAgentWorkspaceDir(agentId);

  // Tier-2 pair history: stored in the TARGET agent's workspace, keyed by caller.
  const logKey = pairLogKey(callerAgentId, agentId);
  const { sessionId, rotated } = ensureChatSession(logKey, { userText: text });
  const pairHistoryMessages = persistHistory
    ? readLastPrivateExchanges(workspaceDir, logKey, DEFAULT_PAIR_HISTORY_EXCHANGES, sessionId)
    : [];
  const historyMessages = resolveSharedTurnHistory(sharedHistoryMessages, pairHistoryMessages);
  const hasChannelHistory = Array.isArray(sharedHistoryMessages) && sharedHistoryMessages.length > 0;
  const channelCtx = channelContext && typeof channelContext === 'object' ? channelContext : null;
  const currentCallChain = Array.isArray(callChain) && callChain.length ? callChain : [callerAgentId, agentId];

  // ctx mirrors the dashboard runner, plus injected agent-to-agent fields so the
  // agent-send executor can delegate further (depth/chain carried forward).
  const ctx = {
    storePath: getCronStorePath(),
    jid: logKey,
    workspaceDir,
    agentId,
    scheduleOneShot: noop,
    startCron: noop,
    isGroup: false,
    runInternalAgent: runInternalAgentTurn,
    agentDepth: depth,
    agentCallChain: currentCallChain,
    callerAgentId,
    delegationHistoryMessages: hasChannelHistory ? sharedHistoryMessages : undefined,
    channelContext: channelCtx || undefined,
    missionId: String(missionId || ''),
  };

  const enabledSkillIds = getEnabledSkillIds({ agentId });
  const enabledSkillSummaries = getEnabledSkillSummaries({ agentId });
  const delegationContext = await buildDelegationContext({
    agentId,
    userText: text,
    availableSkillIds: enabledSkillIds,
  });
  const recommendedTarget = delegationContext?.recommendation?.action === 'delegate'
    ? (delegationContext?.recommendation?.targetAgentId || '')
    : '';
  const delegatedTarget = recommendedTarget && !currentCallChain.includes(recommendedTarget)
    ? recommendedTarget
    : '';
  // Don't force agent-send when the recommended target isn't linked from this
  // caller (blocked === true). The forced agent-send would just fail at the
  // policy check, wasting the LLM round.
  const presetDelegationPlan = delegatedTarget
    && delegationContext?.recommendation?.action === 'delegate'
    && !delegationContext?.recommendation?.blocked
    ? {
        mode: 'tool',
        skills: ['agent-send'],
        plan: `Delegate to ${delegatedTarget} via agent-send first; that agent is the best specialization match for this request.`,
        answer_style: 'short',
      }
    : null;
  const casualIntentPlan = !presetDelegationPlan && isNonTaskMessage(text)
    ? buildCasualChatIntentPlan()
    : null;
  const missionsIntentHint = !presetDelegationPlan && !casualIntentPlan
    ? getMissionsDiscoveryIntentHint(text, historyMessages, enabledSkillIds, agentId)
    : null;
  const githubIntentHint = !presetDelegationPlan && !casualIntentPlan
    ? getGithubSourceIntentHint(text, enabledSkillIds)
    : null;
  const intentPlan = presetDelegationPlan || casualIntentPlan || missionsIntentHint || githubIntentHint || (enabledSkillIds.length > 0
    ? await planIntent({
        userText: text,
        historyMessages,
        availableSkillIds: enabledSkillIds,
        availableSkillSummaries: enabledSkillSummaries,
        agentId,
        delegationContext,
      })
    : null);

  const plannerSaysNoTools = intentPlan !== null && Array.isArray(intentPlan.skills) && intentPlan.skills.length === 0;
  let skillContext = null;
  let toolsToUse = [];
  if (!plannerSaysNoTools) {
    skillContext = getSkillContext({ agentId, hintSkills: intentPlan?.skills ?? null });
    toolsToUse = Array.isArray(skillContext.runSkillTool) && skillContext.runSkillTool.length > 0
      ? skillContext.runSkillTool
      : [];
  }

  const baseSystemPrompt = buildOneOnOneSystemPrompt(workspaceDir) + buildAgentTeamPromptBlock(agentId);
  const planBlock = intentPlanToSystemBlock(intentPlan);
  let systemPrompt = planBlock ? baseSystemPrompt + '\n\n' + planBlock : baseSystemPrompt;
  if (channelCtx?.sessionBootstrap) {
    systemPrompt += channelCtx.sessionBootstrap;
  } else if (rotated) {
    systemPrompt += buildSessionBootstrapContext(workspaceDir, { logJid: logKey }).block;
  }
  if (hasChannelHistory && pairHistoryMessages.length) {
    systemPrompt += buildPairHistoryContextBlock(pairHistoryMessages, callerAgentId);
  }
  if (channelCtx) {
    const memoryConfig = getMemoryConfig();
    const retroBlock = await buildRetrospectiveContextBlock(text, memoryConfig);
    if (retroBlock) systemPrompt += retroBlock;
  }
  if (!isNonTaskMessage(text)) {
    const missionsBlock = buildMissionsContextBlock({ userText: text, historyMessages, agentId });
    if (missionsBlock) systemPrompt += missionsBlock;
    if (callerAgentId) {
      const delegatedBlock = buildDelegatedTasksContextBlock(agentId);
      if (delegatedBlock) systemPrompt += delegatedBlock;
    }
    const projectsBlock = buildProjectsContextBlock({ userText: text, historyMessages });
    if (projectsBlock) systemPrompt += projectsBlock;
    const workflowBlock = buildProjectWorkflowContextBlock({ userText: text, historyMessages, agentId });
    if (workflowBlock) systemPrompt += workflowBlock;
  }

  let turn = null;
  if (presetDelegationPlan && delegatedTarget) {
    try {
      const forcedRaw = await executeSkill('agent-send', ctx, {
        agent: delegatedTarget,
        message: enrichMessageWithProjectContext(text, historyMessages),
      });
      const forced = JSON.parse(forcedRaw || '{}');
      if (forced && typeof forced.reply === 'string' && forced.reply.trim()) {
        const label = forced.agentTitle || forced.agent || delegatedTarget;
        turn = {
          textToSend: formatUserFacingReply(forced.reply.trim()),
          skillsCalled: ['agent-send'],
        };
      } else if (forced && typeof forced.error === 'string') {
        turn = {
          textToSend: `[Pasture] ${forced.error.trim()}`,
          skillsCalled: ['agent-send'],
        };
      }
    } catch (_) {}
  }
  if (!turn) {
    ctx._originalUserText = text;
    turn = await runAgentTurn({
      userText: text,
      ctx,
      systemPrompt,
      tools: toolsToUse,
      historyMessages,
      getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
      resolveToolName: skillContext?.resolveToolName ?? (() => null),
    });
  }

  const textToSend = (turn?.textToSend || '').trim();
  const skillsCalled = Array.isArray(turn?.skillsCalled) ? turn.skillsCalled : [];

  if (persistHistory && textToSend) {
    try {
      appendExchange(workspaceDir, {
        user: text,
        assistant: textToSend,
        timestampMs: Date.now(),
        jid: logKey,
        sessionId,
      });
    } catch (_) {}
  }

  return { textToSend, skillsCalled, agentId };
}
