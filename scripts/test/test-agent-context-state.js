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
      onAgentDelegationError,
      onAgentSkillError,
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
    assert(main.currentGoal === '', `no inferred goal in currentGoal: ${main.currentGoal}`);
    assert(main.currentThought && main.currentThought.includes('blog ideas'), `thought reflects task: ${main.currentThought}`);
    assert(main.currentThought && main.currentThought.includes('Reviewing'), `thought: ${main.currentThought}`);
    assert(main.lastAction === 'Received user message', `lastAction: ${main.lastAction}`);
    assert(main.context.some((c) => c.includes('User asking')), 'main has user context');

    onAgentWaitingFor({
      agentId: 'main',
      targetAgentId: 'marketer',
      task: 'blog ideas for nextpostai.com',
      targetGoal: 'Generate marketing ideas',
    });
    main = readAgentContext('main');
    const marketer = readAgentContext('marketer');
    assert(main.state === 'waiting', 'main waiting while waiting');
    assert(main.waitingFor === 'marketer', 'main waiting for marketer');
    assert(main.lastAction && main.lastAction.includes('Delegated'), `delegation action: ${main.lastAction}`);
    assert(main.currentThought && main.currentThought.includes('Waiting'), `waiting thought: ${main.currentThought}`);
    assert(marketer.state === 'working', 'marketer working');
    assert(marketer.currentGoal === 'Generate marketing ideas', 'marketer goal set');
    assert(marketer.lastAction && marketer.lastAction.includes('Received delegated'), `marketer last: ${marketer.lastAction}`);

    onAgentTurnStart({
      agentId: 'marketer',
      userText: 'blog ideas for nextpostai.com',
      ctx: { jid: 'internal:main->marketer' },
    });
    onAgentSkillStart({ agentId: 'marketer', skillId: 'search' });
    const marketerSearch = readAgentContext('marketer');
    assert(marketerSearch.currentStep === 'Running search', `step: ${marketerSearch.currentStep}`);
    assert(marketerSearch.currentThought && marketerSearch.currentThought.includes('Gathering'), `search thought: ${marketerSearch.currentThought}`);

    onAgentTurnDone({ agentId: 'marketer' });
    onAgentDelegationDone({ callerAgentId: 'main', targetAgentId: 'marketer' });
    assert(readAgentContext('marketer').state === 'idle', 'marketer idle after delegation');
    const mainSynth = readAgentContext('main');
    assert(mainSynth.currentThought && mainSynth.currentThought.includes('Combining'), `main thought: ${mainSynth.currentThought}`);
    assert(mainSynth.lastAction && mainSynth.lastAction.includes('Received reply'), `main last: ${mainSynth.lastAction}`);

    onAgentDelegationError({
      callerAgentId: 'main',
      targetAgentId: 'marketer',
      message: 'Agent not linked',
    });
    assert(readAgentContext('main').state === 'error', 'main error on delegation failure');
    onAgentSkillError({ agentId: 'developer', skillId: 'search', message: 'timeout' });
    assert(readAgentContext('developer').state === 'error', 'developer error on skill failure');

    onAgentTurnStart({
      agentId: 'developer',
      userText: 'nginx 502 on port 8080',
      ctx: {},
    });
    onAgentSkillStart({ agentId: 'developer', skillId: 'read' });
    const dev = readAgentContext('developer');
    assert(dev.currentGoal === '', `no inferred dev goal: ${dev.currentGoal}`);
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
