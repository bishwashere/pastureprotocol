#!/usr/bin/env node
/**
 * Agent team E2E: natural user messages → full app routing → reply.
 * Delegation must come from specialization matching, not naming an agent.
 * See scripts/test/E2E.md.
 *
 * Usage: node scripts/test/test-agent-team-e2e.js
 */

import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';
import { createTempStateDir, runE2E, runDashboardE2E, isNoLlmError } from './e2e-run.js';
import { setupAgentTeamFixture, patchAgentConfig, MARKETER_TAGLINE } from './agent-team-fixture.js';
import { NEW_SESSION_ACK } from '../../lib/chat-session.js';

/** Marketing topic — should route to marketer by specialization, not by name. */
const ASK_COMPANY_TAGLINE = "What's our company tagline for marketing materials?";
/** Engineering topic — should route to Alex by github specialization. */
const ASK_CI_FAILURE = 'Can you investigate why our GitHub CI check is failing and propose a fix?';
/** Conversational team context only; turn 2 must not name any agent or skill. */
const ESTABLISH_MARKETING_LANE = 'Taglines, campaigns, and brand stuff should go through whoever owns marketing on the team.';
/** Initiative-style risk framing; should still use marketing specialist lane. */
const ASK_ONBOARDING_RISK = 'Users drop off right after signup. What risk should we prioritize first, and what small experiment should we run this week?';
/** Proactive collaboration framing; should pull in backend specialist for feasibility. */
const ASK_FEASIBILITY_REVIEW = 'We have an onboarding improvement idea. Can you review technical feasibility and rollout risks before we proceed?';

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

function assertNaturalMarketingOutcome(reply) {
  const answered = replyIncludesTagline(reply) || /tagline|brand|campaign|marketing/i.test(reply || '');
  assert(answered, `Expected useful marketing outcome. reply=${(reply || '').slice(0, 220)}`);
}

function assertNoHallucinatedAlex(reply, skillsCalled) {
  const hallucinatedAlex = /alex here|asked alex|alex says|alex replied/i.test(reply || '');
  assert(
    !hallucinatedAlex,
    `Should not hallucinate Alex when backend specialist is not linked. skills=[${skillsCalled.join(',')}] reply=${(reply || '').slice(0, 200)}`,
  );
}

function assertDelegatedAndNonEmpty(reply, skillsCalled, label = 'delegation expected') {
  const delegated = skillsCalled.includes('agent-send');
  assert(
    delegated && reply && reply.trim().length > 0,
    `${label}. skills=[${skillsCalled.join(',')}] reply=${(reply || '').slice(0, 220)}`,
  );
}

async function main() {
  console.log('Agent team E2E (natural user messages, specialization routing)\n');

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
      name: 'main delegates to marketer by specialization (Telegram path / --test)',
      input: ASK_COMPANY_TAGLINE,
      expectMode: 'actual',
      skill: 'agent-send',
      actualChecks: { replyIncludesAny: [MARKETER_TAGLINE.slice(0, 12)] },
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runE2E(ASK_COMPANY_TAGLINE, { stateDir });
        assertDelegatedOrAnswered(reply, skillsCalled);
        const { pass, reason } = await judgeUserGotWhatTheyWanted(ASK_COMPANY_TAGLINE, reply, stateDir, {
          skillHint: 'agent-send',
        });
        assert(pass || replyIncludesTagline(reply), `Judge: ${reason || 'NO'}`);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'dashboard natural ask returns marketing outcome (no forced delegation)',
      input: ASK_COMPANY_TAGLINE,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runDashboardE2E(ASK_COMPANY_TAGLINE, { stateDir });
        assertNaturalMarketingOutcome(reply);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'rename to Chloe then natural ask still works — no restart',
      input: ASK_COMPANY_TAGLINE,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { renameMarketerToChloe: true });
        const { reply, skillsCalled } = await runE2E(ASK_COMPANY_TAGLINE, { stateDir });
        assertNaturalMarketingOutcome(reply);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'two-turn natural context then ask returns marketing outcome',
      input: `Turn1: ${ESTABLISH_MARKETING_LANE} Turn2: ${ASK_COMPANY_TAGLINE}`,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { renameMarketerToChloe: true });
        const { reply, skillsCalled } = await runE2E(ESTABLISH_MARKETING_LANE, {
          stateDir,
          secondMessage: ASK_COMPANY_TAGLINE,
        });
        assertNaturalMarketingOutcome(reply);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'remove alex from links → no backend delegation hallucination',
      input: ASK_CI_FAILURE,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
        const { reply, skillsCalled } = await runE2E(ASK_CI_FAILURE, { stateDir });
        assertNoHallucinatedAlex(reply, skillsCalled);
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply');
        return { reply, skillsCalled };
      },
    },
    {
      name: 're-add alex → backend specialization delegation works',
      input: ASK_CI_FAILURE,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir, { allow: ['marketer'] });
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer', 'alex'] } });
        const { reply, skillsCalled } = await runE2E(ASK_CI_FAILURE, { stateDir });
        assert(reply && reply.trim().length > 0, 'Expected non-empty reply');
        const delegated = skillsCalled.includes('agent-send');
        const mentionsBackend = /alex|backend|github|ci/i.test(reply || '');
        const { pass, reason } = await judgeUserGotWhatTheyWanted(ASK_CI_FAILURE, reply, stateDir, {
          skillHint: 'agent-send',
        });
        assert(
          (delegated && mentionsBackend) || pass,
          `Expected specialization delegation to backend agent. skills=[${skillsCalled.join(',') || 'none'}] judge=${reason || 'NO'} reply=${(reply || '').slice(0, 200)}`,
        );
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'initiative-style risk prompt gives natural risk+experiment guidance',
      input: ASK_ONBOARDING_RISK,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runE2E(ASK_ONBOARDING_RISK, { stateDir });
        assert(reply && reply.trim().length > 0, 'Expected non-empty risk/experiment response');
        assert(/risk|experiment|signup|onboarding|drop/i.test(reply || ''), `Expected risk/experiment context in reply: ${(reply || '').slice(0, 200)}`);
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'proactive feasibility review returns technical rollout guidance',
      input: ASK_FEASIBILITY_REVIEW,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        const { reply, skillsCalled } = await runE2E(ASK_FEASIBILITY_REVIEW, { stateDir });
        assert(reply && reply.trim().length > 0, 'Expected non-empty feasibility response');
        const mentionsTechnical = /technical|backend|rollout|risk|ci|infrastructure/i.test(reply || '');
        const delegated = skillsCalled.includes('agent-send');
        assert(mentionsTechnical || delegated, `Expected technical feasibility context. reply=${(reply || '').slice(0, 220)}`);
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
