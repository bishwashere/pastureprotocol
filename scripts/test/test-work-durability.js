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
    const { createMission, getMission } = await import('../../lib/missions.js');
    const {
      classifyWorkDurability,
      classifyWorkDurabilityWithAi,
      buildDurableDelegationContext,
      delegationArgsFromDurability,
      delegationRoutingTextFromDurability,
      prepareWorkDurability,
      prepareWorkDurabilityWithAi,
    } = await import('../../lib/work-durability.js');

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
    const durable = prepareWorkDurability({ userText: launchMessage, agentId: 'main' });
    assert(durable.kind === 'new_mission_candidate', 'launch work classified as new mission');
    assert(durable.persistence === 'create_lightweight_mission', 'launch work creates lightweight mission');
    assert(durable.missionId, 'new mission has mission id before delegation');
    assert(durable.createdMission === true, 'mission created by durability step');
    const mission = getMission(durable.missionId);
    assert(mission?.title === 'Launch TestProduct', 'mission title uses product name');
    const taskTitles = (mission?.tasks || []).map((sg) => sg.title).join(' | ').toLowerCase();
    assert(taskTitles.includes('positioning'), 'positioning task created');
    assert(taskTitles.includes('launch posts'), 'launch posts task created');
    assert(taskTitles.includes('landing page checklist'), 'landing page checklist task created');

    const args = delegationArgsFromDurability(durable, launchMessage);
    assert(args.missionId === durable.missionId, 'delegation args include mission id');
    assert(/positioning/i.test(args.expectedOutput), 'delegation expected output includes tasks');

    const routingText = delegationRoutingTextFromDurability(durable, launchMessage);
    assert(/marketing/.test(routingText), 'routing text includes marketing hint after decomposition');

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
    assert(aiDurable.classifier === 'ai', 'messy launch uses AI classifier');
    assert(aiDurable.persistence === 'create_lightweight_mission', 'AI can create durable mission');
    assert(aiDurable.confidence === 0.88, 'AI confidence retained');
    assert(aiDurable.missionId, 'AI durable decision creates mission before delegation');
    const aiMission = getMission(aiDurable.missionId);
    assert(aiMission?.title === 'Launch TestProduct', 'AI projectName used in mission title');
    assert((aiMission?.tasks || []).length === 3, 'AI deliverables become tasks');

    // Known-project early return: a message that mentions a registered project by name
    // should become a new_mission_candidate WITHOUT calling the AI classifier.
    process.env.PASTURE_STATE_DIR = stateDir; // already set, but be explicit
    // Register a mock project so mentionsKnownProject fires.
    const { createProject } = await import('../../lib/projects-db.js');
    createProject({ name: 'testproject', url: 'https://example.com' });
    let knownProjLlmCalls = 0;
    const knownProjResult = await prepareWorkDurabilityWithAi({
      userText: 'how can i improve testproject customer signups',
      agentId: 'main',
      llmChat: async (messages) => {
        const system = String(messages?.[0]?.content || '');
        if (system.includes('decompose persistent user work')) {
          return JSON.stringify({ subtasks: [{ title: 'Improve signup funnel', type: 'marketing', suggestedAgent: 'marketer', confidence: 0.85, reason: 'Signup improvements are marketing work.' }] });
        }
        knownProjLlmCalls += 1;
        return JSON.stringify({ workMode: 'direct_answer', requiresPersistence: false, confidence: 0.9, reason: 'Generic advice' });
      },
    });
    assert(knownProjLlmCalls === 0, 'known-project path skips AI durability classifier');
    assert(knownProjResult.kind === 'new_mission_candidate', 'known-project message becomes new mission');
    assert(knownProjResult.persistence === 'create_lightweight_mission', 'known-project creates mission');
    assert(knownProjResult.projectName === 'testproject', 'known-project name captured');
    assert(knownProjResult.missionId, 'known-project mission created before delegation');
    assert(knownProjResult.decomposition === 'ai-constrained', 'known-project uses AI decomposition for tasks');

    const followup = await prepareWorkDurabilityWithAi({
      userText: 'Make the positioning less corporate',
      agentId: 'main',
      historyMessages: [],
      llmChat: async () => JSON.stringify({
        missionMatch: 'recent_mission',
        missionId: aiDurable.missionId,
        taskMatch: 'positioning',
        confidence: 0.84,
        reason: "User refers to 'the positioning', which belongs to the recent launch package.",
      }),
    });
    assert(followup.kind === 'existing_mission_task_update', 'follow-up attaches to existing mission');
    assert(followup.classifier === 'ai-mission-resolution', 'follow-up uses AI mission resolution');
    assert(followup.missionId === aiDurable.missionId, 'follow-up keeps launch mission id');
    assert(followup.taskId, 'follow-up finds positioning task');
    assert(followup.taskMatch === 'positioning', 'task match retained');
    assert(followup.confidence === 0.84, 'mission resolution confidence retained');

    const unnumberedLaunch = 'I need the launch ready — messaging, socials, maybe the page, and whatever else is missing.';
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
          workMode: 'new_mission_candidate',
          requiresPersistence: true,
          confidence: 0.86,
          reason: 'User describes launch preparation with multiple implied deliverables.',
          projectName: '',
          deliverables: [],
        });
      },
    });
    assert(decompositionCalls === 1, 'AI decomposition called for persistent work');
    assert(decomposed.decomposition === 'ai-constrained', 'decomposition marked ai-constrained');
    assert(decomposed.tasks.length === 4, 'AI decomposition creates four subtasks');
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
