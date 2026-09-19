import { getCronStorePath, getAgentWorkspaceDir } from '../util/paths.js';
import { DEFAULT_AGENT_ID, buildAgentTeamPromptBlock, loadAgentConfig } from './agent-config.js';
import { ensureChatSession, shouldAckNewSessionOnly, NEW_SESSION_ACK, getSessionWorkMode } from '../context/chat-session.js';
import { appendExchange, readLastPrivateExchanges, DEFAULT_CHAT_HISTORY_EXCHANGES } from '../context/chat-log.js';
import { buildSessionBootstrapContext } from './session-bootstrap.js';
import { buildOneOnOneSystemPrompt } from './system-prompt.js';
import { getEnabledSkillIds, getEnabledSkillSummaries, getSkillContext } from '../../skills/loader.js';
import { turnRouteToSystemBlock } from './turn-router.js';
import { runAgentTurn } from './agent.js';
import { buildExecutionRequirements } from './execution-requirements.js';
import { runInternalAgentTurn } from './internal-agent-turn.js';
import { getMemoryConfig } from '../context/memory-config.js';
import { indexChatExchange } from '../context/memory-index.js';
import { resolveWorkModeForTurn } from './work-mode.js';
import { fastTriageToTurnRoute, planFastTurnTriage } from './fast-turn-triage.js';
import {
  classifyTaskFrameStatusAfterTurn,
  classifyTaskFrameTurn,
  clearTaskFrame,
  getActiveTaskFrame,
  shouldUseTaskFrameFastPath,
  taskFrameDecisionToTurnRoute,
  taskFrameToSystemBlock,
  updateTaskFrameAfterTurn,
  upsertTaskFrame,
} from '../context/task-frame.js';
import {
  planUnifiedTurn,
  unifiedPlanToTurnRoute,
} from './unified-turn-planner.js';
import {
  buildProjectWorkflowContextBlock,
} from '../context/project-workflow.js';
import {
  buildProjectsContextBlock,
  getProjectTeamId,
  listProjectsForTeam,
  resolveFocusedProjectForTurn,
} from '../context/projects-context.js';
import { buildMissionsContextBlock } from '../context/missions-context.js';
import { getAgentTeamId, listTeamMemberIds } from './teams.js';
import { buildDurabilitySystemBlock } from '../context/work-durability.js';
import { buildRetrospectiveContextBlock } from './retrospective.js';

const noop = () => {};

function apiLogKey(agentId, conversationId) {
  const conv = String(conversationId || 'default').trim() || 'default';
  return `api:${agentId}:${conv}`;
}

/**
 * Run a named Pasture agent from an API input adapter.
 *
 * Keep this on the same private-turn decision stack as WhatsApp/Telegram:
 * fast triage -> work mode -> Task Frame -> Unified Planner -> runAgentTurn.
 * The API may provide transport metadata/history, but it must not keep its own
 * router or planner path.
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
    sessionId,
    logKey,
  };

  const enabledSkillIds = getEnabledSkillIds({ agentId: id });
  const enabledSkillSummaries = getEnabledSkillSummaries({ agentId: id });
  const activeAgentTeamId = getAgentTeamId(id);
  let focusedProject = resolveFocusedProjectForTurn({ userText: text, historyMessages: turnHistory });
  if (!focusedProject && activeAgentTeamId) {
    const teamProjects = listProjectsForTeam(activeAgentTeamId);
    if (teamProjects.length === 1) focusedProject = teamProjects[0];
  }
  const focusedProjectTeamId = getProjectTeamId(focusedProject);
  const eligibleTeamIds = focusedProjectTeamId && focusedProjectTeamId === activeAgentTeamId
    ? listTeamMemberIds(focusedProjectTeamId).filter((teamAgentId) => teamAgentId !== id)
    : [];
  const availableTeamAgents = eligibleTeamIds.map((teamAgentId) => ({ agentId: teamAgentId }));

  let workMode = getSessionWorkMode(logKey);
  const activeTaskFrameBeforeRouting = getActiveTaskFrame(logKey);
  const fastTriage = await planFastTurnTriage({
    userText: text,
    historyMessages: turnHistory,
    availableSkillIds: enabledSkillIds,
    currentWorkMode: workMode,
    activeFrame: activeTaskFrameBeforeRouting,
    agentId: id,
  });
  const fastTriageRoute = fastTriageToTurnRoute(fastTriage);
  if (fastTriage) {
    console.log('[api-fast-triage]', JSON.stringify({
      route: fastTriage.route,
      rawRoute: fastTriage.rawRoute,
      confidence: fastTriage.confidence,
      skills: fastTriage.skills,
      activeFrameId: activeTaskFrameBeforeRouting?.id || '',
      reason: fastTriage.reason || '',
    }));
  }

  if (!fastTriageRoute) {
    const wm = await resolveWorkModeForTurn({
      userText: text,
      logKey,
      agentId: id,
    });
    if (wm) workMode = wm.modeBefore;
  }

  const taskFrameRouting = !fastTriageRoute
    ? await classifyTaskFrameTurn({
        logKey,
        userText: text,
        historyMessages: turnHistory,
        availableSkillIds: enabledSkillIds,
        availableSkillSummaries: enabledSkillSummaries,
        currentWorkMode: workMode === 'multi' ? 'work' : 'single',
        focusedProject,
        focusedProjectTeamId,
        availableTeamAgents,
        agentId: id,
      })
    : null;
  const taskFrameDecision = taskFrameRouting?.decision || null;
  let activeTaskFrame = taskFrameRouting?.activeFrame || null;
  let taskFrameCandidate = null;
  let taskFrameFastPath = false;
  let taskFrameRoute = null;
  if (taskFrameDecision?.action === 'exit' && taskFrameDecision.confidence >= 0.72) {
    clearTaskFrame(logKey, { reason: taskFrameDecision.reason || 'user_exit' });
    activeTaskFrame = null;
  } else if (taskFrameDecision?.action === 'new_candidate' && taskFrameDecision.confidence >= 0.72) {
    taskFrameCandidate = taskFrameDecision;
  } else if (shouldUseTaskFrameFastPath(taskFrameDecision)) {
    taskFrameRoute = taskFrameDecisionToTurnRoute(taskFrameDecision, activeTaskFrame);
    taskFrameFastPath = !!taskFrameRoute;
  }

  let unifiedPlan = null;
  if (!fastTriageRoute && !taskFrameFastPath) {
    unifiedPlan = await planUnifiedTurn({
      userText: text,
      historyMessages: turnHistory,
      availableSkillIds: enabledSkillIds,
      availableSkillSummaries: enabledSkillSummaries,
      currentWorkMode: workMode,
      activeTaskFrame,
      taskFrameDecision,
      taskFrameCandidate,
      availableTeamAgents,
      focusedProject,
      agentId: id,
    });
  }

  const canUseActiveFrameFallback = activeTaskFrame && ['continue_fast', 'continue_replan'].includes(taskFrameDecision?.action || '');
  const plannerFailureFallbackRoute = !taskFrameFastPath && !unifiedPlan
    ? (canUseActiveFrameFallback
        ? {
            mode: activeTaskFrame.kind === 'repo_work' || activeTaskFrame.kind === 'feature_work' || activeTaskFrame.kind === 'debugging' ? 'code' : 'tool',
            skills: Array.isArray(activeTaskFrame.toolProfile) ? activeTaskFrame.toolProfile : [],
            executionMode: 'tool_use',
            usesExistingWorkIntake: true,
            needsWorklog: activeTaskFrame.needsWorklog === true,
            plan: `Planner failed after Task Frame continuation precheck; use active Task Frame profile for ${activeTaskFrame.objective || activeTaskFrame.title || activeTaskFrame.kind}.`,
            answer_style: 'short',
            fallbackToolPolicy: 'active_frame_profile',
          }
        : {
            mode: 'chat',
            skills: [],
            executionMode: 'direct_answer',
            usesExistingWorkIntake: false,
            plan: 'Planner failed; answer directly with no tools.',
            answer_style: 'short',
            fallbackToolPolicy: 'no_tools',
          })
    : null;
  const turnRoute = fastTriageRoute || taskFrameRoute || unifiedPlanToTurnRoute(unifiedPlan) || plannerFailureFallbackRoute;

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
  if (activeTaskFrame) systemPrompt += taskFrameToSystemBlock(activeTaskFrame, taskFrameDecision);
  if (rotated) systemPrompt += buildSessionBootstrapContext(workspaceDir, { logJid: logKey }).block;
  systemPrompt += buildDurabilitySystemBlock(null);
  const retroBlock = await buildRetrospectiveContextBlock(text, getMemoryConfig(loadAgentConfig(id), { workspaceDir }));
  if (retroBlock) systemPrompt += retroBlock;
  if (
    unifiedPlan?.projectOrMissionIntent
    && unifiedPlan.projectOrMissionIntent !== 'none'
  ) {
    systemPrompt += buildMissionsContextBlock({
      userText: text,
      historyMessages: turnHistory,
      agentId: id,
      projectOrMissionIntent: unifiedPlan.projectOrMissionIntent,
    });
    systemPrompt += buildProjectsContextBlock({ userText: text, historyMessages: turnHistory });
    systemPrompt += buildProjectWorkflowContextBlock({ userText: text, historyMessages: turnHistory, agentId: id });
  }

  ctx._originalUserText = text;
  ctx.priorTaskWorklogId = activeTaskFrame?.worklogId || '';
  const turn = await runAgentTurn({
    userText: text,
    ctx,
    systemPrompt,
    tools: toolsToUse,
    historyMessages: turnHistory,
    getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
    resolveToolName: skillContext?.resolveToolName ?? (() => null),
    onToolProgress,
    executionRequirements: buildExecutionRequirements(turnRoute),
    skipCompletenessProbe: turnRoute?.skipCompletenessProbe === true,
  });

  const reply = String(turn?.textToSend || '').trim();
  const skillsCalled = Array.isArray(turn?.skillsCalled) ? turn.skillsCalled : [];
  const validPostTurnFrameStatuses = new Set(['continue', 'completed', 'blocked', 'mismatch', 'waiting_user']);
  let postTurnTaskFrameStatus = validPostTurnFrameStatuses.has(turn?.taskFrameStatus) ? turn.taskFrameStatus : '';
  let postTurnTaskFrameReason = '';
  const plannedFrameForStatus = unifiedPlan && ['new', 'update', 'replace', 'close'].includes(unifiedPlan.taskFrameAction)
    ? {
        ...(activeTaskFrame || {}),
        ...(unifiedPlan.taskFrame || {}),
        status: activeTaskFrame?.status || 'active',
      }
    : null;
  const frameForStatusBase = activeTaskFrame || plannedFrameForStatus;
  const frameForStatus = frameForStatusBase
    ? {
        ...frameForStatusBase,
        logKey: frameForStatusBase.logKey || logKey,
        worklogId: turn?.taskWorklogId || frameForStatusBase.worklogId || '',
      }
    : null;
  if (!postTurnTaskFrameStatus && frameForStatus && reply) {
    const statusDecision = await classifyTaskFrameStatusAfterTurn({
      frame: frameForStatus,
      userText: text,
      assistantText: reply,
      skillsCalled,
      agentId: id,
    });
    if (validPostTurnFrameStatuses.has(statusDecision?.status) && Number(statusDecision?.confidence || 0) >= 0.55) {
      postTurnTaskFrameStatus = statusDecision.status;
      postTurnTaskFrameReason = statusDecision.reason || '';
    }
  }
  const statusToStoredFrameStatus = (status) => {
    if (status === 'blocked') return 'blocked';
    if (status === 'mismatch' || status === 'waiting_user') return 'waiting_user';
    return undefined;
  };
  if (taskFrameFastPath && activeTaskFrame) {
    if (postTurnTaskFrameStatus === 'completed') {
      clearTaskFrame(logKey, { reason: 'post_turn_completed' });
      activeTaskFrame = null;
    } else {
      updateTaskFrameAfterTurn(logKey, {
        userText: text,
        assistantText: reply,
        skillsCalled,
        status: statusToStoredFrameStatus(postTurnTaskFrameStatus),
        worklogId: turn?.taskWorklogId,
      });
    }
  } else if (postTurnTaskFrameStatus === 'completed' && (activeTaskFrame || ['new', 'update', 'replace'].includes(unifiedPlan?.taskFrameAction || ''))) {
    if (activeTaskFrame) clearTaskFrame(logKey, { reason: postTurnTaskFrameReason || 'post_turn_completed' });
    activeTaskFrame = null;
  } else if (unifiedPlan?.taskFrameAction === 'close') {
    clearTaskFrame(logKey, { reason: unifiedPlan.reason || 'unified_planner_close' });
    activeTaskFrame = null;
  } else if (unifiedPlan && ['new', 'update', 'replace'].includes(unifiedPlan.taskFrameAction)) {
    const frameRequiredSkillIds = (unifiedPlan.requiredToolSteps || [])
      .flatMap((step) => Array.isArray(step?.anyOfSkills) ? step.anyOfSkills : []);
    const plannedFrameSkills = unifiedPlan.taskFrame?.toolProfile?.length
      ? unifiedPlan.taskFrame.toolProfile
      : unifiedPlan.skills;
    const frameDecision = {
      action: unifiedPlan.taskFrameAction === 'new' || unifiedPlan.taskFrameAction === 'replace' ? 'new_candidate' : 'continue_replan',
      confidence: 0.8,
      kind: unifiedPlan.taskFrame?.kind || 'general_task',
      title: unifiedPlan.taskFrame?.title || '',
      objective: unifiedPlan.taskFrame?.objective || '',
      projectName: unifiedPlan.taskFrame?.projectName || '',
      repoUrl: unifiedPlan.taskFrame?.repoUrl || '',
      localPath: unifiedPlan.taskFrame?.localPath || '',
      ownerAgentId: unifiedPlan.teamRouting === 'current_agent'
        ? id
        : (unifiedPlan.taskFrame?.ownerAgentId || activeTaskFrame?.ownerAgentId || ''),
      teamId: unifiedPlan.taskFrame?.teamId || focusedProjectTeamId || activeTaskFrame?.teamId || '',
      toolProfile: [...new Set([...frameRequiredSkillIds, ...(plannedFrameSkills || [])])],
      needsWorklog: unifiedPlan.needsWorklog === true,
      plan: unifiedPlan.taskFrame?.plan || unifiedPlan.plan || '',
      reason: unifiedPlan.reason || '',
    };
    activeTaskFrame = upsertTaskFrame(logKey, frameDecision, activeTaskFrame, {
      userText: text,
      replace: unifiedPlan.taskFrameAction === 'new' || unifiedPlan.taskFrameAction === 'replace',
      worklogId: turn?.taskWorklogId,
    });
    updateTaskFrameAfterTurn(logKey, {
      userText: text,
      assistantText: reply,
      skillsCalled,
      status: statusToStoredFrameStatus(postTurnTaskFrameStatus),
      worklogId: turn?.taskWorklogId,
    });
  }
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
    taskWorklogId: turn?.taskWorklogId,
    taskWorklogCheckpointCount: Number(turn?.taskWorklogCheckpointCount || 0),
  };
}
