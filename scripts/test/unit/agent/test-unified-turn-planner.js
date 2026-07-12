#!/usr/bin/env node

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const { loadPrompt } = await import('../../../../lib/agent/md-llm.js');
  const {
    planUnifiedTurn,
    unifiedPlanToDelegationContext,
    unifiedPlanToDurabilityDecision,
    unifiedPlanToTurnRoute,
  } = await import('../../../../lib/agent/unified-turn-planner.js');

  const prompt = loadPrompt('unified-turn-planner');
  assert(prompt.includes('work-mode toggle'), 'prompt covers work-mode toggle');
  assert(prompt.includes('never downgrade implementation requests to read-only self-inspection'),
    'prompt preserves implementation tools');
  assert(prompt.includes('Task Frames'), 'prompt covers task frames');
  assert(prompt.includes('command-execution/package-manager capability'),
    'prompt distinguishes package-manager commands from filesystem writes');

  const availableSkillIds = ['read', 'go-read', 'write', 'edit', 'apply-patch', 'project-workflow', 'agent-send', 'search'];
  const implementationPlan = await planUnifiedTurn({
    userText: 'apply the patches',
    currentWorkMode: 'multi',
    availableSkillIds,
    availableSkillSummaries: availableSkillIds.map((id) => ({ id, description: id })),
    availableTeamAgents: [{ agentId: 'builder' }],
    llmChat: async () => JSON.stringify({
      workModeToggle: 'enable',
      needsMultiAgent: true,
      needsDurability: false,
      needsDelegation: false,
      teamRouting: 'current_agent',
      delegationAction: 'none',
      targetAgentId: '',
      mode: 'code',
      skills: ['read', 'go-read', 'write', 'edit', 'apply-patch', 'not-enabled'],
      executionMode: 'tool_use',
      usesExistingWorkIntake: false,
      mustUseTool: true,
      fallbackToolPolicy: 'active_frame_profile',
      projectOrMissionIntent: 'continue',
      githubSourceIntent: false,
      taskFrameAction: 'update',
      taskFrameSeedPolicy: 'reject_candidate',
      taskFrameStatusHint: 'continue',
      taskFrame: {
        kind: 'repo_work',
        title: 'Patch repo',
        objective: 'Apply the approved patches',
        projectName: '',
        repoUrl: '',
        localPath: '',
        ownerAgentId: 'main',
        teamId: 'default',
        toolProfile: ['read', 'write', 'apply-patch', 'not-enabled'],
        plan: 'Inspect and patch files.',
      },
      plan: 'Use read plus write/patch tools.',
      answer_style: 'short',
      reason: 'Continuation of implementation work.',
    }),
  });
  assert(implementationPlan.workModeToggle === 'no_change', 'multi mode cannot be re-enabled');
  assert(implementationPlan.teamRouting === 'current_agent', 'team routing is preserved');
  assert(implementationPlan.mode === 'code', 'implementation plan remains code mode');
  assert(implementationPlan.mustUseTool === true, 'mustUseTool is preserved');
  assert(implementationPlan.fallbackToolPolicy === 'active_frame_profile', 'fallback policy is preserved');
  assert(implementationPlan.taskFrameSeedPolicy === 'reject_candidate', 'seed policy is preserved');
  assert(implementationPlan.skills.includes('write'), 'write skill preserved');
  assert(implementationPlan.skills.includes('apply-patch'), 'apply-patch skill preserved');
  assert(!implementationPlan.skills.includes('not-enabled'), 'hallucinated skills are filtered');
  assert(implementationPlan.taskFrame.toolProfile.join(',') === 'read,write,apply-patch',
    'task-frame tool profile is filtered');

  const route = unifiedPlanToTurnRoute(implementationPlan);
  assert(route.mode === 'code', 'route uses planner mode');
  assert(route.mustUseTool === true, 'route carries mustUseTool');
  assert(route.skills.includes('edit'), 'route carries planner skills');

  const delegatedPlan = await planUnifiedTurn({
    userText: 'have the specialist continue this project',
    currentWorkMode: 'multi',
    availableSkillIds,
    availableTeamAgents: [{ agentId: 'builder' }],
    llmChat: async () => JSON.stringify({
      workModeToggle: 'no_change',
      needsMultiAgent: true,
      needsDurability: true,
      needsDelegation: true,
      teamRouting: 'delegate_to_specialist',
      delegationAction: 'delegate',
      targetAgentId: 'builder',
      mode: 'tool',
      skills: ['agent-send'],
      executionMode: 'delegation',
      usesExistingWorkIntake: false,
      mustUseTool: false,
      fallbackToolPolicy: 'active_frame_profile',
      projectOrMissionIntent: 'continue',
      githubSourceIntent: false,
      taskFrameAction: 'replace',
      taskFrameSeedPolicy: 'revise_candidate',
      taskFrameStatusHint: 'continue',
      taskFrame: {},
      plan: 'Delegate through agent-send and preserve project workflow state.',
      answer_style: 'short',
      reason: 'Specialist should handle this durable work.',
    }),
  });
  assert(delegatedPlan.executionMode === 'persistent_delegation',
    'durable delegation coerces execution mode');
  assert(delegatedPlan.teamRouting === 'delegate_to_specialist', 'specialist team routing is preserved');
  assert(delegatedPlan.mustUseTool === true, 'delegation forces mustUseTool');
  assert(delegatedPlan.delegationAction === 'delegate', 'delegation action is preserved');
  assert(delegatedPlan.taskFrameAction === 'replace', 'replace action is preserved');
  assert(delegatedPlan.taskFrameSeedPolicy === 'revise_candidate', 'candidate seed policy is preserved');
  assert(delegatedPlan.skills.includes('agent-send'), 'delegation forces agent-send when available');
  assert(delegatedPlan.skills.includes('project-workflow'), 'durable work forces project-workflow when available');
  assert(delegatedPlan.needsDelegation === true && delegatedPlan.targetAgentId === 'builder',
    'delegation target is preserved');

  const durability = unifiedPlanToDurabilityDecision(delegatedPlan);
  assert(durability && durability.classifier === 'unified-turn-planner', 'durability comes from unified planner');

  const delegationContext = unifiedPlanToDelegationContext(delegatedPlan, 'main');
  assert(delegationContext?.recommendation?.targetAgentId === 'builder',
    'delegation context uses planner target');
  assert(delegationContext?.recommendation?.routingMethod === 'unified-turn-planner',
    'delegation context records unified source');

  const bad = await planUnifiedTurn({
    userText: 'whatever',
    availableSkillIds,
    llmChat: async () => 'not json',
  });
  assert(bad === null, 'malformed LLM output returns null');

  console.log('unified-turn-planner tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
