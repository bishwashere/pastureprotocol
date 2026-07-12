#!/usr/bin/env node
/**
 * Unit tests for intent-planner routing with skill summaries.
 *
 * Verifies that planIntent() selects the correct skill based on meaning
 * (via descriptions), not just skill names. Key regression: a filesystem
 * query ("check a folder on my computer") must route to go-read, NOT browse.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');

dotenv.config({ path: join(homedir(), '.pasture', '.env') });

const { loadPrompt } = await import('../../../../lib/agent/md-llm.js');
const { planIntent } = await import('../../../../lib/agent/intent-planner.js');
const { getEnabledSkillSummaries } = await import('../../../../skills/loader.js');

const TIMEOUT_MS = 30_000;
const RUN_LIVE_LLM = process.env.PASTURE_RUN_LIVE_LLM_TESTS === '1';

const SKILL_SUMMARIES = getEnabledSkillSummaries();

/** @type {Array<{ label: string, message: string, expectSkill?: string, expectMode?: string, forbidSkill?: string }>} */
const CASES = [
  {
    label: 'Filesystem query → go-read (regression)',
    message: 'Can you check in my computer a folder called main projects?',
    expectSkill: 'go-read',
    forbidSkill: 'browse',
  },
  {
    label: 'List directory → go-read',
    message: 'List the files in my Downloads folder.',
    expectSkill: 'go-read',
  },
  {
    label: 'Web browsing → browse',
    message: 'Open slickdeals.net and show me the top deals.',
    expectSkill: 'browse',
    forbidSkill: 'go-read',
  },
  {
    label: 'Web search → search',
    message: 'What are the latest Node.js release notes?',
    expectSkill: 'search',
  },
  {
    label: 'Plain greeting → chat, no tools',
    message: 'Hi',
    expectMode: 'chat',
    expectNoSkills: true,
  },
];

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  );
}

async function runCase(tc) {
  const plan = await Promise.race([
    planIntent({
      userText: tc.message,
      availableSkillIds: SKILL_SUMMARIES.map((s) => s.id),
      availableSkillSummaries: SKILL_SUMMARIES,
    }),
    timeout(TIMEOUT_MS),
  ]);

  if (!plan) throw new Error('planIntent returned null');

  if (tc.expectMode && plan.mode !== tc.expectMode) {
    throw new Error(`Expected mode="${tc.expectMode}" but got "${plan.mode}". Plan: ${JSON.stringify(plan)}`);
  }
  if (tc.expectSkill && !plan.skills.includes(tc.expectSkill)) {
    throw new Error(
      `Expected skill "${tc.expectSkill}" in [${plan.skills.join(', ')}]. Plan: ${JSON.stringify(plan)}`
    );
  }
  if (tc.forbidSkill && plan.skills.includes(tc.forbidSkill)) {
    throw new Error(
      `Skill "${tc.forbidSkill}" should NOT be selected, but was. Skills: [${plan.skills.join(', ')}]. Plan: ${JSON.stringify(plan)}`
    );
  }
  if (tc.expectNoSkills && plan.skills.length > 0) {
    throw new Error(`Expected no skills but got [${plan.skills.join(', ')}]. Plan: ${JSON.stringify(plan)}`);
  }
  return plan;
}

async function main() {
  console.log('Intent planner routing tests (with skill summaries)\n');

  const routerPrompt = loadPrompt('turn-router');
  if (!routerPrompt.includes('Code and file implementation')) {
    throw new Error('turn-router prompt must include implementation routing guidance');
  }
  if (!routerPrompt.includes('write`, `edit`, `go-write`, or `apply-patch`')) {
    throw new Error('turn-router prompt must tell implementation turns to include write-capable skills');
  }
  if (!routerPrompt.includes('command-execution/package-manager capability')) {
    throw new Error('turn-router prompt must distinguish package-manager commands from filesystem writes');
  }

  const weatherPhrasings = [
    'Hows the weather today',
    'Is it going to rain today?',
    'What should I wear outside this morning?',
    'weather please',
    'Do I need an umbrella today?',
  ];
  for (const userText of weatherPhrasings) {
    const weatherPlan = await planIntent({
      userText,
      availableSkillIds: ['search', 'memory', 'me'],
      availableSkillSummaries: [
        { id: 'search', description: 'Search the web for current, live, or recent information including weather.' },
        { id: 'memory', description: 'Read or write saved memory.' },
        { id: 'me', description: 'Read the user profile.' },
      ],
      llmChat: async () => JSON.stringify({
        mode: 'tool',
        skills: ['search'],
        executionMode: 'tool_use',
        usesExistingWorkIntake: false,
        plan: 'Search weather for the best known default location and answer compactly before asking any correction follow-up.',
        answer_style: 'short',
      }),
    });
    if (weatherPlan.mode !== 'tool') throw new Error(`${userText}: expected weather mode=tool: ${JSON.stringify(weatherPlan)}`);
    if (!weatherPlan.skills.includes('search')) throw new Error(`${userText}: expected search skill: ${JSON.stringify(weatherPlan)}`);
    if (weatherPlan.answer_style !== 'short') throw new Error(`${userText}: expected short answer style: ${JSON.stringify(weatherPlan)}`);
    if (!/answer compactly before asking/i.test(weatherPlan.plan)) {
      throw new Error(`${userText}: expected answer-first compact weather plan: ${JSON.stringify(weatherPlan)}`);
    }
  }
  console.log('  Weather phrasings → ✅  route to search, short answer, answer-first default-location plan');

  const durablePlan = await planIntent({
    userText: 'I need the launch ready — messaging, socials, maybe the page, and whatever else is missing.',
    availableSkillIds: ['project-workflow', 'agent-send', 'memory'],
    availableSkillSummaries: [
      { id: 'project-workflow', description: 'Track persistent projects, tasks, and workflow state.' },
      { id: 'agent-send', description: 'Delegate work to another agent.' },
      { id: 'memory', description: 'Read or write memory.' },
    ],
    delegationContext: {
      recommendation: {
        action: 'delegate',
        targetAgentId: 'marketer',
        reason: 'Durable routing selected marketer.',
      },
    },
    workDurability: {
      kind: 'new_mission_candidate',
      persistence: 'create_lightweight_mission',
      missionId: 'mission-launch-testproduct',
      reason: 'Persistent launch work.',
    },
    llmChat: async () => JSON.stringify({
      mode: 'chat',
      skills: [],
      executionMode: 'direct_answer',
      usesExistingWorkIntake: false,
      plan: 'Answer directly.',
      answer_style: 'short',
    }),
  });
  if (durablePlan.mode === 'chat') throw new Error(`Durable work was downgraded to chat: ${JSON.stringify(durablePlan)}`);
  if (!durablePlan.skills.includes('project-workflow')) throw new Error(`Durable plan missing project-workflow: ${JSON.stringify(durablePlan)}`);
  if (!durablePlan.skills.includes('agent-send')) throw new Error(`Durable delegation plan missing agent-send: ${JSON.stringify(durablePlan)}`);
  if (durablePlan.executionMode !== 'persistent_delegation') throw new Error(`Expected persistent_delegation: ${JSON.stringify(durablePlan)}`);
  if (durablePlan.usesExistingWorkIntake !== true) throw new Error(`Expected usesExistingWorkIntake=true: ${JSON.stringify(durablePlan)}`);
  console.log('  Durable work constraint → ✅  mode=' + durablePlan.mode + ' skills=[' + durablePlan.skills.join(', ') + ']');

  const implementationPlan = await planIntent({
    userText: 'Go ahead and apply patches for the approved task status feature.',
    historyMessages: [
      { role: 'user', content: 'Implement successful/failed/pending task states in My Work List.' },
      { role: 'assistant', content: 'I can do that once write tools are available.' },
    ],
    availableSkillIds: ['read', 'go-read', 'write', 'edit', 'go-write', 'apply-patch', 'search'],
    availableSkillSummaries: [
      { id: 'read', description: 'Read files from the workspace.' },
      { id: 'go-read', description: 'Inspect local files and directories.' },
      { id: 'write', description: 'Write files.' },
      { id: 'edit', description: 'Edit existing files.' },
      { id: 'go-write', description: 'Run allowlisted filesystem write operations.' },
      { id: 'apply-patch', description: 'Apply code patches to files.' },
      { id: 'search', description: 'Search the web.' },
    ],
    llmChat: async () => JSON.stringify({
      mode: 'code',
      skills: ['read', 'go-read', 'write', 'edit', 'go-write', 'apply-patch'],
      executionMode: 'tool_use',
      usesExistingWorkIntake: true,
      plan: 'Continue the approved implementation by inspecting the repo, applying patches, and verifying the changed files.',
      answer_style: 'short',
    }),
  });
  for (const id of ['read', 'go-read', 'write', 'edit', 'go-write', 'apply-patch']) {
    if (!implementationPlan.skills.includes(id)) {
      throw new Error(`Implementation plan missing ${id}: ${JSON.stringify(implementationPlan)}`);
    }
  }
  if (implementationPlan.mode !== 'code') throw new Error(`Expected implementation mode=code: ${JSON.stringify(implementationPlan)}`);
  console.log('  Implementation routing constraint → ✅  skills=[' + implementationPlan.skills.join(', ') + ']');

  const rows = [];
  let failed = 0;

  if (!RUN_LIVE_LLM) {
    console.log('  Live LLM planner cases → skipped (set PASTURE_RUN_LIVE_LLM_TESTS=1 to run)');
  } else {
    for (const tc of CASES) {
      process.stdout.write(`  ${tc.label} … `);
      try {
        const plan = await runCase(tc);
        console.log(`✅  mode=${plan.mode} skills=[${plan.skills.join(', ')}]`);
        rows.push({ test: tc.label, result: '✅ Pass', detail: `mode=${plan.mode} skills=[${plan.skills.join(', ')}]` });
      } catch (err) {
        console.log(`❌  ${err.message}`);
        rows.push({ test: tc.label, result: '❌ Fail', detail: err.message });
        failed++;
      }
    }
  }

  console.log('\n--- Results ---');
  if (rows.length) {
    console.log(
      `${'Test'.padEnd(50)} ${'Result'.padEnd(10)} Detail`
    );
    console.log('-'.repeat(120));
    for (const r of rows) {
      console.log(`${r.test.padEnd(50)} ${r.result.padEnd(10)} ${r.detail}`);
    }
    console.log();
    console.log(`${CASES.length - failed}/${CASES.length} passed.`);
  } else {
    console.log('No live LLM rows were run.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
