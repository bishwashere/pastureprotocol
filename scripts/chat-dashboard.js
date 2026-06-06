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
import { getEnvPath, getCronStorePath, getWorkspaceDir, getAgentWorkspaceDir } from '../lib/paths.js';
import dotenv from 'dotenv';
import { getSkillContext, getEnabledSkillIds, getEnabledSkillSummaries } from '../skills/loader.js';
import { runAgentTurn } from '../lib/agent.js';
import { runInternalAgentTurn } from '../lib/internal-agent-turn.js';
import { planIntent, intentPlanToSystemBlock, buildCasualChatIntentPlan } from '../lib/intent-planner.js';
import { isNonTaskMessage } from '../lib/evaluate-team-capability.js';
import { buildDelegationContext } from '../lib/agent-delegation-router.js';
import { buildDelegationDecisionDetails } from '../lib/delegation-routing-details.js';
import { executeSkill } from '../skills/executor.js';
import { logTeamActivity } from '../lib/team-activity.js';
import { buildOneOnOneSystemPrompt } from '../lib/system-prompt.js';
import { DEFAULT_AGENT_ID, ensureMainAgentInitialized, loadAgentConfig, buildAgentTeamPromptBlock } from '../lib/agent-config.js';
import { appendExchange, readLastPrivateExchanges, resolveChatHistoryExchanges } from '../lib/chat-log.js';
import { ensureChatSession, shouldAckNewSessionOnly, NEW_SESSION_ACK } from '../lib/chat-session.js';
import { buildSessionBootstrapContext } from '../lib/session-bootstrap.js';
import { getOwnerLogJid } from '../lib/owner-config.js';
import { getMemoryConfig } from '../lib/memory-config.js';
import { indexChatExchange } from '../lib/memory-index.js';
import {
  afterExchangeLogged,
  beforeUserMessage,
  buildRetrospectiveContextBlock,
} from '../lib/retrospective.js';
import {
  buildProjectsContextBlock,
  enrichMessageWithProjectContext,
} from '../lib/projects-context.js';
import { buildGoalsContextBlock, getGoalsDiscoveryIntentHint } from '../lib/goals-context.js';
import { buildProjectWorkflowContextBlock } from '../lib/project-workflow.js';
import {
  buildDurabilitySystemBlock,
  delegationArgsFromDurability,
  delegationRoutingTextFromDurability,
  prepareWorkDurability,
} from '../lib/work-durability.js';
import { getGithubSourceIntentHint } from '../lib/github-context.js';
import { appendUserFacingPrompt } from '../lib/user-reply-style.js';
import { formatUserFacingReply, logOutboundReplyDecorations, looksLikeToolAuditReply } from '../lib/user-facing-reply.js';
import { buildToolAuditRewriteInstruction } from '../lib/user-reply-style.js';

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
  const message = payload.message && String(payload.message).trim();
  const requestedAgentId = payload.agentId && String(payload.agentId).trim();
  ensureMainAgentInitialized();
  const agentId = requestedAgentId || DEFAULT_AGENT_ID;
  loadAgentConfig(agentId);
  if (!message) {
    writeNdjsonLine({ type: 'error', error: 'message is required' });
    process.exit(1);
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
  await beforeUserMessage(workspaceDir, dashboardJid, sessionId, message);
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
  // Step 2: decide work durability before delegation. Persistence must be
  // attached to the turn before agent-send chooses who should do the work.
  const durabilityDecision = prepareWorkDurability({ userText: message, historyMessages, agentId });
  if (durabilityDecision?.goalId) ctx.goalId = durabilityDecision.goalId;
  if (durabilityDecision) {
    process.stderr.write('[work-durability] ' + JSON.stringify({
      kind: durabilityDecision.kind,
      persistence: durabilityDecision.persistence,
      goalId: durabilityDecision.goalId || '',
      createdGoal: !!durabilityDecision.createdGoal,
    }) + '\n');
  }
  // Step 3: specialization-aware delegation check before planner (same as index.js private chat).
  const delegationContext = await buildDelegationContext({
    agentId,
    userText: delegationRoutingTextFromDurability(durabilityDecision, message),
    availableSkillIds: enabledSkillIds,
  });
  const delegatedTarget = delegationContext?.recommendation?.action === 'delegate'
    ? (delegationContext?.recommendation?.targetAgentId || '')
    : '';
  const delegationDecision = buildDelegationDecisionDetails(delegationContext);
  const presetDelegationPlan = delegatedTarget && delegationContext?.recommendation?.action === 'delegate'
    ? {
        mode: 'tool',
        skills: ['agent-send'],
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
  // Step 4: intent planner — one small LLM call before loading any tool schemas.
  const casualIntentPlan = !presetDelegationPlan && isNonTaskMessage(message)
    ? buildCasualChatIntentPlan()
    : null;
  const goalsIntentHint = !presetDelegationPlan && !casualIntentPlan
    ? getGoalsDiscoveryIntentHint(message, historyMessages, enabledSkillIds, agentId)
    : null;
  const githubIntentHint = !presetDelegationPlan && !casualIntentPlan
    ? getGithubSourceIntentHint(message, enabledSkillIds)
    : null;
  const intentPlan = presetDelegationPlan || casualIntentPlan || goalsIntentHint || githubIntentHint || (enabledSkillIds.length > 0
    ? await planIntent({
        userText: message,
        historyMessages,
        availableSkillIds: enabledSkillIds,
        availableSkillSummaries: enabledSkillSummaries,
        agentId,
        delegationContext,
      })
    : null);
  if (intentPlan) process.stderr.write('[intent-planner] ' + JSON.stringify(intentPlan) + '\n');
  // Step 5: load tool schemas based on what the planner returned.
  //   intentPlan === null      → planner failed  → full tools (safe fallback)
  //   intentPlan.skills = []   → planner: chat   → skip schema loading entirely, no tools
  //   intentPlan.skills = [...] → planner: tools  → load only selected schemas
  const plannerSaysNoTools = intentPlan !== null && Array.isArray(intentPlan.skills) && intentPlan.skills.length === 0;
  let skillContext = null;
  let toolsToUse = [];
  if (!plannerSaysNoTools) {
    skillContext = getSkillContext({ agentId, hintSkills: intentPlan?.skills ?? null });
    toolsToUse = Array.isArray(skillContext.runSkillTool) && skillContext.runSkillTool.length > 0 ? skillContext.runSkillTool : [];
  }
  const toolNames = toolsToUse.map((t) => t?.function?.name).filter(Boolean);
  const baseSystemPrompt = buildOneOnOneSystemPrompt(workspaceDir) + buildAgentTeamPromptBlock(agentId);
  const planBlock = intentPlanToSystemBlock(intentPlan);
  let systemPrompt = planBlock ? baseSystemPrompt + '\n\n' + planBlock : baseSystemPrompt;
  if (sessionRotated) {
    systemPrompt += buildSessionBootstrapContext(workspaceDir, { logJid: dashboardJid }).block;
  }
  systemPrompt += buildDurabilitySystemBlock(durabilityDecision);
  const memoryConfig = getMemoryConfig();
  const retroBlock = await buildRetrospectiveContextBlock(message, memoryConfig);
  if (retroBlock) systemPrompt += retroBlock;
  if (!isNonTaskMessage(message)) {
    const goalsBlock = buildGoalsContextBlock({ userText: message, historyMessages, agentId });
    if (goalsBlock) systemPrompt += goalsBlock;
    const projectsBlock = buildProjectsContextBlock({ userText: message, historyMessages });
    if (projectsBlock) systemPrompt += projectsBlock;
    const workflowBlock = buildProjectWorkflowContextBlock({ userText: message, historyMessages, agentId });
    if (workflowBlock) systemPrompt += workflowBlock;
    systemPrompt = appendUserFacingPrompt(systemPrompt);
  }

  try {
    let textToSend = '';
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
          textToSend = `[CowCode] ${forced.error.trim()}`;
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
      skillsCalled = Array.isArray(turn?.skillsCalled) ? turn.skillsCalled : [];
    }
    if (skillsCalled.length) {
      process.stderr.write('[dashboard-skills] ' + skillsCalled.join(',') + '\n');
    }
    if (
      !isNonTaskMessage(message) &&
      textToSend &&
      looksLikeToolAuditReply(formatUserFacingReply(textToSend))
    ) {
      process.stderr.write('[chat-dashboard] tool-audit reply detected, rewriting\n');
      try {
        const rewriteHistory = historyMessages.concat([
          { role: 'user', content: message },
          { role: 'assistant', content: formatUserFacingReply(textToSend) },
        ]);
        const rewrite = await runAgentTurn({
          userText: buildToolAuditRewriteInstruction(message),
          ctx,
          systemPrompt,
          tools: [],
          historyMessages: rewriteHistory,
          getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
          resolveToolName: skillContext?.resolveToolName ?? (() => null),
        });
        const candidate = formatUserFacingReply(rewrite?.textToSend || '');
        if (candidate && !looksLikeToolAuditReply(candidate)) {
          textToSend = rewrite.textToSend || textToSend;
          skillsCalled = Array.isArray(rewrite?.skillsCalled) ? rewrite.skillsCalled : skillsCalled;
        }
      } catch (err) {
        process.stderr.write(`[chat-dashboard] tool-audit rewrite failed: ${err?.message || err}\n`);
      }
    }
    const reply = formatDashboardReply(textToSend);
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
    writeNdjsonLine({ type: 'done', reply });
  } catch (err) {
    writeNdjsonLine({ type: 'error', error: err.message || String(err) });
    process.exit(1);
  }
}

main();
