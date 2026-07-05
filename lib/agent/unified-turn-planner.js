import { runMdPrompt } from './md-llm.js';
import { formatHistoryForClassifier } from '../context/conversation-context.js';

const VALID_TOGGLES = new Set(['enable', 'disable', 'no_change']);
const VALID_MODES = new Set(['chat', 'tool', 'research', 'code', 'memory']);
const VALID_STYLES = new Set(['short', 'detailed']);
const VALID_EXECUTION_MODES = new Set(['direct_answer', 'tool_use', 'delegation', 'persistent_work', 'persistent_delegation']);
const VALID_PROJECT_INTENTS = new Set(['none', 'discover', 'continue', 'status']);
const VALID_TASK_FRAME_ACTIONS = new Set(['none', 'new', 'update', 'close']);
const VALID_TASK_FRAME_KINDS = new Set(['repo_work', 'project_work', 'feature_work', 'debugging', 'general_task']);
const VALID_DELEGATION_ACTIONS = new Set(['none', 'handle_in_main', 'delegate']);
const VALID_FALLBACK_TOOL_POLICIES = new Set(['no_tools', 'active_frame_profile', 'full_tools']);
const VALID_TASK_FRAME_STATUS_HINTS = new Set(['continue', 'completed', 'blocked', 'mismatch']);

function clean(text, max = 800) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function normalizeSkills(skills, availableSkillIds = [], max = 8) {
  const available = new Set((availableSkillIds || []).map(String));
  const out = [];
  for (const raw of Array.isArray(skills) ? skills : []) {
    const id = String(raw || '').trim();
    if (!id || !available.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function addSkillIfAvailable(skills, id, availableSkillIds) {
  if ((availableSkillIds || []).includes(id) && !skills.includes(id)) skills.push(id);
}

function normalizeTaskFrame(raw, availableSkillIds) {
  const frame = raw && typeof raw === 'object' ? raw : {};
  return {
    kind: VALID_TASK_FRAME_KINDS.has(frame.kind) ? frame.kind : 'general_task',
    title: clean(frame.title, 120),
    objective: clean(frame.objective, 500),
    projectName: clean(frame.projectName, 120),
    repoUrl: clean(frame.repoUrl, 300),
    localPath: clean(frame.localPath, 300),
    toolProfile: normalizeSkills(frame.toolProfile, availableSkillIds, 8),
    plan: clean(frame.plan, 800),
  };
}

function normalizeTeamAgents(agents = []) {
  return (Array.isArray(agents) ? agents : [])
    .map((agent) => {
      if (typeof agent === 'string') return { agentId: agent, title: '' };
      return {
        agentId: clean(agent?.agentId || agent?.id, 80),
        title: clean(agent?.title || agent?.name, 120),
        role: clean(agent?.role || '', 120),
      };
    })
    .filter((agent) => agent.agentId)
    .slice(0, 12);
}

export async function planUnifiedTurn({
  userText,
  historyMessages = [],
  availableSkillIds = [],
  availableSkillSummaries = [],
  currentWorkMode = 'single',
  activeTaskFrame = null,
  taskFrameDecision = null,
  taskFrameCandidate = null,
  availableTeamAgents = [],
  focusedProject = null,
  agentId,
  llmChat = null,
} = {}) {
  const summaries = Array.isArray(availableSkillSummaries) && availableSkillSummaries.length > 0
    ? availableSkillSummaries
    : availableSkillIds.map((id) => ({ id, description: id }));
  const result = await runMdPrompt({
    promptName: 'unified-turn-planner',
    user: {
      latestUserMessage: clean(userText, 1200),
      recentConversation: formatHistoryForClassifier(historyMessages, 6),
      currentWorkMode: currentWorkMode === 'multi' ? 'multi' : 'single',
      activeTaskFrame,
      taskFramePrecheck: taskFrameDecision,
      taskFrameCandidate,
      focusedProject,
      availableSkills: summaries.slice(0, 40),
      availableTeamAgents: normalizeTeamAgents(availableTeamAgents),
    },
    agentId,
    purpose: 'unified_turn_planner',
    llmChat,
  });
  if (!result || typeof result !== 'object') return null;

  try {
    const workMode = currentWorkMode === 'multi' ? 'multi' : 'single';
    let workModeToggle = VALID_TOGGLES.has(result.workModeToggle) ? result.workModeToggle : 'no_change';
    if (workMode === 'multi' && workModeToggle === 'enable') workModeToggle = 'no_change';
    if (workMode === 'single' && workModeToggle === 'disable') workModeToggle = 'no_change';

    const skills = normalizeSkills(result.skills, availableSkillIds, 8);
    const delegationAction = VALID_DELEGATION_ACTIONS.has(result.delegationAction)
      ? result.delegationAction
      : (result.needsDelegation === true ? 'delegate' : 'none');
    const requestedDelegation = delegationAction === 'delegate' || result.needsDelegation === true;
    const needsDelegation = requestedDelegation && availableSkillIds.includes('agent-send');
    const targetAgentId = needsDelegation ? clean(result.targetAgentId, 80) : '';
    const needsDurability = result.needsDurability === true;

    if (needsDelegation) addSkillIfAvailable(skills, 'agent-send', availableSkillIds);
    if (needsDurability || result.usesExistingWorkIntake === true) {
      addSkillIfAvailable(skills, 'project-workflow', availableSkillIds);
    }

    let executionMode = VALID_EXECUTION_MODES.has(result.executionMode)
      ? result.executionMode
      : (skills.length ? 'tool_use' : 'direct_answer');
    if (needsDelegation && needsDurability) executionMode = 'persistent_delegation';
    else if (needsDelegation) executionMode = 'delegation';
    else if (needsDurability) executionMode = 'persistent_work';

    const taskFrameAction = VALID_TASK_FRAME_ACTIONS.has(result.taskFrameAction)
      ? result.taskFrameAction
      : 'none';
    const taskFrame = normalizeTaskFrame(result.taskFrame, availableSkillIds);

    return {
      workModeToggle,
      needsMultiAgent: result.needsMultiAgent === true || needsDelegation || needsDurability,
      needsDurability,
      delegationAction: needsDelegation ? 'delegate' : (delegationAction === 'handle_in_main' ? 'handle_in_main' : 'none'),
      needsDelegation: needsDelegation && !!targetAgentId,
      targetAgentId,
      mode: VALID_MODES.has(result.mode) ? result.mode : (skills.length ? 'tool' : 'chat'),
      skills,
      executionMode,
      usesExistingWorkIntake: result.usesExistingWorkIntake === true || needsDurability,
      mustUseTool: result.mustUseTool === true || needsDelegation,
      fallbackToolPolicy: VALID_FALLBACK_TOOL_POLICIES.has(result.fallbackToolPolicy)
        ? result.fallbackToolPolicy
        : (activeTaskFrame ? 'active_frame_profile' : 'no_tools'),
      projectOrMissionIntent: VALID_PROJECT_INTENTS.has(result.projectOrMissionIntent)
        ? result.projectOrMissionIntent
        : 'none',
      githubSourceIntent: result.githubSourceIntent === true,
      taskFrameAction,
      taskFrameStatusHint: VALID_TASK_FRAME_STATUS_HINTS.has(result.taskFrameStatusHint)
        ? result.taskFrameStatusHint
        : 'continue',
      taskFrame,
      plan: clean(result.plan, 1000),
      answer_style: VALID_STYLES.has(result.answer_style) ? result.answer_style : 'short',
      reason: clean(result.reason, 500),
    };
  } catch (err) {
    console.log('[unified-planner] post-validation failed, skipping:', err?.message || err);
    return null;
  }
}

export function unifiedPlanToTurnRoute(plan) {
  if (!plan) return null;
  return {
    mode: plan.mode,
    skills: Array.isArray(plan.skills) ? plan.skills : [],
    executionMode: plan.executionMode,
    usesExistingWorkIntake: plan.usesExistingWorkIntake === true,
    mustUseTool: plan.mustUseTool === true,
    plan: plan.plan || plan.reason || '',
    answer_style: plan.answer_style || 'short',
  };
}

export function unifiedPlanToDurabilityDecision(plan) {
  if (!plan?.needsDurability && !plan?.usesExistingWorkIntake) return null;
  return {
    kind: plan.executionMode === 'persistent_delegation'
      ? 'unified_persistent_delegation'
      : 'unified_persistent_work',
    persistence: plan.usesExistingWorkIntake ? 'unified_planner' : 'none',
    confidence: 0.8,
    classifier: 'unified-turn-planner',
    reason: plan.reason || plan.plan || 'Unified planner marked this turn as durable work.',
    title: plan.taskFrame?.title || '',
    projectName: plan.taskFrame?.projectName || '',
  };
}

export function unifiedPlanToDelegationContext(plan, agentId = 'main') {
  if (!plan?.needsDelegation || !plan.targetAgentId) return null;
  const reason = plan.reason || plan.plan || `Unified planner selected ${plan.targetAgentId}.`;
  return {
    candidates: [
      {
        agentId: plan.targetAgentId,
        title: plan.targetAgentId,
        score: 100,
        confidence: 0.8,
        matchedSkills: [],
        matchedConcepts: [],
        reasoning: reason,
      },
    ],
    teamCapability: {
      request: plan.plan || reason,
      callerAgentId: agentId,
      agents: [
        {
          agentId: plan.targetAgentId,
          title: plan.targetAgentId,
          role: 'specialist',
          linked: true,
          score: 100,
          confidence: 0.8,
          confidencePct: '80%',
          matchedSkills: [],
          matchedConcepts: [],
          reasoning: reason,
        },
      ],
      recommendation: {
        action: 'delegate',
        targetAgentId: plan.targetAgentId,
        reason,
      },
    },
    recommendation: {
      mode: 'delegate',
      action: 'delegate',
      targetAgentId: plan.targetAgentId,
      score: 100,
      confidence: 0.8,
      matchedSkills: [],
      matchedConcepts: [],
      blocked: false,
      reason,
      offerUpgrade: false,
      routingMethod: 'unified-turn-planner',
    },
  };
}
