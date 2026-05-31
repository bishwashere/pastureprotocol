#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-agent-context-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const {
      onAgentTurnStart,
      onAgentSkillStart,
      onAgentWaitingFor,
      onAgentDelegationDone,
      onAgentTurnDone,
      readAllAgentContext,
      readAgentContext,
    } = await import('../../lib/agent-context-state.js');

    onAgentTurnStart({
      agentId: 'main',
      userText: 'What blog ideas for nextpostai.com today?',
      ctx: { jid: 'user@local' },
    });
    let main = readAgentContext('main');
    assert(main.state === 'working', 'main working on turn start');
    assert(main.currentGoal === 'Generate marketing ideas', `goal: ${main.currentGoal}`);
    assert(main.context.some((c) => c.includes('User asking')), 'main has user context');

    onAgentWaitingFor({
      agentId: 'main',
      targetAgentId: 'marketer',
      task: 'blog ideas for nextpostai.com',
      targetGoal: 'Generate marketing ideas',
    });
    main = readAgentContext('main');
    const marketer = readAgentContext('marketer');
    assert(main.state === 'blocked', 'main blocked while waiting');
    assert(main.waitingFor === 'marketer', 'main waiting for marketer');
    assert(marketer.state === 'working', 'marketer working');
    assert(marketer.currentGoal === 'Generate marketing ideas', 'marketer goal set');

    onAgentTurnStart({
      agentId: 'marketer',
      userText: 'blog ideas for nextpostai.com',
      ctx: { jid: 'internal:main->marketer' },
    });
    onAgentSkillStart({ agentId: 'marketer', skillId: 'search' });
    const marketerSearch = readAgentContext('marketer');
    assert(marketerSearch.currentStep === 'Running search', `step: ${marketerSearch.currentStep}`);

    onAgentTurnDone({ agentId: 'marketer' });
    onAgentDelegationDone({ callerAgentId: 'main', targetAgentId: 'marketer' });
    assert(readAgentContext('marketer').state === 'idle', 'marketer idle after delegation');
    assert(readAgentContext('main').currentStep === 'Synthesizing team reply', 'main synthesizing');

    onAgentTurnStart({
      agentId: 'developer',
      userText: 'nginx 502 on port 8080',
      ctx: {},
    });
    onAgentSkillStart({ agentId: 'developer', skillId: 'read' });
    const dev = readAgentContext('developer');
    assert(dev.currentGoal === 'Fix nginx issue', `dev goal: ${dev.currentGoal}`);
    assert(dev.currentStep === 'Reading files', `dev step: ${dev.currentStep}`);

    onAgentTurnDone({ agentId: 'developer' });
    assert(readAgentContext('developer').state === 'idle', 'developer idle after turn');

    const all = readAllAgentContext();
    assert(all.agents.main, 'snapshot includes main');
    assert(Number(all.updatedAt) > 0, 'snapshot has updatedAt');

    console.log('agent-context-state tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
