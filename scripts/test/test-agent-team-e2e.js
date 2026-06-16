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
import { setupAgentTeamFixture, seedAgentTeamStatusFixture, patchAgentConfig, MARKETER_TAGLINE } from './agent-team-fixture.js';
import { NEW_SESSION_ACK } from '../../lib/context/chat-session.js';

/** Marketing topic — should route to marketer by specialization, not by name. */
const ASK_COMPANY_TAGLINE = "What's our company tagline for marketing materials?";
/** Engineering topic — should route to Alex by github specialization. */
const ASK_CI_FAILURE = 'Can you investigate why our GitHub CI check is failing and propose a fix?';
/** Conversational team context only; turn 2 must not name any agent or skill. */
const ESTABLISH_MARKETING_LANE = 'Taglines, campaigns, and brand stuff should go through whoever owns marketing on the team.';
/** SuggestedTask-style risk framing; should still use marketing specialist lane. */
const ASK_ONBOARDING_RISK = 'Users drop off right after signup. What risk should we prioritize first, and what small experiment should we run this week?';
/** Proactive collaboration framing; should pull in backend specialist for feasibility. */
const ASK_FEASIBILITY_REVIEW = 'We have an onboarding improvement idea. Can you review technical feasibility and rollout risks before we proceed?';
/** Natural team-status analytics questions — must be answerable by the LLM from prompt context. */
const ASK_TEAM_HEADCOUNT_AND_RECENT = 'How many agents are there, and what are the recent movements?';
const ASK_ALEX_LAST_FIVE = 'What did Alex do in his last five tasks?';
const ASK_TEAM_ATTENTION_AND_DONE = 'What is in need of attention, and what work has been completed?';

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

async function assertTeamStatusJudgePass(input, reply, stateDir, criteria) {
  const { pass, reason } = await judgeUserGotWhatTheyWanted(input, reply, stateDir, {
    prompt: `You are judging a team-status E2E test. The bot had a seeded team snapshot with these facts:
- Visible agents: main, marketer, alex (3 total).
- Alex's recent task history includes OAuth callback investigation, webhook retry validation, backend rollout checklist, API latency log review, migration rollback audit, and CI failure review.
- Recent movement includes the OAuth callback investigation involving main and alex, plus other recent team events from marketer/alex.
- Needs attention includes Alex's OAuth callback investigation blocked by a missing GitHub token.
- Completed work includes Alex's completed backend tasks and marketer's onboarding email/pricing/tagline work.

User asked:
"${input}"

Bot replied:
---
${reply}
---

Pass if the reply answers the user naturally from those facts. Do not require exact wording, exact ordering, or every seeded item; partial summaries are okay when they contain the key requested category. ${criteria}
Answer exactly one line beginning YES or NO, followed by one short reason.`,
  });
  assert(pass, `Judge: ${reason || 'NO'}`);
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
      name: 'suggestedTask-style risk prompt gives natural risk+experiment guidance',
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
    {
      name: 'LLM answers natural team count and recent movements',
      input: ASK_TEAM_HEADCOUNT_AND_RECENT,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        await seedAgentTeamStatusFixture(stateDir);
        const { reply, skillsCalled } = await runE2E(ASK_TEAM_HEADCOUNT_AND_RECENT, { stateDir });
        assert(reply && reply.trim().length > 0, 'Expected non-empty team status reply');
        assert(/\b(3|three)\b/i.test(reply || ''), `Expected agent count in reply: ${(reply || '').slice(0, 220)}`);
        assert(/main|marketer|alex/i.test(reply || ''), `Expected agent names in reply: ${(reply || '').slice(0, 220)}`);
        assert(/oauth|movement|delegat|recent|alex/i.test(reply || ''), `Expected recent movement context: ${(reply || '').slice(0, 220)}`);
        await assertTeamStatusJudgePass(
          ASK_TEAM_HEADCOUNT_AND_RECENT,
          reply,
          stateDir,
          'The reply must include the 3-agent count and at least one concrete recent movement/activity from the snapshot.',
        );
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'LLM answers natural last five tasks for a named agent',
      input: ASK_ALEX_LAST_FIVE,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        await seedAgentTeamStatusFixture(stateDir);
        const { reply, skillsCalled } = await runE2E(ASK_ALEX_LAST_FIVE, { stateDir });
        assert(reply && reply.trim().length > 0, 'Expected non-empty last-five-tasks reply');
        const hits = ['ci', 'migration', 'latency', 'rollout', 'webhook', 'oauth']
          .filter((term) => new RegExp(term, 'i').test(reply || '')).length;
        assert(hits >= 3, `Expected multiple Alex task facts in reply: ${(reply || '').slice(0, 260)}`);
        await assertTeamStatusJudgePass(
          ASK_ALEX_LAST_FIVE,
          reply,
          stateDir,
          'The reply must list or summarize several of Alex\'s recent tasks, including active/attention items if the bot treats them as part of the latest task history.',
        );
        return { reply, skillsCalled, stateDir };
      },
    },
    {
      name: 'LLM answers natural attention and completed work summary',
      input: ASK_TEAM_ATTENTION_AND_DONE,
      expectMode: 'behavior',
      run: async () => {
        const stateDir = createTempStateDir();
        await setupAgentTeamFixture(stateDir);
        await seedAgentTeamStatusFixture(stateDir);
        const { reply, skillsCalled } = await runE2E(ASK_TEAM_ATTENTION_AND_DONE, { stateDir });
        assert(reply && reply.trim().length > 0, 'Expected non-empty attention/completed reply');
        assert(/attention|blocked|missing|token|oauth/i.test(reply || ''), `Expected attention context: ${(reply || '').slice(0, 260)}`);
        assert(/completed|done|ci|email|pricing|tagline|webhook|rollout/i.test(reply || ''), `Expected completed work context: ${(reply || '').slice(0, 260)}`);
        await assertTeamStatusJudgePass(
          ASK_TEAM_ATTENTION_AND_DONE,
          reply,
          stateDir,
          'The reply must identify the OAuth/GitHub-token attention item and mention completed work.',
        );
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
