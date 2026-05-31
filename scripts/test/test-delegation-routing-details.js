#!/usr/bin/env node

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { buildDelegationContext } = await import('../../lib/agent-delegation-router.js');
  const { buildDelegationDecisionDetails } = await import('../../lib/delegation-routing-details.js');

  const ctx = buildDelegationContext({
    agentId: 'main',
    userText: "What's our company tagline for marketing materials?",
    availableSkillIds: ['agent-send', 'evaluate-team-capability'],
    minScore: 5,
  });
  assert(ctx, 'expected delegation context');
  const details = buildDelegationDecisionDetails(ctx);
  assert(details && details.reason, 'reason present');
  assert(Array.isArray(details.candidates) && details.candidates.length > 0, 'candidates');
  assert(details.candidates[0].score > 0, 'score on candidate');
  assert(details.selectedScore >= 0, 'selected score');

  console.log('| Test | Input | Output | Status |');
  console.log('| --- | --- | --- | --- |');
  console.log('| delegation-routing-details | marketing delegate | score+candidates | ✅ Pass |');
  console.log('\ndelegation-routing-details tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
