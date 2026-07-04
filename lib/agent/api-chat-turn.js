import { getCronStorePath, getAgentWorkspaceDir } from '../util/paths.js';
import { DEFAULT_AGENT_ID, buildAgentTeamPromptBlock, loadAgentConfig } from './agent-config.js';
import { ensureChatSession, shouldAckNewSessionOnly, NEW_SESSION_ACK } from '../context/chat-session.js';
import { appendExchange, readLastPrivateExchanges, DEFAULT_CHAT_HISTORY_EXCHANGES } from '../context/chat-log.js';
import { buildSessionBootstrapContext } from './session-bootstrap.js';
import { buildOneOnOneSystemPrompt } from './system-prompt.js';
import { getEnabledSkillIds, getEnabledSkillSummaries, getSkillContext } from '../../skills/loader.js';
import { classifyTurnIntent, buildCasualPlanFromTurnIntent } from './turn-intent.js';
import { isNonTaskMessage } from './evaluate-team-capability.js';
import { routeTurn, turnRouteToSystemBlock, buildCasualChatTurnRoute } from './turn-router.js';
import { runAgentTurn } from './agent.js';
import { runInternalAgentTurn } from './internal-agent-turn.js';
import { getMemoryConfig } from '../context/memory-config.js';
import { indexChatExchange } from '../context/memory-index.js';

const noop = () => {};

function apiLogKey(agentId, conversationId) {
  const conv = String(conversationId || 'default').trim() || 'default';
  return `api:${agentId}:${conv}`;
}

/**
 * Run a named Pasture agent as an isolated API chat surface.
 *
 * This intentionally does not route through the main/owner chat channel. It
 * uses the target agent's own workspace for history, bootstrap, and memory.
 */
export async function runAgentApiChatTurn({
  agentId,
  userText,
  conversationId = 'default',
  historyMessages = null,
  model = '',
  onToolProgress = null,
} = {}) {
  const id = String(agentId || '').trim() || DEFAULT_AGENT_ID;
  const text = String(userText || '').trim();
  if (!text) throw new Error('userText is required');

  loadAgentConfig(id);
  const workspaceDir = getAgentWorkspaceDir(id);
  const logKey = apiLogKey(id, conversationId);
  const { sessionId, rotated, reason } = ensureChatSession(logKey, { userText: text });

  if (shouldAckNewSessionOnly(reason, text)) {
    const exchange = {
      user: text,
      assistant: NEW_SESSION_ACK,
      timestampMs: Date.now(),
      jid: logKey,
      sessionId,
    };
    appendExchange(workspaceDir, exchange);
    return {
      reply: NEW_SESSION_ACK,
      skillsCalled: [],
      sessionId,
      logKey,
      model,
    };
  }

  const persistedHistory = readLastPrivateExchanges(
    workspaceDir,
    logKey,
    DEFAULT_CHAT_HISTORY_EXCHANGES,
    sessionId,
  );
  const turnHistory = Array.isArray(historyMessages) && historyMessages.length
    ? historyMessages
    : persistedHistory;

  const ctx = {
    storePath: getCronStorePath(),
    jid: logKey,
    workspaceDir,
    agentId: id,
    scheduleOneShot: noop,
    startCron: noop,
    isGroup: false,
    runInternalAgent: runInternalAgentTurn,
    agentDepth: 0,
    agentCallChain: [id],
  };

  const enabledSkillIds = getEnabledSkillIds({ agentId: id });
  const enabledSkillSummaries = getEnabledSkillSummaries({ agentId: id });
  const turnIntent = await classifyTurnIntent({
    userText: text,
    historyMessages: turnHistory,
    availableSkillIds: enabledSkillIds,
    availableSkillSummaries: enabledSkillSummaries,
    currentWorkMode: 'single',
    agentId: id,
  });
  const turnIntentIsConfident = turnIntent && turnIntent.confidence >= 0.65;
  const casualPlan = turnIntentIsConfident
    ? buildCasualPlanFromTurnIntent(turnIntent)
    : (isNonTaskMessage(text) ? buildCasualChatTurnRoute() : null);
  const turnRoute = casualPlan || (enabledSkillIds.length > 0
    ? await routeTurn({
        userText: text,
        historyMessages: turnHistory,
        availableSkillIds: enabledSkillIds,
        availableSkillSummaries: enabledSkillSummaries,
        agentId: id,
      })
    : null);

  const plannerSaysNoTools = turnRoute !== null && Array.isArray(turnRoute.skills) && turnRoute.skills.length === 0;
  let skillContext = null;
  let toolsToUse = [];
  if (!plannerSaysNoTools) {
    skillContext = getSkillContext({ agentId: id, hintSkills: turnRoute?.skills ?? null });
    toolsToUse = Array.isArray(skillContext.runSkillTool) ? skillContext.runSkillTool : [];
  }

  const basePrompt = buildOneOnOneSystemPrompt(workspaceDir, { agentId: id }) + buildAgentTeamPromptBlock(id);
  const planBlock = turnRouteToSystemBlock(turnRoute);
  let systemPrompt = planBlock ? basePrompt + '\n\n' + planBlock : basePrompt;
  if (rotated) systemPrompt += buildSessionBootstrapContext(workspaceDir, { logJid: logKey }).block;

  ctx._originalUserText = text;
  const turn = await runAgentTurn({
    userText: text,
    ctx,
    systemPrompt,
    tools: toolsToUse,
    historyMessages: turnHistory,
    getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
    resolveToolName: skillContext?.resolveToolName ?? (() => null),
    onToolProgress,
  });

  const reply = String(turn?.textToSend || '').trim();
  const skillsCalled = Array.isArray(turn?.skillsCalled) ? turn.skillsCalled : [];
  if (reply) {
    const exchange = {
      user: text,
      assistant: reply,
      timestampMs: Date.now(),
      jid: logKey,
      sessionId,
    };
    const memoryConfig = getMemoryConfig(loadAgentConfig(id), { workspaceDir });
    if (memoryConfig) {
      await indexChatExchange(memoryConfig, exchange);
    } else {
      appendExchange(workspaceDir, exchange);
    }
  }

  return {
    reply,
    skillsCalled,
    sessionId,
    logKey,
    model,
  };
}
