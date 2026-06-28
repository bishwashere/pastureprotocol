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
import { executeForcedDelegation } from './forced-delegation.js';
import { planIntent, intentPlanToSystemBlock, buildCasualChatIntentPlan } from './intent-planner.js';
import { classifyTurnIntent, buildCasualPlanFromTurnIntent } from './turn-intent.js';
import { classifySelfInspection, buildSelfInspectionIntentPlan } from './self-inspection.js';
import { isNonTaskMessage } from './evaluate-team-capability.js';
import { buildDelegationContext } from './agent-delegation-router.js';
import { buildOneOnOneSystemPrompt } from './system-prompt.js';
import { buildSessionBootstrapContext } from './session-bootstrap.js';
import { resolveSharedTurnHistory, buildPairHistoryContextBlock } from '../context/conversation-context.js';
import { buildProjectsContextBlock, enrichMessageWithProjectContext } from '../context/projects-context.js';
import { buildMissionsContextBlock, buildMissionIntentPlan, resolveMissionForUserTurn } from '../context/missions-context.js';
import { buildDelegatedTasksContextBlock } from './delegated-tasks.js';
import { buildProjectWorkflowContextBlock } from '../context/project-workflow.js';
import { buildGithubSourceIntentPlan } from '../context/github-context.js';
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
  skipDelegationRouter = false,
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
  // Audit finding #25: nested delegated turns shouldn't re-run the delegation
  // router LLM call — the parent already decided this specialist is the
  // handler. Skip the LLM round when invoked from agent-send.
  const delegationContext = skipDelegationRouter
    ? null
    : await buildDelegationContext({
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
  const turnIntent = !presetDelegationPlan
    ? await classifyTurnIntent({
        userText: text,
        historyMessages,
        availableSkillIds: enabledSkillIds,
        availableSkillSummaries: enabledSkillSummaries,
        currentWorkMode: 'multi',
        agentId,
      })
    : null;
  const turnIntentIsConfident = turnIntent && turnIntent.confidence >= 0.65;
  const casualIntentPlan = !presetDelegationPlan
    ? (turnIntentIsConfident
        ? buildCasualPlanFromTurnIntent(turnIntent)
        : (isNonTaskMessage(text) ? buildCasualChatIntentPlan() : null))
    : null;
  const missionForIntent = !presetDelegationPlan && !casualIntentPlan && turnIntentIsConfident && turnIntent.project_or_mission_intent !== 'none'
    ? resolveMissionForUserTurn({
        userText: text,
        historyMessages,
        agentId,
        projectOrMissionIntent: turnIntent.project_or_mission_intent,
      })
    : null;
  const missionsIntentHint = missionForIntent
    ? buildMissionIntentPlan(missionForIntent, enabledSkillIds)
    : null;
  const githubIntentHint = !presetDelegationPlan && !casualIntentPlan
    ? (turnIntentIsConfident && turnIntent.github_source_intent
        ? buildGithubSourceIntentPlan(enabledSkillIds)
        : null)
    : null;
  const selfInspection = !presetDelegationPlan && enabledSkillIds.length > 0
    ? await classifySelfInspection({
        userText: text,
        historyMessages,
        agentId,
      })
    : null;
  const selfInspectionPlan = buildSelfInspectionIntentPlan(selfInspection, enabledSkillIds);
  const intentPlan = presetDelegationPlan || selfInspectionPlan || casualIntentPlan || missionsIntentHint || githubIntentHint || (enabledSkillIds.length > 0
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
    const missionsBlock = buildMissionsContextBlock({
      userText: text,
      historyMessages,
      agentId,
      projectOrMissionIntent: turnIntentIsConfident ? turnIntent.project_or_mission_intent : 'none',
    });
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
    // Audit finding #9: this used to inline the agent-send call, parse the
    // JSON, and silently swallow exceptions. Now the shared
    // `executeForcedDelegation` runs the call, normalizes the result via
    // parseSkillResult, and surfaces errors to the log so missing forced-
    // delegation work is visible (no more silent failure).
    const forced = await executeForcedDelegation(ctx, {
      target: delegatedTarget,
      message: enrichMessageWithProjectContext(text, historyMessages),
    });
    if (forced.ok) {
      turn = {
        textToSend: formatUserFacingReply(forced.reply),
        skillsCalled: forced.skillsCalled,
      };
    } else if (forced.error) {
      turn = {
        textToSend: `[Pasture] ${forced.error}`,
        skillsCalled: forced.skillsCalled,
      };
    }
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
  if (
    selfInspectionPlan
    && Array.isArray(toolsToUse)
    && toolsToUse.length > 0
    && (!Array.isArray(turn?.skillsCalled) || turn.skillsCalled.length === 0)
  ) {
    turn = await runAgentTurn({
      userText: text,
      ctx,
      systemPrompt: systemPrompt +
        '\n\n--- Self-Inspection Tool Requirement ---\n' +
        'This turn was classified as Pasture/CowCode self-inspection. Before final answering, call at least one available local inspection tool and ground the answer in what it returns.\n' +
        '---',
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
