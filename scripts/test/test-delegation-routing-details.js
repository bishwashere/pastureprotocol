#!/usr/bin/env node

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { buildDelegationContext } = await import('../../lib/agent-delegation-router.js');
  const { buildDelegationDecisionDetails } = await import('../../lib/delegation-routing-details.js');

  const ctx = await buildDelegationContext({
    agentId: 'main',
    userText: "What's our company tagline for marketing materials?",
    availableSkillIds: ['agent-send', 'evaluate-team-capability'],
  });
  assert(ctx, 'expected delegation context');
  const details = buildDelegationDecisionDetails(ctx);
  assert(details && details.reason, 'reason present');
  assert(details.selectedScore >= 0, 'selected score present');
  assert(typeof details.action === 'string', 'action is string');

  console.log('| Test | Input | Output | Status |');
  console.log('| --- | --- | --- | --- |');
  console.log('| delegation-routing-details | marketing delegate | reason+action present | ✅ Pass |');
  console.log('\ndelegation-routing-details tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
