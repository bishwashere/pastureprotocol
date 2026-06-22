#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-work-durability-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { createMission, getMission } = await import('../../lib/context/missions.js');
    const {
      classifyWorkDurability,
      classifyWorkDurabilityWithAi,
      buildDurableDelegationContext,
      buildDurabilitySystemBlock,
      delegationArgsFromDurability,
      delegationRoutingTextFromDurability,
      prepareWorkDurability,
      prepareWorkDurabilityWithAi,
    } = await import('../../lib/context/work-durability.js');

    const direct = classifyWorkDurability({ userText: 'hi', agentId: 'main' });
    assert(direct.kind === 'direct_answer', 'greeting is direct answer');
    assert(direct.persistence === 'none', 'greeting has no persistence');
    let llmCalls = 0;
    const directAi = await classifyWorkDurabilityWithAi({
      userText: 'hi',
      agentId: 'main',
      llmChat: async () => {
        llmCalls += 1;
        throw new Error('should not call LLM for deterministic fast path');
      },
    });
    assert(directAi.kind === 'direct_answer', 'AI classifier keeps greeting direct');
    assert(llmCalls === 0, 'deterministic fast path skips LLM');

    const existing = createMission({
      title: 'Increase customer sign-ups for NextpostAI',
      objective: 'Improve the signup funnel',
      ownerAgentId: 'main',
      status: 'active',
    });
    const attached = prepareWorkDurability({
      userText: 'continue the Increase customer sign-ups for NextpostAI work',
      agentId: 'main',
    });
    assert(attached.kind === 'existing_mission_task_update', 'existing mission update classified');
    assert(attached.missionId === existing.id, 'existing mission attached before delegation');

    const metaStatus = prepareWorkDurability({
      userText: 'How many tasks or todos are there with agents?',
      agentId: 'main',
    });
    assert(metaStatus.persistence === 'none', 'task count question is not persisted');
    assert(!metaStatus.missionId, 'task count question does not attach to existing mission');

    const launchMessage = [
      'I’m launching a small product called TestProduct next week. It helps solo founders turn rough product notes into launch content.',
      '',
      'Can you prepare:',
      '1. a simple positioning statement',
      '2. 3 launch posts',
      '3. a landing page checklist',
    ].join('\n');
    // Policy: chat-detected multi-deliverable work must ASK before creating a
    // mission. Even with an explicit deliverables list, no mission is created
    // until the user confirms (or explicitly says "create a mission").
    const durable = prepareWorkDurability({ userText: launchMessage, agentId: 'main' });
    assert(durable.kind === 'mission_suggest', 'launch work proposes mission_suggest, not auto-create');
    assert(durable.persistence === 'none', 'launch work does NOT auto-persist mission');
    assert(!durable.missionId, 'launch work does not create mission id before confirmation');
    assert(!durable.createdMission, 'no mission created at the chat-detection step');
    assert(durable.title === 'Launch TestProduct', 'suggested mission title uses product name');
    const suggestedTaskTitles = (durable.tasks || []).map((sg) => sg.title).join(' | ').toLowerCase();
    assert(suggestedTaskTitles.includes('positioning'), 'positioning task suggested');
    assert(suggestedTaskTitles.includes('launch posts'), 'launch posts task suggested');
    assert(suggestedTaskTitles.includes('landing page checklist'), 'landing page checklist task suggested');

    // The system block must instruct the agent to ask the user, list the
    // proposed tasks, and explicitly NOT create the mission yet.
    const launchSuggestBlock = buildDurabilitySystemBlock(durable);
    assert(launchSuggestBlock.includes('Do NOT create a mission yet'), 'launch suggest block tells agent to wait');
    assert(/positioning/i.test(launchSuggestBlock), 'launch suggest block lists proposed tasks');

    // Confirming via "yes" after the agent's mission_suggest reply turns the
    // suggestion into an actual mission, using the original message (not "yes")
    // for AI decomposition.
    const launchHistory = [
      { role: 'user', content: launchMessage },
      { role: 'assistant', content: 'Sounds great. Would you like me to open a tracked mission for TestProduct so I can plan and delegate this? Proposed tasks: positioning, launch posts, landing page checklist.' },
    ];
    let launchDecomposeCalls = 0;
    let launchDecomposeSawOriginal = false;
    const confirmedLaunch = await prepareWorkDurabilityWithAi({
      userText: 'yes please',
      agentId: 'main',
      historyMessages: launchHistory,
      llmChat: async (messages) => {
        const system = String(messages?.[0]?.content || '');
        const user = String(messages?.[1]?.content || '');
        if (system.includes('decompose persistent user work')) {
          launchDecomposeCalls += 1;
          if (user.includes('TestProduct')) launchDecomposeSawOriginal = true;
          return JSON.stringify({
            subtasks: [
              { title: 'Create positioning statement', type: 'marketing', suggestedAgent: 'marketer', confidence: 0.9, reason: 'Marketing work.' },
              { title: 'Draft launch posts', type: 'marketing', suggestedAgent: 'marketer', confidence: 0.88, reason: 'Marketing work.' },
              { title: 'Build landing page checklist', type: 'product', suggestedAgent: 'alex', confidence: 0.78, reason: 'Product work.' },
            ],
          });
        }
        return JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Should not be called' });
      },
    });
    assert(launchDecomposeCalls === 1, 'AI decomposition called once on confirmation');
    assert(launchDecomposeSawOriginal === true, 'decomposition runs on the original user message, not "yes"');
    assert(confirmedLaunch.kind === 'new_mission_candidate', 'confirmation creates new_mission_candidate');
    assert(confirmedLaunch.persistence === 'create_lightweight_mission', 'confirmation persists mission');
    assert(confirmedLaunch.missionId, 'confirmation produces mission id');
    const confirmedMission = getMission(confirmedLaunch.missionId);
    assert(confirmedMission?.title === 'TestProduct work' || confirmedMission?.title === 'Launch TestProduct',
      'confirmed mission title references TestProduct');
    assert((confirmedMission?.tasks || []).length === 3, 'AI decomposition tasks persisted on confirm');

    const args = delegationArgsFromDurability(confirmedLaunch, launchMessage);
    assert(args.missionId === confirmedLaunch.missionId, 'delegation args include mission id after confirm');
    assert(/positioning/i.test(args.expectedOutput), 'delegation expected output includes tasks after confirm');

    const routingText = delegationRoutingTextFromDurability(confirmedLaunch, launchMessage);
    assert(/marketing/.test(routingText), 'routing text includes marketing hint after decomposition');

    // Explicit "create a mission" wording bypasses the ask-first flow — the
    // user already gave consent in this turn so the mission is created
    // immediately (with AI-decomposed tasks).
    let explicitDecomposeCalls = 0;
    const explicitCreate = await prepareWorkDurabilityWithAi({
      userText: 'Please create a mission to launch ExplicitProduct with positioning, posts, and a landing page.',
      agentId: 'main',
      llmChat: async (messages) => {
        const system = String(messages?.[0]?.content || '');
        if (system.includes('decompose persistent user work')) {
          explicitDecomposeCalls += 1;
          return JSON.stringify({
            subtasks: [
              { title: 'Create positioning statement', type: 'marketing', suggestedAgent: 'marketer', confidence: 0.9, reason: 'Marketing.' },
              { title: 'Draft launch posts', type: 'marketing', suggestedAgent: 'marketer', confidence: 0.88, reason: 'Marketing.' },
            ],
          });
        }
        return JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Should not be called' });
      },
    });
    assert(explicitDecomposeCalls === 1, 'explicit mission request triggers AI decomposition');
    assert(explicitCreate.kind === 'new_mission_candidate', 'explicit request creates new mission');
    assert(explicitCreate.persistence === 'create_lightweight_mission', 'explicit request persists immediately');
    assert(explicitCreate.explicitMissionRequest === true, 'explicit request marked on decision');
    assert(explicitCreate.missionId, 'explicit request produces mission id');

    // Negated "don't create a mission" must NOT trigger explicit creation.
    const negated = await prepareWorkDurabilityWithAi({
      userText: "Don't create a mission, just answer me directly: what's a good positioning for TestProduct?",
      agentId: 'main',
      llmChat: async () => JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Direct answer.' }),
    });
    assert(negated.kind !== 'new_mission_candidate', 'negated explicit phrasing does not create mission');
    assert(!negated.missionId, 'negated explicit phrasing creates no mission');

    // AI classifier returning new_mission_candidate must also be downgraded to
    // mission_suggest — chat-detected work never auto-creates.
    const messyLaunch = 'I’m launching this next week and need to get the messaging, posts, and page ready.';
    const aiDurable = await prepareWorkDurabilityWithAi({
      userText: messyLaunch,
      agentId: 'main',
      llmChat: async () => JSON.stringify({
        workMode: 'new_mission_candidate',
        requiresPersistence: true,
        confidence: 0.88,
        reason: 'User describes a future launch with multiple deliverables.',
        projectName: 'TestProduct',
        deliverables: ['Positioning', 'Launch posts', 'Landing page'],
      }),
    });
    assert(aiDurable.classifier === 'ai', 'messy launch still uses AI classifier');
    assert(aiDurable.kind === 'mission_suggest', 'AI-classified new mission becomes mission_suggest');
    assert(aiDurable.persistence === 'none', 'AI-classified mission_suggest does not persist');
    assert(!aiDurable.missionId, 'AI-classified mission_suggest creates no mission yet');
    assert(aiDurable.confidence === 0.88, 'AI confidence retained on mission_suggest');
    assert(Array.isArray(aiDurable.tasks) && aiDurable.tasks.length === 3, 'AI deliverables surfaced as proposed tasks');

    // ── Known-project three-tier tests ────────────────────────────────────────
    // Use separate project names per tier so earlier mission creation doesn't
    // cause deterministicFastPath to return existing_mission_task_update.
    const { createProject } = await import('../../lib/context/projects-db.js');
    createProject({ name: 'alphapp', url: 'https://alpha.example.com' });
    createProject({ name: 'betapp', url: 'https://beta.example.com' });
    createProject({ name: 'gammaapp', url: 'https://gamma.example.com' });

    // TIER 1 — HIGH confidence: project + explicit multi-deliverable list
    // → mission_suggest (ask first), no auto-create, no AI decomposition yet.
    let highTierLlmCalls = 0;
    let highTierDecomposeCalls = 0;
    const highTierResult = await prepareWorkDurabilityWithAi({
      userText: 'for alphapp I need:\n1. a new onboarding flow\n2. updated signup copy\n3. analytics tracking',
      agentId: 'main',
      llmChat: async (messages) => {
        const system = String(messages?.[0]?.content || '');
        if (system.includes('decompose persistent user work')) {
          highTierDecomposeCalls += 1;
          return JSON.stringify({ subtasks: [{ title: 'Redesign onboarding flow', type: 'product', suggestedAgent: 'alex', confidence: 0.85, reason: 'Product work.' }] });
        }
        highTierLlmCalls += 1;
        return JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Generic advice' });
      },
    });
    assert(highTierLlmCalls === 0, 'high-confidence known-project skips AI durability classifier');
    assert(highTierDecomposeCalls === 0, 'high-confidence does not decompose until user confirms');
    assert(highTierResult.kind === 'mission_suggest', 'high-confidence returns mission_suggest, not auto-create');
    assert(highTierResult.persistence === 'none', 'high-confidence does NOT auto-persist');
    assert(highTierResult.projectName === 'alphapp', 'high-confidence project name captured');
    assert(!highTierResult.missionId, 'high-confidence does not create mission before confirmation');
    assert(Array.isArray(highTierResult.tasks) && highTierResult.tasks.length >= 3, 'high-confidence carries deterministic tasks for confirmation prompt');

    // TIER 2 — MEDIUM confidence: project + action verb but no deliverables
    // → mission_suggest, agent asks confirmation, no mission created yet.
    let midTierLlmCalls = 0;
    const midTierResult = await prepareWorkDurabilityWithAi({
      userText: 'how can i improve betapp customer signups',
      agentId: 'main',
      llmChat: async () => {
        midTierLlmCalls += 1;
        return JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Generic advice' });
      },
    });
    assert(midTierLlmCalls === 0, 'medium-confidence known-project skips AI durability classifier');
    assert(midTierResult.kind === 'mission_suggest', 'medium-confidence returns mission_suggest');
    assert(midTierResult.persistence === 'none', 'medium-confidence does not persist immediately');
    assert(!midTierResult.missionId, 'medium-confidence does not create mission yet');
    assert(midTierResult.projectName === 'betapp', 'medium-confidence captures project name');

    // TIER 3 — NO action intent: just mentioning the project without work verbs
    // → falls through to AI or one_off_delegated_answer, no auto-mission.
    const noActionResult = await prepareWorkDurabilityWithAi({
      userText: 'tell me about gammaapp',
      agentId: 'main',
      llmChat: async () => JSON.stringify({ workMode: 'one_off_delegated_answer', requiresPersistence: false, confidence: 0.8, reason: 'Status question.' }),
    });
    assert(noActionResult.kind !== 'new_mission_candidate', 'general project mention does not auto-create mission');
    assert(noActionResult.kind !== 'mission_suggest', 'general project mention does not suggest mission either');
    assert(!noActionResult.missionId, 'general project mention creates no mission');

    // ── Layer: confirmation detection ─────────────────────────────────────────
    // After agent asked "Should I create a mission for betapp?", user says "yes".
    // detectMissionConfirmation should fire and produce new_mission_candidate.
    const fakeAgentSuggestHistory = [
      { role: 'user', content: 'how can i improve betapp customer signups' },
      { role: 'assistant', content: 'Here are some ideas... Would you like me to open a tracked mission for betapp so this work can be delegated and followed up?' },
    ];
    let confirmLlmCalls = 0;
    const confirmResult = await prepareWorkDurabilityWithAi({
      userText: 'yes',
      agentId: 'main',
      historyMessages: fakeAgentSuggestHistory,
      llmChat: async (messages) => {
        const system = String(messages?.[0]?.content || '');
        if (system.includes('decompose persistent user work')) {
          return JSON.stringify({ subtasks: [{ title: 'Improve betapp signup funnel', type: 'marketing', suggestedAgent: 'marketer', confidence: 0.85, reason: 'Signup improvement.' }] });
        }
        confirmLlmCalls += 1;
        return JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Simple yes reply.' });
      },
    });
    assert(confirmLlmCalls === 0, 'confirmed mission skips AI durability classifier');
    assert(confirmResult.kind === 'new_mission_candidate', 'confirmed yes creates new mission');
    assert(confirmResult.persistence === 'create_lightweight_mission', 'confirmed yes persists mission');
    assert(confirmResult.projectName === 'betapp', 'confirmed yes captures project from history');
    assert(confirmResult.missionId, 'confirmed yes creates mission before delegation');
    assert(confirmResult.decomposition === 'ai-constrained', 'confirmed yes decomposes into subtasks');

    // Non-affirmative reply should NOT trigger confirmation even with mission history.
    const nonAffirmResult = await prepareWorkDurabilityWithAi({
      userText: 'not sure yet',
      agentId: 'main',
      historyMessages: fakeAgentSuggestHistory,
      llmChat: async () => JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Uncertain reply.' }),
    });
    assert(nonAffirmResult.kind !== 'new_mission_candidate', 'uncertain reply does not create mission');

    // ── Layer: delegationRoutingTextFromDurability for mission_suggest ─────────
    // mission_suggest has persistence:'none' but should include project name in routing.
    const suggestDecision = { kind: 'mission_suggest', persistence: 'none', projectName: 'betapp', title: 'betapp work' };
    const suggestRoutingText = delegationRoutingTextFromDurability(suggestDecision, 'how can i improve betapp signups');
    assert(suggestRoutingText.includes('betapp'), 'mission_suggest routing text includes project name');

    // ── Layer: buildDurabilitySystemBlock for mission_suggest ─────────────────
    const suggestBlock = buildDurabilitySystemBlock(suggestDecision);
    assert(suggestBlock.includes('INSTRUCTION'), 'mission_suggest system block has agent instruction');
    assert(suggestBlock.includes('betapp'), 'mission_suggest system block includes project name');
    assert(suggestBlock.includes('Do NOT create a mission yet'), 'mission_suggest system block tells agent to wait');

    // mission_suggest with proposed tasks should surface them in the block so
    // the agent can mention concrete tasks when asking for confirmation.
    const suggestWithTasks = {
      kind: 'mission_suggest',
      persistence: 'none',
      projectName: 'alphapp',
      title: 'alphapp work',
      tasks: [
        { title: 'Redesign onboarding flow' },
        { title: 'Update signup copy' },
      ],
    };
    const suggestTasksBlock = buildDurabilitySystemBlock(suggestWithTasks);
    assert(suggestTasksBlock.includes('Proposed tasks'), 'system block lists proposed tasks header');
    assert(suggestTasksBlock.includes('Redesign onboarding flow'), 'proposed task surfaced in block');
    assert(suggestTasksBlock.includes('Update signup copy'), 'second proposed task surfaced in block');

    const followup = await prepareWorkDurabilityWithAi({
      userText: 'Make the positioning less corporate',
      agentId: 'main',
      historyMessages: [],
      llmChat: async () => JSON.stringify({
        missionMatch: 'recent_mission',
        missionId: confirmedLaunch.missionId,
        taskMatch: 'positioning',
        confidence: 0.84,
        reason: "User refers to 'the positioning', which belongs to the recent launch package.",
      }),
    });
    assert(followup.kind === 'existing_mission_task_update', 'follow-up attaches to existing mission');
    assert(followup.classifier === 'ai-mission-resolution', 'follow-up uses AI mission resolution');
    assert(followup.missionId === confirmedLaunch.missionId, 'follow-up keeps launch mission id');
    assert(followup.taskId, 'follow-up finds positioning task');
    assert(followup.taskMatch === 'positioning', 'task match retained');
    assert(followup.confidence === 0.84, 'mission resolution confidence retained');

    // AI decomposition end-to-end: explicit "create a mission" wording bypasses
    // the ask-first flow and triggers full AI decomposition + persistence.
    const unnumberedLaunch = 'Please create a mission. I need the launch ready — messaging, socials, maybe the page, and whatever else is missing.';
    let decompositionCalls = 0;
    const decomposed = await prepareWorkDurabilityWithAi({
      userText: unnumberedLaunch,
      agentId: 'main',
      llmChat: async (messages) => {
        const system = String(messages?.[0]?.content || '');
        if (system.includes('decompose persistent user work')) {
          decompositionCalls += 1;
          return JSON.stringify({
            subtasks: [
              {
                title: 'Create positioning statement',
                type: 'marketing',
                suggestedAgent: 'marketer',
                confidence: 0.91,
                reason: 'Positioning and launch messaging are marketing tasks.',
              },
              {
                title: 'Create launch posts',
                type: 'marketing',
                suggestedAgent: 'marketer',
                confidence: 0.9,
                reason: 'Launch posts are marketing content.',
              },
              {
                title: 'Create landing page checklist',
                type: 'product',
                suggestedAgent: 'alex',
                confidence: 0.72,
                reason: 'Checklist includes product/page implementation review.',
              },
              {
                title: 'Identify missing launch items',
                type: 'planning',
                suggestedAgent: 'main',
                confidence: 0.78,
                reason: 'Coordinator should identify missing cross-functional work.',
              },
            ],
          });
        }
        return JSON.stringify({
          workMode: 'direct_answer',
          requiresPersistence: false,
          confidence: 0.9,
          reason: 'Should not be called — explicit request short-circuits the classifier.',
        });
      },
    });
    assert(decompositionCalls === 1, 'AI decomposition called for explicit mission request');
    assert(decomposed.kind === 'new_mission_candidate', 'explicit request creates new_mission_candidate');
    assert(decomposed.explicitMissionRequest === true, 'decomposed flagged as explicit request');
    assert(decomposed.decomposition === 'ai-constrained', 'decomposition marked ai-constrained');
    assert(decomposed.tasks.length === 4, 'AI decomposition creates four subtasks');
    assert(decomposed.missionId, 'explicit request persists mission immediately');
    const decomposedMission = getMission(decomposed.missionId);
    const typed = decomposedMission.tasks || [];
    assert(typed.some((sg) => sg.title === 'Create positioning statement' && sg.type === 'marketing' && sg.suggestedAgent === 'marketer'), 'positioning task typed for marketer');
    assert(typed.some((sg) => sg.title === 'Create landing page checklist' && sg.type === 'product' && sg.suggestedAgent === 'alex'), 'landing page task typed for alex');
    assert(typed.some((sg) => sg.title === 'Identify missing launch items' && sg.type === 'planning' && sg.suggestedAgent === 'main'), 'missing launch items task typed for main');

    const durableRouting = buildDurableDelegationContext(decomposed, {
      agentId: 'main',
      availableSkillIds: ['agent-send'],
    });
    assert(durableRouting?.recommendation?.action === 'delegate', 'durable work routes to a specialist');
    assert(durableRouting.recommendation.targetAgentId === 'marketer', 'durable routing selects marketer over keyword tie');
    assert(durableRouting.recommendation.routingMethod === 'durable-ai', 'durable routing is semantic-first');
    assert(durableRouting.recommendation.confidence === 0.91, 'durable routing keeps route confidence');
    assert(durableRouting.recommendation.routes.some((r) => r.task === 'Create landing page checklist' && r.agent === 'alex' && r.confidence === 0.72), 'durable routing includes alex page route');
    assert(durableRouting.recommendation.routes.some((r) => r.task === 'Create positioning statement' && r.agent === 'marketer'), 'durable routing includes marketer positioning route');

    console.log('work-durability tests passed');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.PASTURE_STATE_DIR;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
