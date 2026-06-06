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
    const { createGoal, getGoal } = await import('../../lib/goals.js');
    const {
      classifyWorkDurability,
      delegationArgsFromDurability,
      delegationRoutingTextFromDurability,
      prepareWorkDurability,
    } = await import('../../lib/work-durability.js');

    const direct = classifyWorkDurability({ userText: 'hi', agentId: 'main' });
    assert(direct.kind === 'direct_answer', 'greeting is direct answer');
    assert(direct.persistence === 'none', 'greeting has no persistence');

    const existing = createGoal({
      title: 'Increase customer sign-ups for NextpostAI',
      objective: 'Improve the signup funnel',
      ownerAgentId: 'main',
      status: 'active',
    });
    const attached = prepareWorkDurability({
      userText: 'continue the Increase customer sign-ups for NextpostAI work',
      agentId: 'main',
    });
    assert(attached.kind === 'existing_goal_task_update', 'existing goal update classified');
    assert(attached.goalId === existing.id, 'existing goal attached before delegation');

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
    assert(durable.goalId, 'new mission has goal id before delegation');
    assert(durable.createdGoal === true, 'goal created by durability step');
    const goal = getGoal(durable.goalId);
    assert(goal?.title === 'Launch TestProduct', 'mission title uses product name');
    const subgoalTitles = (goal?.subgoals || []).map((sg) => sg.title).join(' | ').toLowerCase();
    assert(subgoalTitles.includes('positioning'), 'positioning subgoal created');
    assert(subgoalTitles.includes('launch posts'), 'launch posts subgoal created');
    assert(subgoalTitles.includes('landing page checklist'), 'landing page checklist subgoal created');

    const args = delegationArgsFromDurability(durable, launchMessage);
    assert(args.goalId === durable.goalId, 'delegation args include goal id');
    assert(/positioning/i.test(args.expectedOutput), 'delegation expected output includes subgoals');

    const routingText = delegationRoutingTextFromDurability(durable, launchMessage);
    assert(/marketing/.test(routingText), 'routing text includes marketing hint after decomposition');

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
