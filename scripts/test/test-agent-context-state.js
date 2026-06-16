#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-agent-context-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const {
      onAgentTurnStart,
      onAgentSkillStart,
      onAgentWaitingFor,
      onAgentDelegationDone,
      onAgentTurnDone,
      onAgentDelegationError,
      onAgentSkillError,
      onAgentTurnError,
      readAllAgentContext,
      readAgentContext,
    } = await import('../../lib/agent/agent-context-state.js');

    onAgentTurnStart({
      agentId: 'main',
      userText: 'What blog ideas for nextpostai.com today?',
      ctx: { jid: 'user@local' },
    });
    let main = readAgentContext('main');
    assert(main.state === 'working', 'main working on turn start');
    assert(main.currentMission === '', `no inferred mission in currentMission: ${main.currentMission}`);
    assert(main.currentThought && main.currentThought.includes('blog ideas'), `thought reflects task: ${main.currentThought}`);
    assert(main.currentThought && main.currentThought.includes('Reviewing'), `thought: ${main.currentThought}`);
    assert(main.lastAction === 'Received user message', `lastAction: ${main.lastAction}`);
    assert(main.context.some((c) => c.includes('User asking')), 'main has user context');

    onAgentWaitingFor({
      agentId: 'main',
      targetAgentId: 'marketer',
      task: 'blog ideas for nextpostai.com',
      targetMission: 'Generate marketing ideas',
    });
    main = readAgentContext('main');
    const marketer = readAgentContext('marketer');
    assert(main.state === 'waiting', 'main waiting while waiting');
    assert(main.waitingFor === 'marketer', 'main waiting for marketer');
    assert(main.lastAction && main.lastAction.includes('Delegated'), `delegation action: ${main.lastAction}`);
    assert(main.currentThought && main.currentThought.includes('Waiting'), `waiting thought: ${main.currentThought}`);
    assert(marketer.state === 'working', 'marketer working');
    assert(marketer.currentMission === 'Generate marketing ideas', 'marketer mission set');
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
    const marketerIdle = readAgentContext('marketer');
    assert(marketerIdle.state === 'idle', 'marketer idle after delegation');
    assert(marketerIdle.currentMission === '', `marketer mission cleared when idle: ${marketerIdle.currentMission}`);

    onAgentDelegationDone({ callerAgentId: 'main', targetAgentId: 'marketer' });
    assert(readAgentContext('marketer').state === 'idle', 'marketer idle after delegation done');
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
    assert(dev.currentMission === '', `no inferred dev mission: ${dev.currentMission}`);
    assert(dev.currentStep === 'Reading files', `dev step: ${dev.currentStep}`);

    onAgentTurnDone({ agentId: 'developer' });
    const devIdle = readAgentContext('developer');
    assert(devIdle.state === 'idle', 'developer idle after turn');
    assert(devIdle.currentMission === '', `developer mission cleared when idle: ${devIdle.currentMission}`);

    onAgentTurnStart({
      agentId: 'main',
      userText: 'Check NextPostAI growth',
      ctx: { jid: 'user@local' },
    });
    onAgentTurnDone({ agentId: 'main' });
    const mainIdle = readAgentContext('main');
    assert(mainIdle.currentMission === '', `stale Answer user question cleared: ${mainIdle.currentMission}`);
    assert(mainIdle.currentThought.includes('Standing by'), `main idle thought: ${mainIdle.currentThought}`);

    const { writeFileSync, mkdirSync } = await import('fs');
    const { dirname } = await import('path');
    const { getAgentContextStatePath } = await import('../../lib/util/paths.js');
    const stalePath = getAgentContextStatePath();
    mkdirSync(dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, JSON.stringify({
      agents: {
        main: {
          agentId: 'main',
          state: 'idle',
          currentMission: 'Answer user question',
          currentThought: 'Standing by for the next task.',
          currentStep: '',
          waitingFor: '',
          lastAction: 'Completed turn',
          context: [],
          knownFacts: [],
          updatedAt: Date.now(),
        },
      },
      updatedAt: Date.now(),
    }), 'utf8');
    const staleRead = readAgentContext('main');
    assert(staleRead.currentMission === '', `read sanitizes stale idle mission: ${staleRead.currentMission}`);

    const all = readAllAgentContext();
    assert(all.agents.main, 'snapshot includes main');
    assert(Number(all.updatedAt) > 0, 'snapshot has updatedAt');

    onAgentTurnStart({ agentId: 'tester', userText: 'do a thing', ctx: { jid: 'user@local' } });
    onAgentSkillError({ agentId: 'tester', skillId: 'github', message: 'token missing' });
    let tester = readAgentContext('tester');
    assert(tester.state === 'error', `error state set by skill error: ${tester.state}`);
    onAgentTurnDone({ agentId: 'tester', status: 'error' });
    tester = readAgentContext('tester');
    assert(
      tester.state === 'error',
      `onAgentTurnDone(status=error) keeps state=error (got ${tester.state}) so the dashboard can show failure`
    );
    assert(
      tester.lastAction && tester.lastAction.includes('errors'),
      `lastAction reflects error: ${tester.lastAction}`
    );

    onAgentTurnStart({ agentId: 'crasher', userText: 'crash me', ctx: { jid: 'user@local' } });
    onAgentTurnError({ agentId: 'crasher', message: 'rate limit exceeded' });
    const crasher = readAgentContext('crasher');
    assert(crasher.state === 'error', `onAgentTurnError sets state=error (got ${crasher.state})`);
    assert(
      crasher.currentThought && crasher.currentThought.toLowerCase().includes('failed'),
      `error thought set: ${crasher.currentThought}`
    );

    onAgentTurnStart({ agentId: 'okboy', userText: 'easy task', ctx: { jid: 'user@local' } });
    onAgentTurnDone({ agentId: 'okboy', status: 'ok' });
    const okboy = readAgentContext('okboy');
    assert(okboy.state === 'idle', `status=ok still resets to idle: ${okboy.state}`);

    console.log('agent-context-state tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
