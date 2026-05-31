#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-goals-ctx-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const { createProject } = await import('../../lib/projects-db.js');
    const { createGoal } = await import('../../lib/goals.js');
    const {
      resolveGoalForUserTurn,
      buildGoalsContextBlock,
      getGoalsDiscoveryIntentHint,
      isWorkOrDiscoveryRequest,
      goalLabelForAgentContext,
    } = await import('../../lib/goals-context.js');

    assert(isWorkOrDiscoveryRequest('find out what this project is about'), 'work request');

    createProject({
      name: 'nextpostai',
      description: 'AI marketing',
      url: 'https://nextpostai.com',
    });
    const goal = createGoal({
      title: 'Research nextpostai',
      objective: 'Learn what nextpostai is and document findings',
      ownerAgentId: 'developer',
    });

    const resolved = resolveGoalForUserTurn({
      userText: 'what is this project all about find out',
      historyMessages: [],
      agentId: 'developer',
    });
    assert(resolved && resolved.id === goal.id, 'goal resolved via project name');

    const block = buildGoalsContextBlock({
      userText: 'what is this project all about find out',
      historyMessages: [],
      agentId: 'developer',
    });
    assert(block.includes('Active goal'), 'goal block header');
    assert(block.includes('nextpostai'), 'related project in block');
    assert(block.includes('tools') && block.includes('confirm'), 'work instructions');
    assert(block.includes('Research nextpostai'), 'goal title');

    const hint = getGoalsDiscoveryIntentHint(
      'find out what this is about',
      [],
      ['browse', 'github', 'memory', 'search'],
      'developer',
    );
    assert(hint && hint.skills.includes('browse'), 'intent includes browse');
    assert(hint.plan.includes('goal'), 'intent references goal');

    assert(goalLabelForAgentContext(goal).includes('Research'), 'goal label');

    console.log('goals-context tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
