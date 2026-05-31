#!/usr/bin/env node
/**
 * Casual greetings — fast unit routing + E2E reply checks.
 *
 * Unit: isNonTaskMessage, buildCasualChatIntentPlan, planIntent (no LLM for greetings).
 * E2E: index.js --test — no search/browse, no dictionary-style citations.
 *
 * Run: pnpm run test:casual-greetings
 * Skip E2E: COWCODE_SKIP_GREETING_E2E=1 pnpm run test:casual-greetings
 */

import { runSkillTests } from './skill-test-runner.js';
import { createTempStateDir, runE2E } from './e2e-run.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';

const INTERNAL_LEAK_PATTERNS = [
  /dictionary\.cambridge/i,
  /source:\s*https?:\/\//i,
  /tool(?:ing)? check/i,
  /github tool/i,
  /memory_search/i,
  /what i found using/i,
  /required tools/i,
  /don'?t need (web )?search/i,
  /\[retry with search\]/i,
];

const CASUAL_MESSAGES = ['hi', 'hello', 'hey', 'hey!', 'thanks', 'thank you', 'ok', 'Hi there', 'good morning'];
const TASK_MESSAGES = ['what is hi', 'find out about nextpostai', 'fix the nginx 502 error'];
const E2E_GREETINGS = ['hi', 'hello', 'hey!'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoLeak(reply) {
  const r = String(reply || '');
  for (const pat of INTERNAL_LEAK_PATTERNS) {
    if (pat.test(r)) throw new Error(`Reply looks like research/tool audit, not a greeting: matched ${pat}`);
  }
}

function assertNoTools(skillsCalled) {
  const skills = Array.isArray(skillsCalled) ? skillsCalled : [];
  const bad = skills.filter((s) => ['search', 'browse', 'github', 'memory'].includes(String(s).toLowerCase()));
  if (bad.length) throw new Error(`Unexpected tools for greeting: ${bad.join(', ')}`);
}

async function runUnitTests() {
  const { isNonTaskMessage } = await import('../../lib/evaluate-team-capability.js');
  const { buildCasualChatIntentPlan, planIntent } = await import('../../lib/intent-planner.js');
  const { getGoalsDiscoveryIntentHint, isWorkOrDiscoveryRequest } = await import('../../lib/goals-context.js');

  const rows = [];

  for (const msg of CASUAL_MESSAGES) {
    const ok = isNonTaskMessage(msg);
    rows.push({
      name: `isNonTaskMessage: ${msg}`,
      input: msg,
      output: ok ? 'casual' : 'task',
      status: ok ? 'pass' : 'fail',
      detail: ok ? '' : 'expected casual',
    });
    assert(ok, `expected casual: ${msg}`);
  }

  for (const msg of TASK_MESSAGES) {
    const casual = isNonTaskMessage(msg);
    rows.push({
      name: `isTaskMessage: ${msg}`,
      input: msg,
      output: casual ? 'casual' : 'task',
      status: casual ? 'fail' : 'pass',
      detail: casual ? 'should not be casual' : '',
    });
    assert(!casual, `expected task: ${msg}`);
  }

  const plan = buildCasualChatIntentPlan();
  assert(plan.mode === 'chat' && plan.skills.length === 0, 'casual plan shape');
  rows.push({
    name: 'buildCasualChatIntentPlan',
    input: '(none)',
    output: `mode=${plan.mode} skills=[]`,
    status: 'pass',
  });

  const hiPlan = await planIntent({ userText: 'hi', availableSkillIds: ['search', 'browse', 'read'] });
  assert(hiPlan && hiPlan.mode === 'chat' && hiPlan.skills.length === 0, `planIntent(hi): ${JSON.stringify(hiPlan)}`);
  rows.push({
    name: 'planIntent("hi") fast path',
    input: 'hi',
    output: `mode=${hiPlan.mode} skills=[${hiPlan.skills.join(', ')}]`,
    status: 'pass',
  });

  assert(!isWorkOrDiscoveryRequest('hi'), 'hi is not work request');
  assert(!getGoalsDiscoveryIntentHint('hi', [], ['search', 'browse'], 'main'), 'no goals hint for hi');
  rows.push({
    name: 'no goals discovery for hi',
    input: 'hi',
    output: 'no hint',
    status: 'pass',
  });

  console.log('\n## Unit: casual-greetings\n');
  console.log('| Test | Input | Output | Status |');
  console.log('| --- | --- | --- | --- |');
  for (const r of rows) {
    const status = r.status === 'pass' ? '✅ Pass' : '❌ Fail';
    console.log(`| ${r.name} | ${r.input} | ${r.output} | ${status}${r.detail ? ` — ${r.detail}` : ''} |`);
  }
  const failed = rows.filter((r) => r.status === 'fail').length;
  if (failed) throw new Error(`${failed} unit case(s) failed`);
  console.log(`\nUnit: ${rows.length - failed}/${rows.length} passed.\n`);
}

async function runE2ETests() {
  if (process.env.COWCODE_SKIP_GREETING_E2E === '1') {
    console.log('Skipping greeting E2E (COWCODE_SKIP_GREETING_E2E=1)\n');
    return { passed: 0, failed: 0 };
  }

  const stateDir = createTempStateDir();
  const tests = E2E_GREETINGS.map((message) => ({
    name: `E2E greeting: "${message}"`,
    input: message,
    expectMode: 'behavior',
    run: async () => {
      const { reply, skillsCalled } = await runE2E(message, { stateDir, timeoutMs: 90_000 });
      assertNoLeak(reply);
      assertNoTools(skillsCalled);
      const { pass, reason } = await judgeUserGotWhatTheyWanted(message, reply, stateDir, {
        prompt:
          `The user said "${message}". The bot replied:\n\n---\n${reply}\n---\n\n` +
          'Is this a short, friendly conversational reply (greeting back or offer to help)? ' +
          'Answer NO if it defines a word, cites a dictionary/URL, lists tool attempts, or reads like a research report.\n' +
          'Answer YES or NO then one short sentence.',
      });
      if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
      return { reply, skillsCalled };
    },
  }));

  return runSkillTests('casual-greetings-e2e', tests);
}

async function main() {
  console.log('Casual greetings test\n');
  await runUnitTests();
  const { failed } = await runE2ETests();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
