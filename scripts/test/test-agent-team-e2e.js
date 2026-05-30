#!/usr/bin/env node
/**
 * Agent team E2E: message in → full app routing → reply out.
 * No executeAgentSend calls, no mocked sub-agents. See scripts/test/E2E.md.
 *
 * Usage: node scripts/test/test-agent-team-e2e.js
 */

import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';
import { createTempStateDir, runE2E, runDashboardE2E, isNoLlmError } from './e2e-run.js';
import { setupAgentTeamFixture, patchAgentConfig, MARKETER_TAGLINE } from './agent-team-fixture.js';
import { NEW_SESSION_ACK } from '../../lib/chat-session.js';

const DELEGATE_MSG =
  'Use agent-send to ask the marketer agent what our company tagline is. Reply with their exact answer.';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function replyIncludesTagline(reply) {
  return reply && reply.toLowerCase().includes(MARKETER_TAGLINE.toLowerCase().slice(0, 12));
}

async function main() {
  console.log('Agent team E2E (index.js --test + chat-dashboard, no inner mocks)\n');

  const tests = [
    {
      name: 'new session → brief ack',
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runE2E('new session', { stateDir });
        console.log('  INPUT: new session');
        console.log('  OUTPUT:', reply);
        assert(reply.includes(NEW_SESSION_ACK) || reply === NEW_SESSION_ACK.replace('.', ''), 'Expected new session ack');
        assert(!skillsCalled.includes('agent-send'), 'New session should not call agent-send');
        return { reply, skillsCalled };
      },
    },
    {
      name: 'main delegates to marketer (Telegram path / --test)',
      expectMode: 'behavior',
      skill: 'agent-send',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        console.log('  INPUT:', DELEGATE_MSG);
        const { reply, skillsCalled } = await runE2E(DELEGATE_MSG, { stateDir });
        console.log('  OUTPUT:', reply.slice(0, 400));
        console.log('  SKILLS:', skillsCalled.join(', ') || '(none)');
        assert(skillsCalled.includes('agent-send'), `Expected agent-send in skills, got: ${skillsCalled.join(',')}`);
        const { pass, reason } = await judgeUserGotWhatTheyWanted(DELEGATE_MSG, reply, stateDir, { skillHint: 'agent-send' });
        assert(pass || replyIncludesTagline(reply), `Judge NO and no tagline in reply. ${reason || ''}`);
        return { reply, skillsCalled };
      },
    },
    {
      name: 'main delegates via dashboard (web chat path)',
      expectMode: 'behavior',
      skill: 'agent-send',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        console.log('  INPUT:', DELEGATE_MSG);
        const { reply, skillsCalled } = await runDashboardE2E(DELEGATE_MSG, { stateDir });
        console.log('  OUTPUT:', reply.slice(0, 400));
        assert(replyIncludesTagline(reply) || /marketer|chloe/i.test(reply), 'Expected sub-agent content in dashboard reply');
        return { reply, skillsCalled };
      },
    },
    {
      name: 'rename to Chloe (PATCH) then delegate by alias — no restart',
      expectMode: 'behavior',
      skill: 'agent-send',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { renameMarketerToChloe: true });
        const msg = 'Use agent-send to ask Chloe what our company tagline is. Reply with their exact answer.';
        console.log('  SETUP: PATCH marketer title → Chloe');
        console.log('  INPUT:', msg);
        const { reply, skillsCalled } = await runE2E(msg, { stateDir });
        console.log('  OUTPUT:', reply.slice(0, 400));
        assert(skillsCalled.includes('agent-send'), 'Expected agent-send after rename');
        const { pass, reason } = await judgeUserGotWhatTheyWanted(msg, reply, stateDir, { skillHint: 'agent-send' });
        assert(pass || replyIncludesTagline(reply), `Rename delegation failed. ${reason || ''}`);
        return { reply, skillsCalled };
      },
    },
    {
      name: 'two-turn: setup context then short message (same session)',
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { renameMarketerToChloe: true });
        const msg1 = 'Remember: Chloe is the marketer agent on my team.';
        const msg2 = 'Use agent-send to ask Chloe for our tagline and tell me what they said.';
        console.log('  INPUT 1:', msg1);
        console.log('  INPUT 2:', msg2);
        const { reply, skillsCalled } = await runE2E(msg1, { stateDir, secondMessage: msg2 });
        console.log('  OUTPUT:', reply.slice(0, 400));
        const { pass, reason } = await judgeUserGotWhatTheyWanted(msg2, reply, stateDir, { skillHint: 'agent-send' });
        assert(pass || replyIncludesTagline(reply), `Two-turn delegation failed. ${reason || ''}`);
        return { reply, skillsCalled };
      },
    },
    {
      name: 'remove alex from links → delegation blocked',
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
        const msg = 'Use agent-send to ask alex if he is there.';
        console.log('  SETUP: main allow = [marketer] only');
        console.log('  INPUT:', msg);
        const { reply, skillsCalled } = await runE2E(msg, { stateDir });
        console.log('  OUTPUT:', reply.slice(0, 400));
        const blocked = /not linked|cannot|can't|unable|don't have.*link|no link/i.test(reply);
        assert(blocked, 'Expected blocked delegation message');
        return { reply, skillsCalled };
      },
    },
    {
      name: 're-add alex → delegation works',
      expectMode: 'behavior',
      skill: 'agent-send',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { allow: ['marketer'] });
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer', 'alex'] } });
        const msg = 'Use agent-send to ask alex if he is there. Include his reply.';
        console.log('  SETUP: re-add alex to allow list');
        console.log('  INPUT:', msg);
        const { reply, skillsCalled } = await runE2E(msg, { stateDir });
        console.log('  OUTPUT:', reply.slice(0, 400));
        assert(/alex here|backend/i.test(reply), 'Expected alex sub-agent reply');
        return { reply, skillsCalled };
      },
    },
  ];

  try {
    const { failed } = await runSkillTests('agent-team', tests);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    if (isNoLlmError(err)) {
      console.log('\nSKIP agent-team E2E: LLM not configured.');
      process.exit(0);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
