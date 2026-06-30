#!/usr/bin/env node
/**
 * One-off agent run for the dashboard chat UI.
 * Reads JSON from stdin: { "message": "...", "history": [...], "agentId": "..." }
 * Writes NDJSON to stdout (line-delimited JSON):
 *   { "type": "progress", "message": "..." } — filesystem / shell steps as they run
 *   { "type": "done", "reply": "..." } — final assistant text
 *   { "type": "error", "error": "..." } — failure
 * Uses same soul/identity and skills as main app (workspace SOUL.md, WhoAmI.md, MyHuman.md).
 */

import { writeSync } from 'fs';
import { getEnvPath, getCronStorePath, getWorkspaceDir, getAgentWorkspaceDir } from '../lib/util/paths.js';
import dotenv from 'dotenv';
import { getSkillContext, getEnabledSkillIds, getEnabledSkillSummaries } from '../skills/loader.js';
import { runAgentTurn } from '../lib/agent/agent.js';
import { runInternalAgentTurn } from '../lib/agent/internal-agent-turn.js';
import { routeTurn, turnRouteToSystemBlock, buildCasualChatTurnRoute } from '../lib/agent/turn-router.js';
import { classifyTurnIntent, buildCasualPlanFromTurnIntent } from '../lib/agent/turn-intent.js';
import { isNonTaskMessage } from '../lib/agent/evaluate-team-capability.js';
import { buildDelegationContext } from '../lib/agent/agent-delegation-router.js';
import { buildDelegationDecisionDetails } from '../lib/agent/delegation-routing-details.js';
import { executeSkill } from '../skills/executor.js';
import { logTeamActivity } from '../lib/agent/team-activity.js';
import { buildOneOnOneSystemPrompt } from '../lib/agent/system-prompt.js';
import { DEFAULT_AGENT_ID, ensureMainAgentInitialized, loadAgentConfig, buildAgentTeamPromptBlock } from '../lib/agent/agent-config.js';
import { appendExchange, readLastPrivateExchanges, resolveChatHistoryExchanges } from '../lib/context/chat-log.js';
import { ensureChatSession, shouldAckNewSessionOnly, NEW_SESSION_ACK, getSessionWorkMode } from '../lib/context/chat-session.js';
import { resolveWorkModeForTurn } from '../lib/agent/work-mode.js';
import { buildSessionBootstrapContext } from '../lib/agent/session-bootstrap.js';
import { getOwnerLogJid } from '../lib/util/owner-config.js';
import { getMemoryConfig } from '../lib/context/memory-config.js';
import { indexChatExchange } from '../lib/context/memory-index.js';
import {
  afterExchangeLogged,
  buildRetrospectiveContextBlock,
} from '../lib/agent/retrospective.js';
import {
  buildProjectsContextBlock,
  enrichMessageWithProjectContext,
} from '../lib/context/projects-context.js';
import { buildMissionsContextBlock, buildMissionIntentPlan, resolveMissionForUserTurn } from '../lib/context/missions-context.js';
import { buildProjectWorkflowContextBlock } from '../lib/context/project-workflow.js';
import {
  buildDurabilitySystemBlock,
  buildDurableDelegationContext,
  delegationArgsFromDurability,
  delegationRoutingTextFromDurability,
  prepareWorkDurabilityWithAi,
} from '../lib/context/work-durability.js';
import { buildGithubSourceIntentPlan } from '../lib/context/github-context.js';
import { formatUserFacingReply, logOutboundReplyDecorations } from '../lib/agent/user-facing-reply.js';
import { getPendingHealthFlags } from '../lib/agent/system-pulse.js';

// Match Telegram/WhatsApp default. Override via PASTURE_DASHBOARD_HISTORY env if needed.
const DASHBOARD_HISTORY_EXCHANGES = resolveChatHistoryExchanges(process.env.PASTURE_DASHBOARD_HISTORY);

dotenv.config({ path: getEnvPath() });

function writeNdjsonLine(obj) {
  const line = JSON.stringify(obj) + '\n';
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(line);
    } else {
      writeSync(process.stdout.fd, line);
    }
  } catch (_) {
    process.stdout.write(line);
  }
}

function formatDashboardReply(textToSend) {
  const raw = textToSend != null ? String(textToSend) : '';
  const reply = formatUserFacingReply(raw);
  logOutboundReplyDecorations(raw, reply, { channel: 'dashboard' });
  return reply;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw || '{}');
  const voiceInput = payload.voiceInput === true;
  let message = payload.message && String(payload.message).trim();
  const requestedAgentId = payload.agentId && String(payload.agentId).trim();
  ensureMainAgentInitialized();
  const agentId = requestedAgentId || DEFAULT_AGENT_ID;
  loadAgentConfig(agentId);
  if (!message) {
    writeNdjsonLine({ type: 'error', error: 'message is required' });
    process.exit(1);
  }
  // Append voice hint so the agent knows to reply as voice when available
  if (voiceInput) {
    message += '\n\n[The user sent a voice message. If the speech skill is available, call it with action reply_as_voice and a concise spoken reply. Otherwise give a brief, spoken-friendly text reply.]';
  }
  const workspaceDir = getAgentWorkspaceDir(agentId) || getWorkspaceDir();
  // Single super-admin model: the dashboard chat is always the owner talking to
  // their own AI. Use the unified owner log jid so this conversation shares the
  // same chat-log file and memory index as the owner's Telegram/WhatsApp DMs.
  const dashboardJid = getOwnerLogJid();
  const { sessionId, rotated: sessionRotated, reason: sessionReason } = ensureChatSession(dashboardJid, { userText: message });
  if (sessionRotated) {
    process.stderr.write(`[chat-dashboard] new session ${sessionId}\n`);
  }
  if (shouldAckNewSessionOnly(sessionReason, message)) {
    const reply = NEW_SESSION_ACK;
    const exchange = {
      user: message,
      assistant: reply,
      timestampMs: Date.now(),
      jid: dashboardJid,
      sessionId,
    };
    try {
      const memoryConfig = getMemoryConfig();
      if (memoryConfig) {
        const logMeta = await indexChatExchange(memoryConfig, exchange);
        afterExchangeLogged(workspaceDir, exchange, logMeta);
      } else {
        const logMeta = appendExchange(workspaceDir, exchange);
        afterExchangeLogged(workspaceDir, exchange, logMeta);
      }
    } catch (memErr) {
      try {
        process.stderr.write(`[chat-dashboard] memory index failed: ${memErr?.message || memErr}\n`);
      } catch (_) {}
    }
    writeNdjsonLine({ type: 'done', reply });
    return;
  }
  // Server-managed history, same pattern as Telegram private chats. Any `payload.history`
  // sent by the client is intentionally ignored — context lives on disk on the server.
  const historyMessages = readLastPrivateExchanges(workspaceDir, dashboardJid, DASHBOARD_HISTORY_EXCHANGES, sessionId);

  const noop = () => {};
  const ctx = {
    storePath: getCronStorePath(),
    jid: 'dashboard:' + agentId,
    workspaceDir,
    agentId,
    scheduleOneShot: noop,
    startCron: noop,
    runInternalAgent: runInternalAgentTurn,
    agentDepth: 0,
    agentCallChain: [agentId],
  };
  // Step 1: cheap config-only skill ID list (no SKILL.md reads yet).
  const enabledSkillIds = getEnabledSkillIds({ agentId });
  const enabledSkillSummaries = getEnabledSkillSummaries({ agentId });
  // Step 1.5: classify work-mode for this turn (LLM, MD-driven). The
  // multi-agent pipeline only runs when this session is in "multi". Default
  // is "single" — focus on direct tool execution.
  let workModeAck = null;
  let workMode = getSessionWorkMode(dashboardJid);
  const wm = await resolveWorkModeForTurn({
    userText: message,
    logKey: dashboardJid,
    agentId,
  });
  if (wm) {
    workMode = wm.modeAfter;
    if (wm.toggled) {
      workModeAck = wm.ack;
      process.stderr.write('[work-mode] ' + JSON.stringify({ before: wm.modeBefore, after: wm.modeAfter, reason: wm.reason }) + '\n');
    } else {
      process.stderr.write('[work-mode] ' + JSON.stringify({ mode: workMode }) + '\n');
    }
  }
  const isMultiAgent = workMode === 'multi';
  // Step 2: decide work durability before delegation. Persistence must be
  // attached to the turn before agent-send chooses who should do the work.
  // Single-agent mode skips this entirely.
  const durabilityDecision = isMultiAgent
    ? await prepareWorkDurabilityWithAi({ userText: message, historyMessages, agentId })
    : null;
  if (durabilityDecision?.missionId) ctx.missionId = durabilityDecision.missionId;
  if (durabilityDecision) {
    process.stderr.write('[work-durability] ' + JSON.stringify({
      kind: durabilityDecision.kind,
      persistence: durabilityDecision.persistence,
      missionId: durabilityDecision.missionId || '',
      createdMission: !!durabilityDecision.createdMission,
    }) + '\n');
  }
  // Step 3: specialization-aware delegation check before planner.
  // Skipped in single-agent mode.
  const durableDelegationContext = isMultiAgent
    ? buildDurableDelegationContext(durabilityDecision, {
        agentId,
        availableSkillIds: enabledSkillIds,
      })
    : null;
  const delegationContext = durableDelegationContext || (isMultiAgent
    ? await buildDelegationContext({
        agentId,
        userText: delegationRoutingTextFromDurability(durabilityDecision, message),
        availableSkillIds: enabledSkillIds,
      })
    : null);
  const delegatedTarget = delegationContext?.recommendation?.action === 'delegate'
    ? (delegationContext?.recommendation?.targetAgentId || '')
    : '';
  const delegationDecision = buildDelegationDecisionDetails(delegationContext);
  const presetDelegationPlan = delegatedTarget && delegationContext?.recommendation?.action === 'delegate'
    ? {
        mode: 'tool',
        skills: [
          ...(durabilityDecision?.persistence && durabilityDecision.persistence !== 'none' && enabledSkillIds.includes('project-workflow') ? ['project-workflow'] : []),
          'agent-send',
        ],
        executionMode: durabilityDecision?.persistence && durabilityDecision.persistence !== 'none'
          ? 'persistent_delegation'
          : 'delegation',
        usesExistingWorkIntake: !!(durabilityDecision?.persistence && durabilityDecision.persistence !== 'none'),
        plan: `Delegate to ${delegatedTarget} via agent-send first; that agent is the best specialization match for this request.`,
        answer_style: 'short',
      }
    : null;
  ctx.delegationHistoryMessages = historyMessages;
  ctx.channelContext = {
    logJid: dashboardJid,
    workspaceDir,
    sessionBootstrap: sessionRotated
      ? buildSessionBootstrapContext(workspaceDir, { logJid: dashboardJid }).block
      : '',
  };
  if (presetDelegationPlan && delegationDecision) {
    logTeamActivity({
      type: 'delegation_decision',
      agentId,
      targetAgentId: delegatedTarget,
      status: delegationContext?.recommendation?.blocked ? 'blocked' : 'ok',
      depth: 0,
      jid: dashboardJid,
        message: delegationContext?.recommendation?.routingMethod === 'llm'
          ? `Delegation decision (LLM router) selected ${delegatedTarget}`
          : `Delegation decision selected ${delegatedTarget}`,
      details: delegationDecision,
    });
  } else if (delegationDecision && delegationContext?.teamCapability) {
    logTeamActivity({
      type: 'team_capability_evaluation',
      agentId,
      status: 'ok',
      depth: 0,
      jid: dashboardJid,
      message: `Team capability: ${delegationDecision.action || 'handle-in-main'}`,
      details: delegationDecision,
    });
  }
  // Step 4: turn router — one small LLM call before loading any tool schemas.
  const turnIntent = isMultiAgent && !presetDelegationPlan
    ? await classifyTurnIntent({
        userText: message,
        historyMessages,
        availableSkillIds: enabledSkillIds,
        availableSkillSummaries: enabledSkillSummaries,
        currentWorkMode: workMode,
        agentId,
      })
    : null;
  if (turnIntent) process.stderr.write('[turn-intent] ' + JSON.stringify(turnIntent) + '\n');
  const turnIntentIsConfident = turnIntent && turnIntent.confidence >= 0.65;
  const casualIntentPlan = !presetDelegationPlan
    ? (turnIntentIsConfident
        ? buildCasualPlanFromTurnIntent(turnIntent)
        : (isNonTaskMessage(message) ? buildCasualChatTurnRoute() : null))
    : null;
  const missionForIntent = isMultiAgent && !presetDelegationPlan && !casualIntentPlan && turnIntentIsConfident && turnIntent.project_or_mission_intent !== 'none'
    ? resolveMissionForUserTurn({
        userText: message,
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
  const turnRoute = presetDelegationPlan || casualIntentPlan || missionsIntentHint || githubIntentHint || (enabledSkillIds.length > 0
    ? await routeTurn({
        userText: message,
        historyMessages,
        availableSkillIds: enabledSkillIds,
        availableSkillSummaries: enabledSkillSummaries,
        agentId,
        delegationContext,
        workDurability: durabilityDecision,
      })
    : null);
  if (turnRoute) process.stderr.write('[turn-router] ' + JSON.stringify(turnRoute) + '\n');
  // Step 5: load tool schemas based on what the planner returned.
  //   turnRoute === null      → planner failed  → full tools (safe fallback)
  //   turnRoute.skills = []   → planner: chat   → skip schema loading entirely, no tools
  //   turnRoute.skills = [...] → planner: tools  → load only selected schemas
  const plannerSaysNoTools = turnRoute !== null && Array.isArray(turnRoute.skills) && turnRoute.skills.length === 0;
  let skillContext = null;
  let toolsToUse = [];
  if (!plannerSaysNoTools) {
    skillContext = getSkillContext({ agentId, hintSkills: turnRoute?.skills ?? null });
    toolsToUse = Array.isArray(skillContext.runSkillTool) && skillContext.runSkillTool.length > 0 ? skillContext.runSkillTool : [];
  }
  const toolNames = toolsToUse.map((t) => t?.function?.name).filter(Boolean);
  const baseSystemPrompt = buildOneOnOneSystemPrompt(workspaceDir) + buildAgentTeamPromptBlock(agentId);
  const planBlock = turnRouteToSystemBlock(turnRoute);
  let systemPrompt = planBlock ? baseSystemPrompt + '\n\n' + planBlock : baseSystemPrompt;
  if (sessionRotated) {
    systemPrompt += buildSessionBootstrapContext(workspaceDir, { logJid: dashboardJid }).block;
  }
  systemPrompt += buildDurabilitySystemBlock(durabilityDecision);
  const memoryConfig = getMemoryConfig();
  const retroBlock = await buildRetrospectiveContextBlock(message, memoryConfig);
  if (retroBlock) systemPrompt += retroBlock;
  if (isMultiAgent && !isNonTaskMessage(message)) {
    const missionsBlock = buildMissionsContextBlock({
      userText: message,
      historyMessages,
      agentId,
      projectOrMissionIntent: turnIntentIsConfident ? turnIntent.project_or_mission_intent : 'none',
    });
    if (missionsBlock) systemPrompt += missionsBlock;
    const projectsBlock = buildProjectsContextBlock({ userText: message, historyMessages });
    if (projectsBlock) systemPrompt += projectsBlock;
    const workflowBlock = buildProjectWorkflowContextBlock({ userText: message, historyMessages, agentId });
    if (workflowBlock) systemPrompt += workflowBlock;
  }

  try {
    let textToSend = '';
    let voiceReplyText = '';
    let skillsCalled = [];
    if (presetDelegationPlan && delegatedTarget) {
      try {
        if (delegationDecision) ctx.delegationRouting = delegationDecision;
        const forcedRaw = await executeSkill('agent-send', ctx, {
          agent: delegatedTarget,
          message: enrichMessageWithProjectContext(message, historyMessages),
          ...delegationArgsFromDurability(durabilityDecision, message),
        });
        const forced = JSON.parse(forcedRaw || '{}');
        if (forced && typeof forced.reply === 'string' && forced.reply.trim()) {
          textToSend = forced.reply.trim();
          skillsCalled = ['agent-send'];
        } else if (forced && typeof forced.error === 'string') {
          textToSend = `[Pasture] ${forced.error.trim()}`;
          skillsCalled = ['agent-send'];
        }
      } catch (_) {}
    }
    if (!textToSend) {
      ctx._originalUserText = message;
      const turn = await runAgentTurn({
        userText: message,
        ctx,
        systemPrompt,
        tools: toolsToUse,
        historyMessages,
        getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
        resolveToolName: skillContext?.resolveToolName ?? (() => null),
        onToolProgress: (msg) => {
          const m = msg != null ? String(msg).trim() : '';
          if (m) writeNdjsonLine({ type: 'progress', message: m });
        },
      });
      textToSend = turn?.textToSend || '';
      voiceReplyText = turn?.voiceReplyText || '';
      skillsCalled = Array.isArray(turn?.skillsCalled) ? turn.skillsCalled : [];
    }
    if (skillsCalled.length) {
      process.stderr.write('[dashboard-skills] ' + skillsCalled.join(',') + '\n');
    }
    const healthNote = getPendingHealthFlags();
    if (healthNote && textToSend) textToSend = healthNote + '\n\n' + textToSend;
    if (workModeAck) {
      textToSend = textToSend
        ? '[Pasture] ' + workModeAck + '\n\n' + textToSend.replace(/^\[Pasture\]\s*/i, '')
        : '[Pasture] ' + workModeAck;
    }
    const reply = formatDashboardReply(textToSend);
    // For voice inputs, fall back to the full reply text if the agent didn't
    // explicitly call reply_as_voice (e.g. speech skill not enabled).
    const speakText = voiceReplyText || (voiceInput ? reply : '');
    const exchange = {
      user: message,
      assistant: reply,
      timestampMs: Date.now(),
      jid: dashboardJid,
      sessionId,
    };
    try {
      if (memoryConfig) {
        const logMeta = await indexChatExchange(memoryConfig, exchange);
        afterExchangeLogged(workspaceDir, exchange, logMeta);
      } else {
        const logMeta = appendExchange(workspaceDir, exchange);
        afterExchangeLogged(workspaceDir, exchange, logMeta);
      }
    } catch (memErr) {
      try {
        process.stderr.write(`[chat-dashboard] memory index failed: ${memErr?.message || memErr}\n`);
      } catch (_) {}
    }
    writeNdjsonLine({ type: 'done', reply, ...(speakText ? { voiceReplyText: speakText } : {}) });
  } catch (err) {
    writeNdjsonLine({ type: 'error', error: err.message || String(err) });
    process.exit(1);
  }
}

main();
