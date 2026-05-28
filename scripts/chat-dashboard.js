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
import { planIntent, intentPlanToSystemBlock } from '../lib/intent-planner.js';
import { buildOneOnOneSystemPrompt } from '../lib/system-prompt.js';
import { DEFAULT_AGENT_ID, ensureMainAgentInitialized, loadAgentConfig } from '../lib/agent-config.js';
import { appendExchange, readLastPrivateExchanges } from '../lib/chat-log.js';
import { ensureChatSession } from '../lib/chat-session.js';
import { buildSessionBootstrapContext } from '../lib/session-bootstrap.js';
import { getOwnerLogJid } from '../lib/owner-config.js';
import { getMemoryConfig } from '../lib/memory-config.js';
import { indexChatExchange } from '../lib/memory-index.js';

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
  const { sessionId, rotated: sessionRotated } = ensureChatSession(dashboardJid, { userText: message });
  if (sessionRotated) {
    process.stderr.write(`[chat-dashboard] new session ${sessionId}\n`);
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
  };
  // Step 1: cheap config-only skill ID list (no SKILL.md reads yet).
  const enabledSkillIds = getEnabledSkillIds({ agentId });
  const enabledSkillSummaries = getEnabledSkillSummaries({ agentId });
  // Step 2: intent planner — one small LLM call before loading any tool schemas.
  const intentPlan = enabledSkillIds.length > 0
    ? await planIntent({ userText: message, availableSkillIds: enabledSkillIds, availableSkillSummaries: enabledSkillSummaries, agentId })
    : null;
  if (intentPlan) process.stderr.write('[intent-planner] ' + JSON.stringify(intentPlan) + '\n');
  // Step 3: load tool schemas based on what the planner returned.
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
  const baseSystemPrompt = buildOneOnOneSystemPrompt(workspaceDir);
  const planBlock = intentPlanToSystemBlock(intentPlan);
  let systemPrompt = planBlock ? baseSystemPrompt + '\n\n' + planBlock : baseSystemPrompt;
  if (sessionRotated) {
    systemPrompt += buildSessionBootstrapContext(workspaceDir).block;
  }

  try {
    const { textToSend } = await runAgentTurn({
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
    const reply = formatDashboardReply(textToSend);
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
        await indexChatExchange(memoryConfig, exchange);
      } else {
        appendExchange(workspaceDir, exchange);
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
