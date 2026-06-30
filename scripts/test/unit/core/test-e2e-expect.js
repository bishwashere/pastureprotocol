/**
 * Unit tests for e2e-expect.js (actual vs behavior assertions).
 * Run: node scripts/test/test-e2e-expect.js
 */

import {
  assertSkillCalled,
  assertNotFailureOnlyReply,
  assertActualResult,
} from '../../support/e2e-expect.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function testThrows(name, fn, partialMsg) {
  try {
    fn();
    console.error(`  ✗ ${name}: expected throw`);
    failed++;
  } catch (err) {
    if (partialMsg && !err.message.includes(partialMsg)) {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
      return;
    }
    console.log(`  ✓ ${name}`);
    passed++;
  }
}

console.log('\ne2e-expect unit tests\n');

test('assertSkillCalled passes when skill present', () => {
  assertSkillCalled(['search', 'core'], 'search');
});

testThrows('assertSkillCalled fails when skill missing', () => {
  assertSkillCalled(['core'], 'search');
}, 'requires skill');

test('assertNotFailureOnlyReply passes substantive reply', () => {
  assertNotFailureOnlyReply('London weather is 12°C with light rain and wind from the west.');
});

testThrows('assertNotFailureOnlyReply fails polite failure', () => {
  assertNotFailureOnlyReply("Sorry, I couldn't reach Home Assistant to fetch your lights.");
}, 'failure-only');

test('assertActualResult with replyIncludesAny', () => {
  assertActualResult(
    { reply: 'Test User prefers E2E tests.', skillsCalled: ['me'] },
    { skill: 'me', actualChecks: { replyIncludesAny: ['Test User'] } }
  );
});

testThrows('assertActualResult fails when reply missing required substring', () => {
  assertActualResult(
    { reply: 'I have no profile saved for you.', skillsCalled: ['me'] },
    { skill: 'me', actualChecks: { replyIncludesAny: ['Test User'] } }
  );
}, 'must include one of');

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
