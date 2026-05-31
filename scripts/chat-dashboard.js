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
import { planIntent, intentPlanToSystemBlock } from '../lib/intent-planner.js';
import { buildDelegationContext } from '../lib/agent-delegation-router.js';
import { executeSkill } from '../skills/executor.js';
import { logTeamActivity } from '../lib/team-activity.js';
import { buildOneOnOneSystemPrompt } from '../lib/system-prompt.js';
import { DEFAULT_AGENT_ID, ensureMainAgentInitialized, loadAgentConfig, buildAgentTeamPromptBlock } from '../lib/agent-config.js';
import { appendExchange, readLastPrivateExchanges } from '../lib/chat-log.js';
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
import { appendUserFacingPrompt } from '../lib/user-reply-style.js';

// Match Telegram/WhatsApp default. Override via COWCODE_DASHBOARD_HISTORY env if needed.
const DASHBOARD_HISTORY_EXCHANGES = Math.max(
  1,
  Math.floor(Number(process.env.COWCODE_DASHBOARD_HISTORY)) || 5
);

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
  let reply = textToSend != null ? String(textToSend) : '';
  reply = reply.replace(/(^|\n)\s*\[CowCode\]\s*/gi, '$1').trim();
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
  // Step 2: specialization-aware delegation check before planner (same as index.js private chat).
  const delegationContext = buildDelegationContext({
    agentId,
    userText: message,
    availableSkillIds: enabledSkillIds,
  });
  const delegatedTarget = delegationContext?.recommendation?.action === 'delegate'
    ? (delegationContext?.recommendation?.targetAgentId || '')
    : '';
  const delegationDecision = delegationContext?.recommendation
    ? {
        reason: String(delegationContext.recommendation.reason || '').trim(),
        selected: delegatedTarget || '',
        action: String(delegationContext.recommendation.action || '').trim(),
        selectedConfidence: Number(delegationContext.recommendation.confidence || 0),
        offerUpgrade: !!delegationContext.recommendation.offerUpgrade,
        suggestedDomain: String(delegationContext.recommendation.suggestedDomain || '').trim(),
        candidates: Array.isArray(delegationContext.candidates)
          ? delegationContext.candidates.slice(0, 5).map((c) => ({
              agentId: String(c.agentId || '').trim(),
              title: String(c.title || '').trim(),
              confidence: Number(c.confidence || 0),
              score: Number(c.score || 0),
            }))
          : [],
        teamAgents: Array.isArray(delegationContext.teamCapability?.agents)
          ? delegationContext.teamCapability.agents.slice(0, 6).map((a) => ({
              agentId: a.agentId,
              confidencePct: a.confidencePct,
              reasoning: a.reasoning,
            }))
          : [],
      }
    : null;
  const presetDelegationPlan = delegatedTarget && delegationContext?.recommendation?.action === 'delegate'
    ? {
        mode: 'tool',
        skills: ['agent-send'],
        plan: `Delegate to ${delegatedTarget} via agent-send first; that agent is the best specialization match for this request.`,
        answer_style: 'short',
      }
    : null;
  if (presetDelegationPlan && delegationDecision) {
    logTeamActivity({
      type: 'delegation_decision',
      agentId,
      targetAgentId: delegatedTarget,
      status: delegationContext?.recommendation?.blocked ? 'blocked' : 'ok',
      depth: 0,
      jid: dashboardJid,
      message: `Delegation decision selected ${delegatedTarget}`,
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
  // Step 3: intent planner — one small LLM call before loading any tool schemas.
  const goalsIntentHint = !presetDelegationPlan
    ? getGoalsDiscoveryIntentHint(message, historyMessages, enabledSkillIds, agentId)
    : null;
  const intentPlan = presetDelegationPlan || goalsIntentHint || (enabledSkillIds.length > 0
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
  // Step 4: load tool schemas based on what the planner returned.
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
  const memoryConfig = getMemoryConfig();
  const retroBlock = await buildRetrospectiveContextBlock(message, memoryConfig);
  if (retroBlock) systemPrompt += retroBlock;
  const goalsBlock = buildGoalsContextBlock({ userText: message, historyMessages, agentId });
  if (goalsBlock) systemPrompt += goalsBlock;
  const projectsBlock = buildProjectsContextBlock({ userText: message, historyMessages });
  if (projectsBlock) systemPrompt += projectsBlock;
  systemPrompt = appendUserFacingPrompt(systemPrompt);

  try {
    let textToSend = '';
    let skillsCalled = [];
    if (presetDelegationPlan && delegatedTarget) {
      try {
        const forcedRaw = await executeSkill('agent-send', ctx, {
          agent: delegatedTarget,
          message: enrichMessageWithProjectContext(message, historyMessages),
        });
        const forced = JSON.parse(forcedRaw || '{}');
        if (forced && typeof forced.reply === 'string' && forced.reply.trim()) {
          const label = forced.agentTitle || forced.agent || delegatedTarget;
          textToSend = `[CowCode] ${label} replied: ${forced.reply.trim()}`;
          skillsCalled = ['agent-send'];
        } else if (forced && typeof forced.error === 'string') {
          textToSend = `[CowCode] ${forced.error.trim()}`;
          skillsCalled = ['agent-send'];
        }
      } catch (_) {}
    }
    if (!textToSend) {
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
