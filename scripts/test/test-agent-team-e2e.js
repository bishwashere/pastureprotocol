#!/usr/bin/env node
/**
 * Agent team E2E: natural user messages → full app routing → reply.
 * No tool names or "reply with exact answer" in prompts. See scripts/test/E2E.md.
 *
 * Usage: node scripts/test/test-agent-team-e2e.js
 */

import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';
import { createTempStateDir, runE2E, runDashboardE2E, isNoLlmError } from './e2e-run.js';
import { setupAgentTeamFixture, patchAgentConfig, MARKETER_TAGLINE } from './agent-team-fixture.js';
import { NEW_SESSION_ACK } from '../../lib/chat-session.js';

/** How a real user would ask — no skill names or meta-instructions. */
const ASK_MARKETER_TAGLINE = "Hey, ask the marketer — what's our company tagline?";
const ASK_CHLOE_TAGLINE = "Hey Chloe — what's our company tagline?";
const ASK_ALEX_CHECK = "Can you check with Alex if he's around?";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function replyIncludesTagline(reply) {
  return reply && reply.toLowerCase().includes(MARKETER_TAGLINE.toLowerCase().slice(0, 12));
}

function assertDelegatedOrAnswered(reply, skillsCalled) {
  const delegated = skillsCalled.includes('agent-send');
  const answered = replyIncludesTagline(reply);
  assert(
    delegated && answered,
    `Expected agent-send plus tagline in reply. skills=[${skillsCalled.join(',')}] reply=${(reply || '').slice(0, 200)}`,
  );
}

function assertAlexDelegationBlocked(reply, skillsCalled) {
  const notLinked = /not linked|team link|agent map|can't reach|cannot reach|unable to reach|don't have.*link|no link to alex|not connected to alex/i.test(
    reply || '',
  );
  const triedSend = skillsCalled.includes('agent-send');
  assert(
    notLinked || (triedSend && /not linked|team link|agent map/i.test(reply || '')),
    `Expected explanation that Alex is not on the team. skills=[${skillsCalled.join(',')}] reply=${(reply || '').slice(0, 200)}`,
  );
}

async function main() {
  console.log('Agent team E2E (natural user messages, no tool hints)\n');

  const tests = [
    {
      name: 'new session → brief ack',
      input: 'new session',
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runE2E('new session', { stateDir });
        assert(reply.includes(NEW_SESSION_ACK) || reply === NEW_SESSION_ACK.replace('.', ''), 'Expected new session ack');
        assert(!skillsCalled.includes('agent-send'), 'New session should not call agent-send');
        return { reply, skillsCalled };
      },
    },
    {
      name: 'main delegates to marketer (Telegram path / --test)',
      input: ASK_MARKETER_TAGLINE,
      expectMode: 'actual',
      skill: 'agent-send',
      actualChecks: { replyIncludesAny: [MARKETER_TAGLINE.slice(0, 12)] },
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runE2E(ASK_MARKETER_TAGLINE, { stateDir });
        assertDelegatedOrAnswered(reply, skillsCalled);
        const { pass, reason } = await judgeUserGotWhatTheyWanted(ASK_MARKETER_TAGLINE, reply, stateDir, {
          skillHint: 'agent-send',
        });
        assert(pass || replyIncludesTagline(reply), `Judge: ${reason || 'NO'}`);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'main delegates via dashboard (web chat path)',
      input: ASK_MARKETER_TAGLINE,
      expectMode: 'actual',
      skill: 'agent-send',
      actualChecks: { replyIncludesAny: [MARKETER_TAGLINE.slice(0, 12)] },
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runDashboardE2E(ASK_MARKETER_TAGLINE, { stateDir });
        assertDelegatedOrAnswered(reply, skillsCalled);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'rename to Chloe (PATCH) then delegate by alias — no restart',
      input: ASK_CHLOE_TAGLINE,
      expectMode: 'actual',
      skill: 'agent-send',
      actualChecks: { replyIncludesAny: [MARKETER_TAGLINE.slice(0, 12)] },
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { renameMarketerToChloe: true });
        const { reply, skillsCalled } = await runE2E(ASK_CHLOE_TAGLINE, { stateDir });
        assertDelegatedOrAnswered(reply, skillsCalled);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'two-turn: nickname then short ask (same session)',
      input: `Turn1: Let's call the marketer Chloe. Turn2: ${ASK_CHLOE_TAGLINE}`,
      expectMode: 'actual',
      skill: 'agent-send',
      actualChecks: { replyIncludesAny: [MARKETER_TAGLINE.slice(0, 12)] },
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { renameMarketerToChloe: true });
        const msg1 = "Let's call the marketer agent Chloe.";
        const { reply, skillsCalled } = await runE2E(msg1, { stateDir, secondMessage: ASK_CHLOE_TAGLINE });
        assertDelegatedOrAnswered(reply, skillsCalled);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'remove alex from links → delegation blocked',
      input: ASK_ALEX_CHECK,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
        const { reply, skillsCalled } = await runE2E(ASK_ALEX_CHECK, { stateDir });
        assertAlexDelegationBlocked(reply, skillsCalled);
        return { reply, skillsCalled };
      },
    },
    {
      name: 're-add alex → delegation works',
      input: ASK_ALEX_CHECK,
      expectMode: 'actual',
      skill: 'agent-send',
      actualChecks: { replyIncludesAny: ['alex here', 'Alex here', 'backend'] },
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { allow: ['marketer'] });
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer', 'alex'] } });
        const { reply, skillsCalled } = await runE2E(ASK_ALEX_CHECK, { stateDir });
        assert(skillsCalled.includes('agent-send'), `Expected agent-send, got: ${skillsCalled.join(',')}`);
        assert(/alex here|backend/i.test(reply), 'Expected alex sub-agent reply in message');
        return { reply, skillsCalled, stateDir };
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
