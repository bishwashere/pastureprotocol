/**
 * Unit tests for interactive CLI banner (setup / skills).
 */

import {
  CLI_BANNER,
  shouldShowCliBanner,
  beginCliSession,
  refreshCliBanner,
  endCliSession,
  isCliSessionActive,
} from '../../lib/util/cli-banner.js';

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

console.log('\nCLI banner tests\n');

test('CLI_BANNER includes PASTURE art and PROTOCOL subtitle', () => {
  if (!CLI_BANNER.includes('██████╗')) throw new Error('missing PASTURE block letters');
  if (!CLI_BANNER.includes('P R O T O C O L')) throw new Error('missing PROTOCOL subtitle');
  if (!CLI_BANNER.includes('Agent ↔ Delegation ↔ State ↔ Autonomy')) {
    throw new Error('missing tagline');
  }
});

test('shouldShowCliBanner false when tests inject ask', () => {
  if (shouldShowCliBanner({ ask: async () => 'q' })) throw new Error('expected false with ask');
});

test('shouldShowCliBanner false when PASTURE_NO_BANNER=1', () => {
  const prev = process.env.PASTURE_NO_BANNER;
  process.env.PASTURE_NO_BANNER = '1';
  try {
    if (shouldShowCliBanner()) throw new Error('expected false with PASTURE_NO_BANNER');
  } finally {
    if (prev === undefined) delete process.env.PASTURE_NO_BANNER;
    else process.env.PASTURE_NO_BANNER = prev;
  }
});

test('session helpers track active state without printing when not TTY', () => {
  endCliSession();
  if (isCliSessionActive()) throw new Error('expected inactive after end');
  beginCliSession();
  refreshCliBanner();
  endCliSession();
  if (isCliSessionActive()) throw new Error('expected inactive after endCliSession');
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
